/**
 * 离线真实课程探针（2026-07-28）：用导出的课程 JSON 定位 bridge 失败点，
 * 全程只读、可重复、不进部署循环。这是 B2「离线真实数据验证」的工具种子。
 *
 * 用法：
 *   COURSE_JSON='D:\WorkBuddy 地界\tmp\course-xxx.json' pnpm vitest run tests/document-bridge/real-course.probe.test.ts
 * 不设置 COURSE_JSON 时整个文件跳过（CI 安全）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { validateSceneExtended, validateStageExtended } from '@/lib/dsl-extensions/validate';
import type { LegacyDocumentSnapshot } from '@/lib/document-bridge/types';

const coursePath = process.env.COURSE_JSON;
interface ProbeCourseData {
  stage: LegacyDocumentSnapshot['stage'];
  scenes: Record<string, unknown>[];
  outlines?: unknown[];
}
const courseData = (
  coursePath ? JSON.parse(readFileSync(coursePath, 'utf8')).data.data : null
) as ProbeCourseData;

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getEntry: vi.fn(),
  putEntry: vi.fn(),
  report: vi.fn(),
  parityReport: vi.fn(),
}));
vi.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { getUser: mocks.getUser } },
}));
vi.mock('@/lib/document-bridge/ledger', () => ({
  getBridgeEntry: mocks.getEntry,
  putBridgeEntry: mocks.putEntry,
}));
vi.mock('@/lib/document-bridge/diagnostics', () => ({
  reportBridgeDiagnostic: mocks.report,
  reportDocumentParityDiagnostic: mocks.parityReport,
}));

import { bridgeLegacyDocument, compareLegacyDocument } from '@/lib/document-bridge/bridge';

let userSeq = 0;
beforeEach(() => {
  process.env.NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE = '1';
  process.env.NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK = '1';
  userSeq += 1;
  mocks.getUser.mockResolvedValue({ data: { user: { id: `probe-user-${userSeq}` } } });
  mocks.getEntry.mockResolvedValue(undefined);
  mocks.putEntry.mockResolvedValue(undefined);
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
});
afterEach(() => {
  vi.clearAllMocks();
  delete process.env.NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE;
  delete process.env.NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK;
  delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
});

function makeSnapshot(scenes: unknown[]): LegacyDocumentSnapshot {
  return {
    stage: courseData.stage,
    scenes: scenes as LegacyDocumentSnapshot['scenes'],
    outlineRecord: {
      stageId: courseData.stage.id,
      outlines: courseData.outlines ?? [],
      generationComplete: true,
      createdAt: 0,
      updatedAt: 0,
    } as LegacyDocumentSnapshot['outlineRecord'],
  } as LegacyDocumentSnapshot;
}

// 未设置 COURSE_JSON 时整组跳过（CI 与全量测试不受影响）。
describe.runIf(courseData)('真实课程探针', () => {
  it('逐字段打印 validation 失败点', () => {
    const st = validateStageExtended(courseData.stage);
    console.log('[probe] stage valid:', st.valid);
    if (!st.valid) console.log('[probe] stage errors:', JSON.stringify(st.errors, null, 2));

    for (const s of courseData.scenes as Record<string, unknown>[]) {
      const r = validateSceneExtended(s);
      if (!r.valid) {
        console.log(
          `[probe] INVALID scene id=${s.id} type=${s.type} title=${JSON.stringify(s.title)}`,
        );
        console.log('[probe]   errors:', JSON.stringify(r.errors, null, 2));
      } else {
        console.log(`[probe] valid scene id=${s.id} type=${s.type}`);
      }
    }
  });

  it('完整课程：widened-kind 放行后 bridge 应 migrated 且 parity 应 match', async () => {
    const snap = makeSnapshot(courseData.scenes);
    await expect(bridgeLegacyDocument(snap)).resolves.toBe('migrated');
    await expect(compareLegacyDocument(snap, 'cloud_hydration')).resolves.toBe('match');
  });

  it('剔除 interactive 场景后：bridge 应 migrated 且 parity 应 match', async () => {
    const kept = (courseData.scenes as { type: string }[]).filter((s) => s.type !== 'interactive');
    console.log('[probe] kept scenes:', kept.length, 'of', courseData.scenes.length);
    const snap = makeSnapshot(kept);
    await expect(bridgeLegacyDocument(snap)).resolves.toBe('migrated');
    await expect(compareLegacyDocument(snap, 'cloud_hydration')).resolves.toBe('match');
  });
});
