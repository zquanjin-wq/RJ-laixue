/**
 * lib/runtime/playback-outbox.ts
 *
 * R3.1: playback shadow 切换为 outbox 模式。
 *
 * 旧路径 (shadow-writer.ts) 直接调用 RuntimeStore API；
 * R3.1 将 shadowPlaybackProgress 改为入队 outbox，后台队列发送。
 * 保留旧函数作为受控回退路径（由 PlaybackChromeRoot 的 fallback 选择）。
 */

import { db } from '@/lib/utils/database';
import { enqueue, scanAndDrain, cleanupExpiredLeases } from '@/lib/runtime/outbox';
import type { RuntimeOutboxEntry } from '@/lib/utils/database';
import { isPlaybackShadowEnabled } from '@/lib/runtime/shadow-writer';

// ─── 开关 ────────────────────────────────────────────────────────────────────

/** R3.1 双开关门禁：NEXT_PUBLIC_RUNTIME_SHADOW && NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK */
export function isPlaybackOutboxEnabled(): boolean {
  return isPlaybackShadowEnabled();
}

// ─── 迁移锁 ──────────────────────────────────────────────────────────────────

const MIGRATION_COMPLETE_KEY = 'r3:playback:outbox:migration-complete';

export function isMigrationComplete(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(MIGRATION_COMPLETE_KEY) === '1';
}

function setMigrationComplete(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(MIGRATION_COMPLETE_KEY, '1');
  }
}

// ─── drain worker 防重 ───────────────────────────────────────────────────────

let drainRunning = false;

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * R3.1: 将 playback 快照入队 outbox（替代直接 HTTP 发送）。
 *
 * 先检查双开关，关闭时零副作用。
 * 幂等：若当前行无 shadowPending，直接返回。
 * 入队后原子清除 shadowPending。
 */
export async function shadowPlaybackProgressViaOutbox(stageId: string): Promise<'enqueued' | 'skipped' | 'disabled'> {
  if (!isPlaybackOutboxEnabled()) return 'disabled';

  return db.transaction('rw', db.playbackState, db.runtimeOutbox, async () => {
    const row = await db.playbackState.get(stageId);
    if (!row) return 'skipped' as const;
    if (!row.shadowPending) return 'skipped' as const;

    const semKey = `playback:${stageId}:latest-progress`;
    const sessionId = `pb:${stageId}`;
    const capturedAt = row.capturedAt ?? new Date(row.updatedAt).toISOString();
    const eventId = row.runtimeShadowEventId ?? crypto.randomUUID();
    const status = row.completed ? 'completed' : 'active';
    const nowStr = new Date().toISOString();

    // R2.1 已签字契约 —— create_session body
    const createBody = {
      id: sessionId,
      kind: 'playback',
      stageId,
      status,
      createdAt: capturedAt,
      updatedAt: capturedAt,
    };

    // R2.1 已签字契约 —— append_record body（带外层 id/createdAt/payload）
    const appendBody = {
      id: `pb:${stageId}:${eventId}`,
      createdAt: capturedAt,
      sceneId: row.sceneId,
      payload: {
        v: 1,
        sceneId: row.sceneId,
        sceneIndex: row.sceneIndex,
        actionIndex: row.actionIndex,
        consumedDiscussions: row.consumedDiscussions ?? [],
        capturedAt,
      },
    };

    // create → append → [set_status]
    const createId = await _enqueueInTx({
      kind: 'playback', op: 'create_session', sessionId,
      semanticKey: `create:${sessionId}:${eventId}`,
      body: createBody,
    });

    const appendId = await _enqueueInTx({
      kind: 'playback', op: 'append_record', sessionId,
      semanticKey: semKey,
      body: appendBody,
    }, createId);

    if (row.completed) {
      // R2.1 已签字契约 —— set_status body
      await _enqueueInTx({
        kind: 'playback', op: 'set_status', sessionId,
        semanticKey: `status:${sessionId}`,
        body: { status: 'completed', updatedAt: capturedAt },
      }, appendId);
    }

    // 原子清除 shadowPending
    await db.playbackState.update(stageId, { shadowPending: undefined });

    return 'enqueued' as const;
  });
}

/**
 * R3.1 迁移：playbackState.shadowPending → outbox
 * 扫描所有带 shadowPending 的行，原子入队并清除。
 * 幂等：已迁移的行不会被重复入队。
 */
export async function migrateShadowPendingToOutbox(): Promise<{ migrated: number; skipped: number }> {
  if (!isPlaybackOutboxEnabled()) return { migrated: 0, skipped: 0 };
  const allRows = await db.playbackState.toArray();
  let migrated = 0, skipped = 0;
  for (const row of allRows) {
    if (!row.shadowPending) { skipped++; continue; }
    const result = await shadowPlaybackProgressViaOutbox(row.stageId);
    if (result === 'enqueued') migrated++; else skipped++;
  }
  if (migrated > 0) setMigrationComplete();
  return { migrated, skipped };
}

/**
 * R3.1 启动入口：在应用初始化时调用一次。
 * 依次执行：过期 lease 回收 → 一次性迁移（如未完成）→ drain 存量 outbox。
 */
export async function onPlaybackOutboxStartup(tabId?: string): Promise<void> {
  if (!isPlaybackOutboxEnabled()) return;
  const tid = tabId ?? `playback-${crypto.randomUUID().slice(0, 8)}`;
  await cleanupExpiredLeases(tid);
  if (!isMigrationComplete()) await migrateShadowPendingToOutbox();
  await drainPlaybackOutbox(tid);
}

/**
 * 后台发送：触发 scanAndDrain 直到无待发送条目。
 * 防重入：若已有 drain 运行，跳过。
 */
export async function drainPlaybackOutbox(tabId?: string): Promise<void> {
  if (!isPlaybackOutboxEnabled() || drainRunning) return;
  drainRunning = true;
  try {
    const tid = tabId ?? `playback-${crypto.randomUUID().slice(0, 8)}`;
    await scanAndDrain(tid);
  } finally {
    drainRunning = false;
  }
}

/** 供 online/visibilitychange 事件触发 */
export function schedulePlaybackOutboxDrain(tabId?: string): void {
  if (!isPlaybackOutboxEnabled()) return;
  // 延迟执行避免阻塞事件处理
  setTimeout(() => void drainPlaybackOutbox(tabId), 100);
}

// ─── 内部辅助 ────────────────────────────────────────────────────────────────

async function _enqueueInTx(
  params: { kind: 'playback'; op: RuntimeOutboxEntry['op']; sessionId: string; semanticKey: string; body: unknown },
  dependsOnEntryId?: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const nowStr = new Date().toISOString();
  // Playback compaction
  const existing = await db.runtimeOutbox
    .where('semanticKey').equals(params.semanticKey)
    .filter((e) => e.status === 'pending' && !e.leaseOwner && e.id !== id)
    .toArray();
  for (const e of existing) await db.runtimeOutbox.update(e.id, { status: 'superseded' });
  const rows = await db.runtimeOutbox.where('sessionId').equals(params.sessionId).toArray();
  const lastSeq = rows.length > 0 ? Math.max(...rows.map((e) => e.sequence ?? 0)) : 0;
  const entry: RuntimeOutboxEntry = {
    id, kind: params.kind, op: params.op,
    sessionId: params.sessionId, semanticKey: params.semanticKey,
    body: params.body, createdAt: nowStr, attempts: 0, nextAttemptAt: nowStr,
    status: 'pending', sequence: lastSeq + 1, dependsOnEntryId,
  };
  await db.runtimeOutbox.put(entry);
  return id;
}
