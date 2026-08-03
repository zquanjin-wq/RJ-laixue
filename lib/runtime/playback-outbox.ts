/**
 * lib/runtime/playback-outbox.ts
 *
 * R3.1: playback shadow 切换为 outbox 模式。
 *
 * 旧路径 (shadow-writer.ts) 直接调用 RuntimeStore API；
 * R3.1 将 shadowPlaybackProgress 改为入队 outbox，后台队列发送。
 * outboxReady 门禁：迁移完成后才切新路径；未完成时保持旧路径。
 */

import { db } from '@/lib/utils/database';
import { scanAndDrain, cleanupExpiredLeases } from '@/lib/runtime/outbox';
import type { RuntimeOutboxEntry } from '@/lib/utils/database';
import { isPlaybackShadowEnabled } from '@/lib/runtime/shadow-writer';
import { getPlaybackPendingInfo } from '@/lib/utils/playback-persistence';

// ─── 开关 ────────────────────────────────────────────────────────────────────

export function isPlaybackOutboxEnabled(): boolean {
  return isPlaybackShadowEnabled();
}

// ─── outboxReady 门禁 ────────────────────────────────────────────────────────

const OUTBOX_READY_KEY = 'r3:playback:outbox:ready';

/** 迁移完成 + 刷新恢复完成 = outbox 可以接管 */
export function isOutboxReady(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(OUTBOX_READY_KEY) === '1';
}

function setOutboxReady(): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(OUTBOX_READY_KEY, '1');
}

// ─── drain timer ─────────────────────────────────────────────────────────────

let drainTimer: ReturnType<typeof setTimeout> | null = null;
let drainRunning = false;

/** 读取下一个 playback pending 条目的 nextAttemptAt，安排定时唤醒 */
async function scheduleNextDrain(): Promise<void> {
  if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
  if (!isPlaybackOutboxEnabled()) return;

  const pending = await db.runtimeOutbox
    .where('kind').equals('playback')
    .filter((e) => e.status === 'pending')
    .toArray();

  if (pending.length === 0) return;

  const earliest = Math.min(...pending.map((e) => new Date(e.nextAttemptAt).getTime()));
  const delay = Math.max(0, earliest - Date.now()) + 50; // +50ms buffer
  drainTimer = setTimeout(() => void drainPlaybackOutbox(), delay);
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * R3.1: 将 playback 快照入队 outbox（替代直接 HTTP 发送）。
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

    const createBody = {
      id: sessionId, kind: 'playback', stageId, status,
      createdAt: capturedAt, updatedAt: capturedAt,
    };

    const appendBody = {
      id: `pb:${stageId}:${eventId}`, createdAt: capturedAt, sceneId: row.sceneId,
      payload: {
        v: 1, sceneId: row.sceneId, sceneIndex: row.sceneIndex,
        actionIndex: row.actionIndex, consumedDiscussions: row.consumedDiscussions ?? [], capturedAt,
      },
    };

    const createId = await _enqueueInTx({
      kind: 'playback', op: 'create_session', sessionId, semanticKey: `create:${sessionId}:${eventId}`, body: createBody,
    });
    const appendId = await _enqueueInTx({
      kind: 'playback', op: 'append_record', sessionId, semanticKey: semKey, body: appendBody,
    }, createId);

    if (row.completed) {
      await _enqueueInTx({
        kind: 'playback', op: 'set_status', sessionId, semanticKey: `status:${sessionId}`,
        body: { status: 'completed', updatedAt: capturedAt },
      }, appendId);
    }

    // 原子清除 shadowPending（标记已入队）
    await db.playbackState.update(stageId, { shadowPending: undefined });

    return 'enqueued' as const;
  });
}

/**
 * R3.1 迁移：全表 pending → outbox。
 * 当且仅当全部成功后才写 outboxReady 标志。
 */
export async function migrateShadowPendingToOutbox(): Promise<{ migrated: number; skipped: number; failed: boolean }> {
  if (!isPlaybackOutboxEnabled()) return { migrated: 0, skipped: 0, failed: false };

  const allRows = await db.playbackState.toArray();
  let migrated = 0, skipped = 0, failed = 0;

  // 先批量入队（每行独立事务，部分失败不丢未迁移行）
  for (const row of allRows) {
    if (!row.shadowPending) { skipped++; continue; }
    try {
      const result = await shadowPlaybackProgressViaOutbox(row.stageId);
      if (result === 'enqueued') migrated++;
      else { failed++; break; }
    } catch {
      failed++; break;
    }
  }

  // 仅全量成功才标记 outbox ready
  const allDone = failed === 0 && migrated > 0;
  if (allDone || (migrated === 0 && allRows.every((r) => !r.shadowPending))) {
    setOutboxReady();
    return { migrated, skipped, failed: false };
  }

  return { migrated, skipped, failed: true };
}

/**
 * R3.1 启动入口：过期 lease → 迁移（如未完成）→ drain → 安排定时器。
 */
export async function onPlaybackOutboxStartup(tabId?: string): Promise<{ ready: boolean }> {
  if (!isPlaybackOutboxEnabled()) return { ready: false };
  const tid = tabId ?? `pb-startup-${crypto.randomUUID().slice(0, 8)}`;
  await cleanupExpiredLeases(tid);

  if (!isOutboxReady()) {
    const result = await migrateShadowPendingToOutbox();
    if (result.failed) return { ready: false };
  }

  await drainPlaybackOutbox(tid);
  await scheduleNextDrain();
  return { ready: true };
}

/** 后台发送 + 重排定时器 */
export async function drainPlaybackOutbox(tabId?: string): Promise<void> {
  if (!isPlaybackOutboxEnabled() || drainRunning) return;
  drainRunning = true;
  try {
    const tid = tabId ?? `pb-drain-${crypto.randomUUID().slice(0, 8)}`;
    await scanAndDrain(tid);
    // R3.1: 扫描 completed 行，set_status 成功发送后条件清理
    await _cleanupCompletedRows();
  } finally {
    drainRunning = false;
    await scheduleNextDrain();
  }
}

/** online/visibility → drain */
export function schedulePlaybackOutboxDrain(): void {
  if (!isPlaybackOutboxEnabled()) return;
  setTimeout(() => void drainPlaybackOutbox(), 100);
}

// ─── completed 行清理 ────────────────────────────────────────────────────────

async function _cleanupCompletedRows(): Promise<void> {
  const completedRows = await db.playbackState.filter((r) => r.completed === true).toArray();
  for (const row of completedRows) {
    if (!row.runtimeShadowEventId) continue;
    const sid = `pb:${row.stageId}`;
    // 确认该 session 的所有 outbox 条目已排空（全部成功或 dead）
    const pendingEntries = await db.runtimeOutbox.where('sessionId').equals(sid).toArray();
    const active = pendingEntries.filter((e) => e.status === 'pending' || e.status === 'sending');
    if (active.length > 0) continue;

    // R2.1 条件删除：仅当 runtimeShadowEventId 匹配
    const current = await db.playbackState.get(row.stageId);
    if (current?.runtimeShadowEventId === row.runtimeShadowEventId) {
      await db.playbackState.delete(row.stageId);
    }
  }
}

// ─── 内部辅助 ────────────────────────────────────────────────────────────────

async function _enqueueInTx(
  params: { kind: 'playback'; op: RuntimeOutboxEntry['op']; sessionId: string; semanticKey: string; body: unknown },
  dependsOnEntryId?: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const nowStr = new Date().toISOString();
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
