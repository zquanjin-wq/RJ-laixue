import { createHash } from 'node:crypto';
import { generateSceneActions, type AgentInfo, type SceneGenerationContext } from '@/lib/generation/generation-pipeline';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { PptxClassroomRosterMember, PptxPageScript } from './draft';
import type { PptxPageInspection } from './inspection';

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

function requiredSpeech(script: PptxPageScript): Action {
  return {
    id: stableId('pptx-speech', `${script.sceneId}:${script.text}`),
    type: 'speech',
    title: script.sourceKind === 'speaker_notes_rewritten' ? '基于讲者备注的讲解' : 'AI 讲解',
    text: script.text,
  };
}

/**
 * Remove model-generated references that cannot be played by the imported
 * slide. This is intentionally safe to run on checkpointed actions as well as
 * newly generated actions.
 */
export function sanitizePptxPageActions(
  scene: Scene,
  roster: Array<Pick<PptxClassroomRosterMember, 'id'>>,
  actions: Action[],
): Action[] {
  const elementIds = new Set(
    scene.content.type === 'slide'
      ? scene.content.canvas.elements.map((element) => element.id)
      : [],
  );
  const agentIds = new Set(roster.map((agent) => agent.id));

  return actions.filter((action) => {
    if (
      (action.type === 'spotlight' || action.type === 'laser' || action.type === 'play_video') &&
      !elementIds.has(action.elementId)
    ) {
      return false;
    }
    if (action.type === 'discussion' && action.agentId && !agentIds.has(action.agentId)) {
      return false;
    }
    return true;
  });
}

/**
 * Adapt the existing course action generator to an imported slide. The canvas
 * is never regenerated: only actions are produced, and every spotlight is
 * validated by the shared generator against this page's actual element IDs.
 */
export async function generatePptxPageActions(input: {
  scene: Scene;
  inspection: PptxPageInspection;
  script: PptxPageScript;
  pageIndex: number;
  allTitles: string[];
  previousSpeeches: string[];
  roster: PptxClassroomRosterMember[];
  languageDirective: string;
  interactionIntensity: 'light' | 'standard' | 'rich';
  aiCall: AICallFn;
}): Promise<Action[]> {
  const canvas = input.scene.content.type === 'slide' ? input.scene.content.canvas : undefined;
  const speech = requiredSpeech(input.script);
  if (!canvas) return [speech];

  const outline: SceneOutline = {
    id: input.scene.outlineId || input.scene.id,
    type: 'slide',
    title: input.inspection.title,
    description: input.inspection.visibleText.slice(0, 3).join('；') || input.inspection.title,
    keyPoints: input.inspection.visibleText.slice(0, 5),
    order: input.pageIndex + 1,
  };
  const context: SceneGenerationContext = {
    pageIndex: input.pageIndex + 1,
    totalPages: input.allTitles.length,
    allTitles: input.allTitles,
    previousSpeeches: input.previousSpeeches,
  };
  const generated = await generateSceneActions(
    outline,
    { elements: canvas.elements, background: canvas.background },
    input.aiCall,
    {
      ctx: context,
      agents: input.roster as AgentInfo[],
      userProfile:
        input.interactionIntensity === 'light'
          ? 'Interaction intensity: light. Prefer uninterrupted explanation; add a discussion only when it is clearly useful.'
          : input.interactionIntensity === 'rich'
            ? 'Interaction intensity: rich. Add meaningful learner-facing discussion or checks when the slide supports them, without interrupting every sentence.'
            : 'Interaction intensity: standard. Use occasional meaningful learner-facing discussion or checks, not one on every slide.',
      languageDirective: input.languageDirective,
    },
  );

  // The generator owns page cues and interaction selection. The narration
  // text itself was prepared in the preceding Skill step from the teacher's
  // requirement and speaker-notes draft, so replace only speech payloads.
  let speechPlaced = false;
  const actions = generated.map((action) => {
    if (action.type !== 'speech' || speechPlaced) return action;
    speechPlaced = true;
    return speech;
  });
  if (!speechPlaced) actions.push(speech);
  return sanitizePptxPageActions(input.scene, input.roster, actions);
}
