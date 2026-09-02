/**
 * RJ DSL 扩展 validator（P1-b）。
 *
 * 包装上游 @openmaic/dsl validateStage / validateScene，
 * 在 DSL 校验通过后追加 RJ 扩展字段校验（含资产守卫）。
 *
 * 设计原则：
 * 1. DSL validator 失败 → 直接返回 DSL 错误（RJ 不重写规则）
 * 2. DSL validator 通过 → 走扩展校验
 * 3. 资产 URL 字段值必须 https://——通过 NEXT_PUBLIC_DSL_ASSET_GUARD_MODE
 *    控制 warn vs error。默认 warn（防呆）。
 */

import {
  validateStage as dslValidateStage,
  validateScene as dslValidateScene,
  type ValidationResult,
  type ValidationIssue,
} from '@openmaic/dsl';
import { ASSET_URL_PATHS, CLOUD_PERSISTED } from './registry';

export type GuardMode = 'warn' | 'error';

/** 读取环境变量，默认 warn（防呆）。 */
function readGuardMode(): GuardMode {
  const raw = process.env.NEXT_PUBLIC_DSL_ASSET_GUARD_MODE;
  return raw === 'error' ? 'error' : 'warn';
}

type ExtendedValidationResult =
  | { valid: true; warnings?: ValidationIssue[] }
  | { valid: false; errors: ValidationIssue[] };

/**
 * 校验 stage 的 RJ 扩展字段。返回 issue 数组（空数组 = 通过）。
 *
 * 仅检查 CLOUD_PERSISTED 字段中 assetUrl=true 的字段值是否 https URL。
 * 不校验 DSL 已声明的字段（id/name/createdAt 等）。
 */
export function validateStageExtensions(stage: unknown): ValidationIssue[] {
  if (!stage || typeof stage !== 'object') return [];
  const s = stage as Record<string, unknown>;

  const issues: ValidationIssue[] = [];

  // stage.teacherVoiceConfig — 简单类型校验（DSL 不认识）
  if ('teacherVoiceConfig' in s && s.teacherVoiceConfig != null) {
    const cfg = s.teacherVoiceConfig as Record<string, unknown>;
    if (typeof cfg !== 'object') {
      issues.push({
        path: '/teacherVoiceConfig',
        message: 'teacherVoiceConfig must be an object',
      });
    } else {
      for (const key of ['providerId', 'voiceId', 'modelId'] as const) {
        if (typeof cfg[key] !== 'string') {
          issues.push({
            path: `/teacherVoiceConfig/${key}`,
            message: `teacherVoiceConfig.${key} must be a string`,
          });
        }
      }
    }
  }

  // stage.sceneOrderTrusted: boolean
  if ('sceneOrderTrusted' in s && s.sceneOrderTrusted != null) {
    if (typeof s.sceneOrderTrusted !== 'boolean') {
      issues.push({
        path: '/sceneOrderTrusted',
        message: 'sceneOrderTrusted must be boolean',
      });
    }
  }

  // stage.sceneOrderRepairedAt: number
  if ('sceneOrderRepairedAt' in s && s.sceneOrderRepairedAt != null) {
    if (typeof s.sceneOrderRepairedAt !== 'number') {
      issues.push({
        path: '/sceneOrderRepairedAt',
        message: 'sceneOrderRepairedAt must be number',
      });
    }
  }

  // stage.currentSceneId: string | null
  if ('currentSceneId' in s && s.currentSceneId != null) {
    if (typeof s.currentSceneId !== 'string') {
      issues.push({
        path: '/currentSceneId',
        message: 'currentSceneId must be string or null',
      });
    }
  }

  // stage.data.imageMapping: Record<string, string>（值必须 https URL，资产守卫）
  if ('data' in s && s.data != null && typeof s.data === 'object') {
    const data = s.data as Record<string, unknown>;
    if ('imageMapping' in data && data.imageMapping != null) {
      issues.push(
        ...validateAssetMap('/data/imageMapping', data.imageMapping, 'stage.data.imageMapping'),
      );
    }
  }

  return issues;
}

/**
 * 校验 scene 的 RJ 扩展字段。
 */
export function validateSceneExtensions(scene: unknown): ValidationIssue[] {
  if (!scene || typeof scene !== 'object') return [];
  const s = scene as Record<string, unknown>;
  const issues: ValidationIssue[] = [];

  // scene.narrationAudioUrl: string（资产守卫）
  if ('narrationAudioUrl' in s && s.narrationAudioUrl != null) {
    issues.push(
      ...validateAssetValue('/narrationAudioUrl', s.narrationAudioUrl, 'scene.narrationAudioUrl'),
    );
  }

  return issues;
}

/**
 * 校验 Record<string, string> 形态的资产映射。
 * 值必须 https:// 开头，否则按 guard mode 报 issue。
 */
function validateAssetMap(
  basePath: string,
  map: unknown,
  fieldPath: 'stage.data.imageMapping',
): ValidationIssue[] {
  if (typeof map !== 'object' || map === null) {
    return [{ path: basePath, message: `${fieldPath} must be an object` }];
  }
  const issues: ValidationIssue[] = [];
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    issues.push(
      ...validateAssetValue(`${basePath}/${key}`, value, fieldPath),
    );
  }
  return issues;
}

/**
 * 校验单个资产 URL 值。
 * - 必须以 https:// 开头
 * - 不允许 data: URI（base64 内联）
 */
