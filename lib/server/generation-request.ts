import { z } from 'zod';

// First vertical slice is text -> editable draft. Media/PPT enter after asset binding is ready.
export const generationRequestSchema = z
  .object({
    requirement: z.string().trim().min(1).max(12_000),
    agentMode: z.enum(['default', 'generate']).default('default'),
  })
  .strict();

export const TEXT_GENERATION_PIPELINE_VERSION = 1;

/**
 * Enhancement input for the visible "通过 PPT 创建" flow. The imported course
 * already exists; this job enriches that exact revision instead of creating a
 * second course from the same upload.
 */
export const pptxAiClassroomRequestSchema = z
  .object({
    sourceId: z.string().uuid(),
    courseId: z.string().uuid(),
    sourceRevision: z.number().int().positive(),
    // The PPT supplies visual/source material; this requirement supplies the
    // teacher's intent that governs narration, classroom roles and interaction.
    teachingRequirement: z.string().trim().min(1).max(12_000),
    languageDirective: z.string().trim().min(1).max(80).default('zh-CN'),
    interactionIntensity: z.enum(['light', 'standard', 'rich']).default('standard'),
    enableTTS: z.boolean().default(true),
    applySafeRepairs: z.boolean().default(true),
  })
  .strict();

export const PPTX_AI_CLASSROOM_PIPELINE_VERSION = 1;
export type PptxAiClassroomRequest = z.infer<typeof pptxAiClassroomRequestSchema>;
