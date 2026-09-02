/**
 * RJ DSL 扩展序列化（P1-b）。
 *
 * 唯一调用点：cloud-sync 的上传序列化边界（payload 出门前最后一站）。
 * 任务卡明确：不在上游 DSL 加 serializeDocument（侵入 + 语义错位）。
 *
 * ⚠️ 必须深拷贝后剔除字段！原地 delete 会把内存里 stage 对象的
 * seq/currentSceneId 直接抹掉，播放立刻出 bug。
 */

import { RUNTIME_ONLY } from './registry';

/**
 * 从 stage 文档里剔除所有 RUNTIME_ONLY 字段。
 * 返回新对象，不修改原对象。
 */
export function stripRuntimeOnly<T>(stage: T): T {
  if (!stage || typeof stage !== 'object') return stage;
  // 深拷贝
  const cloned = deepClone(stage) as Record<string, unknown>;
  // 剔除 Stage 本体的 RUNTIME_ONLY 字段
  for (const field of RUNTIME_ONLY) {
    if (field.path.startsWith('stage.')) {
      const key = field.path.slice('stage.'.length);
      delete cloned[key];
    }
  }
  // 剔除 Scene 上的 RUNTIME_ONLY 字段
  if (Array.isArray(cloned.scenes)) {
    cloned.scenes = (cloned.scenes as unknown[]).map((scene) =>
      stripSceneRuntimeOnly(scene),
    );
  }
  return cloned as T;
}

/**
 * 从单个 scene 里剔除 RUNTIME_ONLY 字段。
 */
function stripSceneRuntimeOnly(scene: unknown): unknown {
  if (!scene || typeof scene !== 'object') return scene;
  const cloned = deepClone(scene) as Record<string, unknown>;
  for (const field of RUNTIME_ONLY) {
    if (field.path.startsWith('scene.')) {
      const key = field.path.slice('scene.'.length);
      delete cloned[key];
    }
  }
  return cloned;
}

/**
 * 深拷贝。优先 structuredClone（Node 17+ / 现代浏览器都支持）。
 * 兜底 JSON 深拷贝（兼容老环境，但会丢失 Date/Map 等特殊类型）。
 */
function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}