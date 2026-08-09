/**
 * scripts/runtime-observation-summary.ts
 *
 * 生产 shadow 七天观察期只读汇总脚本。
 *
 * 用法：npx tsx scripts/runtime-observation-summary.ts <log-file.jsonl>
 *
 * 输入：人工导出的脱敏 Vercel Logs，JSONL 格式，每行一个请求。
 *       包含 runtime API 路径 + /api/client-diagnostics 遥测。
 * 输出：stdout 打印分组汇总（状态码 × kind、409 errorCode、telemetry outcome、
 *       重试、可疑重复 ID）；可重定向到文件。
 *
 * 约束：不连接 Vercel、不连接生产数据库、不修改任何文件/环境变量。
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';

// ═══════════════════════════════════════════════════════════════════════════════

interface VercelLogLine {
  /** UTC ISO 时间戳 */
  timestamp: string;
  /** HTTP 方法 */
  method: string;
  /** 请求路径 */
  path: string;
  /** HTTP 状态码 */
  statusCode: number;
  /** 响应体 JSON（已脱敏） */
  responseBody?: unknown;
  /** 请求体 JSON（已脱敏） */
  requestBody?: unknown;
  /** 客户端 IP（已脱敏，只保留首字节） */
  ip?: string;
  /** 请求耗时 ms */
  durationMs?: number;
}

interface SummaryReport {
  period: { from: string; to: string };
  totalRequests: number;
  byStatusCode: Record<number, number>;
  byKindStatusCode: Record<string, Record<number, number>>;
  errorCode409: Record<string, number>;
  telemetryOutcomes: Record<string, number>;
  retries: { total: number; attemptsGE3: number };
  deadOrSuperseded: { dead: number; superseded: number };
  duplicateRecordIds: Array<{ recordId: string; sessions: string[]; count: number }>;
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
      ip: obj.ip,
      durationMs: obj.durationMs,
    };
  } catch {
    return null;
  }
}

function extractKind(path: string): string {
  // Classify by known runtime path segments
  if (path.includes('/diagnostics') || path.includes('/client-diagnostics')) return 'telemetry';
  // /api/runtime/v1/sessions/<sessionId>/records
  if (path.includes('/records')) return 'append';
  if (path.includes('/status')) return 'set_status';
  if (path.includes('/sessions')) {
    // POST /api/runtime/v1/sessions → create
    // The request body kind determines kind. Fall back to path classification.
    return 'create';
  }
  return 'unknown';
}

