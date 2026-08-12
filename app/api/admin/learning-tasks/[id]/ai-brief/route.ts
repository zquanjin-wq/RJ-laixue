import { NextRequest, NextResponse } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { resolveModel } from '@/lib/server/resolve-model';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { checkTaskManagePermission } from '@/lib/server/learning-tasks/permissions';
import {
  aiBriefPrompt,
  buildAiBriefSnapshot,
  parseAiBrief,
  type AiBriefContent,
} from '@/lib/server/learning-tasks/ai-brief';
import { toLearnerReportRow, type ReportScene } from '@/lib/server/learning-tasks/report';

type SnapshotData = {
  scenes?: Array<{ id?: unknown; type?: unknown; title?: unknown; order?: unknown; seq?: unknown }>;
};

function scenesFromSnapshot(snapshot: unknown): ReportScene[] {
  const scenes = (snapshot as SnapshotData | null)?.scenes;
  if (!Array.isArray(scenes)) return [];
  return scenes.flatMap((scene, index) => {
    if ((scene.type !== 'slide' && scene.type != null) || typeof scene.id !== 'string') return [];
    return [
      {
        id: scene.id,
        title: typeof scene.title === 'string' && scene.title ? scene.title : `第 ${index + 1} 节`,
        order:
          typeof scene.order === 'number'
            ? scene.order
            : typeof scene.seq === 'number'
              ? scene.seq
              : null,
      },
    ];
  });
}

