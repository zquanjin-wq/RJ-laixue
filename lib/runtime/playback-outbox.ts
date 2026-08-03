/**
 * lib/runtime/playback-outbox.ts
 *
 * R3.1: playback shadow 切换为 outbox 模式。
 *
 * 旧路径 (shadow-writer.ts) 直接调用 RuntimeStore API；
 * R3.1 将 shadowPlaybackProgress 改为入队 outbox，由后台队列负责发送。
 * 保留旧函数作为受控回退路径。
 */

import { db } from '@/lib/utils/database';
import { enqueue, scanAndDrain } from '@/lib/runtime/outbox';
import type { RuntimeOutboxEntry } from '@/lib/utils/database';

/** 读播放行，复用 R2 的四态逻辑但返回可入队的快照信息 */
interface PendingSnapshot {
  stageId: string;
  row: {
    capturedAt: string;
    sceneId?: string;
    sceneIndex: number;
    actionIndex: number;
    consumedDiscussions: string[];
    completed?: boolean;
  };
}

async function readPlaybackRow(stageId: string): Promise<PendingSnapshot | null> {
  const row = await db.playbackState.get(stageId);
  if (!row) return null;
  return {
    stageId,
    row: {
      capturedAt: row.capturedAt ?? new Date().toISOString(),
      sceneId: row.sceneId,
      sceneIndex: row.sceneIndex,
      actionIndex: row.actionIndex,
      consumedDiscussions: row.consumedDiscussions,
      completed: row.completed,
    },
  };
}

/**
 * R3.1: 将 playback 快照入队 outbox（替代直接 HTTP 发送）。
 *
 * 幂等：若当前行无 shadowPending，则是 R2 已发送过的快照，直接返回不重复入队。
 * 首次入队后，shadowPending 被清除，后续调用幂等跳过。
 */
export async function shadowPlaybackProgressViaOutbox(stageId: string): Promise<'enqueued' | 'skipped'> {
  return db.transaction('rw', db.playbackState, db.runtimeOutbox, async () => {
    const row = await db.playbackState.get(stageId);
    if (!row) return 'skipped' as const;
    if (!row.shadowPending) return 'skipped' as const;

    const semKey = `playback:${stageId}:latest-progress`;
    const sessionId = `pb:${stageId}`;
    const body = {
      v: 1,
      sceneId: row.sceneId,
      sceneIndex: row.sceneIndex,
      actionIndex: row.actionIndex,
      consumedDiscussions: row.consumedDiscussions,
      capturedAt: row.capturedAt ?? new Date().toISOString(),
    };

    // 入队 create_session → append_record → [completed? set_status]
    // create 依赖无前置；append 依赖 create；status 依赖最后一条 append
    const createId = await _enqueueInTx({
      kind: 'playback', op: 'create_session', sessionId,
      semanticKey: `create:${sessionId}:${row.runtimeShadowEventId ?? crypto.randomUUID()}`,
      body: { sessionId, kind: 'playback' },
    });

    const appendId = await _enqueueInTx({
      kind: 'playback', op: 'append_record', sessionId,
      semanticKey: semKey,
      body,
    }, createId);

    if (row.completed) {
      await _enqueueInTx({
        kind: 'playback', op: 'set_status', sessionId,
        semanticKey: `status:${sessionId}`,
        body: { status: 'completed' },
      }, appendId);
    }

    // 清除 shadowPending（标记已入队）
    await db.playbackState.update(stageId, { shadowPending: undefined });

    return 'enqueued' as const;
  });
}

/** 辅助：在事务内入队（需调用方已开启事务） */
async function _enqueueInTx(
  params: { kind: 'playback'; op: RuntimeOutboxEntry['op']; sessionId: string; semanticKey: string; body: unknown },
  dependsOnEntryId?: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const nowStr = new Date().toISOString();
  // Playback compaction: supersede old pending entries with same semanticKey (not yet claimed)
  const existing = await db.runtimeOutbox
    .where('semanticKey').equals(params.semanticKey)
    .filter((e) => e.status === 'pending' && !e.leaseOwner && e.id !== id)
    .toArray();
  for (const e of existing) {
    await db.runtimeOutbox.update(e.id, { status: 'superseded' });
  }
  // Get max sequence
  const rows = await db.runtimeOutbox.where('sessionId').equals(params.sessionId).toArray();
  const lastSeq = rows.length > 0 ? Math.max(...rows.map((e) => e.sequence ?? 0)) : 0;
  const entry: RuntimeOutboxEntry = {
    id, kind: params.kind, op: params.op,
    sessionId: params.sessionId,
    semanticKey: params.semanticKey,
    body: params.body,
    createdAt: nowStr, attempts: 0, nextAttemptAt: nowStr,
    status: 'pending', sequence: lastSeq + 1,
    dependsOnEntryId,
  };
  await db.runtimeOutbox.put(entry);
  return id;
}

/**
 * R3.1 迁移：playbackState.shadowPending → outbox
 *
 * 扫描所有带 shadowPending 的 playbackState 行，原子入队 outbox 并清除 shadowPending。
 * 幂等：可以多次调用，已迁移的行不会再入队。
 */
export async function migrateShadowPendingToOutbox(): Promise<{
  migrated: number;
  skipped: number;
}> {
  const allRows = await db.playbackState.toArray();
  let migrated = 0;
  let skipped = 0;

  for (const row of allRows) {
    if (!row.shadowPending) {
      skipped++;
      continue;
    }
    const result = await shadowPlaybackProgressViaOutbox(row.stageId);
    if (result === 'enqueued') migrated++;
    else skipped++;
  }

  return { migrated, skipped };
}

/**
 * 触发后台发送（由调用方定时或事件驱动调用）。
 */
export async function drainPlaybackOutbox(tabId?: string): Promise<void> {
  await scanAndDrain(tabId ?? 'playback-outbox');
}

/** 导出供测试使用 */
export { readPlaybackRow };
