/**
 * R2.1 A1 门禁测试（设计卡 v1.2 §6，Codex 签字范围）。
 *
 * 覆盖 A1 五条验收门禁：
 * 1. 节流 trailing：持续调度超过节流窗口 → 最终状态落盘（且只写最新一份）；
 * 2. 强制 flush：flush() 立即落盘当前待写快照（pause / 切 scene /
 *    visibilitychange→hidden / pagehide 的组件侧触发见 PlaybackChromeRoot 接线）；
 * 3. 写入串行化：慢写 + 快写并发 → 严格按入链顺序执行，旧写不超车；
 * 4. 恢复解析：按 sceneId 定位、actionIndex 越界钳制、失效 discussion 过滤、
 *    completed 行忽略；
 * 5. complete：写 completed:true 最终快照，不删行，恢复忽略。
 *
 * 附：引擎游标恢复（restoreFromSnapshot/getSnapshot 往返）。
 * A2 内容（eventId/pending/影子写）不在本文件——签字范围外。
 *
 * 计时器策略：fake-indexeddb 的异步调度与 vi.useFakeTimers 冲突（DB 操作会
 * 挂起），因此——碰 Dexie 的用例一律用真实计时器 + 短节流窗口；
 * 只有写入被注入桩替换的纯逻辑用例才用假计时器。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { PlaybackStateRecord } from '@/lib/utils/database';
import type {
  PlaybackPersistence,
  PlaybackPersistSnapshot,
} from '@/lib/utils/playback-persistence';

const STAGE = 'stage-a1-1';

const snap = (
  actionIndex: number,
  over: Partial<PlaybackPersistSnapshot> = {},
): PlaybackPersistSnapshot => ({
  sceneId: 'scene-1',
  sceneIndex: 0,
  actionIndex,
  consumedDiscussions: [],
  ...over,
});

/** 每个用例全新 fake-indexeddb + 重置模块，避免 Dexie 单例串库 */
async function freshModules() {
  vi.resetModules();
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
  const dbModule = await import('@/lib/utils/database');
  const persistence = await import('@/lib/utils/playback-persistence');
  return { db: dbModule.db, ...persistence };
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
});

describe('门禁 1：trailing/latest-snapshot 节流', () => {
  it('持续调度超过节流窗口 → 最终行是最新快照（真实 DB）', async () => {
    const { db, createPlaybackPersistence } = await freshModules();
    const p = createPlaybackPersistence({ stageId: STAGE, throttleMs: 40 });

    // 每 25ms 一个 action 推进，共 16 次（约 400ms ≈ 10 个节流窗口）
    for (let i = 1; i <= 16; i++) {
      p.schedule(snap(i));
      await realSleep(25);
    }
    await p.dispose();

    const row = await db.playbackState.get(STAGE);
    expect(row).toBeTruthy();
    // trailing：最终落盘的是最后一次（actionIndex=16）
    expect(row!.actionIndex).toBe(16);
    expect(row!.sceneId).toBe('scene-1');
    expect(row!.capturedAt).toBeTruthy();
  }, 15000);

  it('节流窗口内只保留最新快照（latest wins，不产生逐 action 写）', async () => {
    vi.useFakeTimers();
    const writes: PlaybackStateRecord[] = [];
    const { createPlaybackPersistence } = await freshModules();
    const p: PlaybackPersistence = createPlaybackPersistence({
      stageId: STAGE,
      write: async (row) => {
        writes.push(row);
      },
    });

    p.schedule(snap(1));
    p.schedule(snap(2));
    p.schedule(snap(3));
    await vi.advanceTimersByTimeAsync(5000);
    await p.dispose();

    expect(writes).toHaveLength(1);
    expect(writes[0].actionIndex).toBe(3);
  });
});

describe('门禁 2：关键事件强制 flush', () => {
  it('flush 立即落盘待写快照，不等节流窗口', async () => {
    vi.useFakeTimers();
    const writes: PlaybackStateRecord[] = [];
    const { createPlaybackPersistence } = await freshModules();
    const p = createPlaybackPersistence({
      stageId: STAGE,
      write: async (row) => {
        writes.push(row);
      },
    });

    p.schedule(snap(7));
    await p.flush(); // 模拟 pause / 切 scene / visibilitychange→hidden / pagehide

    expect(writes).toHaveLength(1);
    expect(writes[0].actionIndex).toBe(7);

    // flush 后定时器已取消，推进时间不再产生重复写
    await vi.advanceTimersByTimeAsync(10000);
    await p.dispose();
    expect(writes).toHaveLength(1);
  });

  it('无待写快照时 flush 是空操作', async () => {
    const writes: PlaybackStateRecord[] = [];
    const { createPlaybackPersistence } = await freshModules();
    const p = createPlaybackPersistence({
      stageId: STAGE,
      write: async (row) => {
        writes.push(row);
      },
    });
    await p.flush();
    expect(writes).toHaveLength(0);
  });
});

