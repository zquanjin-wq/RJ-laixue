/**
 * tests/observation/runtime-observation-summary.test.ts
 *
 * 汇总脚本纯函数单元测试——导入 lib 模块，不触发 CLI。
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { summarizeLogs, formatReport } from '../../scripts/runtime-observation-lib';

function writeTempFile(lines: string[]): string {
  const filePath = path.join(os.tmpdir(), `obs-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jsonl`);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

describe('summarizeLogs', () => {
  it('parses valid JSONL lines and filters non-Runtime paths', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ timestamp: '2026-08-09T01:00:00Z', method: 'POST', path: '/api/runtime/v1/sessions/s1/records', statusCode: 201, requestBody: { id: 's1:r1', kind: 'playback' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:00:30Z', path: '/_next/static/chunk.js', statusCode: 200 }),
      JSON.stringify({ timestamp: '2026-08-09T01:01:00Z', path: '/api/client-diagnostics', statusCode: 200, requestBody: { outcome: 'ok', op: 'append_record', kind: 'playback' } }),
    ]);
    const report = await summarizeLogs(filePath);
    expect(report.runtimeRequests).toBe(1);
    expect(report.diagnosticsRequests).toBe(1);
    fs.unlinkSync(filePath);
  });

  it('counts status codes by op × kind', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ timestamp: '2026-08-09T01:00:00Z', path: '/api/runtime/v1/sessions/a/records', statusCode: 201, requestBody: { kind: 'playback' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:01:00Z', path: '/api/runtime/v1/sessions/a/records', statusCode: 409, responseBody: { errorCode: 'IDEMPOTENCY_CONFLICT' }, requestBody: { kind: 'playback' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:02:00Z', path: '/api/runtime/v1/sessions/b/records', statusCode: 409, responseBody: { errorCode: 'IDEMPOTENCY_CONFLICT' }, requestBody: { kind: 'playback' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:03:00Z', path: '/api/runtime/v1/sessions/b/records', statusCode: 200, requestBody: { kind: 'quizAttempt' } }),
    ]);
    const report = await summarizeLogs(filePath);
    const pb = report.opKindStatus['append_record']?.['playback'];
    expect(pb?.[201]).toBe(1);
    expect(pb?.[409]).toBe(2);
    const qz = report.opKindStatus['append_record']?.['quizAttempt'];
    expect(qz?.[200]).toBe(1);
    fs.unlinkSync(filePath);
  });

  it('classifies 409 by errorCode', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ timestamp: '2026-08-09T01:00:00Z', path: '/api/runtime/v1/sessions/s1/records', statusCode: 409, responseBody: { errorCode: 'INACTIVE_SESSION' }, requestBody: { kind: 'playback' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:01:00Z', path: '/api/runtime/v1/sessions/s2/records', statusCode: 409, responseBody: { errorCode: 'IDEMPOTENCY_CONFLICT' }, requestBody: { kind: 'playback' } }),
    ]);
    const report = await summarizeLogs(filePath);
    expect(report.errorCode409['INACTIVE_SESSION']).toBe(1);
    expect(report.errorCode409['IDEMPOTENCY_CONFLICT']).toBe(1);
    fs.unlinkSync(filePath);
  });

  it('counts telemetry outcomes from diagnostics path', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ timestamp: '2026-08-09T01:00:00Z', path: '/api/client-diagnostics', statusCode: 200, requestBody: { outcome: 'ok', op: 'create_session', kind: 'playback' } }),
      JSON.stringify({ timestamp: '2026-08-09T01:01:00Z', path: '/api/client-diagnostics', statusCode: 200, requestBody: { outcome: 'idempotency_conflict', op: 'append_record', kind: 'chat' } }),
    ]);
    const report = await summarizeLogs(filePath);
    expect(report.telemetryOutcomes['ok']).toBe(1);
    expect(report.telemetryOutcomes['idempotency_conflict']).toBe(1);
    fs.unlinkSync(filePath);
  });

  it('detects duplicate recordId with payload drift', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ timestamp: '2026-08-09T01:00:00Z', path: '/api/runtime/v1/sessions/s1/records', statusCode: 201, requestBody: { id: 's1:dup-id', kind: 'playback', payload: { content: 'T1' } } }),
      JSON.stringify({ timestamp: '2026-08-09T01:01:00Z', path: '/api/runtime/v1/sessions/s1/records', statusCode: 201, requestBody: { id: 's1:dup-id', kind: 'playback', payload: { content: 'T2' } } }),
    ]);
    const report = await summarizeLogs(filePath);
    expect(report.duplicateRecordIds.length).toBe(1);
    const dup = report.duplicateRecordIds[0];
    expect(dup.recordId).toBe('s1:dup-id');
    expect(dup.events.length).toBe(2);
    expect(dup.distinctPayloadHashes).toBe(2); // T1 ≠ T2 → drift
    fs.unlinkSync(filePath);
  });

  it('handles empty file', async () => {
    const filePath = writeTempFile([]);
    const report = await summarizeLogs(filePath);
    expect(report.runtimeRequests).toBe(0);
    fs.unlinkSync(filePath);
  });

  it('handles missing requestBody gracefully', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ timestamp: '2026-08-09T01:00:00Z', path: '/api/runtime/v1/sessions/s1/records', statusCode: 201 }),
    ]);
    const report = await summarizeLogs(filePath);
    expect(report.runtimeRequests).toBe(1);
    // Default to 'playback' kind when body is missing
    expect(report.opKindStatus['append_record']?.['playback']?.[201]).toBe(1);
    fs.unlinkSync(filePath);
  });

  it('throws for missing file', async () => {
    await expect(summarizeLogs('/nonexistent/path.jsonl')).rejects.toThrow('File not found');
  });

  it('formatReport includes notObservable section', async () => {
    const filePath = writeTempFile([
      JSON.stringify({ timestamp: '2026-08-09T01:00:00Z', path: '/api/runtime/v1/sessions/s/records', statusCode: 201, requestBody: { kind: 'playback' } }),
    ]);
    const report = await summarizeLogs(filePath);
    const output = formatReport(report);
    expect(output).toContain('RuntimeStore');
    expect(output).toContain('不可观测指标');
    expect(output).toContain('retries');
    fs.unlinkSync(filePath);
  });
});
