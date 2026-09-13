import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { SceneContext } from './regenerate-scene-actions';

export interface ReadCourseStructureDeps {
  listSceneContexts?: () => Array<[sceneId: string, context: SceneContext]>;
  activeSceneId?: string;
}

export const ReadCourseStructureParams = Type.Object({});
export type ReadCourseStructureParams = Static<typeof ReadCourseStructureParams>;

export interface CourseStructureItem {
  sceneId: string;
  order: number;
  title: string;
  type: string;
  description: string;
  keyPoints: string[];
  active: boolean;
}

export interface ReadCourseStructureDetails {
  sceneCount: number;
  scenes: CourseStructureItem[];
}

/** Course-level inventory for Workbench planning before page-level reads/edits. */
export function makeReadCourseStructureTool(
  deps: ReadCourseStructureDeps,
): AgentTool<typeof ReadCourseStructureParams, ReadCourseStructureDetails> {
  return {
    name: 'read_course_structure',
    label: 'Read course structure',
    description:
      'Reads the ordered structure of the entire course. Use it before answering or acting on requests that concern multiple pages, course flow, duplication, omissions, or which page should be edited.',
    parameters: ReadCourseStructureParams,
    execute: async () => {
      const scenes = deps
        .listSceneContexts?.()
        ?? [];
      const orderedScenes = scenes
        .map(([sceneId, context], index) => ({
          sceneId,
          order:
            typeof context.outline.order === 'number' ? context.outline.order : index,
          title: context.outline.title || `Page ${index + 1}`,
          type: context.outline.type,
          description: context.outline.description || '',
          keyPoints: Array.isArray(context.outline.keyPoints)
            ? context.outline.keyPoints.slice(0, 12)
            : [],
          active: sceneId === deps.activeSceneId,
        }))
        .sort((a, b) => a.order - b.order);

      const lines = orderedScenes.map(
        (scene, index) =>
          `${index + 1}. [${scene.sceneId}] ${scene.title} (${scene.type})${scene.active ? ' [current]' : ''}` +
          `${scene.description ? ` — ${scene.description}` : ''}` +
          `${scene.keyPoints.length ? ` | Key points: ${scene.keyPoints.join('; ')}` : ''}`,
      );
      return {
        content: [
          {
            type: 'text',
            text: orderedScenes.length
              ? `Course structure (${orderedScenes.length} scenes):\n${lines.join('\n')}`
              : 'Course structure is empty.',
          },
        ],
        details: { sceneCount: orderedScenes.length, scenes: orderedScenes },
      };
    },
  };
}
