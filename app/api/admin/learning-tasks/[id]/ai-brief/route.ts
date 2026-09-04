import { NextRequest, NextResponse } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { getCurrentActor } from '@/lib/server/auth-context';
import { AccessRepository } from '@/lib/server/db/access-repository';
import { LearningAnalyticsRepository } from '@/lib/server/db/learning-analytics-repository';
import { getDatabasePool } from '@/lib/server/db/pool';
import { resolveModel } from '@/lib/server/resolve-model';
import { aiBriefPrompt, buildAiBriefSnapshot, parseAiBrief, type AiBriefContent } from '@/lib/server/learning-tasks/ai-brief';
import { type ReportScene, toLearnerReportRow } from '@/lib/server/learning-tasks/report';

type SnapshotData = { scenes?: Array<{ id?: unknown; type?: unknown; title?: unknown; order?: unknown; seq?: unknown }> };

function scenesFromContent(content: unknown): ReportScene[] {
  const scenes = (content as SnapshotData | null)?.scenes;
  if (!Array.isArray(scenes)) return [];
  return scenes.flatMap((scene, index) => {
    if ((scene.type !== 'slide' && scene.type != null) || typeof scene.id !== 'string') return [];
    return [{ id: scene.id, title: typeof scene.title === 'string' && scene.title ? scene.title : `Chapter ${index + 1}`, order: typeof scene.order === 'number' ? scene.order : typeof scene.seq === 'number' ? scene.seq : null }];
  });
}

async function authorize(taskId: string) {
  const actor = await getCurrentActor();
  if (!actor) return { response: NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 }) };
  if (!(await new AccessRepository(getDatabasePool()).canManageTask(actor, taskId))) return { response: NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 }) };
  return { actor };
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  const auth = await authorize(taskId);
  if ('response' in auth) return auth.response;
  try {
    const data = await new LearningAnalyticsRepository(getDatabasePool()).listBriefs(taskId);
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('[ai-brief] list failed:', error);
    return NextResponse.json({ success: false, errorCode: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  const auth = await authorize(taskId);
  if ('response' in auth) return auth.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ success: false, errorCode: 'INVALID_BODY' }, { status: 400 }); }
  try {
    const repository = new LearningAnalyticsRepository(getDatabasePool());
    const task = await repository.getTask(taskId);
    if (!task) return NextResponse.json({ success: false, errorCode: 'TASK_NOT_FOUND' }, { status: 404 });
    const data = await repository.getTaskAnalytics(taskId);
    const latest = data.events.map((row) => row.created_at).sort().at(-1);
    const { report, dataVersion } = buildAiBriefSnapshot({
      dueAt: task.due_at,
      learners: data.learners.map((row) => toLearnerReportRow(row, row.name)),
      events: data.events,
      scenes: data.courses.flatMap((course) => scenesFromContent(course.content)),
      generatedAt: latest ? new Date(latest) : new Date(),
    });
    const { model, modelString, thinkingConfig } = await resolveModel({
      modelString: typeof body.modelString === 'string' ? body.modelString : undefined,
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
      providerType: typeof body.providerType === 'string' ? body.providerType : undefined,
      thinkingConfig: typeof body.thinkingConfig === 'object' ? (body.thinkingConfig as never) : undefined,
    });
    const llm = await callLLM({ model, system: 'You are a teaching assistant. Use only the supplied learning statistics.', prompt: aiBriefPrompt(report) }, 'learning-brief', undefined, thinkingConfig);
    const parsed = parseAiBrief(llm.text);
    if (!parsed) return NextResponse.json({ success: false, errorCode: 'AI_RESPONSE_INVALID' }, { status: 502 });
    const learnerById = new Map(report.learners.map((learner) => [learner.studentId, learner]));
    const chapterById = new Map(report.chapters.map((chapter) => [chapter.id, chapter]));
    const learnerBriefs = parsed.learnerBriefs.filter((brief) => learnerById.has(brief.studentId));
    const suggestions = parsed.suggestions.flatMap((suggestion) => {
      const learnerIds = suggestion.learnerIds.filter((id) => learnerById.has(id));
      if (!learnerIds.length) return [];
      const sceneIds = suggestion.sceneIds.filter((id) => chapterById.has(id));
      return [{ learnerIds, sceneIds, reason: suggestion.reason, evidence: { learners: learnerIds.map((id) => learnerById.get(id)), chapters: sceneIds.map((id) => chapterById.get(id)) } }];
    });
    const stored = await repository.storeBrief({
      taskId,
      summaries: [{ scope: 'class', userId: null, content: parsed.classBrief, model: modelString, promptVersion: 'gate1e-v1', dataVersion }, ...learnerBriefs.map((brief) => ({ scope: 'learner' as const, userId: brief.studentId, content: brief.content as AiBriefContent, model: modelString, promptVersion: 'gate1e-v1', dataVersion }))],
      suggestions,
    });
    return NextResponse.json({ success: true, data: stored });
  } catch (error) {
    console.error('[ai-brief] generate failed:', error);
    return NextResponse.json({ success: false, errorCode: 'AI_GENERATION_FAILED' }, { status: 502 });
  }
}
