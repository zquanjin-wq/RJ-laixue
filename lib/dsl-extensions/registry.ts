/**
 * RJ-laixue DSL 扩展字段注册清单（P1-b 定稿）。
 *
 * 原则：上游 packages/@openmaic/dsl 一行不碰。扩展住在 RJ 这层。
 * Phase 4 rebase 上游时 DSL 包整体替换，不留 RJ 痕迹。
 *
 * 字段分类：
 * - cloudPersisted: 进云端 JSON，RJ 负责序列化、DSL validator 静默放过。
 *   写入时通过 validateStageExtended 做扩展字段校验（含资产守卫）。
 * - runtimeOnly: 运行时状态，绝不进云端。stripRuntimeOnly() 在 cloud-sync
 *   上传边界剔除。
 *
 * 清单锁定：P1-b 任务卡拍板。后续发现新字段 → 停下上报，不擅自加。
 */

export type AssetUrlField = 'stage.imageMapping' | 'scene.narrationAudioUrl';

export interface CloudPersistedField {
  /** "stage.xxx" 或 "scene.xxx" */
  path: string;
  /** 字段类型描述（只用于文档与金丝雀） */
  type: string;
  /** 是否资产 URL（值必须 https://） */
  assetUrl?: boolean;
  /** 人类可读用途 */
  purpose: string;
}

export interface RuntimeOnlyField {
  path: string;
  type: string;
  purpose: string;
}

/** 进云端 JSON 的 RJ 扩展字段。 */
export const CLOUD_PERSISTED: readonly CloudPersistedField[] = [
  {
    path: 'stage.teacherVoiceConfig',
    type: '{ providerId: string; voiceId: string; modelId: string }',
    purpose: '老师个性化音色（TTS 选 provider/voice/model）',
  },
  {
    path: 'stage.sceneOrderTrusted',
    type: 'boolean',
    purpose: 'scene `seq` 字段是否可信（v15 migration 引入）',
  },
  {
    path: 'stage.sceneOrderRepairedAt',
    type: 'number',
    purpose: 'scene order 修复时间戳（ops 调试）',
  },
  {
    path: 'stage.currentSceneId',
    type: 'string | null',
    purpose: '学员最后看的 scene id（playback 恢复）',
  },
  {
    path: 'stage.data.imageMapping',
    type: 'Record<string, string>',
    assetUrl: true,
    purpose: 'PDF/PPT 内联图的 Storage URL 引用（base64 改造目标）',
  },
  {
    path: 'scene.narrationAudioUrl',
    type: 'string',
    assetUrl: true,
    purpose: 'scene 整体旁白音频 URL（base64 改造目标）',
  },
] as const;

/** 运行时状态，绝不进云端。 */
export const RUNTIME_ONLY: readonly RuntimeOnlyField[] = [
  {
    path: 'scene.seq',
    type: 'number',
    purpose: 'scene 数组索引（trust 模式下的可信排序键）',
  },
  {
    path: 'scene.narrationText',
    type: 'string',
    purpose: 'scene 整体旁白文本（影响 TTS 时机）',
  },
  {
    path: 'scene.interactionType',
    type: 'string',
    purpose: '互动类型（影响 TTS 时机/方式）',
  },
  {
    path: 'audioFiles.ossKey',
    type: 'string',
    purpose: 'Dexie 本地表字段（CDN 缓存引用）',
  },
] as const;

/** 资产 URL 字段路径集合（用于守卫快速判断）。 */
export const ASSET_URL_PATHS: ReadonlySet<AssetUrlField> = new Set(
  CLOUD_PERSISTED.filter((f) => f.assetUrl).map((f) => f.path as AssetUrlField),
);

/**
 * 已知不注册的字段（上游 DSL 已有 / 派生视图 / 运行时状态非 stage-scene 本体）。
 * 这些字段不归 RJ 维护，扫描脚本见 docs/reports/2026-07-24-dsl-extension-scan.md。
 */
export const EXCLUDED_FIELDS = {
  upstreamDsl: [
    'stage.whiteboard',
    'stage.videoManifest',
    'stage.agentIds',
    'stage.languageDirective',
    'stage.style',
    'stage.outline',
    'stage.data.outline',
    'action.audioUrl', // DSL 已声明（speech action 上）
  ],
  derivedRuntimeState: [
    'quizResults',
    'playbackState',
    'chatResults',
    'chatMessages',
    'chats',
    'mode',
  ],
  mobileView: [
    'MobileChapter.*',
    'm-mode',
    'm-currentChapterIndex',
  ],
  sceneAliases: [
    // DSL 用 title，RJ 多处用 name 做 fallback——不冲突，不注册
    'scene.name',
    'scene.kind', // DSL type 已够用，RJ kind 是冗余但保留以防下游依赖
  ],
} as const;