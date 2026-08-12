import { NextRequest, NextResponse } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { resolveModel } from '@/lib/server/resolve-model';
import { resolveActor } from '@/lib/server/learning-tasks/permissions';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';

type RequestBody = {
  question?: unknown;
  modelString?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  providerType?: unknown;
  thinkingConfig?: unknown;
};

export async function POST(request: NextRequest) {
  const server = await getServerSupabase();
  const {
    data: { user },
  } = await server.auth.getUser();
  if (!user)
    return NextResponse.json(
      { success: false, error: '请先登录', errorCode: 'UNAUTHENTICATED' },
      { status: 401 },
    );

  const actor = await resolveActor(user.id);
  if (actor.role === 'learner')
    return NextResponse.json(
      { success: false, error: '无权访问教学数据', errorCode: 'FORBIDDEN' },
      { status: 403 },
    );

  let body: RequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: '请求格式错误', errorCode: 'INVALID_BODY' },
      { status: 400 },
    );
  }
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question)
    return NextResponse.json(
      { success: false, error: '请输入问题', errorCode: 'QUESTION_REQUIRED' },
      { status: 400 },
    );

  try {
    const svc = getServiceSupabase();
    let taskQuery = svc
      .from('learning_tasks')
      .select('id, title, due_at, status, created_by')
      .eq('status', 'published')
      .order('created_at', { ascending: false });
    if (actor.role === 'teacher') taskQuery = taskQuery.eq('created_by', user.id);
    const { data: tasks, error: taskError } = await taskQuery;
    if (taskError) throw taskError;
    const taskIds = (tasks ?? []).map((task) => task.id);
    const { data: learners, error: learnerError } = taskIds.length
      ? await svc
          .from('task_learners')
          .select('task_id, student_id, status, progress_percent, effective_seconds, last_seen_at')
          .in('task_id', taskIds)
      : { data: [], error: null };
    if (learnerError) throw learnerError;
    const studentIds = [...new Set((learners ?? []).map((row) => row.student_id))];
    const { data: students, error: studentError } = studentIds.length
      ? await svc.from('students').select('id, name').in('id', studentIds)
      : { data: [], error: null };
    if (studentError) throw studentError;

    const names = new Map((students ?? []).map((student) => [student.id, student.name]));
    const now = Date.now();
    const taskData = (tasks ?? []).map((task) => {
      const roster = (learners ?? []).filter((row) => row.task_id === task.id);
      const started = roster.filter((row) => row.status !== 'not_started').length;
      const completed = roster.filter((row) => row.status === 'completed').length;
      const overdue = roster.filter(
        (row) => task.due_at && new Date(task.due_at).getTime() < now && row.status !== 'completed',
      ).length;
      return {
        title: task.title || '未命名任务',
        learnerCount: roster.length,
        startedCount: started,
        completedCount: completed,
        startRate: roster.length ? Math.round((started / roster.length) * 100) : 0,
        completionRate: roster.length ? Math.round((completed / roster.length) * 100) : 0,
        overdueCount: overdue,
        effectiveMinutes: Math.round(
          roster.reduce((sum, row) => sum + Number(row.effective_seconds ?? 0), 0) / 60,
        ),
      };
    });
    const attention = (learners ?? [])
      .filter((row) => row.status === 'not_started')
      .slice(0, 20)
      .map((row) => ({
        task: (tasks ?? []).find((task) => task.id === row.task_id)?.title || '未命名任务',
        learner: names.get(row.student_id) || '未命名学员',
      }));

    const { model, thinkingConfig } = await resolveModel({
      stage: 'teaching-data-chat',
      modelString: typeof body.modelString === 'string' ? body.modelString : undefined,
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
      providerType: typeof body.providerType === 'string' ? body.providerType : undefined,
      thinkingConfig:
        typeof body.thinkingConfig === 'object' ? (body.thinkingConfig as never) : undefined,
    });
    const result = await callLLM(
      {
        model,
        system:
          '你是教学数据助手。只能依据提供的统计数据作答；数据没有给出的内容要明确说“暂无数据”。回答简洁，优先给出可执行的教学或运营建议。不要虚构学员成绩、章节问题或课程详情。',
        prompt: `问题：${question}\n\n当前教师权限范围内的任务统计：${JSON.stringify({ tasks: taskData, notStartedLearners: attention })}`,
      },
      'teaching-data-chat',
      undefined,
      thinkingConfig,
    );

    return NextResponse.json(
      { success: true, data: { answer: result.text } },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    console.error('[teaching-data-chat] failed:', error);
    return NextResponse.json(
      { success: false, error: 'AI 数据问答暂时不可用，请稍后重试', errorCode: 'AI_QUERY_FAILED' },
      { status: 500 },
    );
  }
}
