/**
 * Playback Persistence — R2.1 A1（2026-07-31，Codex 签字范围）
 *
 * 接通 playback 本地持久化链路（此前 savePlaybackState/loadPlaybackState 是
 * 零调用方的休眠代码，PlaybackChromeRoot 的恢复是注释 TODO）。
 *
 * 设计卡：docs/reports/2026-07-31-runtimestore-r2.1-playback-design.md（v1.2）
 *
 * A1 范围（本文件全部内容）：
 * - 5 秒 trailing/latest-snapshot 节流 + 关键事件强制 flush（flush 由调用方
 *   在 pause / stop / 切 scene / visibilitychange→hidden / pagehide 时触发）；
 * - IndexedDB 写入串行化（内部 promise 链，旧快照晚完成不会覆盖新快照）；
 * - completed 本地语义（complete 保存 completed:true 最终快照，不物理删除，
 *   恢复忽略）；
 * - 恢复解析：按 sceneId 定位（sceneIndex 辅助）、actionIndex 越界钳制、
 *   失效 discussion ID 过滤。
 *
 * A2 禁止项本文件一律不含：shadow writer / runtime API 请求 /
 * runtimeShadowEventId / shadowPending / 遥测。
 */

import { db } from './database';
import type { PlaybackStateRecord } from './database';

/** 落盘的快照形状（sceneId 在本层必填——恢复定位的主键） */
export interface PlaybackPersistSnapshot {
  sceneId: string;
  sceneIndex: number;
  actionIndex: number;
  consumedDiscussions: string[];
}

export interface PlaybackPersistenceOptions {
  stageId: string;
  /** 节流间隔，默认 5000ms */
  throttleMs?: number;
  /** 时钟（capturedAt 来源），测试可注入 */
  now?: () => number;
  /** 写入函数，默认 db.playbackState.put；测试可注入慢写/失败写 */
  write?: (row: PlaybackStateRecord) => Promise<unknown>;
}

export interface PlaybackPersistence {
  /** trailing 节流：记录最新快照，节流窗口结束后落盘最新一份 */
  schedule: (snapshot: PlaybackPersistSnapshot) => void;
  /** 立即落盘当前待写快照（关键事件触发）；返回写入链完成 Promise */
  flush: () => Promise<void>;
  /** 播完：先 drain 待写快照，再写 completed:true 最终快照（不删行） */
  complete: (snapshot: PlaybackPersistSnapshot) => Promise<void>;
  /** 卸载：取消定时器并等待写入链排空 */
  dispose: () => Promise<void>;
}

export function createPlaybackPersistence(
  opts: PlaybackPersistenceOptions,
): PlaybackPersistence {
  const throttleMs = opts.throttleMs ?? 5000;
  const now = opts.now ?? (() => Date.now());
  const write =
    opts.write ??
    (async (row: PlaybackStateRecord) => {
      await db.playbackState.put(row);
    });

  let pendingRow: PlaybackStateRecord | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 写入串行化：所有 put 进入同一条 promise 链，保证旧快照晚完成不会覆盖新快照
  let chain: Promise<void> = Promise.resolve();

  const buildRow = (
    snapshot: PlaybackPersistSnapshot,
    completed?: boolean,
  ): PlaybackStateRecord => ({
    stageId: opts.stageId,
    sceneId: snapshot.sceneId,
    sceneIndex: snapshot.sceneIndex,
    actionIndex: snapshot.actionIndex,
    consumedDiscussions: [...snapshot.consumedDiscussions],
    capturedAt: new Date(now()).toISOString(),
    ...(completed ? { completed: true } : {}),
    updatedAt: now(),
  });

  const enqueue = (row: PlaybackStateRecord): void => {
    chain = chain.then(() => write(row)).then(
      () => undefined,
      // 落盘失败不阻断后续写入链（本地持久化失败对业务静默）
      () => undefined,
    );
  };

  const cancelTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const fireScheduled = (): void => {
    timer = null;
    if (pendingRow) {
      const row = pendingRow;
      pendingRow = null;
      enqueue(row);
    }
  };

  return {
    schedule(snapshot) {
      // trailing/latest：始终只保留最新快照，窗口结束写最新一份——
      // 持续播放不会导致最后状态永远不写（设计卡 §3.1 约束）
      pendingRow = buildRow(snapshot);
      if (timer === null) {
        timer = setTimeout(fireScheduled, throttleMs);
      }
    },

    async flush() {
      cancelTimer();
      if (pendingRow) {
        const row = pendingRow;
        pendingRow = null;
        enqueue(row);
      }
      await chain;
    },

    async complete(snapshot) {
      cancelTimer();
      // 先排空普通待写快照，再写 completed 行——同一条链保证顺序
      if (pendingRow) {
        const row = pendingRow;
        pendingRow = null;
        enqueue(row);
      }
      enqueue(buildRow(snapshot, true));
      await chain;
    },

    async dispose() {
      cancelTimer();
      await chain;
    },
  };
}

/** 恢复解析的输出——交给引擎 restoreFromSnapshot 的稳定游标数据 */
export interface RestorablePlayback {
  sceneId: string;
  sceneIndex: number;
  actionIndex: number;
  consumedDiscussions: string[];
}

/** 场景形状的最小约定（恢复定位/校验用） */
export interface RestorableScene {
  id: string;
  actions?: Array<{ id?: string; type: string }> | null;
}

/**
 * 恢复解析（设计卡 §3.3）：
 * 1. 按 sceneId 定位（sceneIndex 只作辅助）；
 * 2. actionIndex 越界钳制到 [0, actions.length-1]；
 * 3. consumedDiscussions 过滤失效 discussion ID（课程编辑后可能不存在）；
 * 4. completed 行忽略，不参与续播。
 * 返回 null 表示无可恢复断点。
 */
export async function resolveRestorablePlayback(
  stageId: string,
  scenes: RestorableScene[],
): Promise<RestorablePlayback | null> {
  const row = await db.playbackState.get(stageId);
  if (!row || row.completed || !row.sceneId) return null;

  const scene = scenes.find((s) => s.id === row.sceneId);
  if (!scene) return null;

  const actions = scene.actions ?? [];
  const maxIndex = Math.max(actions.length - 1, 0);
  const actionIndex = Math.min(Math.max(row.actionIndex, 0), maxIndex);

  const validDiscussionIds = new Set(
    actions.filter((a) => a.type === 'discussion' && a.id).map((a) => a.id as string),
  );
  const consumedDiscussions = (row.consumedDiscussions ?? []).filter((id) =>
    validDiscussionIds.has(id),
  );

  return {
    sceneId: row.sceneId,
    sceneIndex: row.sceneIndex ?? 0,
    actionIndex,
    consumedDiscussions,
  };
}
