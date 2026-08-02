/**
 * lib/runtime/shadow-writer.ts
 *
 * R2 影子双写（shadow write）：把本地运行时数据（chat / quizAttempt）以
 * fire-and-forget 方式镜像到 RuntimeStore 服务端（R1.1 已上线的
 * /api/runtime/v1/* 路由）。
 * ※ playback 已按 Codex 验收卡（2026-07-30）移出 R2，另立 R2.1/R3 前置卡——
 *   初版只在单次调用内重试复用 eventId，没有刷新/跨标签页恢复重放，不满足
 *   「任何重试/刷新/跨标签页恢复都取回同一个 id」的硬门禁；补恢复实质是
 *   建设 pending/outbox，与 R2 排除 outbox 的边界冲突。
 *
 * 授权边界（2026-07-29 R2 实施卡）：
 *   - 只做影子写；开关 NEXT_PUBLIC_RUNTIME_SHADOW 默认关闭（=== '1' 才启用）；
 *   - 本地读源零改动——开关关闭时本模块所有入口立即返回，零 fetch、零 Dexie/localStorage 写；
 *   - 不接 redeem merge-grant / 匿名写 / outbox / 双读 / 读源切换；
 *   - 影子写失败对业务零影响（不抛出、不阻塞调用方）。
 *
 * 幂等锚点（Codex P0 裁决 + 验收卡修订）：确定性 ID 一律锚定在持久化字段上，
 * 影子写只认持久化读回的数据，绝不使用调用方内存状态——
 *   - quizAttempt：attemptId 与 answers 在 writeSubmittedAnswers 内以单键 envelope
 *     同一次原子写入（lib/quiz/persistence.ts）；影子路径经 readSubmittedEnvelope
 *     读回，写失败/legacy 裸 answers 时读不到即跳过；clearSubmitted 删 envelope
 *     后才允许生成新值；
 *   - chat：折叠游标持久化在 localStorage（rshadow:*），刷新后续传不重复 append。
 *
 * 失败语义：8s AbortController 超时；timeout/network/http_5xx 最多重试 2 次（1s/4s）；
 * validation/auth/http_4xx/idempotency_conflict 不重试。每次请求（含每次重试的终态）
 * 上报一条 runtime_shadow 遥测——分母 = 全部尝试，ok_idempotent 算成功。R2 不设 SLO。
 */

import type { ChatSession } from '@/lib/types/chat';
import { readSubmittedEnvelope } from '@/lib/quiz/persistence';
import type { QuestionResult } from '@/lib/quiz/grading';
import { durationBucket } from '@/lib/document-bridge/diagnostics';

export const RUNTIME_SHADOW_VERSION = 'r2.2';

const TIMEOUT_MS = 8_000;
const RETRY_DELAYS_MS = [1_000, 4_000] as const;
const MAX_CHAT_MESSAGES = 200; // 与 chat-storage.ts MAX_MESSAGES_PER_SESSION 保持一致

const SESSION_CREATED_PREFIX = 'rshadow:created:';
const CHAT_CURSOR_PREFIX = 'rshadow:chat:';

export type RuntimeShadowOutcome =
  | 'ok'
  | 'ok_idempotent'
  | 'idempotency_conflict'
  | 'validation'
  | 'auth'
  | 'timeout'
  | 'http_4xx'
  | 'http_5xx'
  | 'network'
  // R2.1 A2：本地丢弃指标——旧 pending 被新快照覆盖时上报，绝不伪装成一次
  // 服务端请求结果（设计卡 §4.3/§5：分母只含真实请求尝试）
  | 'superseded';

export type RuntimeShadowOp = 'create_session' | 'append_record' | 'set_status';
// R2.1 A2（2026-08-02 授权）：playback 回归影子范围，独立子开关门禁
export type RuntimeShadowKind = 'chat' | 'quizAttempt' | 'playback';

