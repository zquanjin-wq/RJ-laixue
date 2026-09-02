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
  /** 读取函数（superseded 检测用），默认 db.playbackState.get；测试可注入 */
  read?: () => Promise<PlaybackStateRecord | undefined>;
  /** A2：每次成功落盘后回调（组件在此挂影子写；开关关闭时回调内部立即返回） */
  onPersisted?: (row: PlaybackStateRecord) => void;
  /** A2：检测到上一笔 persisted pending 被新快照覆盖（superseded）时回调 */
  onSuperseded?: (pending: { eventId: string; capturedAt: string }) => void;
  /** A2：UUID 生成器，测试可注入 */
  uuid?: () => string;
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
  const read =
    opts.read ??
    (async () => {
      return db.playbackState.get(opts.stageId);
    });
  const uuid =
    opts.uuid ??
    (() =>
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `uuid-${now()}-${Math.random().toString(36).slice(2)}`);

  let pendingRow: PlaybackStateRecord | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 写入串行化：所有 put 进入同一条 promise 链，保证旧快照晚完成不会覆盖新快照
  let chain: Promise<void> = Promise.resolve();

  const buildRow = (
    snapshot: PlaybackPersistSnapshot,
    completed?: boolean,
  ): PlaybackStateRecord => {
    // A2：每次业务落盘生成新 UUID，eventId 与 shadowPending 随快照同一次 put
    // （R2.1 §4.3 不变量）；重试只能复用已持久化的 id，下次保存必须换新
    const capturedAt = new Date(now()).toISOString();
    const eventId = uuid();
    return {
      stageId: opts.stageId,
      sceneId: snapshot.sceneId,
      sceneIndex: snapshot.sceneIndex,
      actionIndex: snapshot.actionIndex,
      consumedDiscussions: [...snapshot.consumedDiscussions],
      capturedAt,
      ...(completed ? { completed: true } : {}),
      runtimeShadowEventId: eventId,
      shadowPending: { eventId, capturedAt },
      updatedAt: now(),
    };
  };

  const enqueue = (row: PlaybackStateRecord): void => {
    chain = chain
      .then(async () => {
        // A2 superseded 检测（仅在注册了 onSuperseded 消费者时启用——A1 用例
        // 无消费者，行为与签字版完全一致零偏移）：新快照落盘前，若库中当前行
        // 仍带 shadowPending（上一笔已持久化但影子未送出），旧 pending 被本
        // 快照覆盖放弃——本地丢弃指标（local_drop），不得伪装成服务端请求
        // 结果（R2.1 §4.3）
        if (opts.onSuperseded) {
          const prev = await read().catch(() => undefined);
          if (prev?.shadowPending) {
            opts.onSuperseded(prev.shadowPending);
          }
        }
        await write(row);
        opts.onPersisted?.(row);
      })
      .then(
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

// ── R2.1 A2：影子 pending 管理 ─────────────────────────────────────────────

/**
 * 条件清除影子 pending（设计卡 §4.3）：只有数据库当前行的
 * runtimeShadowEventId 与已发送成功的 eventId 相同才允许清除——
 * 防止旧请求晚成功误删已被新快照覆盖的新 pending。
 * completed 行在影子成功后物理删除（设计卡 §3.4：complete 先行快照+pending，
 * 影子成功才删行，失败留 pending 供挂载重试）。
 *
 * Codex A2 复审卡（2026-08-02）：读取、比较、清除/删除必须在同一 rw 事务内
 * 完成——get→比较→写 之间存在跨标签页竞态窗口，另一标签页可能在此期间
 * 保存新快照，非原子的旧清除会误删/覆盖新行。
 */
export async function clearPlaybackPending(
  stageId: string,
  eventId: string,
): Promise<'cleared' | 'deleted-complete' | 'skipped'> {
  return db.transaction('rw', db.playbackState, async () => {
    const row = await db.playbackState.get(stageId);
    if (!row || row.runtimeShadowEventId !== eventId) return 'skipped';
    if (row.completed) {
      await db.playbackState.delete(stageId);
      return 'deleted-complete';
    }
    await db.playbackState.put({ ...row, shadowPending: undefined });
    return 'cleared';
  });
}

/** 挂载补写检查（设计卡 §4.3）：返回当前行是否有待发送的影子 pending */
export async function getPlaybackPendingInfo(
  stageId: string,
): Promise<{ hasPending: boolean; eventId?: string; capturedAt?: string }> {
  const row = await db.playbackState.get(stageId);
  if (!row?.shadowPending) return { hasPending: false };
  return {
    hasPending: true,
    eventId: row.shadowPending.eventId,
    capturedAt: row.shadowPending.capturedAt,
  };
}

/**
 * 快照新旧比较（设计卡 §4.5）：按 capturedAt 判断新旧，绝不按服务端
 * append 到达顺序；capturedAt 相同时按 eventId 字典序取大（稳定 tie-break）。
 * 返回 >0 表示 a 较新，<0 表示 b 较新，0 表示完全同一笔。
 */
export function comparePlaybackSnapshotOrder(
  a: { capturedAt: string; eventId: string },
  b: { capturedAt: string; eventId: string },
): number {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? -1 : 1;
  if (a.eventId === b.eventId) return 0;
  return a.eventId < b.eventId ? -1 : 1;
}
