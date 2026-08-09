/**
 * scripts/runtime-observation-lib.ts
 *
 * 生产 shadow 观察汇总——纯函数模块（不含 CLI 入口，可安全导入测试）。
 *
 * 支持格式：人工导出的脱敏 Vercel Logs JSONL（runtime API + diagnostics 路径）。
 * 不连接 Vercel、不连接生产数据库。
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';

// ═══════════════════════════════════════════════════════════════════════════════

/** 只过滤 Runtime API 和 diagnostics 路径，排除静态资源等。 */
const RUNTIME_PATH_RE = /\/api\/runtime\/v1\//;
const DIAGNOSTICS_PATH_RE = /\/api\/client-diagnostics/;

interface VercelLogLine {
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  responseBody?: unknown;
  requestBody?: unknown;
}

export interface SummaryReport {
  period: { from: string; to: string };
  runtimeRequests: number;
  diagnosticsRequests: number;
  /** op × kind × statusCode → count */
  opKindStatus: Record<string, Record<string, Record<number, number>>>;
  errorCode409: Record<string, number>;
  telemetryOutcomes: Record<string, number>;

  /** 日志中无法可靠统计的指标——受限于纯客户端日志的观测边界 */
  notObservable: string[];

  /** 可疑重复：同 recordId 出现多次，且请求体内容可能不同（payload 漂移风险） */
  duplicateRecordIds: Array<{
    recordId: string;
    events: Array<{ sessionId: string; timestamp: string }>;
    distinctPayloadHashes: number;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════════

function parseLogLine(raw: string): VercelLogLine | null {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.path !== 'string') return null;
    return {
      timestamp: obj.timestamp ?? '',
      method: obj.method ?? 'POST',
      path: obj.path,
      statusCode: typeof obj.statusCode === 'number' ? obj.statusCode : 0,
      responseBody: obj.responseBody,
      requestBody: obj.requestBody,
    };
  } catch {
    return null;
  }
}

/** 判断路径是否属于 Runtime API 或 diagnostics 域。 */
function isRuntimePath(path: string): boolean {
  return RUNTIME_PATH_RE.test(path) || DIAGNOSTICS_PATH_RE.test(path);
}

function extractOp(path: string): string {
  if (path.includes('/records')) return 'append_record';
  if (path.includes('/status')) return 'set_status';
  if (path.includes('/sessions') && !path.includes('/records') && !path.includes('/status')) return 'create_session';
  return 'unknown';
}

/** 从路径提取 sessionId */
function extractSessionId(path: string): string {
  const m = path.match(/\/sessions\/([^/?]+)/);
  return m ? decodeURIComponent(m[1]) : 'unknown';
}

/** 从请求体/路径推断 runtime kind。缺证据时返回 'unknown'，禁止默认猜 Playback。 */
function extractKind(body: unknown, sessionId: string): string {
  if (typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    if (typeof b.kind === 'string') return b.kind;
    if (typeof b.attemptId === 'string') return 'quizAttempt';
  }
  // 从 sessionId 前缀推断：
  // pb:<stageId> or pb:<stageId>:<visitId> → playback
  // qa:<attemptId> → quizAttempt
  if (sessionId.startsWith('pb:')) return 'playback';
  if (sessionId.startsWith('qa:')) return 'quizAttempt';
  // Chat session IDs are UUIDs; Vercel logs don't always carry requestBody.
  // Chat sessions have IDs that look like UUID patterns (long hex). But we
  // cannot reliably distinguish Chat from other UUID-pattern session IDs
  // without kind field in body. Return unknown.
  return 'unknown';
}

