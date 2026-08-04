/**
 * lib/runtime/dual-read.ts
 *
 * R3.2: dual-read compare infrastructure.
 *
 * Business logic ALWAYS uses local data.
 * Server data is fetched async, compared, and reported via telemetry.
 * Never impacts UI. 5s timeout, no retry, degrade to local on failure.
 */

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface DualReadResult {
  kind: 'playback' | 'quizAttempt';
  sessionId: string;
  match: boolean;
  local: unknown;
  server: unknown | null;
  serverError?: string;
  latencyMs: number;
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * Playback dual-read: compare local playbackState with server latest record.
 */
export async function dualReadPlayback(
  stageId: string,
  localState: { sceneId?: string; sceneIndex?: number; actionIndex: number; consumedDiscussions?: string[]; completed?: boolean },
): Promise<DualReadResult> {
  const sessionId = `pb:${stageId}`;
  const start = Date.now();
  let server: unknown = null;
  let serverError: string | undefined;

  try {
    const resp = await fetch(
      `/api/runtime/v1/sessions/${encodeURIComponent(sessionId)}/records/latest`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (resp.ok) {
      server = await resp.json().catch(() => null);
    } else if (resp.status === 404) {
      // No session yet — shadow write hasn't landed
      server = null;
    } else {
      serverError = `HTTP ${resp.status}`;
    }
  } catch (err: unknown) {
    serverError = err instanceof Error ? err.message : String(err);
  }

  const match = comparePlayback(localState, server);
  return { kind: 'playback', sessionId, match, local: localState, server, serverError, latencyMs: Date.now() - start };
}

/**
 * QuizAttempt dual-read: compare local envelope with server records.
 */
export async function dualReadQuizAttempt(
  stageId: string,
  sceneId: string,
  attemptId: string,
  local: { submitted?: { answers: unknown }; reviewed?: { answers: unknown; results: unknown } },
): Promise<DualReadResult> {
  const sessionId = `qa:${stageId}:${sceneId}:${attemptId}`;
  const start = Date.now();
  let server: unknown = null;
  let serverError: string | undefined;

  try {
    const resp = await fetch(
      `/api/runtime/v1/sessions/${encodeURIComponent(sessionId)}/records`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (resp.ok) {
      server = await resp.json().catch(() => null);
    } else if (resp.status === 404) {
      server = null;
    } else {
      serverError = `HTTP ${resp.status}`;
    }
  } catch (err: unknown) {
    serverError = err instanceof Error ? err.message : String(err);
  }

  const match = compareQuizAttempt(local, server);
  return { kind: 'quizAttempt', sessionId, match, local, server, serverError, latencyMs: Date.now() - start };
}

/**
 * Report dual-read telemetry.
 */
export function reportDualReadResult(result: DualReadResult): void {
  if (typeof window === 'undefined') return;
  void fetch('/api/client-diagnostics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'runtime_dual_read',
      kind: result.kind,
      sessionId: result.sessionId,
      match: result.match,
      serverError: result.serverError,
      latencyMs: result.latencyMs,
    }),
    keepalive: true,
  }).catch(() => { /* noop */ });
}

// ─── 比对逻辑 ────────────────────────────────────────────────────────────────

function comparePlayback(
  local: { sceneId?: string; sceneIndex?: number; actionIndex: number; consumedDiscussions?: string[]; completed?: boolean },
  server: unknown,
): boolean {
  if (!server || typeof server !== 'object') return false;
  const s = server as Record<string, unknown>;
  // Compare the latest record's payload
  const payload = (s.payload ?? s) as Record<string, unknown> | undefined;
  if (!payload) return false;
  return (
    payload.actionIndex === local.actionIndex &&
    (payload.sceneId === local.sceneId || local.sceneId === undefined) &&
    JSON.stringify(payload.consumedDiscussions ?? []) === JSON.stringify(local.consumedDiscussions ?? [])
  );
}

function compareQuizAttempt(
  local: { submitted?: { answers: unknown }; reviewed?: { answers: unknown; results: unknown } },
  server: unknown,
): boolean {
  if (!server || !Array.isArray(server)) return false;
  const records = server as Array<Record<string, unknown>>;
  const submitRecord = records.find((r) => {
    const p = r.payload as Record<string, unknown> | undefined;
    return p?.phase === 'submitted';
  });
  const gradeRecord = records.find((r) => {
    const p = r.payload as Record<string, unknown> | undefined;
    return p?.phase === 'reviewed';
  });

  const submitMatch = local.submitted
    ? !!(submitRecord && JSON.stringify((submitRecord.payload as Record<string, unknown>)?.answers) === JSON.stringify(local.submitted.answers))
    : true;
  const gradeMatch = local.reviewed
    ? !!(gradeRecord &&
      JSON.stringify((gradeRecord.payload as Record<string, unknown>)?.answers) === JSON.stringify(local.reviewed.answers) &&
      JSON.stringify((gradeRecord.payload as Record<string, unknown>)?.results) === JSON.stringify(local.reviewed.results))
    : true;
  return submitMatch && gradeMatch;
}