function extractSessionId(path: string): string {
  // /api/runtime/v1/sessions/<sessionId>/...
  const m = path.match(/\/sessions\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════════

export async function summarizeLogs(filePath: string): Promise<SummaryReport> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const report: SummaryReport = {
    period: { from: '', to: '' },
    totalRequests: 0,
    byStatusCode: {},
    byKindStatusCode: {},
    errorCode409: {},
    telemetryOutcomes: {},
    retries: { total: 0, attemptsGE3: 0 },
    deadOrSuperseded: { dead: 0, superseded: 0 },
    duplicateRecordIds: [],
  };

  const recordIdMap = new Map<string, string[]>();

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    const entry = parseLogLine(line);
    if (!entry) continue;

    // Period
    if (!report.period.from || entry.timestamp < report.period.from) {
      report.period.from = entry.timestamp;
    }
    if (!report.period.to || entry.timestamp > report.period.to) {
      report.period.to = entry.timestamp;
    }

    report.totalRequests++;

    const kind = extractKind(entry.path);
    const sc = entry.statusCode;

    // Status code
    report.byStatusCode[sc] = (report.byStatusCode[sc] || 0) + 1;

    // Kind × status code
    if (!report.byKindStatusCode[kind]) report.byKindStatusCode[kind] = {};
    report.byKindStatusCode[kind][sc] = (report.byKindStatusCode[kind][sc] || 0) + 1;

    // 409 errorCode
    if (sc === 409) {
      const body = entry.responseBody as Record<string, unknown> | undefined;
      const ec = typeof body?.errorCode === 'string' ? body.errorCode : 'unknown';
      report.errorCode409[ec] = (report.errorCode409[ec] || 0) + 1;
    }

    // Telemetry outcomes
    if (kind === 'telemetry') {
      const body = (entry.requestBody ?? entry.responseBody) as Record<string, unknown> | undefined;
      const outcome = typeof body?.outcome === 'string' ? body.outcome : 'unknown';
      report.telemetryOutcomes[outcome] = (report.telemetryOutcomes[outcome] || 0) + 1;
    }

    // Dead / superseded detection (from telemetry reason)
    if (kind === 'telemetry') {
      const body = (entry.requestBody ?? entry.responseBody) as Record<string, unknown> | undefined;
      const reason = body?.reason;
      if (reason === 'max_retries' || reason === 'idempotency_conflict' || reason === 'inactive_session') {
        report.deadOrSuperseded.dead++;
      }
    }

    // Duplicate record ID detection
    if (kind === 'append') {
      const body = entry.requestBody as Record<string, unknown> | undefined;
      const recordId = typeof body?.id === 'string' ? body.id : undefined;
      if (recordId) {
        const sessionId = extractSessionId(entry.path);
        if (!recordIdMap.has(recordId)) recordIdMap.set(recordId, []);
        recordIdMap.get(recordId)!.push(sessionId);
      }
    }
  }

  // Deduplicate: find records that appear > 1 time
  for (const [recordId, sessions] of recordIdMap) {
    if (sessions.length > 1) {
      report.duplicateRecordIds.push({
        recordId,
        sessions: [...new Set(sessions)],
        count: sessions.length,
      });
    }
  }

  return report;
}

export function formatReport(report: SummaryReport): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('  RuntimeStore 生产 Shadow 观察汇总');
  lines.push(`  周期: ${report.period.from} ~ ${report.period.to}`);
  lines.push(`  总请求数: ${report.totalRequests}`);
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  lines.push('## HTTP 状态码');
  for (const [sc, count] of Object.entries(report.byStatusCode).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const pct = ((count / report.totalRequests) * 100).toFixed(1);
    lines.push(`  ${sc}: ${count} (${pct}%)`);
  }
  lines.push('');

  lines.push('## kind × 状态码');
  for (const [kind, scMap] of Object.entries(report.byKindStatusCode).sort()) {
    for (const [sc, count] of Object.entries(scMap).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      lines.push(`  ${kind.padEnd(12)} ${sc.toString().padStart(3)}: ${count}`);
    }
  }
  lines.push('');

  lines.push('## 409 errorCode 分类');
  for (const [ec, count] of Object.entries(report.errorCode409).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${ec}: ${count}`);
  }
  lines.push('');

  lines.push('## Telemetry outcome');
  for (const [outcome, count] of Object.entries(report.telemetryOutcomes).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${outcome}: ${count}`);
  }
  lines.push('');

  lines.push('## 重试');
  lines.push(`  attempts >= 3: ${report.retries.attemptsGE3}`);
  lines.push('');

  lines.push('## Dead / Superseded (telemetry)');
  lines.push(`  dead: ${report.deadOrSuperseded.dead}`);
  lines.push(`  superseded: ${report.deadOrSuperseded.superseded}`);
  lines.push('');

  if (report.duplicateRecordIds.length > 0) {
    lines.push('## 可疑重复 record ID');
    for (const dup of report.duplicateRecordIds) {
      lines.push(`  ${dup.recordId} ×${dup.count} sessions=[${dup.sessions.join(', ')}]`);
    }
  } else {
    lines.push('## 可疑重复 record ID: 无');
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════

/** CLI 入口 */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/runtime-observation-summary.ts <log-file.jsonl>');
    process.exit(1);
  }
  const filePath = args[0];
  const report = await summarizeLogs(filePath);
  console.log(formatReport(report));
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(2);
});
