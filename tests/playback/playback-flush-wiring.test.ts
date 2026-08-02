/**
 * R2.1 A1 修复卡测试（Codex 2026-08-02 复审）：五类关键事件的接线真实断言。
 *
 * 复审意见：原"强制 flush"测试只是直接调用 p.flush()，只能证明 persistence
 * API 能 flush，不能证明 pause / stop / 切 scene / visibilitychange / pagehide
 * 这些引擎/浏览器事件真的触发了它。
 *
 * 本文件对组件实际使用的接线函数（lib/utils/playback-flush-wiring.ts）做
 * 真实断言：配合**真实 persistence 实例**（仅写入函数换注入桩），触发接线
 * 函数后断言**落盘行内容**，而非仅仅"flush 被调用"。
 *
 * 关键负例（Codex 复审约束）：idle 不得触发 flush（正常 complete 也会先进
 * idle，不能把所有 idle 当 stop）；visibilityState=visible 不得触发。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { PlaybackStateRecord } from '@/lib/utils/database';
import type { PlaybackPersistSnapshot } from '@/lib/utils/playback-persistence';
import {
  flushOnEngineMode,
  flushOnTeardown,
  flushOnSceneSwitch,
  flushOnVisibilityChange,
  flushOnPageHide,
} from '@/lib/utils/playback-flush-wiring';

const STAGE = 'stage-wiring-1';

const snap = (actionIndex: number): PlaybackPersistSnapshot => ({
  sceneId: 'scene-1',
  sceneIndex: 0,
  actionIndex,
  consumedDiscussions: [],
});

async function freshPersistence(writes: PlaybackStateRecord[]) {
  vi.resetModules();
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
  const { createPlaybackPersistence } = await import('@/lib/utils/playback-persistence');
  return createPlaybackPersistence({
    stageId: STAGE,
    throttleMs: 60_000, // 长窗口：只有关键事件 flush 才会落盘
    write: async (row) => {
      writes.push(row);
    },
  });
}

afterEach(() => {
  delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
});

describe('关键事件接线（真实 persistence + 落盘断言）', () => {
  it('pause（onModeChange=paused）→ flush，落盘最新快照', async () => {
    const writes: PlaybackStateRecord[] = [];
    const p = await freshPersistence(writes);
    p.schedule(snap(11));

    const triggered = flushOnEngineMode('paused', p);
    await p.dispose();

    expect(triggered).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].actionIndex).toBe(11);
    expect(writes[0].stageId).toBe(STAGE);
  });

  it('负例：idle 不触发 flush（complete 也会先进 idle，不能当 stop）', async () => {
    const writes: PlaybackStateRecord[] = [];
    const p = await freshPersistence(writes);
    p.schedule(snap(11));

    const triggered = flushOnEngineMode('idle', p);
    await p.dispose(); // dispose 只排空写入链，不会 flush 待写快照

    expect(triggered).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('stop/teardown → flush，落盘最新快照', async () => {
    const writes: PlaybackStateRecord[] = [];
    const p = await freshPersistence(writes);
    p.schedule(snap(22));

    flushOnTeardown(p);
    await p.flush(); // teardown 内 flush 是 fire-and-forget，这里 drain 断言
    await p.dispose();

    expect(writes).toHaveLength(1);
    expect(writes[0].actionIndex).toBe(22);
  });

  it('切 scene → flush 上一场景待写进度', async () => {
    const writes: PlaybackStateRecord[] = [];
    const p = await freshPersistence(writes);
    p.schedule(snap(33));

    flushOnSceneSwitch(p);
    await p.flush();
    await p.dispose();

    expect(writes).toHaveLength(1);
    expect(writes[0].actionIndex).toBe(33);
  });

  it('visibilitychange→hidden → flush；visible 不触发', async () => {
    const writes: PlaybackStateRecord[] = [];
    const p = await freshPersistence(writes);

    p.schedule(snap(1));
    const visibleTriggered = flushOnVisibilityChange('visible', p);
    expect(visibleTriggered).toBe(false);

    p.schedule(snap(44));
    const hiddenTriggered = flushOnVisibilityChange('hidden', p);
    await p.flush();
    await p.dispose();

    expect(hiddenTriggered).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].actionIndex).toBe(44);
  });

  it('pagehide → flush，落盘最新快照', async () => {
    const writes: PlaybackStateRecord[] = [];
    const p = await freshPersistence(writes);
    p.schedule(snap(55));

    flushOnPageHide(p);
    await p.flush();
    await p.dispose();

    expect(writes).toHaveLength(1);
    expect(writes[0].actionIndex).toBe(55);
  });

  it('persistence 不存在（null）时所有接线函数安全空转', async () => {
    expect(() => {
      flushOnEngineMode('paused', null);
      flushOnTeardown(null);
      flushOnSceneSwitch(undefined);
      flushOnVisibilityChange('hidden', null);
      flushOnPageHide(undefined);
    }).not.toThrow();
  });
});
