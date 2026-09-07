import type { Scene, Stage } from '@/lib/types/stage';
import type { Action } from '@/lib/types/action';

export interface PptxQualityIssue {
  severity: 'error' | 'warning';
  code: string;
  page?: number;
  message: string;
}

export interface PptxQualityReport {
  issues: PptxQualityIssue[];
  speechPages: number;
  audioCoverage: { required: number; ready: number };
}

/** Validate the playable contract immediately before an imported course commits. */
export function validatePptxAiClassroom(input: {
  stage: Stage;
  scenes: Scene[];
  requireAudio: boolean;
}): PptxQualityReport {
  const issues: PptxQualityIssue[] = [];
  const roster = input.stage.generatedAgentConfigs ?? [];
  const teachers = roster.filter((agent) => agent.role === 'teacher');
  if (teachers.length !== 1) {
    issues.push({ severity: 'error', code: 'teacher_count', message: '课堂必须恰好有一名 AI 教师。' });
  }
  if (roster.length < 2) {
    issues.push({ severity: 'error', code: 'roster_size', message: '课堂至少需要一名教师和一名伴学角色。' });
  }
  if (input.stage.agentIds?.join('|') !== roster.map((agent) => agent.id).join('|')) {
    issues.push({ severity: 'error', code: 'roster_pointer', message: '课堂角色引用与正式角色配置不一致。' });
  }

  let speechPages = 0;
  let audioRequired = 0;
  let audioReady = 0;
  const knownAgents = new Set(roster.map((agent) => agent.id));
  for (const [index, scene] of input.scenes.entries()) {
    const page = index + 1;
    if (scene.order !== index && scene.seq !== index) {
      issues.push({ severity: 'warning', code: 'page_order', page, message: '页面排序字段不连续，将按保存顺序播放。' });
    }
    const elements = scene.content.type === 'slide'
      ? new Set(scene.content.canvas.elements.map((element) => element.id))
      : new Set<string>();
    const speeches = (scene.actions ?? []).filter(
      (action): action is Extract<Action, { type: 'speech' }> =>
        action.type === 'speech' && Boolean(action.text.trim()),
    );
    if (scene.content.type === 'slide' && elements.size > 0 && speeches.length === 0) {
      issues.push({ severity: 'warning', code: 'missing_speech', page, message: '该页面没有可播放讲稿。' });
    }
    if (speeches.length) speechPages += 1;
    for (const action of scene.actions ?? []) {
      if ((action.type === 'spotlight' || action.type === 'laser' || action.type === 'play_video') && !elements.has(action.elementId)) {
        issues.push({ severity: 'error', code: 'missing_element', page, message: '动作引用了不存在的页面元素。' });
      }
      if (action.type === 'discussion' && action.agentId && !knownAgents.has(action.agentId)) {
        issues.push({ severity: 'error', code: 'missing_agent', page, message: '伴学互动引用了不存在的角色。' });
      }
    }
    for (const speech of speeches) {
      if (!input.requireAudio) continue;
      audioRequired += 1;
      if (speech.audioId && speech.audioUrl) audioReady += 1;
      else issues.push({ severity: 'error', code: 'missing_audio', page, message: '讲稿缺少可播放音频。' });
    }
  }
  return { issues, speechPages, audioCoverage: { required: audioRequired, ready: audioReady } };
}