/** 总开关：默认关闭，显式 '1' 才启用；SSR/测试环境无 window 一律关闭。 */
export function isRuntimeShadowEnabled(): boolean {
  return typeof window !== 'undefined' && process.env.NEXT_PUBLIC_RUNTIME_SHADOW === '1';
}

/**
 * playback 子开关（Codex A2 授权边界，2026-08-02）：Preview 总开关已开，
 * 若只复用总开关，A2 代码推送后 playback 影子会未经验收直接生效。
 * 必须总开关 + 子开关同时为真才发送；A2 开发/部署期间子开关保持未设置。
 */
export function isPlaybackShadowEnabled(): boolean {
  return isRuntimeShadowEnabled() && process.env.NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK === '1';
}

// ─── 遥测 ────────────────────────────────────────────────────────────────────

function reportRuntimeShadowDiagnostic(payload: {
  outcome: RuntimeShadowOutcome;
  op: RuntimeShadowOp;
  kind: RuntimeShadowKind;
  durationMs: number;
  /** 本地丢弃指标来源标记（设计卡 §5：source: local_drop），普通请求结果不带 */
  source?: 'local_drop';
}): void {
  if (typeof window === 'undefined') return;
  void fetch('/api/client-diagnostics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'runtime_shadow',
      outcome: payload.outcome,
      durationBucket: durationBucket(payload.durationMs),
      shadowVersion: RUNTIME_SHADOW_VERSION,
      op: payload.op,
      kind: payload.kind,
      ...(payload.source ? { source: payload.source } : {}),
    }),
    keepalive: true,
  }).catch(() => {
    // 可观测性永远不在用户数据路径上。
  });
}

// ─── localStorage 安全包装（与 lib/quiz/persistence.ts 同款语义） ─────────────

function safeGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // quota / disabled storage ——影子写不得影响业务
  }
}

function isSessionMarkedCreated(sessionId: string): boolean {
  return safeGet(SESSION_CREATED_PREFIX + sessionId) === '1';
}

function markSessionCreated(sessionId: string): void {
  safeSet(SESSION_CREATED_PREFIX + sessionId, '1');
}

interface ChatCursor {
  /** 已影子化的消息数（相对当前截断后数组的下标）。 */
  count: number;
  /** 已影子化的会话状态；用于 completed 流转的折叠。 */
  status?: 'active' | 'completed';
}

function readChatCursor(sessionId: string): ChatCursor {
  const raw = safeGet(CHAT_CURSOR_PREFIX + sessionId);
  if (!raw) return { count: 0 };
  try {
    const parsed = JSON.parse(raw) as ChatCursor;
    return { count: typeof parsed.count === 'number' ? parsed.count : 0, status: parsed.status };
  } catch {
    return { count: 0 };
  }
}

function writeChatCursor(sessionId: string, cursor: ChatCursor): void {
  safeSet(CHAT_CURSOR_PREFIX + sessionId, JSON.stringify(cursor));
}

// ─── 请求核心：超时 + 有界重试 + 失败分类 + 遥测 ──────────────────────────────