async function authorize(taskId: string): Promise<{ error: NextResponse } | { userId: string }> {
  const server = await getServerSupabase();
  const {
    data: { user },
  } = await server.auth.getUser();
  if (!user)
    return {
      error: NextResponse.json(
        { success: false, error: '请先登录', errorCode: 'UNAUTHENTICATED' },
        { status: 401 },
      ),
    };
  const permission = await checkTaskManagePermission(user.id, taskId);
  if (!permission.ok) {
    const status = permission.reason === 'task_not_found' ? 404 : 403;
    return {
      error: NextResponse.json(
        {
          success: false,
          error: '无权管理此任务',
          errorCode: status === 404 ? 'TASK_NOT_FOUND' : 'FORBIDDEN',
        },
        { status },
      ),
    };
  }
  return { userId: user.id };
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  const auth = await authorize(taskId);
  if ('error' in auth) return auth.error;
  try {
    const svc = getServiceSupabase();
    const [
      { data: summaries, error: summaryError },
      { data: suggestions, error: suggestionError },
    ] = await Promise.all([
      svc
        .from('ai_learning_summaries')
        .select('id, scope, student_id, content, model, data_version, created_at')
        .eq('task_id', taskId)
        .order('created_at', { ascending: false }),
      svc
        .from('ai_intervention_suggestions')
        .select('id, learner_ids, scene_ids, reason, evidence, status, created_task_id, created_at')
        .eq('task_id', taskId)
        .order('created_at', { ascending: false }),
    ]);
    if (summaryError) throw summaryError;
    if (suggestionError) throw suggestionError;
    return NextResponse.json(
      { success: true, data: { summaries: summaries ?? [], suggestions: suggestions ?? [] } },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    console.error('[ai-brief] get failed:', error);
    return NextResponse.json(
      { success: false, error: '获取 AI 简报失败', errorCode: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  const auth = await authorize(taskId);
  if ('error' in auth) return auth.error;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: '无效请求', errorCode: 'INVALID_BODY' },
      { status: 400 },
    );
  }

  try {
    const svc = getServiceSupabase();
    const { data: task, error: taskError } = await svc
      .from('learning_tasks')
      .select('id, due_at, snapshot_id')
      .eq('id', taskId)
      .maybeSingle();
    if (taskError) throw taskError;
    if (!task)
      return NextResponse.json(
        { success: false, error: '任务不存在', errorCode: 'TASK_NOT_FOUND' },
        { status: 404 },
      );
    const [
      { data: learnerRows, error: learnerError },
      { data: eventRows, error: eventError },
      { data: snapshot, error: snapshotError },
    ] = await Promise.all([
      svc
        .from('task_learners')
        .select(
          'student_id, status, progress_percent, mastery_percent, effective_seconds, last_seen_at',
        )
        .eq('task_id', taskId),
      svc
        .from('task_learning_events')
        .select('student_id, event_type, scene_id, created_at')
        .eq('task_id', taskId),
      task.snapshot_id
        ? svc
            .from('course_snapshots')
            .select('snapshot_data')
            .eq('id', task.snapshot_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (learnerError) throw learnerError;
    if (eventError) throw eventError;
    if (snapshotError) throw snapshotError;
    const studentIds = (learnerRows ?? []).map((row) => row.student_id);
    const { data: students, error: studentError } = studentIds.length
      ? await svc.from('students').select('id, name').in('id', studentIds)
      : { data: [], error: null };
    if (studentError) throw studentError;
    const names = new Map((students ?? []).map((student) => [student.id, student.name]));
    const latest = (eventRows ?? [])
      .map((row) => row.created_at)
      .filter((value): value is string => typeof value === 'string')
      .sort()
      .at(-1);
    const { report, dataVersion } = buildAiBriefSnapshot({
      dueAt: task.due_at,
      learners: (learnerRows ?? []).map((row) =>
        toLearnerReportRow(row, names.get(row.student_id) ?? ''),
      ),
      events: (eventRows ?? []).map((row) => ({
        student_id: row.student_id,
        event_type: row.event_type,
        scene_id: row.scene_id,
      })),
      scenes: scenesFromSnapshot(snapshot?.snapshot_data),
      generatedAt: latest ? new Date(latest) : new Date(),
    });
    const { model, modelString, thinkingConfig } = await resolveModel({
      modelString: typeof body.modelString === 'string' ? body.modelString : undefined,
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
      providerType: typeof body.providerType === 'string' ? body.providerType : undefined,
      thinkingConfig:
        typeof body.thinkingConfig === 'object' ? (body.thinkingConfig as never) : undefined,
    });
    const llm = await callLLM(
      {
        model,
        system: '你是教学助理。只解释提供的学习统计，不编造事实或成绩。',
        prompt: aiBriefPrompt(report),
      },
      'learning-brief',
      undefined,
      thinkingConfig,
    );
    const parsed = parseAiBrief(llm.text);
    if (!parsed)
      return NextResponse.json(
        { success: false, error: 'AI 返回格式无法识别，请重试', errorCode: 'AI_RESPONSE_INVALID' },
        { status: 502 },
      );

    const learnerById = new Map(report.learners.map((learner) => [learner.studentId, learner]));
    const chapterById = new Map(report.chapters.map((chapter) => [chapter.id, chapter]));
    const learnerBriefs = parsed.learnerBriefs.filter((brief) => learnerById.has(brief.studentId));
    const suggestionsForStorage = parsed.suggestions.flatMap((suggestion) => {
      const learnerIds = suggestion.learnerIds.filter((id) => learnerById.has(id));
      if (!learnerIds.length) return [];
      const sceneIds = suggestion.sceneIds.filter((id) => chapterById.has(id));
      return [
        {
          ...suggestion,
          learnerIds,
          sceneIds,
          evidence: {
            learners: learnerIds.map((id) => learnerById.get(id)),
            chapters: sceneIds.map((id) => chapterById.get(id)),
          },
        },
      ];
    });
    const summaryRows = [
      {
        task_id: taskId,
        scope: 'class',
        student_id: null,
        content: parsed.classBrief,
        model: modelString,
        prompt_version: 'gate1e-v1',
        data_version: dataVersion,
      },
      ...learnerBriefs.map((brief) => ({
        task_id: taskId,
        scope: 'learner',
        student_id: brief.studentId,
        content: brief.content,
        model: modelString,
        prompt_version: 'gate1e-v1',
        data_version: dataVersion,
      })),
    ];
    const { data: summaries, error: insertSummaryError } = await svc
      .from('ai_learning_summaries')
      .insert(summaryRows)
      .select('id, scope, student_id, content, model, data_version, created_at');
    if (insertSummaryError) throw insertSummaryError;
    const suggestionRows = suggestionsForStorage.map((suggestion) => ({
      task_id: taskId,
      learner_ids: suggestion.learnerIds,
      scene_ids: suggestion.sceneIds,
      reason: suggestion.reason,
      evidence: suggestion.evidence,
    }));
    const { data: suggestions, error: insertSuggestionError } = suggestionRows.length
      ? await svc
          .from('ai_intervention_suggestions')
          .insert(suggestionRows)
          .select(
            'id, learner_ids, scene_ids, reason, evidence, status, created_task_id, created_at',
          )
      : { data: [], error: null };
    if (insertSuggestionError) throw insertSuggestionError;
    return NextResponse.json({
      success: true,
      data: { summaries: summaries ?? [], suggestions: suggestions ?? [] },
    });
  } catch (error) {
    console.error('[ai-brief] generate failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'AI 简报生成失败，请检查模型配置后重试',
        errorCode: 'AI_GENERATION_FAILED',
      },
      { status: 502 },
    );
  }
}
