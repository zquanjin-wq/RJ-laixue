import { NextRequest, NextResponse } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { getCurrentActor } from '@/lib/server/auth-context';
import { getDatabasePool } from '@/lib/server/db/pool';
import { resolveModel } from '@/lib/server/resolve-model';

type RequestBody = {
  question?: unknown;
  modelString?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  providerType?: unknown;
  thinkingConfig?: unknown;
};

type TaskRow = {
  id: string;
  title: string | null;
  due_at: string | null;
};

type LearnerRow = {
  task_id: string;
  student_name: string | null;
  status: string;
  effective_seconds: number | string | null;
};

export async function POST(request: NextRequest) {
  const actor = await getCurrentActor();
  if (!actor)
    return NextResponse.json(
      { success: false, error: '请先登录', errorCode: 'UNAUTHENTICATED' },
      { status: 401 },
    );
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
    const pool = getDatabasePool();
    const ownerUserId = actor.role === 'teacher' ? actor.userId : null;
    const tasksResult = await pool.query<TaskRow>(
      `SELECT id::text, title, due_at::text
         FROM app.learning_tasks
        WHERE status = 'published'
          AND ($1::text IS NULL OR created_by = $1)
        ORDER BY created_at DESC`,
      [ownerUserId],
    );
    const tasks = tasksResult.rows;
    const taskIds = tasks.map((task) => task.id);
    const learnersResult = taskIds.length
      ? await pool.query<LearnerRow>(
          `SELECT assignment.task_id::text,
                  COALESCE(profile.display_name, account.name) AS student_name,
                  assignment.status,
                  assignment.effective_seconds
             FROM app.task_assignments assignment
             JOIN public."user" account ON account.id = assignment.user_id
             LEFT JOIN app.user_profiles profile ON profile.user_id = assignment.user_id
            WHERE assignment.task_id = ANY($1::uuid[])`,
          [taskIds],
        )
      : { rows: [] as LearnerRow[] };
    const learners = learnersResult.rows;

    const now = Date.now();
    const taskData = tasks.map((task) => {
      const roster = learners.filter((row) => row.task_id === task.id);
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
    const taskTitles = new Map(tasks.map((task) => [task.id, task.title || '未命名任务']));
    const attention = learners
      .filter((row) => row.status === 'not_started')
      .slice(0, 20)
      .map((row) => ({
        task: taskTitles.get(row.task_id) || '未命名任务',
        learner: row.student_name || '未命名学员',
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