interface ShadowRequestResult {
  ok: boolean;
  /** HTTP 状态码（有响应时）；调用方用于 404 等特殊处置。 */
  status?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shadowRequest(opts: {
  method: 'POST' | 'PATCH';
  path: string;
  body: unknown;
  op: RuntimeShadowOp;
  kind: RuntimeShadowKind;
  /** create_session 的 409（会话已存在）视为幂等成功。 */
  treat409AsIdempotent?: boolean;
}): Promise<ShadowRequestResult> {
  const started = Date.now();
  let lastOutcome: RuntimeShadowOutcome = 'network';
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(opts.path, {
        method: opts.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts.body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      lastStatus = res.status;
      if (res.ok) {
        reportRuntimeShadowDiagnostic({
          outcome: 'ok',
          op: opts.op,
          kind: opts.kind,
          durationMs: Date.now() - started,
        });
        return { ok: true, status: res.status };
      }
      if (res.status === 409) {
        // create：会话已存在 → 幂等成功；append：同 id 不同内容 → 真异常，响亮计数不重试
        const outcome: RuntimeShadowOutcome = opts.treat409AsIdempotent
          ? 'ok_idempotent'
          : 'idempotency_conflict';
        reportRuntimeShadowDiagnostic({
          outcome,
          op: opts.op,
          kind: opts.kind,
          durationMs: Date.now() - started,
        });
        return { ok: outcome === 'ok_idempotent', status: res.status };
      }
      if (res.status === 400 || res.status === 422) {
        reportRuntimeShadowDiagnostic({
          outcome: 'validation',
          op: opts.op,
          kind: opts.kind,
          durationMs: Date.now() - started,
        });
        return { ok: false, status: res.status };
      }
      if (res.status === 401 || res.status === 403) {
        reportRuntimeShadowDiagnostic({
          outcome: 'auth',
          op: opts.op,
          kind: opts.kind,
          durationMs: Date.now() - started,
        });
        return { ok: false, status: res.status };
      }
      if (res.status >= 500) {
        lastOutcome = 'http_5xx';
        continue;
      }
      // 其余 4xx（404 / 429 等）不重试
      reportRuntimeShadowDiagnostic({
        outcome: 'http_4xx',
        op: opts.op,
        kind: opts.kind,
        durationMs: Date.now() - started,
      });
      return { ok: false, status: res.status };
    } catch {
      clearTimeout(timer);
      lastOutcome = controller.signal.aborted ? 'timeout' : 'network';
    }
  }

  reportRuntimeShadowDiagnostic({
    outcome: lastOutcome,
    op: opts.op,
    kind: opts.kind,
    durationMs: Date.now() - started,
  });
  return { ok: false, status: lastStatus };
}

// ─── RuntimeStore v1 三个端点的薄封装 ─────────────────────────────────────────

async function ensureSession(
  sessionId: string,
  kind: RuntimeShadowKind,
  stageId: string,
  status: 'active' | 'completed',
  createdAt: string,
  updatedAt: string,
): Promise<boolean> {
  if (isSessionMarkedCreated(sessionId)) return true;
  const r = await shadowRequest({
    method: 'POST',
    path: '/api/runtime/v1/sessions',
    body: { id: sessionId, kind, stageId, status, createdAt, updatedAt },
    op: 'create_session',
    kind,
    treat409AsIdempotent: true,
  });
  if (r.ok) markSessionCreated(sessionId);
  return r.ok;
}

async function appendRecord(
  sessionId: string,
  record: {
    id: string;
    createdAt: string;
    payload: unknown;
    sceneId?: string;
    actionIndex?: number;
  },
  kind: RuntimeShadowKind,
): Promise<ShadowRequestResult> {
  return shadowRequest({
    method: 'POST',
    path: `/api/runtime/v1/sessions/${encodeURIComponent(sessionId)}/records`,
    body: record,
    op: 'append_record',
    kind,
  });
}

async function setSessionStatusShadow(
  sessionId: string,
  status: 'completed' | 'archived',
  updatedAt: string,
  kind: RuntimeShadowKind,
): Promise<ShadowRequestResult> {
  return shadowRequest({
    method: 'PATCH',
    path: `/api/runtime/v1/sessions/${encodeURIComponent(sessionId)}/status`,
    body: { status, updatedAt },
    op: 'set_status',
    kind,
  });
}

// ─── chat ────────────────────────────────────────────────────────────────────

/** Dexie SessionStatus（idle/active/interrupted/completed/error）→ runtime 枚举。 */
function mapChatStatus(status: string): 'active' | 'completed' {
  return status === 'completed' ? 'completed' : 'active';
}

/** UIMessage（ai SDK v5）的文本：从 parts 里拼 text 段。 */
function messageText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(
      (p): p is { type: 'text'; text: string } =>
        typeof p === 'object' &&
        p !== null &&
        (p as { type?: unknown }).type === 'text' &&
        typeof (p as { text?: unknown }).text === 'string',
    )
    .map((p) => p.text)
    .join('');
}

