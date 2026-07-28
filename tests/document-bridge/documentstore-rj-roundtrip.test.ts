/**
 * B2.2 本地复现 harness（2026-07-28）。
 *
 * 背景：Preview 影子读路径报 `document_parity / read_failure / TypeError`，
 * 但既有测试从未跑过「真实 BrowserDocumentStore × 真实 RJ 文档形状」：
 * - 本目录 bridge-fallback.test.ts 把 BrowserDocumentStore 整个 mock 掉；
 * - 上游 storage 包契约测试只喂标准 slide/quiz 场景，不喂 RJ 扩展文档。
 *
 * 本文件补齐这一层：只 mock 外部世界（Supabase Auth / ledger / diagnostics），
 * 保留真实的 BrowserDocumentStore（fake-indexeddb 后端）、真实的
 * validateSceneExtended / validateStageExtended，以及真实的 bridge + parity
 * 代码路径。fixture 形状复刻 app/classroom/[id]/page.tsx 的 cloud_hydration
 * 快照（stage 原样 + scenes 经 migrateScene + outlineRecord 固定时间戳）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { LegacyDocumentSnapshot } from '@/lib/document-bridge/types';

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

// 关键：不 mock @openmaic/storage，也不 mock @/lib/dsl-extensions/validate。
import { bridgeLegacyDocument, compareLegacyDocument } from '@/lib/document-bridge/bridge';

/** 每个用例使用独立用户 id → 独立 namespace → storeFor 新建 BrowserDocumentStore，
 * 从而吃到本用例注入的全新 fake-indexeddb，避免模块级 memo 串库。 */
let userSeq = 0;

