import { createHash } from 'node:crypto';
import type { Action } from '@/lib/types/action';
import type { Scene, Stage } from '@/lib/types/stage';
import type { PptxPageInspection } from './inspection';

export interface PptxClassroomRosterMember {
  id: string;
  name: string;
  role: 'teacher' | 'assistant' | 'student';
  persona: string;
  avatar: string;
  color: string;
  priority: number;
  voiceDesign?: { identity: string; texture: string; delivery: string };
}

export interface PptxPageScript {
  sceneId: string;
  text: string;
  sourceKind: 'speaker_notes' | 'ai_generated';
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

/**
 * Adds a stable minimal playback timeline to imported slides. AI-generated
 * spotlight/laser cues may be appended later, but a valid speech action is
 * never replaced by a cue that points at an unknown element.
 */
export function applyPptxScriptsToScenes(
  scenes: Scene[],
  scripts: PptxPageScript[],
  options: { interactionIntensity?: 'light' | 'standard' | 'rich'; companionId?: string } = {},
): Scene[] {
  const bySceneId = new Map(scripts.map((script) => [script.sceneId, script]));
  return scenes.map((scene) => {
    const script = bySceneId.get(scene.id);
    if (!script) return scene;
    const action: Action = {
      id: stableId('pptx-speech', `${scene.id}:${script.text}`),
      type: 'speech',
      title: script.sourceKind === 'speaker_notes' ? '讲者备注' : 'AI 讲解',
      text: script.text,
    };
    const actions: Action[] = [];
    const canvas = scene.content.type === 'slide' ? scene.content.canvas : undefined;
    const focusElement = canvas?.elements.find(
      (element) => element.type === 'text' && typeof element.id === 'string' && element.id,
    );
    if (focusElement) {
      actions.push({
        id: stableId('pptx-spotlight', `${scene.id}:${focusElement.id}`),
        type: 'spotlight',
        title: '聚焦重点',
        elementId: focusElement.id,
      });
    }
    actions.push(action);
    const page = scenes.findIndex((candidate) => candidate.id === scene.id) + 1;
    const every = options.interactionIntensity === 'rich' ? 2 : options.interactionIntensity === 'light' ? 5 : 3;
    if (options.companionId && page > 0 && page % every === 0) {
      actions.push({
        id: stableId('pptx-discussion', `${scene.id}:${options.companionId}`),
        type: 'discussion',
        title: '伴学提问',
        topic: scene.title,
        prompt: '请结合本页内容，用自己的话说出最重要的一点。',
        agentId: options.companionId,
      });
    }
    return { ...scene, actions, updatedAt: Date.now() };
  });
}

export function applyPptxRoster(
  stage: Stage,
  roster: PptxClassroomRosterMember[],
): Stage {
  const teachers = roster.filter((member) => member.role === 'teacher');
  if (teachers.length !== 1) throw new Error('PPTX classroom roster requires exactly one teacher');
  return {
    ...stage,
    generatedAgentConfigs: roster,
    updatedAt: Date.now(),
  };
}

export function scriptsFromSpeakerNotes(inspections: PptxPageInspection[]): PptxPageScript[] {
  return inspections.flatMap((page) => {
    const text = page.speakerNotes?.trim();
    return text ? [{ sceneId: page.sceneId, text, sourceKind: 'speaker_notes' as const }] : [];
  });
}
