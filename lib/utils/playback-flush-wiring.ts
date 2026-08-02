/**
 * Playback Flush Wiring — R2.1 A1 修复卡（Codex 2026-08-02 复审）
 *
 * 五类关键事件 → flush 的唯一接线处。PlaybackChromeRoot 只调用本模块，
 * 测试直接对这里的函数做真实断言（配合真实 persistence + 注入写桩，
 * 断言落盘行而不仅是"flush 被调用"）。
 *
 * 关键约束（Codex 复审原话）：
 * - stop 本身是独立关键事件：在明确的用户 stop / teardown 路径 flush，
 *   **不要把所有 idle 都当 stop**——正常 complete 也会先进入 idle；
 * - pause 走 onModeChange === 'paused'；
 * - visibilitychange 只在 visibilityState === 'hidden' 时 flush。
 */

import type { EngineMode } from '@/lib/playback';
import type { PlaybackPersistence } from './playback-persistence';

type Flushable = Pick<PlaybackPersistence, 'flush'> | null | undefined;

/** pause → flush（引擎 onModeChange 回调用）。返回是否触发了 flush。 */
export function flushOnEngineMode(mode: EngineMode, p: Flushable): boolean {
  if (mode === 'paused' && p) {
    void p.flush();
    return true;
  }
  return false;
}

/** 明确的用户 stop / imperative teardown → flush（独立关键事件）。 */
export function flushOnTeardown(p: Flushable): void {
  void p?.flush();
}

/** 切 scene → flush 上一场景的待写进度。 */
export function flushOnSceneSwitch(p: Flushable): void {
  void p?.flush();
}

/** visibilitychange → 仅在 hidden 时 flush。 */
export function flushOnVisibilityChange(visibilityState: string, p: Flushable): boolean {
  if (visibilityState === 'hidden' && p) {
    void p.flush();
    return true;
  }
  return false;
}

/** pagehide → flush。 */
export function flushOnPageHide(p: Flushable): void {
  void p?.flush();
}