async function shadowOneChatSession(stageId: string, session: ChatSession): Promise<void> {
  // 与 chat-storage.ts 同款的截断语义，保证游标下标对齐
  const messages = session.messages.slice(-MAX_CHAT_MESSAGES);
  const cursor = readChatCursor(session.id);
  const targetStatus = mapChatStatus(session.status);

  if (!isSessionMarkedCreated(session.id)) {
    const created = await ensureSession(
      session.id,
      'chat',
      stageId,
      targetStatus,
      new Date(session.createdAt).toISOString(),
      new Date(session.updatedAt).toISOString(),
    );
    if (!created) return; // 游标不动，下次保存重试
    cursor.status = targetStatus;
    writeChatCursor(session.id, cursor);
  }

  // 截断会让数组起点前移；游标若越过当前长度说明发生过截断，归零重放。
  // 重放安全：record id = <sessionId>:<message.id> 且内容（role/content/createdAt）
  // 确定，服务端幂等返回已有行（201），不会产生重复记录。
  if (cursor.count > messages.length) cursor.count = 0;

  for (let i = cursor.count; i < messages.length; i++) {
    const msg = messages[i];
    const r = await appendRecord(
      session.id,
      {
        id: `${session.id}:${msg.id}`,
        // metadata.createdAt 缺失时回退会话创建时间——确定性优先于精确性，
        // 否则同一 record id 的重放会因 createdAt 漂移被判 IDEMPOTENCY_CONFLICT。
        createdAt: new Date(msg.metadata?.createdAt ?? session.createdAt).toISOString(),
        payload: { role: msg.role, content: messageText(msg.parts) },
        ...(session.sceneId ? { sceneId: session.sceneId } : {}),
      },
      'chat',
    );
    if (!r.ok) {
      // 会话在服务端缺失（404）：清 created 标记，下次保存重建会话
      writeChatCursor(session.id, cursor);
      return;
    }
    cursor.count = i + 1;
    writeChatCursor(session.id, cursor);
  }

  // 会话完成状态的跟随流转（折叠：每个会话只 PATCH 一次）
  if (targetStatus === 'completed' && cursor.status !== 'completed') {
    const r = await setSessionStatusShadow(
      session.id,
      'completed',
      new Date(session.updatedAt).toISOString(),
      'chat',
    );
    if (r.ok) {
      cursor.status = 'completed';
      writeChatCursor(session.id, cursor);
    }
  }
}

/**
 * chat 影子写挂点：saveChatSessions 覆写成功后调用。
 * 整 stage 覆写语义 → 影子端按会话折叠游标，只 append 增量。
 * 空 sessions（删除路径）影子期不动（设计稿 §5.1）。
 */
export async function shadowChatSessions(stageId: string, sessions: ChatSession[]): Promise<void> {
  if (!isRuntimeShadowEnabled() || !sessions || sessions.length === 0) return;
  for (const session of sessions) {
    try {
      await shadowOneChatSession(stageId, session);
    } catch {
      // fire-and-forget：任何意外都不得影响 chat 本地保存
    }
  }
}

// ─── quizAttempt ─────────────────────────────────────────────────────────────

function quizSessionId(stageId: string, sceneId: string, attemptId: string): string {
  return `qa:${stageId}:${sceneId}:${attemptId}`;
}

/**
 * 提交影子写（quiz-view handleSubmit 挂点，writeSubmittedAnswers 之后调用）。
 * 一个答题周期 = 一个会话；提交即 completed。
 *
 * Codex 验收卡（2026-07-30）：attemptId 与 answers 只从持久化的提交 envelope
 * 读回（lib/quiz/persistence.ts 单键原子写），禁止使用调用方内存数据——
 * 写失败/legacy 裸 answers 时读不到 envelope，直接跳过，不产生错误周期。
 */
