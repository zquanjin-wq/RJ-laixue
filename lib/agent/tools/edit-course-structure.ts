import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { SceneContext } from './regenerate-scene-actions';

const RenameOperation = Type.Object({
  type: Type.Literal('rename'),
  sceneId: Type.String(),
  title: Type.String({ minLength: 1, maxLength: 120 }),
});
const ReorderOperation = Type.Object({
  type: Type.Literal('reorder'),
  sceneIds: Type.Array(Type.String(), { minItems: 1, uniqueItems: true, maxItems: 200 }),
});

export const EditCourseStructureParams = Type.Object({
  operations: Type.Array(Type.Union([RenameOperation, ReorderOperation]), {
    minItems: 1,
    maxItems: 20,
  }),
});
export type EditCourseStructureParams = Static<typeof EditCourseStructureParams>;
export interface EditCourseStructureDetails {
  operations: EditCourseStructureParams['operations'] | null;
  updateCount: number;
  refuseReason?: string;
}

export function makeEditCourseStructureTool(deps: {
  listSceneContexts?: () => Array<[string, SceneContext]>;
}): AgentTool<typeof EditCourseStructureParams, EditCourseStructureDetails> {
  return {
    name: 'edit_course_structure',
    label: 'Edit course structure',
    description:
      'Renames pages or reorders the entire course. Read the course structure first. Reorder must contain every existing scene id exactly once. This tool does not add or delete pages.',
    parameters: EditCourseStructureParams,
    execute: async (_id, params) => {
      const existingIds = (deps.listSceneContexts?.() ?? []).map(([id]) => id);
      const existing = new Set(existingIds);
      for (const operation of params.operations) {
        if (operation.type === 'rename' && !existing.has(operation.sceneId)) {
          return refusal(`Unknown scene id: ${operation.sceneId}`);
        }
        if (operation.type === 'reorder') {
          const proposed = new Set(operation.sceneIds);
          if (
            proposed.size !== existing.size ||
            operation.sceneIds.length !== existingIds.length ||
            existingIds.some((id) => !proposed.has(id))
          ) {
            return refusal('Reorder must include every current scene id exactly once.');
          }
        }
      }
      return {
        content: [{ type: 'text', text: `Prepared ${params.operations.length} course structure update(s).` }],
        details: { operations: params.operations, updateCount: params.operations.length },
      };
    },
  };
}

function refusal(reason: string) {
  return {
    content: [{ type: 'text' as const, text: `Could not edit course structure: ${reason}` }],
    details: { operations: null, updateCount: 0, refuseReason: reason },
    isError: true,
  };
}
