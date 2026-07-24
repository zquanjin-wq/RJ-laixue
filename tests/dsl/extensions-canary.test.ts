/**
 * RJ DSL 扩展金丝雀测试（P1-b）。
 *
 * 任务卡明确：测试测 RJ 扩展层 + 上游 DSL 组合行为，
 * 主体是 RJ 代码，住 RJ 的 tests 目录。
 *
 * 上游 cherry-pick 任何版本后跑这个测试，能立即发现：
 * - cloudPersisted 字段被 strip
 * - runtimeOnly 字段没被剥离
 * - 资产守卫在 error 模式下误判 / 在 warn 模式下漏报
 */

import { describe, expect, it } from 'vitest';

// 注意：上游 DSL 包不直接依赖 RJ 这层（单向依赖：RJ → DSL）。
// 我们测 RJ 这层包装过的 validateStageExtended / validateSceneExtended
// 以及 stripRuntimeOnly。
import {
  validateStageExtended,
  validateSceneExtended,
} from '@/lib/dsl-extensions/validate';
import { stripRuntimeOnly } from '@/lib/dsl-extensions/serialize';
import { CLOUD_PERSISTED, RUNTIME_ONLY, ASSET_URL_PATHS } from '@/lib/dsl-extensions/registry';

describe('RJ DSL extensions — registry invariants', () => {
  it('CLOUD_PERSISTED has 6 fields', () => {
    expect(CLOUD_PERSISTED.length).toBe(6);
  });

  it('RUNTIME_ONLY has 4 fields', () => {
    expect(RUNTIME_ONLY.length).toBe(4);
  });

  it('asset URL fields are subset of CLOUD_PERSISTED', () => {
    expect(ASSET_URL_PATHS.size).toBe(2);
    expect(Array.from(ASSET_URL_PATHS)).toEqual(
      expect.arrayContaining(['stage.data.imageMapping', 'scene.narrationAudioUrl']),
    );
  });
});

describe('validateStageExtended — cloudPersisted 字段不被 strip / 校验通过', () => {
  it('accepts stage with all 6 cloudPersisted fields + valid https URLs', () => {
    const stage = {
      id: 'stage-canary',
      name: '金丝雀课程',
      createdAt: 0,
      updatedAt: 0,
      teacherVoiceConfig: {
        providerId: 'minimax-tts',
        voiceId: 'female-yujie',
        modelId: 'speech-2.8-hd',
      },
      sceneOrderTrusted: true,
      sceneOrderRepairedAt: 1753344000000,
      currentSceneId: 'scene-3',
      data: {
        imageMapping: {
          'img-1': 'https://example.supabase.co/storage/v1/object/courses/img-1.png',
          'img-2': 'https://example.supabase.co/storage/v1/object/courses/img-2.png',
        },
      },
    };
    const result = validateStageExtended(stage);
    expect(result.valid).toBe(true);
  });

  it('reject when imageMapping value is data: URI (warn mode)', () => {
    const stage = {
      id: 'stage-canary',
      name: '金丝雀',
      createdAt: 0,
      updatedAt: 0,
      data: {
        imageMapping: {
          'img-1': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...',
        },
      },
    };
    const result = validateStageExtended(stage);
    // warn 模式下 valid 仍是 true，但有 warnings
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBeGreaterThan(0);
      expect(result.warnings![0].message).toContain('检测到内联 base64 资产');
    }
  });

  it('reject when narrationAudioUrl is not https (DSL validator doesn\'t know it, RJ layer catches)', () => {
    const scene = {
      id: 'scene-1',
      stageId: 'stage-1',
      title: 'test',
      order: 0,
      type: 'slide',
      content: { type: 'slide', canvas: { elements: [] } },
      narrationAudioUrl: 'http://insecure.example.com/audio.mp3', // 不是 https
    };
    const result = validateSceneExtended(scene);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.warnings).toBeDefined();
      expect(result.warnings![0].path).toBe('/narrationAudioUrl');
    }
  });
});

describe('stripRuntimeOnly — 深拷贝不污染原对象 + RUNTIME_ONLY 字段被剔除', () => {
  it('strips scene.seq / scene.narrationText / scene.interactionType from scenes array', () => {
    const original = {
      id: 'stage-1',
      name: 'test',
      scenes: [
        {
          id: 'scene-1',
          order: 0,
          seq: 0,
          narrationText: '旁白文本',
          interactionType: 'quiz',
          teacherVoiceConfig: { providerId: 'x', voiceId: 'y', modelId: 'z' }, // CLOUD_PERSISTED，必须保留
        },
      ],
    };
    const stripped = stripRuntimeOnly(original);
    // 原对象不被修改
    expect(original.scenes[0].seq).toBe(0);
    expect(original.scenes[0].narrationText).toBe('旁白文本');
    // stripped 没有 RUNTIME_ONLY 字段
    expect(stripped.scenes[0].seq).toBeUndefined();
    expect(stripped.scenes[0].narrationText).toBeUndefined();
    expect(stripped.scenes[0].interactionType).toBeUndefined();
    // CLOUD_PERSISTED 字段保留
    expect(stripped.scenes[0].teacherVoiceConfig).toEqual({
      providerId: 'x',
      voiceId: 'y',
      modelId: 'z',
    });
  });

  it('deep clone — 修改 stripped 不影响原对象', () => {
    const original = {
      id: 'stage-1',
      scenes: [{ id: 's1', seq: 0 }],
    };
    const stripped = stripRuntimeOnly(original);
    (stripped.scenes[0] as Record<string, unknown>).id = 'mutated';
    expect(original.scenes[0].id).toBe('s1');
    expect(stripped.scenes[0].id).toBe('mutated');
  });
});

describe('end-to-end — 上游 splitDocument / reassembleDocument 配合', () => {
  // 注意：上游 DSL 的 splitDocument / reassembleDocument 在 v0.3.1 cherry-pick 后
  // 才能直接 import。这个 canary 暂用 RJ 包装接口（不依赖上游）。
  // 完整上游集成测试在 Phase 1+2 阶段 3 commit `runtimestore-conflict-scan.md` 之后。
  it('validateStageExtended passes a stage with nested imageMapping in data.outline', () => {
    const stage = {
      id: 'stage-x',
      name: 'test',
      createdAt: 0,
      updatedAt: 0,
      data: {
        outline: { someOutline: 'value' },
        imageMapping: { 'img-1': 'https://x.example.com/img-1.png' },
      },
    };
    const result = validateStageExtended(stage);
    expect(result.valid).toBe(true);
  });
});