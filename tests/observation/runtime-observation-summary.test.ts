/**
 * scripts/__tests__/runtime-observation-summary.test.ts
 *
 * 汇总脚本单元测试：JSONL 解析、分类、统计、重复检测。
 * 使用临时文件，不连接任何外部服务。
 */

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { summarizeLogs, formatReport } from '../../scripts/runtime-observation-summary';

function writeTempFile(lines: string[]): string {
  const filePath = path.join(os.tmpdir(), `obs-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jsonl`);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

afterEach(() => {
  // Cleanup handled by unique filenames + system tmp reuse
});

describe('summarizeLogs', () => {
  it('parses valid JSONL lines and skips blanks/comments', async () => {
    const filePath = writeTempFile([
      '', // blank
      JSON.stringify({ timestamp: '2026-08-09T01:00:00Z', method: 'POST', path: '/api/runtime/v1/sessions/s1/records', statusCode: 201, responseBody: {}, requestBody: { id: 's1:r1' } }),
      '// comment-like garbage',
      JSON.stringify({ timestamp: '2026-08-09T01:01:00Z', method: 'POST', path: '/api/client-diagnostics', statusCode: 200, requestBody: { outcome: 'ok', op: 'append_record', kind: 'playback' } }),
    ]);
    const report = await summarizeLogs(filePath);
    expect(report.totalRequests).toBe(2);
    fs.unlinkSync(filePath);
  });

  it('counts status codes correctly', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ timestamp: '2026-08-09T01:00:00Z', path: '/api/runtime/v1/sessions/a/records', statusCode: 201 }),
      JSON.stringify({ timestamp: '2026-08-09T01:01:00Z', path: '/api/runtime/v1/sessions/a/records', statusCode: 409, responseBody: { errorCode: 'IDEMPOTENCY_CONFLICT' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:02:00Z', path: '/api/runtime/v1/sessions/b/records', statusCode: 409, responseBody: { errorCode: 'IDEMPOTENCY_CONFLICT' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:03:00Z', path: '/api/runtime/v1/sessions/b/records', statusCode: 200 }),
    ]);
    const report = await summarizeLogs(filePath);
    expect(report.byStatusCode[201]).toBe(1);
    expect(report.byStatusCode[200]).toBe(1);
    expect(report.byStatusCode[409]).toBe(2);
    expect(report.errorCode409['IDEMPOTENCY_CONFLICT']).toBe(2);
    fs.unlinkSync(filePath);
  });

  it('classifies 409 by errorCode: INACTIVE_SESSION vs IDEMPOTENCY_CONFLICT', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ timestamp: '2026-08-09T01:00:00Z', path: '/api/runtime/v1/sessions/s1/records', statusCode: 409, responseBody: { errorCode: 'INACTIVE_SESSION', error: '...' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:01:00Z', path: '/api/runtime/v1/sessions/s2/records', statusCode: 409, responseBody: { errorCode: 'IDEMPOTENCY_CONFLICT', error: '...' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:02:00Z', path: '/api/runtime/v1/sessions/s3/records', statusCode: 409, responseBody: {} }), // empty → 'unknown'
    ]);
    const report = await summarizeLogs(filePath);
    expect(report.errorCode409['INACTIVE_SESSION']).toBe(1);
    expect(report.errorCode409['IDEMPOTENCY_CONFLICT']).toBe(1);
    expect(report.errorCode409['unknown']).toBe(1);
    fs.unlinkSync(filePath);
  });

  it('counts telemetry outcomes', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ timestamp: '2026-08-09T01:00:00Z', path: '/api/client-diagnostics', statusCode: 200, requestBody: { outcome: 'ok', op: 'create_session', kind: 'playback' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:01:00Z', path: '/api/client-diagnostics', statusCode: 200, requestBody: { outcome: 'idempotency_conflict', op: 'append_record', kind: 'chat' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:02:00Z', path: '/api/client-diagnostics', statusCode: 200, requestBody: { outcome: 'idempotency_conflict', op: 'append_record', kind: 'chat' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:03:00Z', path: '/api/client-diagnostics', statusCode: 200, requestBody: { outcome: 'ok', op: 'set_status', kind: 'playback' } }),
    ]);
    const report = await summarizeLogs(filePath);
    expect(report.telemetryOutcomes['ok']).toBe(2);
    expect(report.telemetryOutcomes['idempotency_conflict']).toBe(2);
    fs.unlinkSync(filePath);
  });

  it('detects dead reason in telemetry', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ timestamp: '2026-08-09T01:00:00Z', path: '/api/client-diagnostics', statusCode: 200, requestBody: { outcome: 'idempotency_conflict', reason: 'inactive_session' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:01:00Z', path: '/api/client-diagnostics', statusCode: 200, requestBody: { outcome: 'idempotency_conflict', reason: 'max_retries' } }),
    ]);
    const report = await summarizeLogs(filePath);
    expect(report.deadOrSuperseded.dead).toBe(2);
    fs.unlinkSync(filePath);
  });

  it('detects duplicate record IDs across sessions', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ timestamp: '2026-08-09T01:00:00Z', path: '/api/runtime/v1/sessions/s1/records', statusCode: 201, requestBody: { id: 's1:dup-id' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:01:00Z', path: '/api/runtime/v1/sessions/s2/records', statusCode: 201, requestBody: { id: 's1:dup-id' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:02:00Z', path: '/api/runtime/v1/sessions/s1/records', statusCode: 200, requestBody: { id: 's1:unique' } }),
    ]);
    const report = await summarizeLogs(filePath);
    expect(report.duplicateRecordIds.length).toBe(1);
    const dup = report.duplicateRecordIds[0];
    expect(dup.recordId).toBe('s1:dup-id');
    expect(dup.count).toBe(2);
    expect(dup.sessions.length).toBe(2);
    fs.unlinkSync(filePath);
  });

  it('handles empty file', async () => {
    const filePath = writeTempFile([]);
    const report = await summarizeLogs(filePath);
    expect(report.totalRequests).toBe(0);
    fs.unlinkSync(filePath);
  });

  it('throws for missing file', async () => {
    await expect(summarizeLogs('/nonexistent/path.jsonl')).rejects.toThrow('File not found');
  });

  it('formatReport produces non-empty string', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ timestamp: '2026-08-09T01:00:00Z', path: '/api/runtime/v1/sessions/s/records', statusCode: 201 }),
    ]);
    const report = await summarizeLogs(filePath);
    const output = formatReport(report);
    expect(output).toContain('RuntimeStore');
    expect(output).toContain('201');
    fs.unlinkSync(filePath);
  });
});