beforeEach(() => {
  process.env.NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE = '1';
  process.env.NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK = '1';
  userSeq += 1;
  mocks.getUser.mockResolvedValue({ data: { user: { id: `roundtrip-user-${userSeq}` } } });
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

type RjScene = LegacyDocumentSnapshot['scenes'][number];

function rjStage(id: string): LegacyDocumentSnapshot['stage'] {
  return {
    id,
    name: 'RJ round-trip course',
    createdAt: 1753000000000,
    updatedAt: 1753000001000,
    // RJ 扩展字段（cloudPersisted，见 lib/dsl-extensions/registry.ts）
    teacherVoiceConfig: { providerId: 'minimax', voiceId: 'teacher-1', modelId: 'speech-02' },
    sceneOrderTrusted: true,
    sceneOrderRepairedAt: 1753000000500,
    generatedAgentConfigs: [
      { id: 'agent-1', name: '讲师', role: 'lecturer', systemPrompt: '...' },
    ],
    data: { imageMapping: { hero: 'https://cdn.example.com/hero.png' } },
  } as unknown as LegacyDocumentSnapshot['stage'];
}

function slideScene(stageId: string, order: number): RjScene {
  return {
    id: `slide-${order}`,
    stageId,
    title: `Slide ${order}`,
    order,
    seq: order,
    type: 'slide',
    content: { type: 'slide', canvas: { elements: [{ id: 'el-1', type: 'text' }] } },
    narrationText: '同学们好',
    narrationAudioUrl: 'https://cdn.example.com/narration.mp3',
    actions: [{ id: 'act-1', type: 'speech', text: '同学们好' }],
  } as unknown as RjScene;
}

function quizScene(stageId: string, order: number): RjScene {
  return {
    id: `quiz-${order}`,
    stageId,
    title: `Quiz ${order}`,
    order,
    seq: order,
    type: 'quiz',
    content: {
      type: 'quiz',
      questions: [
        {
          id: 'q-1',
          type: 'single_choice',
          question: '1+1=?',
          options: [
            { id: 'o-1', text: '2' },
            { id: 'o-2', text: '3' },
          ],
          correctOptionIds: ['o-1'],
        },
      ],
    },
  } as unknown as RjScene;
}

function interactiveScene(stageId: string, order: number): RjScene {
  return {
    id: `interactive-${order}`,
    stageId,
    title: `Interactive ${order}`,
    order,
    seq: order,
    type: 'interactive',
    content: { type: 'interactive', url: 'https://cdn.example.com/widget.html' },
  } as unknown as RjScene;
}

function pblScene(stageId: string, order: number): RjScene {
  return {
    id: `pbl-${order}`,
    stageId,
    title: `PBL ${order}`,
    order,
    seq: order,
    type: 'pbl',
    content: { type: 'pbl', projectConfig: { title: '项目制学习', milestones: [] } },
  } as unknown as RjScene;
}

/** url 为空且无 html 的 interactive：放行类型判别，但内容结构必须仍被拒。 */
function malformedInteractiveScene(stageId: string, order: number): RjScene {
  return {
    id: `interactive-bad-${order}`,
    stageId,
    title: `Malformed interactive ${order}`,
    order,
    seq: order,
    type: 'interactive',
    content: { type: 'interactive', url: '' },
  } as unknown as RjScene;
}

function snapshot(
  id: string,
  scenes: RjScene[],
  { withOutline = true }: { withOutline?: boolean } = {},
): LegacyDocumentSnapshot {
  return {
    stage: rjStage(id),
    scenes,
    ...(withOutline
      ? {
          outlineRecord: {
            stageId: id,
            outlines: [{ id: 'ol-1', title: '第一章', sceneIds: scenes.map((s) => s.id) }],
            generationComplete: true,
            createdAt: 0,
            updatedAt: 0,
          } as unknown as LegacyDocumentSnapshot['outlineRecord'],
        }
      : {}),
  } as LegacyDocumentSnapshot;
}

describe('DocumentStore × RJ 文档形状 round-trip（真实存储后端）', () => {
  it('slide+quiz 课程：影子复制成功且双读指纹一致（Preview TypeError 的最小复现面）', async () => {
    const courseId = 'oiqTbzCXwy'; // Preview 复现课程之一
    const snap = snapshot(courseId, [slideScene(courseId, 0), quizScene(courseId, 1)]);

    await expect(bridgeLegacyDocument(snap)).resolves.toBe('migrated');
    await expect(compareLegacyDocument(snap, 'cloud_hydration')).resolves.toBe('match');

    expect(mocks.parityReport).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'match', source: 'cloud_hydration' }),
    );
  });

  it('无 outline 的课程：影子复制与比对同样成立', async () => {
    const courseId = 'txo6PVFVnx'; // Preview 复现课程之一
    const snap = snapshot(courseId, [slideScene(courseId, 0)], { withOutline: false });

    await expect(bridgeLegacyDocument(snap)).resolves.toBe('migrated');
    await expect(compareLegacyDocument(snap, 'cloud_hydration')).resolves.toBe('match');
  });

  it('widened kind（interactive/pbl）放行后：影子复制与比对成立', async () => {
    // 2026-07-28 拍板（方案 A）：validateSceneExtended 对 RJ 注册种类
    // （interactive/pbl）吞掉 DSL 的 unknown-kind 判别错误，改走 RJ 内容校验。
    const courseId = 'HsxJTCOZuK'; // Preview 复现课程之一
    const snap = snapshot(courseId, [
      slideScene(courseId, 0),
      interactiveScene(courseId, 1),
      pblScene(courseId, 2),
    ]);

    await expect(bridgeLegacyDocument(snap)).resolves.toBe('migrated');
    await expect(compareLegacyDocument(snap, 'cloud_hydration')).resolves.toBe('match');
  });

  it('interactive 内容结构不合法（无 https url 且无 html）仍 fail-loud', async () => {
    const courseId = 'course-bad-interactive';
    const snap = snapshot(courseId, [malformedInteractiveScene(courseId, 0)]);

    await expect(bridgeLegacyDocument(snap)).resolves.toBe('skipped');
    expect(mocks.report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', errorCode: 'validation' }),
    );
    await expect(compareLegacyDocument(snap, 'cloud_hydration')).resolves.toBe('missing_document');
  });

  it('widened kind 的其余 DSL 错误不因放行被吞掉（缺 title 仍失败）', async () => {
    const courseId = 'course-widened-missing-title';
    const bad = { ...interactiveScene(courseId, 0) } as Record<string, unknown>;
    delete bad.title;
    const snap = snapshot(courseId, [bad as RjScene]);

    await expect(bridgeLegacyDocument(snap)).resolves.toBe('skipped');
    expect(mocks.report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', errorCode: 'validation' }),
    );
  });
});