export async function shadowQuizSubmitted(
  stageId: string | null | undefined,
  sceneId: string,
): Promise<void> {
  if (!isRuntimeShadowEnabled() || !stageId) return;
  try {
    const envelope = readSubmittedEnvelope(sceneId);
    if (!envelope) return;
    const sessionId = quizSessionId(stageId, sceneId, envelope.attemptId);
    const now = new Date().toISOString();
    const created = await ensureSession(sessionId, 'quizAttempt', stageId, 'active', now, now);
    if (!created) return;
    const r = await appendRecord(
      sessionId,
      {
        id: `${sessionId}:submit`,
        createdAt: now,
        sceneId,
        payload: { phase: 'submitted', answers: envelope.answers },
      },
      'quizAttempt',
    );
    if (!r.ok) return;
    await setSessionStatusShadow(sessionId, 'completed', new Date().toISOString(), 'quizAttempt');
  } catch {
    // fire-and-forget
  }
}

/**
 * 批改完成影子写（quiz-view grading effect 挂点，writeSubmittedResults 之后）。
 * phase 枚举使用 DSL QuizAttemptPhase 的 'reviewed'（设计稿中的 'reviewing'
 * 是本地 SubmittedState 词表，不是 DSL 枚举值——实施时校正，Codex 已认可）。
 */
export async function shadowQuizReviewed(
  stageId: string | null | undefined,
  sceneId: string,
  results: QuestionResult[],
): Promise<void> {
  if (!isRuntimeShadowEnabled() || !stageId) return;
  try {
    const envelope = readSubmittedEnvelope(sceneId);
    if (!envelope) return;
    const sessionId = quizSessionId(stageId, sceneId, envelope.attemptId);
    const now = new Date().toISOString();
    // submit 影子写可能已丢失（fire-and-forget）：此处兜底重建会话，
    // 409 幂等成功路径保证已存在时零副作用。
    const created = await ensureSession(sessionId, 'quizAttempt', stageId, 'completed', now, now);
    if (!created) return;
    await appendRecord(
      sessionId,
      {
        id: `${sessionId}:grade`,
        createdAt: now,
        sceneId,
        payload: { phase: 'reviewed', answers: envelope.answers, results },
      },
      'quizAttempt',
    );
  } catch {
    // fire-and-forget
  }
}

/**
 * 重答影子写（quiz-view handleRetry 挂点）——必须在 clearSubmitted 之前调用，
 * 否则 envelope 已被清除，无法定位要归档的会话。
 * 从未影子化过的周期（本地答题但开关中途才开）直接跳过。
 */
export async function shadowQuizRetry(
  stageId: string | null | undefined,
  sceneId: string,
): Promise<void> {
  if (!isRuntimeShadowEnabled() || !stageId) return;
  try {
    const attemptId = readSubmittedEnvelope(sceneId)?.attemptId;
    if (!attemptId) return;
    const sessionId = quizSessionId(stageId, sceneId, attemptId);
    if (!isSessionMarkedCreated(sessionId)) return;
    await setSessionStatusShadow(
      sessionId,
      'archived',
      new Date().toISOString(),
      'quizAttempt',
    );
  } catch {
    // fire-and-forget
  }
}

// ─── playback（R2.1 A2）───────────────────────────────────────────────────────

/**
 * playback 影子写（设计卡 v1.3 §4.2-4.5）。
 *
 * 幂等锚点：只从 Dexie playbackState 行读回 eventId/pending/快照——
 * 禁止使用调用方内存数据（与 quizAttempt envelope 同款纪律）。
 * 每次业务落盘生成新 UUID 并与快照同一次 put（persistence buildRow），
 * 重试/刷新/跨标签页恢复都取回同一个 id，直到被新快照覆盖。
 *
 * A1 遗留行升级（§3.4-3）：A1 期间的 completed/普通行没有 eventId——
 * 首次影子时生成 eventId+pending 补写回库再发送。
 *
 * 会话模型：pb:<stageId> 单会话；record id = pb:<stageId>:<eventId>；
 * 「最新」由 capturedAt 判定（payload 携带），绝不按 append 到达顺序。
 */
