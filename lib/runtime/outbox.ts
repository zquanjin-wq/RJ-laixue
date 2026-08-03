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

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 退避表：attempts → 等待毫秒数 */
const BACKOFF_SCHEDULE: Record<number, number> = {
  1: 5_000,
  2: 15_000,
  3: 45_000,
  4: 5 * 60_000,
  5: 15 * 60_000,
  6: 30 * 60_000,
};

/** 超过此次数标记 dead */
const DEAD_AFTER_ATTEMPTS = 7;

/** 租约时长（毫秒） */
const LEASE_DURATION_MS = 30_000;

/** HTTP 请求超时 */
const HTTP_TIMEOUT_MS = 8_000;

/** 死信 / 成功凭据保留天数 */
const CLEANUP_RETENTION_DAYS = 7;

/** 出队循环间延迟（毫秒） */
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

/** 深拷贝 body，确保入队后内容冻结 */
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
  }).catch(() => {
    // 可观测性永远不在用户数据路径上
  });
}

// ─── 内部辅助（需在 Dexie rw 事务内调用） ──────────────────────────────────

/**
 * 在事务内递归标记 dead 并级联所有依赖者。
 * 调用方必须已经处于包含 db.runtimeOutbox 的 rw 事务中。
 *
 * @returns 级联总数（含自身）
 */
async function cascadeMarkDeadInTx(entryId: string): Promise<number> {
  let cascaded = 0;
  const queue = [entryId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    await db.runtimeOutbox.update(id, {
      status: 'dead',
      leaseOwner: null,
      leaseUntil: null,
    });
    cascaded++;
    const deps = await db.runtimeOutbox
      .where('dependsOnEntryId')
      .equals(id)
      .toArray();
    for (const dep of deps) {
      queue.push(dep.id);
    }
  }
  return cascaded;
}

// ─── 公开 API ────────────────────────────────────────────────────────────────

/**
 * 2.1 enqueue — 入队一条 outbox 条目
 *
 * 自动分配 sequence（per-session 自增）。
 * 对于 playback 类型同 semanticKey 的旧 pending（未 claim），标记为 superseded。
 * 内容在入队时冻结（深拷贝），入队后不可修改。
 *
 * @returns 新条目的 UUID
 */
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
    // 获取当前 session 的最大 sequence
    const entries = await db.runtimeOutbox
      .where('sessionId')
      .equals(params.sessionId)
      .toArray();
    const lastSeq =
      entries.length > 0
        ? Math.max(...entries.map((e) => e.sequence ?? 0))
        : 0;
    const sequence = lastSeq + 1;

    // 压缩：playback 类型，同 semanticKey 的旧 pending（未 claim）→ superseded
    if (params.kind === 'playback') {
      const existing = await db.runtimeOutbox
        .where('semanticKey')
        .equals(params.semanticKey)
        .filter(
          (e) =>
            e.status === 'pending' &&
            !e.leaseOwner &&
            e.id !== id,
        )
        .toArray();

      for (const e of existing) {
        await db.runtimeOutbox.update(e.id, { status: 'superseded' });
      }

      if (existing.length > 0) {
        reportTelemetry('outbox_compaction', {
          superseded: existing.length,
          semanticKey: params.semanticKey,
        });
      }
    }

    // 写入新条目
    await db.runtimeOutbox.put({
      id,
      kind: params.kind,
      op: params.op,
      sessionId: params.sessionId,
      recordId: params.recordId,
      semanticKey: params.semanticKey,
      body: frozenBody,
      createdAt: nowStr,
      attempts: 0,
      nextAttemptAt: nowStr,
      status: 'pending',
      sequence,
      dependsOnEntryId: params.dependsOnEntryId,
    } satisfies RuntimeOutboxEntry);
  });

  return id;
}

/**
 * 2.2 scanAndDrain — 后台扫描出队循环
 *
 * 循环调用 dequeueOne 直到无可发送条目。
 * 每次循环间加入小延迟防止热循环。
 */
export async function scanAndDrain(tabId: string): Promise<void> {
  let hadWork = true;
  while (hadWork) {
    hadWork = await dequeueOne(tabId);
    if (hadWork) {
      await new Promise<void>((r) => setTimeout(r, DRAIN_LOOP_DELAY_MS));
    }
  }
}

/**
 * 2.3 dequeueOne — 逐条即时 claim + 发送
 *
 * 每次只 claim 一条，发送前即时 claim，lease 仅在发送期间占用。
 *
 * @returns true 表示有条目被处理，false 表示无可用条目
 */