function validateAssetValue(
  path: string,
  value: unknown,
  fieldPath: 'stage.data.imageMapping' | 'scene.narrationAudioUrl',
): ValidationIssue[] {
  if (typeof value !== 'string') {
    return [{ path, message: `${fieldPath} value must be a string` }];
  }
  // data: URI 显式拒绝（这是 P0-3 的根因）
  if (value.startsWith('data:')) {
    return [
      {
        path,
        message: `检测到内联 base64 资产，请先上传至 Storage 后再保存（${fieldPath}）`,
      },
    ];
  }
  if (!value.startsWith('https://')) {
    return [
      {
        path,
        message: `${fieldPath} value must start with https:// (got "${value.slice(0, 20)}...")`,
      },
    ];
  }
  return [];
}

/**
 * 包装上游 validateStage：先跑 DSL，再跑 RJ 扩展校验。
 * 扩展校验按 guard mode 决定 issue 是 warning 还是 error。
 */
export function validateStageExtended(stage: unknown): ExtendedValidationResult {
  const dslResult = dslValidateStage(stage);
  if (!dslResult.valid) return dslResult;

  const mode = readGuardMode();
  const extIssues = validateStageExtensions(stage);

  if (mode === 'error' && extIssues.length > 0) {
    return { valid: false, errors: extIssues };
  }
  if (extIssues.length > 0) {
    return { valid: true, warnings: extIssues };
  }
  return { valid: true };
}

/**
 * 包装上游 validateScene：先跑 DSL，再跑 RJ 扩展校验。
 *
 * Widened-kind 放行（2026-07-28 拍板，方案 A）：DSL 只拥有 slide/quiz，
 * 上游 BrowserDocumentStore 的设计意图是"app 注入接受自有 kind 的
 * validator，且 gate 保持 fail-loud"。因此当 dslValidateScene 的
 * 唯一错误是 `/type` 的 unknown scene type、且类型属于 RJ 注册种类
 * （interactive/pbl，即 lib/types/stage.ts 的 AppSceneContent 扩展判别）时，
 * 吞掉该单一判别错误，改由 validateWidenedContent 做 RJ 内容校验；
 * DSL 的任何其他错误（id/stageId/title/order/content/actions）仍然失败。
 */
export function validateSceneExtended(scene: unknown): ExtendedValidationResult {
  const dslResult = dslValidateScene(scene);
  if (!dslResult.valid) {
    const t = (scene as { type?: unknown } | null)?.type;
    const hasUnknownKindIssue = dslResult.errors.some(isUnknownSceneKindIssue);
    const nonKindIssues = dslResult.errors.filter((e) => !isUnknownSceneKindIssue(e));
    const isWidenedKind = typeof t === 'string' && WIDENED_SCENE_KINDS.has(t);
    if (!isWidenedKind || !hasUnknownKindIssue || nonKindIssues.length > 0) {
      return dslResult;
    }
    // 仅类型判别不拥有该 kind；RJ 内容校验 fail-loud（不走 guard mode）。
    const widenedIssues = validateWidenedContent(scene as Record<string, unknown>, t);
    if (widenedIssues.length > 0) {
      return { valid: false, errors: widenedIssues };
    }
  }

  const mode = readGuardMode();
  const extIssues = validateSceneExtensions(scene);

  if (mode === 'error' && extIssues.length > 0) {
    return { valid: false, errors: extIssues };
  }
  if (extIssues.length > 0) {
    return { valid: true, warnings: extIssues };
  }
  return { valid: true };
}

/** RJ 注册的 widened scene kinds（AppSceneContent 中 DSL 不拥有的判别）。 */
const WIDENED_SCENE_KINDS = new Set(['interactive', 'pbl']);

/** 识别 DSL checkScene 对未知 scene 类型报出的 `/type` 错误。 */
function isUnknownSceneKindIssue(issue: ValidationIssue): boolean {
  return issue.path === '/type' && issue.message.startsWith('unknown scene type');
}

/**
 * widened kind 的 RJ 内容校验（结构不变量，fail-loud，与资产守卫的
 * warn/error 开关无关）：
 * - content.type 必须与 scene.type 一致（与 DSL 对 slide/quiz 的要求对齐）；
 * - interactive：必须有 https 的 content.url，或非空的 content.html
 *   （真实课程存在 url 为空、html 内嵌的合法形态）；
 * - pbl：必须有对象形态的 content.projectConfig。
 */
function validateWidenedContent(
  scene: Record<string, unknown>,
  kind: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const content = scene.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    // dslValidateScene 已会报告非对象 content；防御性兜底。
    return [{ path: '/content', message: 'scene `content` must be an object' }];
  }
  const c = content as Record<string, unknown>;
  if (c.type !== kind) {
    issues.push({
      path: '/content/type',
      message: `content type ${JSON.stringify(c.type)} does not match scene type ${JSON.stringify(kind)}`,
    });
  }
  if (kind === 'interactive') {
    const hasHttpsUrl = typeof c.url === 'string' && c.url.startsWith('https://');
    const hasHtml = typeof c.html === 'string' && c.html.length > 0;
    if (!hasHttpsUrl && !hasHtml) {
      issues.push({
        path: '/content',
        message: 'interactive content requires an https `url` or a non-empty `html`',
      });
    }
  } else if (kind === 'pbl') {
    if (!c.projectConfig || typeof c.projectConfig !== 'object' || Array.isArray(c.projectConfig)) {
      issues.push({
        path: '/content/projectConfig',
        message: 'pbl content requires an object `projectConfig`',
      });
    }
  }
  return issues;
}

export { ASSET_URL_PATHS, CLOUD_PERSISTED };