/** Canonical JSON hash — sort keys, stable across property ordering. */
function canonicalJSON(obj: unknown): string {
  if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJSON).join(',')}]`;
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  return `{${sorted.map((k) => `${JSON.stringify(k)}:${canonicalJSON((obj as Record<string, unknown>)[k])}`).join(',')}}`;
}

function payloadHash(obj: unknown): number {
  return simpleHash(canonicalJSON(obj));
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

// ═══════════════════════════════════════════════════════════════════════════════

export async function summarizeLogs(filePath: string): Promise<SummaryReport> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const report: SummaryReport = {
    period: { from: '', to: '' },
    runtimeRequests: 0,
    diagnosticsRequests: 0,
    opKindStatus: {},
    errorCode409: {},
    telemetryOutcomes: {},
    notObservable: [
      'retries (attempts count) — only client-side outbox has this; server logs do not',
      'dead/superseded counts — client-only; not observable from Vercel logs until diagnostics contract',
    ],
    duplicateRecordIds: [],
  };

  // recordId → { payloadHashes: Set<number>, events: [...] }
  const recordIdMap = new Map<string, { hashes: Set<number>; events: Array<{ sessionId: string; timestamp: string }> }>();

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    const entry = parseLogLine(line);
    if (!entry || !isRuntimePath(entry.path)) continue;

    // Period
    if (!report.period.from || entry.timestamp < report.period.from) {
      report.period.from = entry.timestamp;
    }
    if (!report.period.to || entry.timestamp > report.period.to) {
      report.period.to = entry.timestamp;
    }

    const isDiag = DIAGNOSTICS_PATH_RE.test(entry.path);
    if (isDiag) {
      report.diagnosticsRequests++;
      const body = (entry.requestBody ?? entry.responseBody) as Record<string, unknown> | undefined;
      const outcome = typeof body?.outcome === 'string' ? body.outcome : 'unknown';
      report.telemetryOutcomes[outcome] = (report.telemetryOutcomes[outcome] || 0) + 1;
      continue;
    }

    // Runtime API
    report.runtimeRequests++;
    const op = extractOp(entry.path);
    const sessionId = extractSessionId(entry.path);
    const kind = extractKind(entry.requestBody, sessionId);
    const sc = entry.statusCode;

    // op × kind × statusCode
    if (!report.opKindStatus[op]) report.opKindStatus[op] = {};
    if (!report.opKindStatus[op][kind]) report.opKindStatus[op][kind] = {};
    report.opKindStatus[op][kind][sc] = (report.opKindStatus[op][kind][sc] || 0) + 1;

    // 409 errorCode
    if (sc === 409) {
      const body = entry.responseBody as Record<string, unknown> | undefined;
      const ec = typeof body?.errorCode === 'string' ? body.errorCode : 'unknown';
      report.errorCode409[ec] = (report.errorCode409[ec] || 0) + 1;
    }

    // Duplicate recordId with payload drift detection
    if (op === 'append_record') {
      const body = entry.requestBody as Record<string, unknown> | undefined;
      const recordId = typeof body?.id === 'string' ? body.id : undefined;
      if (recordId) {
        if (!recordIdMap.has(recordId)) {
          recordIdMap.set(recordId, { hashes: new Set(), events: [] });
        }
        const rec = recordIdMap.get(recordId)!;
        const hash = payloadHash(body);
        rec.hashes.add(hash);
        rec.events.push({ sessionId: extractSessionId(entry.path), timestamp: entry.timestamp });
      }
    }
  }

  // Dedup: find records with > 1 event or > 1 distinct payload hash
  for (const [recordId, rec] of recordIdMap) {
    if (rec.events.length > 1 || rec.hashes.size > 1) {
      report.duplicateRecordIds.push({
        recordId,
        events: rec.events.slice(0, 10), // cap for sanity
        distinctPayloadHashes: rec.hashes.size,
      });
    }
  }

  return report;
}

// ═══════════════════════════════════════════════════════════════════════════════

export function formatReport(report: SummaryReport): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('  RuntimeStore 生产 Shadow 观察汇总');
  lines.push(`  周期: ${report.period.from || 'N/A'} ~ ${report.period.to || 'N/A'}`);
  lines.push(`  Runtime 请求: ${report.runtimeRequests}  Diagnostics: ${report.diagnosticsRequests}`);
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  // op × kind × statusCode
  lines.push('## op × kind × statusCode');
  for (const op of Object.keys(report.opKindStatus).sort()) {
    const kindMap = report.opKindStatus[op];
    for (const kind of Object.keys(kindMap).sort()) {
      const scMap = kindMap[kind];
      for (const sc of Object.keys(scMap).sort((a, b) => Number(a) - Number(b))) {
        const count = scMap[Number(sc)];
        lines.push(`  ${op.padEnd(16)} ${kind.padEnd(12)} ${sc.toString().padStart(3)}: ${count}`);
      }
    }
  }
  lines.push('');

  // 409 errorCode
  const total409 = Object.values(report.errorCode409).reduce((a, b) => a + b, 0);
  lines.push(`## 409 errorCode（共 ${total409}）`);
  for (const [ec, count] of Object.entries(report.errorCode409).sort((a, b) => b[1] - a[1])) {
    const pct = total409 > 0 ? ((count / total409) * 100).toFixed(1) : '0.0';
    lines.push(`  ${ec}: ${count} (${pct}%)`);
  }
  lines.push('');

  // Telemetry
  lines.push('## Diagnostics outcome');
  for (const [outcome, count] of Object.entries(report.telemetryOutcomes).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${outcome}: ${count}`);
  }
  lines.push('');

  // Not observable
  lines.push('## 不可观测指标（纯客户端日志边界）');
  for (const item of report.notObservable) {
    lines.push(`  ⚠ ${item}`);
  }
  lines.push('');

  // Duplicate recordId
  if (report.duplicateRecordIds.length > 0) {
    lines.push('## 可疑重复 recordId（含 payload 漂移风险）');
    for (const dup of report.duplicateRecordIds) {
      const sessions = [...new Set(dup.events.map((e) => e.sessionId))];
      const drift = dup.distinctPayloadHashes > 1 ? ' ⚠ PAYLOAD 漂移' : '';
      lines.push(`  ${dup.recordId} ×${dup.events.length} sessions=[${sessions.join(', ')}] distinctPayloads=${dup.distinctPayloadHashes}${drift}`);
    }
  } else {
    lines.push('## 可疑重复 recordId: 无');
  }

  return lines.join('\n');
}