export async function shadowPlaybackProgress(stageId: string): Promise<void> {
  if (!isPlaybackShadowEnabled() || !stageId) return;
  try {
    const { db } = await import('@/lib/utils/database');
    const { clearPlaybackPending } = await import('@/lib/utils/playback-persistence');

    const fetched = await db.playbackState.get(stageId);
    if (!fetched) return;

    // capturedAt 类型可选（legacy 行可能缺失）：回退 updatedAt，保证确定性
    const baseCapturedAt = fetched.capturedAt ?? new Date(fetched.updatedAt).toISOString();

    // A1 遗留行升级：无 eventId 的行补写 eventId+pending。
    // Codex A2 复审卡（2026-08-02）：升级必须是事务内 CAS——get legacy →
    // 生成 UUID → put 旧副本 之间存在跨标签页竞态，另一标签页的新快照会被
    // 旧副本整体覆盖回旧状态。事务内重新读取：仅当当前行仍无 eventId/pending
    // 时才升级；已被新快照替换则直接使用新行，禁止写回旧副本。
    let row = fetched;
    if (!row.runtimeShadowEventId || !row.shadowPending) {
      const newEventId = crypto.randomUUID();
      const pending = { eventId: newEventId, capturedAt: baseCapturedAt };
      const resolved = await db.transaction('rw', db.playbackState, async () => {
        const cur = await db.playbackState.get(stageId);
        if (!cur) return null; // 行已被删除：放弃本次影子
        if (cur.runtimeShadowEventId && cur.shadowPending) return cur; // 新快照已替换
        const upgraded = {
          ...cur,
          runtimeShadowEventId: cur.runtimeShadowEventId ?? newEventId,
          shadowPending: cur.shadowPending ?? pending,
          capturedAt: cur.capturedAt ?? baseCapturedAt,
        };
        await db.playbackState.put(upgraded);
        return upgraded;
      });
      if (!resolved) return;
      row = resolved;
    }

    const eventId = row.runtimeShadowEventId as string;
    const capturedAt = row.shadowPending?.capturedAt ?? baseCapturedAt;
    const sessionId = `pb:${stageId}`;
    const created = await ensureSession(
      sessionId,
      'playback',
      stageId,
      row.completed ? 'completed' : 'active',
      capturedAt,
      capturedAt,
    );
    if (!created) return;

    const r = await appendRecord(
      sessionId,
      {
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
      },
      'playback',
    );
    if (!r.ok) return;

    if (row.completed) {
      // Codex A2 复审卡（2026-08-02）：PATCH 失败必须保留 completed pending——
      // 否则 append 成功但状态流转失败时行被删除，会话状态永远无法补偿。
      // 仅 PATCH 成功/幂等成功后才允许条件删除。
      const s = await setSessionStatusShadow(sessionId, 'completed', capturedAt, 'playback');
      if (!s.ok) return;
    }
    // 条件清除：旧请求晚成功不得误删已被新快照覆盖的新 pending；
    // completed 行影子成功后物理删除（§3.4）
    await clearPlaybackPending(stageId, eventId);
  } catch {
    // fire-and-forget：任何意外都不得影响 playback 本地保存
  }
}

/**
 * superseded 本地丢弃指标（设计卡 §4.3）：新快照覆盖尚未发送的旧 pending 时
 * 由 persistence onSuperseded 回调上报。不是服务端请求结果，op/kind 仅为
 * 归属标记；durationBucket 恒 lt_1s。
 */
export function reportPlaybackSuperseded(): void {
  if (!isPlaybackShadowEnabled()) return;
  reportRuntimeShadowDiagnostic({
    outcome: 'superseded',
    op: 'append_record',
    kind: 'playback',
    durationMs: 0,
    // 设计卡 §5 + Codex A2 复审卡：本地丢弃指标必须显式标记 source，
    // 避免后续统计把它当普通请求结果
    source: 'local_drop',
  });
}