describe('门禁 3：写入串行化', () => {
  it('慢写 + 快写并发 → 严格按入链顺序执行，旧写不超车', async () => {
    const { createPlaybackPersistence } = await freshModules();

    // 可控写：每笔挂起，手动放行
    const resolvers: Array<() => void> = [];
    const write = vi.fn(async (_row: PlaybackStateRecord) => {
      await new Promise<void>((resolve) => resolvers.push(resolve));
    });
    const p = createPlaybackPersistence({ stageId: STAGE, write });

    p.schedule(snap(1, { sceneId: 'scene-old' }));
    const firstDone = p.flush(); // 第一笔入链（挂起）
    await Promise.resolve(); // 让链的 microtask 启动第一笔写
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);

    p.schedule(snap(99, { sceneId: 'scene-new' }));
    const secondDone = p.flush(); // 第二笔排在链尾
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1); // 串行：第二笔尚未开始

    // 放行第一笔（晚完成）→ 第二笔才开始
    resolvers[0]();
    await firstDone;
    expect(write).toHaveBeenCalledTimes(2);

    resolvers[1]();
    await secondDone;
    await p.dispose();

    const calls = write.mock.calls.map((c) => (c[0] as PlaybackStateRecord).sceneId);
    expect(calls).toEqual(['scene-old', 'scene-new']); // 严格按入链顺序
  });
});

describe('门禁 4：恢复解析（sceneId 定位 / 钳制 / 过滤 / completed 忽略）', () => {
  const scenes = [
    {
      id: 'scene-1',
      actions: [
        { id: 'a1', type: 'speech' },
        { id: 'd1', type: 'discussion' },
        { id: 'd2', type: 'discussion' },
      ],
    },
    { id: 'scene-2', actions: [] },
  ];

  async function seed(row: Partial<PlaybackStateRecord>) {
    const { db } = await freshModules();
    await db.playbackState.put({
      stageId: STAGE,
      sceneIndex: 0,
      actionIndex: 1,
      consumedDiscussions: [],
      updatedAt: Date.now(),
      ...row,
    } as PlaybackStateRecord);
  }

  it('正常行 → 按 sceneId 定位，discussion 过滤失效 ID', async () => {
    const { resolveRestorablePlayback } = await freshModules();
    await seed({
      sceneId: 'scene-1',
      consumedDiscussions: ['d1', 'd-ghost', 'd2'],
    });
    const r = await resolveRestorablePlayback(STAGE, scenes);
    expect(r).toEqual({
      sceneId: 'scene-1',
      sceneIndex: 0,
      actionIndex: 1,
      consumedDiscussions: ['d1', 'd2'], // d-ghost 被过滤
    });
  });

  it('actionIndex 越界 → 钳制到 [0, actions.length-1]', async () => {
    const { resolveRestorablePlayback } = await freshModules();
    await seed({ sceneId: 'scene-1', actionIndex: 99 });
    const r = await resolveRestorablePlayback(STAGE, scenes);
    expect(r!.actionIndex).toBe(2); // 3 个 action → 最大 2
  });

  it('sceneId 不在课程场景列表 → 丢弃', async () => {
    const { resolveRestorablePlayback } = await freshModules();
    await seed({ sceneId: 'scene-deleted' });
    expect(await resolveRestorablePlayback(STAGE, scenes)).toBeNull();
  });

  it('无 sceneId（旧行）→ 丢弃', async () => {
    const { resolveRestorablePlayback } = await freshModules();
    await seed({ sceneId: undefined });
    expect(await resolveRestorablePlayback(STAGE, scenes)).toBeNull();
  });

  it('completed 行 → 忽略，不参与续播', async () => {
    const { resolveRestorablePlayback } = await freshModules();
    await seed({ sceneId: 'scene-1', completed: true });
    expect(await resolveRestorablePlayback(STAGE, scenes)).toBeNull();
  });
});

describe('门禁 5：complete 本地语义', () => {
  it('complete 写 completed:true 最终快照，行保留不删除，恢复忽略', async () => {
    const { db, createPlaybackPersistence, resolveRestorablePlayback } =
      await freshModules();
    const p = createPlaybackPersistence({ stageId: STAGE });

    p.schedule(snap(5));
    await p.complete(snap(6));
    await p.dispose();

    const row = await db.playbackState.get(STAGE);
    expect(row).toBeTruthy(); // 行保留
    expect(row!.completed).toBe(true);
    expect(row!.actionIndex).toBe(6); // 最终快照

    // 恢复忽略 completed 行
    expect(
      await resolveRestorablePlayback(STAGE, [{ id: 'scene-1', actions: [] }]),
    ).toBeNull();
  });
});

describe('引擎游标恢复（restoreFromSnapshot 往返）', () => {
  it('restoreFromSnapshot 恢复 sceneIndex/actionIndex/consumedDiscussions 三个游标字段', async () => {
    const { PlaybackEngine } = await import('@/lib/playback/engine');
    // 绕过构造器（需要 ActionEngine/AudioPlayer），只测游标语义。
    // 注意：restoreFromSnapshot（engine.ts:119-123）只恢复这三个字段——
    // sceneId 不在其中，恢复定位由组件接线层在创建引擎前完成（先选场景再建引擎）。
    const engine = Object.create(PlaybackEngine.prototype) as InstanceType<
      typeof PlaybackEngine
    >;
    engine.restoreFromSnapshot({
      sceneIndex: 0,
      actionIndex: 4,
      consumedDiscussions: ['d1'],
      sceneId: 'scene-1',
    });
    const s = engine.getSnapshot();
    expect(s.sceneIndex).toBe(0);
    expect(s.actionIndex).toBe(4);
    expect(s.consumedDiscussions).toEqual(['d1']);
    // 未调用 start()/continuePlayback() → 不存在播放副作用（无 mode 转换）
  });
});
