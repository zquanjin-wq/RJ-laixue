import { z } from 'zod';

// First vertical slice is text -> editable draft. Media/PPT enter after asset binding is ready.
export const generationRequestSchema = z
  .object({
    requirement: z.string().trim().min(1).max(12_000),
    agentMode: z.enum(['default', 'generate']).default('default'),
    // A completed AI course must be immediately playable.  The durable text
    // pipeline is the only creator that previously omitted this flag, which
    // silently skipped its TTS phase and left the first cloud save to create
    // the audio instead.  Keep this opt-out for API callers, but make sound
    // part of the default course-completion contract.
    enableTTS: z.boolean().default(true),
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
    teacherVoice: z
      .object({ providerId: z.string().trim().min(1).max(80), modelId: z.string().trim().max(120).optional(), voiceId: z.string().trim().min(1).max(160) })
      .optional(),
    companionCount: z.number().int().min(1).max(3).default(1),
    applySafeRepairs: z.boolean().default(true),
  })
  .strict();

export const PPTX_AI_CLASSROOM_PIPELINE_VERSION = 1;
export type PptxAiClassroomRequest = z.infer<typeof pptxAiClassroomRequestSchema>;
