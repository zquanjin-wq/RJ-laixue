import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { Slide } from '@openmaic/dsl';
import { resolveApiToken } from '@/lib/server/api-token';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';
import { PptxSourceRepository } from '@/lib/server/db/pptx-source-repository';
import { createPptxCourseDraft } from '@/lib/import/pptx-course-draft';

export const runtime = 'nodejs';

const requestSchema = z.object({
  sourceId: z.string().uuid(),
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => /\.pptx$/i.test(value)),
  slides: z.array(z.unknown()).min(1).max(200),
  title: z.string().trim().min(1).max(200).optional(),
});

/**
 * Creates the revision-anchored editable draft after an external Skill has
 * parsed the PPTX with the same OpenMAIC importer contract used by the web UI.
 */
export async function POST(request: NextRequest) {
  const pool = getDatabasePool();
  const actor = await resolveApiToken(pool, request.headers.get('authorization'));
  if (!actor || actor.role === 'learner' || !actor.scopes.includes('classroom:write')) {
    return NextResponse.json({ errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ errorCode: 'INVALID_REQUEST' }, { status: 400 });
  const source = await new PptxSourceRepository(pool).getOwned(parsed.data.sourceId, actor.userId);
  if (!source) return NextResponse.json({ errorCode: 'SOURCE_NOT_FOUND' }, { status: 404 });

  const courseId = randomUUID();
  const draft = createPptxCourseDraft({
    courseId,
    fileName: parsed.data.fileName,
    slides: parsed.data.slides as Slide[],
    sourceId: source.id,
  });
  const course = await new CourseRepository(pool).createCourse({
    id: courseId,
    ownerUserId: actor.userId,
    title: parsed.data.title ?? draft.title,
    content: draft,
    saveState: 'draft',
  });
  return NextResponse.json(
    { courseId: course.id, sourceRevision: course.contentRevision, saveState: course.saveState },
    { status: 201 },
  );
}