export async function dequeueOne(tabId: string): Promise<boolean> {
  let claimed: RuntimeOutboxEntry | null = null;

  // Phase 1: 在事务内筛选、去重、依赖检查、claim
  try {
    claimed = await db.transaction(
      'rw',
      db.runtimeOutbox,
      db.succeededEntries,
      async (): Promise<RuntimeOutboxEntry | null> => {
        const nowStr = now();

        // 筛选可发送条目：status='pending' AND nextAttemptAt <= now
        const candidates = await db.runtimeOutbox
          .where('status')
          .equals('pending')
          .filter((e) => e.nextAttemptAt <= nowStr)
          .sortBy('createdAt');

        if (candidates.length === 0) return null;

        // 按 semanticKey 去重：同 key 只保留 createdAt 最新的一条
        const byKey = new Map<string, RuntimeOutboxEntry>();
        for (const e of candidates) {
          const existing = byKey.get(e.semanticKey);
          if (!existing || e.createdAt > existing.createdAt) {
            byKey.set(e.semanticKey, e);
          }
        }

        // 按 createdAt ASC 排序
        const deduped = [...byKey.values()].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );

        // 遍历去重后的候选
        for (const entry of deduped) {
          // 依赖检查
          if (entry.dependsOnEntryId) {
            const dep = await db.runtimeOutbox.get(entry.dependsOnEntryId);
            if (dep) {
              if (dep.status === 'dead') {
                // 前置已 dead → 级联标记本条 dead（递归）
                const cascadedCount =
                  (await cascadeMarkDeadInTx(entry.id)) - 1;
                reportTelemetry('outbox_dependency_dead', {
                  rootEntryId: entry.id,
                  cascadedCount,
                });
                return { __deadCascaded: true } as unknown as RuntimeOutboxEntry;
              }
              // 前置存在但非 dead（pending/sending/superseded）→ 跳过
              continue;
            }
            // 前置不在 outbox 中 → 查询 succeededEntries
            const succ = await db.succeededEntries.get(
              entry.dependsOnEntryId,
            );
            if (!succ) {
              // 前置不明消失 → 标记 dead
              await cascadeMarkDeadInTx(entry.id);
              reportTelemetry('outbox_dependency_lost', {
                entryId: entry.id,
                dependsOnEntryId: entry.dependsOnEntryId,
              });
              return { __deadCascaded: true } as unknown as RuntimeOutboxEntry;
            }
            // 前置在 succeededEntries 中 → 依赖满足，继续
          }

          // 检查 lease：仅 leaseOwner 为 null 或 lease 已过期才可 claim
          if (
            entry.leaseOwner &&
            entry.leaseUntil &&
            entry.leaseUntil >= nowStr
          ) {
            // lease 仍有效 → 其他标签页持有，跳过
            continue;
          }

          // Claim：写入 leaseOwner、leaseUntil、status='sending'
          const leaseUntil = new Date(
            nowMs() + LEASE_DURATION_MS,
          ).toISOString();
          await db.runtimeOutbox.update(entry.id, {
            leaseOwner: tabId,
            leaseUntil,
            status: 'sending',
          });

          // 返回 claimed 条目（含更新后的字段）
          return {
            ...entry,
            leaseOwner: tabId,
            leaseUntil,
            status: 'sending',
          };
        }

        return null;
      },
    );
  } catch (_err) {
    // 事务异常（例如 DB 已关闭），安全返回 false
    return false;
  }

  if (!claimed) return false;

  // Sentinel: dead cascade was performed (dependency_lost) → work was done
  if ((claimed as Record<string, unknown>).__deadCascaded) return true;

  // Phase 2: 发送 HTTP（在事务外）
  try {
    const resp = await fetch(
      `/api/runtime/v1/sessions/${claimed.sessionId}/records`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(claimed.body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      },
    );

    // Phase 3: 处理响应（在事务内）
    if (resp.status === 201 || resp.status === 200) {
      // 成功：同一事务删除 outbox + 写入 succeededEntries
      await db.transaction(
        'rw',
        db.runtimeOutbox,
        db.succeededEntries,
        async () => {
          await db.runtimeOutbox.delete(claimed!.id);
          await db.succeededEntries.put({
            entryId: claimed!.id,
            deletedAt: now(),
          } satisfies SucceededEntry);
        },
      );
      return true;
    }

    if (resp.status === 404) {
      // 404：session missing → handle404 恢复
      await handle404(claimed.id);
      return true;
    }

    if (resp.status === 409) {
      // 409：idempotency conflict → 标记 dead，不重试
      await db.transaction('rw', db.runtimeOutbox, async () => {
        await db.runtimeOutbox.update(claimed!.id, {
          status: 'dead',
          leaseOwner: null,
          leaseUntil: null,
        });
      });
      reportTelemetry('outbox_dead', {
        entryId: claimed.id,
        reason: 'idempotency_conflict',
      });
      return true;
    }

    // 其他 HTTP 错误 → 按失败重试
    throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    // 网络错误 / 超时 / 非预期 HTTP 状态码
    const nextAttempts = (claimed.attempts || 0) + 1;

    await db.transaction('rw', db.runtimeOutbox, async () => {
      if (nextAttempts >= DEAD_AFTER_ATTEMPTS) {
        // 先更新尝试信息，再递归级联标记 dead
        await db.runtimeOutbox.update(claimed!.id, {
          attempts: nextAttempts,
          lastError: String(err),
          lastAttemptAt: now(),
        });
        const cascaded = await cascadeMarkDeadInTx(claimed!.id);
        reportTelemetry('outbox_dead', {
          entryId: claimed!.id,
          reason: 'max_retries',
          attempts: nextAttempts,
          cascadedCount: cascaded - 1,
        });
      } else {
        // 退避重试
        const backoffMs = BACKOFF_SCHEDULE[nextAttempts] ?? 0;
        const nextAttemptAt = new Date(
          nowMs() + backoffMs,
        ).toISOString();
        await db.runtimeOutbox.update(claimed!.id, {
          status: 'pending',
          leaseOwner: null,
          leaseUntil: null,
          attempts: nextAttempts,
          nextAttemptAt,
          lastError: String(err),
          lastAttemptAt: now(),
        });
      }
    });
    return true;
  }
}

