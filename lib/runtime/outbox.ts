/**
 * lib/runtime/outbox.ts
 *
 * R3.0 RuntimeStore 通用 outbox 基础设施
 *
 * 持久化的"待发送到服务端的操作"列表，跨标签页安全。
 * 所有操作通过 Dexie rw 事务保证原子性。
 *
 * 设计依据：docs/reports/2026-08-02-runtimestore-r3-read-cutover-design.md 第三章
 */

import { db } from '@/lib/utils/database';
import type { RuntimeOutboxEntry, SucceededEntry } from '@/lib/utils/database';

// ─── 类型导出 ────────────────────────────────────────────────────────────────

export type OutboxPhase = 'local-only' | 'shadow' | 'dual-read-compare' | 'server-preferred' | 'server-primary';
export type OutboxOp = 'create_session' | 'append_record' | 'set_status';
export type OutboxKind = 'playback' | 'quizAttempt' | 'chat';
export type OutboxStatus = 'pending' | 'sending' | 'superseded' | 'dead';

/** 内部哨兵：事务内做了死信级联，无实际 claimed 条目需发送 */
const DEAD_CASCADE_SENTINEL = Symbol('deadCascade');

// ─── 常量 ────────────────────────────────────────────────────────────────────

const BACKOFF_SCHEDULE: Record<number, number> = {
  1: 5_000,
  2: 15_000,
  3: 45_000,
  4: 5 * 60_000,
  5: 15 * 60_000,
  6: 30 * 60_000,
};
const DEAD_AFTER_ATTEMPTS = 7;
const LEASE_DURATION_MS = 30_000;
const HTTP_TIMEOUT_MS = 8_000;
const CLEANUP_RETENTION_DAYS = 7;
const DRAIN_LOOP_DELAY_MS = 100;

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}
function now(): string {
  return new Date().toISOString();
}
function nowMs(): number {
  return Date.now();
}
function daysAgo(days: number): string {
  return new Date(nowMs() - days * 24 * 60 * 60 * 1000).toISOString();
}
function freezeBody(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body));
}

// ─── 遥测 ────────────────────────────────────────────────────────────────────

function reportTelemetry(event: string, payload: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  void fetch('/api/client-diagnostics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ...payload }),
    keepalive: true,
  }).catch(() => { /* noop */ });
}

/**
 * 按 op 分派请求 URL / method。
 */
function buildRequest(entry: RuntimeOutboxEntry): { url: string; method: string } {
  const sid = encodeURIComponent(entry.sessionId);
  switch (entry.op) {
    case 'create_session':
      return { url: '/api/runtime/v1/sessions', method: 'POST' };
    case 'append_record':
      return { url: `/api/runtime/v1/sessions/${sid}/records`, method: 'POST' };
    case 'set_status':
      return { url: `/api/runtime/v1/sessions/${sid}/status`, method: 'PATCH' };
  }
}

// ─── 内部辅助（需在 Dexie rw 事务内调用） ──────────────────────────────────

async function cascadeMarkDeadInTx(entryId: string): Promise<number> {
  let cascaded = 0;
  const queue = [entryId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    await db.runtimeOutbox.update(id, { status: 'dead', leaseOwner: undefined, leaseUntil: undefined });
    cascaded++;
    const deps = await db.runtimeOutbox.where('dependsOnEntryId').equals(id).toArray();
    for (const dep of deps) queue.push(dep.id);
  }
  return cascaded;
}

// ─── 公开 API ────────────────────────────────────────────────────────────────

export async function enqueue(params: {
  kind: OutboxKind;
  op: OutboxOp;
  sessionId: string;
  recordId?: string;
  semanticKey: string;
  body: unknown;
  dependsOnEntryId?: string;
}): Promise<string> {
  const id = uuid();
  const nowStr = now();
  const frozenBody = freezeBody(params.body);

  await db.transaction('rw', db.runtimeOutbox, async () => {
    const entries = await db.runtimeOutbox.where('sessionId').equals(params.sessionId).toArray();
    const lastSeq = entries.length > 0 ? Math.max(...entries.map((e) => e.sequence ?? 0)) : 0;
    const sequence = lastSeq + 1;

    if (params.kind === 'playback') {
      const existing = await db.runtimeOutbox
        .where('semanticKey').equals(params.semanticKey)
        .filter((e) => e.status === 'pending' && !e.leaseOwner && e.id !== id)
        .toArray();
      for (const e of existing) await db.runtimeOutbox.update(e.id, { status: 'superseded' });
      if (existing.length > 0) reportTelemetry('outbox_compaction', { superseded: existing.length, semanticKey: params.semanticKey });
    }

    const entry: RuntimeOutboxEntry = {
      id, kind: params.kind, op: params.op,
      sessionId: params.sessionId, recordId: params.recordId,
      semanticKey: params.semanticKey, body: frozenBody,
      createdAt: nowStr, attempts: 0, nextAttemptAt: nowStr,
      status: 'pending', sequence,
      dependsOnEntryId: params.dependsOnEntryId,
    };
    await db.runtimeOutbox.put(entry);
  });

  return id;
}

