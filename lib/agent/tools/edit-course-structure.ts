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
const AddBlankOperation = Type.Object({
  type: Type.Literal('add_blank'),
  afterSceneId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
});
const DuplicateOperation = Type.Object({
  type: Type.Literal('duplicate'),
  sceneId: Type.String(),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
});
const DeleteOperation = Type.Object({
  type: Type.Literal('delete'),
  sceneId: Type.String(),
});

export const EditCourseStructureParams = Type.Object({
  operations: Type.Array(Type.Union([
    RenameOperation,
    ReorderOperation,
    AddBlankOperation,
    DuplicateOperation,
    DeleteOperation,
  ]), {
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
      'Renames, reorders, adds a blank slide, duplicates a slide, or deletes a page. Read the course structure first. Reorder must contain every existing scene id exactly once and cannot be mixed with add, duplicate, or delete. Only delete when the user explicitly asks.',
    parameters: EditCourseStructureParams,
    execute: async (_id, params) => {
      const existingIds = (deps.listSceneContexts?.() ?? []).map(([id]) => id);
      const contexts = new Map(deps.listSceneContexts?.() ?? []);
      const existing = new Set(existingIds);
      const changesMembership = params.operations.some((operation) =>
        operation.type === 'add_blank' || operation.type === 'duplicate' || operation.type === 'delete',
      );
      if (changesMembership && params.operations.some((operation) => operation.type === 'reorder')) {
        return refusal('Reorder cannot be combined with add, duplicate, or delete in one call.');
      }
      const deleteIds = new Set(
        params.operations.filter((operation) => operation.type === 'delete').map((operation) => operation.sceneId),
      );
      if (deleteIds.size >= existingIds.length) {
        return refusal('A course must keep at least one page.');
      }
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
        if (operation.type === 'add_blank' && operation.afterSceneId && !existing.has(operation.afterSceneId)) {
          return refusal(`Unknown anchor scene id: ${operation.afterSceneId}`);
        }
        if ((operation.type === 'duplicate' || operation.type === 'delete') && !existing.has(operation.sceneId)) {
          return refusal(`Unknown scene id: ${operation.sceneId}`);
        }
        if (operation.type === 'duplicate' && contexts.get(operation.sceneId)?.outline.type !== 'slide') {
          return refusal('Only slide pages can be duplicated safely.');
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