/**
 * 2.4 handle404 — 404 恢复
 *
 * 同一事务内：
 * 1. 读取被 404 的条目（必须 status='sending'）
 * 2. 新建 create_session 条目（新 UUID，kind/op=create_session）
 * 3. 将原条目回退 pending + dependsOnEntryId 指向新 create 的 UUID
 */
async function handle404(entryId: string): Promise<void> {
  await db.transaction('rw', db.runtimeOutbox, async () => {
    const entry = await db.runtimeOutbox.get(entryId);
    if (!entry || entry.status !== 'sending') return;

    const newCreateId = uuid();
    const nowStr = now();

    // 新建 create_session 条目
    await db.runtimeOutbox.put({
      id: newCreateId,
      kind: entry.kind,
      op: 'create_session' as const,
      sessionId: entry.sessionId,
      semanticKey: `create:${entry.sessionId}:${newCreateId}`,
      body: { sessionId: entry.sessionId },
      createdAt: nowStr,
      attempts: 0,
      nextAttemptAt: nowStr,
      status: 'pending',
      sequence: 0,
    } satisfies RuntimeOutboxEntry);

    // 原条目回退 pending + dependsOnEntryId 指向新 create
    await db.runtimeOutbox.update(entryId, {
      status: 'pending',
      dependsOnEntryId: newCreateId,
      leaseOwner: null,
      leaseUntil: null,
      // attempts 不变
    });

    reportTelemetry('outbox_404_recovery', {
      entryId,
      sessionId: entry.sessionId,
      newCreateId,
    });
  });
}

/**
 * 2.5 markDead — 递归死信级联
 *
 * 标记指定条目为 dead，并递归标记所有依赖该条目的条目。
 * 返回级联总数（含自身）。
 */
export async function markDead(entryId: string): Promise<number> {
  return db.transaction('rw', db.runtimeOutbox, async () => {
    return cascadeMarkDeadInTx(entryId);
  });
}

/**
 * 2.6 cleanupExpiredLeases — 刷新/启动恢复
 *
 * 扫描 status='sending' 且 leaseUntil < now() 的条目，
 * 释放 lease 回退为 pending。
 * 不得无条件回退所有 sending——只回收已过期 lease。
 *
 * @returns 回收的条目数量
 */