export async function scanAndDrain(tabId: string): Promise<void> {
  let hadWork = true;
  while (hadWork) {
    hadWork = await dequeueOne(tabId);
    if (hadWork) await new Promise<void>((r) => setTimeout(r, DRAIN_LOOP_DELAY_MS));
  }
}

type ClaimResult = { claimed: RuntimeOutboxEntry } | { sentinel: typeof DEAD_CASCADE_SENTINEL } | null;

export async function dequeueOne(tabId: string): Promise<boolean> {
  let result: ClaimResult = null;

  try {
    result = await db.transaction('rw', db.runtimeOutbox, db.succeededEntries, async (): Promise<ClaimResult> => {
      const nowStr = now();
      const candidates = await db.runtimeOutbox.where('status').equals('pending')
        .filter((e) => e.nextAttemptAt <= nowStr).sortBy('createdAt');
      if (candidates.length === 0) return null;

      const byKey = new Map<string, RuntimeOutboxEntry>();
      for (const e of candidates) {
        const exist = byKey.get(e.semanticKey);
        if (!exist || e.createdAt > exist.createdAt) byKey.set(e.semanticKey, e);
      }
      const deduped = [...byKey.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      for (const entry of deduped) {
        if (entry.dependsOnEntryId) {
          const dep = await db.runtimeOutbox.get(entry.dependsOnEntryId);
          if (dep) {
            if (dep.status === 'dead') {
              await cascadeMarkDeadInTx(entry.id);
              reportTelemetry('outbox_dependency_dead', { rootEntryId: entry.id });
              return { sentinel: DEAD_CASCADE_SENTINEL };
            }
            continue;
          }
          const succ = await db.succeededEntries.get(entry.dependsOnEntryId);
          if (!succ) {
            await cascadeMarkDeadInTx(entry.id);
            reportTelemetry('outbox_dependency_lost', { entryId: entry.id, dependsOnEntryId: entry.dependsOnEntryId });
            return { sentinel: DEAD_CASCADE_SENTINEL };
          }
        }

        if (entry.leaseOwner && entry.leaseUntil && entry.leaseUntil >= nowStr) continue;

        const leaseUntil = new Date(nowMs() + LEASE_DURATION_MS).toISOString();
        await db.runtimeOutbox.update(entry.id, { leaseOwner: tabId, leaseUntil, status: 'sending' });
        return { claimed: { ...entry, leaseOwner: tabId, leaseUntil, status: 'sending' } };
      }
      return null;
    });
  } catch {
    return false;
  }

  if (!result) return false;
  if ('sentinel' in result) return true;

  const { claimed } = result;

  // Phase 2: 发送 HTTP（按 op 分派）
  try {
    const { url, method } = buildRequest(claimed);
    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(claimed.body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    // Phase 3: 事务内 CAS 确认 + 响应处理
    if (resp.status === 201 || resp.status === 200) {
      await db.transaction('rw', db.runtimeOutbox, db.succeededEntries, async () => {
        const fresh = await db.runtimeOutbox.get(claimed.id);
        if (!fresh || fresh.status !== 'sending' || fresh.leaseOwner !== claimed.leaseOwner) return;
        await db.runtimeOutbox.delete(claimed.id);
        await db.succeededEntries.put({ entryId: claimed.id, deletedAt: now() } satisfies SucceededEntry);
      });
      return true;
    }

    if (resp.status === 404) {
      await handle404(claimed.id, claimed.leaseOwner ?? '');
      return true;
    }

    if (resp.status === 409) {
      await db.transaction('rw', db.runtimeOutbox, async () => {
        const fresh = await db.runtimeOutbox.get(claimed.id);
        if (!fresh || fresh.status !== 'sending' || fresh.leaseOwner !== claimed.leaseOwner) return;
        await cascadeMarkDeadInTx(claimed.id);
      });
      reportTelemetry('outbox_dead', { entryId: claimed.id, reason: 'idempotency_conflict' });
      return true;
    }

    throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    const nextAttempts = (claimed.attempts || 0) + 1;
    await db.transaction('rw', db.runtimeOutbox, async () => {
      const fresh = await db.runtimeOutbox.get(claimed.id);
      if (!fresh || fresh.status !== 'sending' || fresh.leaseOwner !== claimed.leaseOwner) return;

      if (nextAttempts >= DEAD_AFTER_ATTEMPTS) {
        await db.runtimeOutbox.update(claimed.id, { attempts: nextAttempts, lastError: String(err), lastAttemptAt: now() });
        const cascaded = await cascadeMarkDeadInTx(claimed.id);
        reportTelemetry('outbox_dead', { entryId: claimed.id, reason: 'max_retries', attempts: nextAttempts, cascadedCount: cascaded - 1 });
      } else {
        const backoffMs = BACKOFF_SCHEDULE[nextAttempts] ?? 0;
        const nextAttemptAt = new Date(nowMs() + backoffMs).toISOString();
        await db.runtimeOutbox.update(claimed.id, {
          status: 'pending', leaseOwner: undefined, leaseUntil: undefined,
          attempts: nextAttempts, nextAttemptAt, lastError: String(err), lastAttemptAt: now(),
        });
      }
    });
    return true;
  }
}

/**
 * handle404 — 404 恢复。必须 leaseOwner 匹配才执行，防止过期响应误操作。
 */
async function handle404(entryId: string, leaseOwner: string): Promise<void> {
  await db.transaction('rw', db.runtimeOutbox, async () => {
    const entry = await db.runtimeOutbox.get(entryId);
    if (!entry || entry.status !== 'sending' || entry.leaseOwner !== leaseOwner) return;

    const newCreateId = uuid();
    const nowStr = now();
    const createEntry: RuntimeOutboxEntry = {
      id: newCreateId, kind: entry.kind, op: 'create_session',
      sessionId: entry.sessionId, semanticKey: `create:${entry.sessionId}:${newCreateId}`,
      body: { sessionId: entry.sessionId }, createdAt: nowStr,
      attempts: 0, nextAttemptAt: nowStr, status: 'pending', sequence: 0,
    };
    await db.runtimeOutbox.put(createEntry);

    await db.runtimeOutbox.update(entryId, {
      status: 'pending', dependsOnEntryId: newCreateId,
      leaseOwner: undefined, leaseUntil: undefined,
    });

    reportTelemetry('outbox_404_recovery', { entryId, sessionId: entry.sessionId, newCreateId });
  });
}

export async function markDead(entryId: string): Promise<number> {
  return db.transaction('rw', db.runtimeOutbox, async () => cascadeMarkDeadInTx(entryId));
}

export async function cleanupExpiredLeases(_tabId: string): Promise<number> {
  return db.transaction('rw', db.runtimeOutbox, async () => {
    const nowStr = now();
    const expired = await db.runtimeOutbox.where('status').equals('sending')
      .filter((e) => !!e.leaseUntil && e.leaseUntil < nowStr).toArray();
    for (const e of expired) {
      await db.runtimeOutbox.update(e.id, { status: 'pending', leaseOwner: undefined, leaseUntil: undefined });
    }
    if (expired.length > 0) reportTelemetry('outbox_lease_reclaimed', { count: expired.length });
    return expired.length;
  });
}

export async function cleanupDeadEntries(): Promise<number> {
  return db.transaction('rw', db.runtimeOutbox, db.succeededEntries, async () => {
    const cutoff = daysAgo(CLEANUP_RETENTION_DAYS);
    const deadEntries = await db.runtimeOutbox.where('status').equals('dead')
      .filter((e) => e.createdAt < cutoff).toArray();
    let deleted = 0;
    for (const e of deadEntries) {
      const deps = await db.runtimeOutbox.where('dependsOnEntryId').equals(e.id)
        .filter((d) => d.status === 'pending' || d.status === 'sending').toArray();
      if (deps.length > 0) continue;
      await db.runtimeOutbox.delete(e.id);
      deleted++;
    }
    if (deleted > 0) reportTelemetry('outbox_dead_cleanup', { deleted });
    return deleted;
  });
}

export async function cleanupSucceededEntries(): Promise<number> {
  return db.transaction('rw', db.runtimeOutbox, db.succeededEntries, async () => {
    const cutoff = daysAgo(CLEANUP_RETENTION_DAYS);
    const stale = await db.succeededEntries.filter((s) => s.deletedAt < cutoff).toArray();
    let deleted = 0;
    for (const s of stale) {
      const deps = await db.runtimeOutbox.where('dependsOnEntryId').equals(s.entryId)
        .filter((d) => d.status === 'pending' || d.status === 'sending').toArray();
      if (deps.length > 0) continue;
      await db.succeededEntries.delete(s.entryId);
      deleted++;
    }
    if (deleted > 0) reportTelemetry('outbox_succeeded_cleanup', { deleted });
    return deleted;
  });
}

export async function getLastSequence(sessionId: string): Promise<number> {
  const entries = await db.runtimeOutbox.where('sessionId').equals(sessionId).toArray();
  if (entries.length === 0) return 0;
  return Math.max(...entries.map((e) => e.sequence ?? 0));
}

export async function getOutboxStats(): Promise<{
  pending: number; sending: number; dead: number; superseded: number; succeededEntries: number;
}> {
  const [pending, sending, dead, superseded, succeededEntries] = await Promise.all([
    db.runtimeOutbox.where('status').equals('pending').count(),
    db.runtimeOutbox.where('status').equals('sending').count(),
    db.runtimeOutbox.where('status').equals('dead').count(),
    db.runtimeOutbox.where('status').equals('superseded').count(),
    db.succeededEntries.count(),
  ]);
  return { pending, sending, dead, superseded, succeededEntries };
}

export { buildRequest };
