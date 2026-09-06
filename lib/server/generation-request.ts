import { z } from 'zod';

// First vertical slice is text -> editable draft. Media/PPT enter after asset binding is ready.
export const generationRequestSchema = z
  .object({
    requirement: z.string().trim().min(1).max(12_000),
    agentMode: z.enum(['default', 'generate']).default('default'),
  })
  .strict();

export const TEXT_GENERATION_PIPELINE_VERSION = 1;