export async function cleanupExpiredLeases(tabId: string): Promise<number> {
  return db.transaction('rw', db.runtimeOutbox, async () => {
    const nowStr = now();
    const expired = await db.runtimeOutbox
      .where('status')
      .equals('sending')
      .filter(
        (e) => !!e.leaseUntil && e.leaseUntil < nowStr,
      )
      .toArray();

    for (const e of expired) {
      await db.runtimeOutbox.update(e.id, {
        status: 'pending',
        leaseOwner: null,
        leaseUntil: null,
      });
    }

    if (expired.length > 0) {
      reportTelemetry('outbox_lease_reclaimed', {
        count: expired.length,
        tabId,
      });
    }

    return expired.length;
  });
}

/**
 * 2.7 cleanupDeadEntries — 死信清理
 *
 * 删除 status='dead' 且 createdAt > 7 天的条目。
 * 清理前确认不存在 pending/sending 条目的 dependsOnEntryId 指向该条目。
 *
 * @returns 删除的条目数量
 */
export async function cleanupDeadEntries(): Promise<number> {
  return db.transaction('rw', db.runtimeOutbox, db.succeededEntries, async () => {
    const cutoff = daysAgo(CLEANUP_RETENTION_DAYS);
    const deadEntries = await db.runtimeOutbox
      .where('status')
      .equals('dead')
      .filter((e) => e.createdAt < cutoff)
      .toArray();

    let deleted = 0;
    for (const e of deadEntries) {
      // 确认无 pending/sending 依赖者
      const dependents = await db.runtimeOutbox
        .where('dependsOnEntryId')
        .equals(e.id)
        .filter(
          (d) =>
            d.status === 'pending' || d.status === 'sending',
        )
        .toArray();

      if (dependents.length > 0) {
        // 仍有非终态依赖者 → 跳过，保留死信供排查
        continue;
      }

      await db.runtimeOutbox.delete(e.id);
      deleted++;
    }

    if (deleted > 0) {
      reportTelemetry('outbox_dead_cleanup', { deleted });
    }

    return deleted;
  });
}

/**
 * 2.8 cleanupSucceededEntries — 凭据条件清理
 *
 * 删除 succeededEntries 中 deletedAt > 7 天的凭据。
 * 关键：仅当不存在任何非终态 outbox 条目的 dependsOnEntryId
 * 指向该 entryId 时才允许删除。
 *
 * @returns 删除的凭据数量
 */
export async function cleanupSucceededEntries(): Promise<number> {
  return db.transaction('rw', db.runtimeOutbox, db.succeededEntries, async () => {
    const cutoff = daysAgo(CLEANUP_RETENTION_DAYS);
    const stale = await db.succeededEntries
      .filter((s) => s.deletedAt < cutoff)
      .toArray();

    let deleted = 0;
    for (const s of stale) {
      // 检查是否有非终态 outbox 条目依赖此凭据
      const dependents = await db.runtimeOutbox
        .where('dependsOnEntryId')
        .equals(s.entryId)
        .filter(
          (d) =>
            d.status === 'pending' || d.status === 'sending',
        )
        .toArray();

      if (dependents.length > 0) {
        // 有非终态依赖者 → 保留凭据
        continue;
      }

      await db.succeededEntries.delete(s.entryId);
      deleted++;
    }

    if (deleted > 0) {
      reportTelemetry('outbox_succeeded_cleanup', { deleted });
    }

    return deleted;
  });
}

/**
 * 2.9 getLastSequence — per-session 序号
 *
 * 返回指定 sessionId 的当前最大 sequence。
 * 若无任何条目则返回 0。
 */
export async function getLastSequence(sessionId: string): Promise<number> {
  const entries = await db.runtimeOutbox
    .where('sessionId')
    .equals(sessionId)
    .toArray();
  if (entries.length === 0) return 0;
  return Math.max(...entries.map((e) => e.sequence ?? 0));
}

/**
 * 2.10 getOutboxStats — 诊断统计
 *
 * 返回各状态条目数量和 succeededEntries 数量。
 */
export async function getOutboxStats(): Promise<{
  pending: number;
  sending: number;
  dead: number;
  superseded: number;
  succeededEntries: number;
}> {
  const [pending, sending, dead, superseded, succeededEntries] =
    await Promise.all([
      db.runtimeOutbox.where('status').equals('pending').count(),
      db.runtimeOutbox.where('status').equals('sending').count(),
      db.runtimeOutbox.where('status').equals('dead').count(),
      db.runtimeOutbox.where('status').equals('superseded').count(),
      db.succeededEntries.count(),
    ]);
  return { pending, sending, dead, superseded, succeededEntries };
}
