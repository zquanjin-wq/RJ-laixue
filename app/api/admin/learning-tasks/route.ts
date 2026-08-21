/**
 * GET  /api/admin/learning-tasks  — 列出任务
 * POST /api/admin/learning-tasks  — 创建草稿任务（RPC 原子事务）
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { getServiceSupabase } from '@/lib/supabase/server';
import {
  resolveActor,
  checkCoursePublishPermission,
} from '@/lib/server/learning-tasks/permissions';

// ============================================================
// GET
// ============================================================

export async function GET(_request: NextRequest) {
  try {
    const serverSupabase = await getServerSupabase();
    const {
      data: { user },
    } = await serverSupabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { success: false, error: '未登录', errorCode: 'UNAUTHENTICATED' },
        { status: 401 },
      );
    }

    const actor = await resolveActor(user.id);
    if (actor.role === 'learner') {
      return NextResponse.json(
        { success: false, error: '学习者无权管理任务', errorCode: 'FORBIDDEN' },
        { status: 403 },
      );
    }

    const svc = getServiceSupabase();
    let query = svc
      .from('learning_tasks')
      .select(
        'id, course_id, title, description, status, task_type, start_at, due_at, created_by, created_at, updated_at',
      )
      .order('created_at', { ascending: false });

    if (actor.role === 'teacher') {
      query = query.eq('created_by', user.id);
    }

    const { data, error } = await query;
    if (error) throw error;

    const tasks = data ?? [];
    const courseIds = [...new Set(tasks.map((t) => t.course_id).filter(Boolean))];
    const taskIds = tasks.map((t) => t.id);

    // 补充课程标题和学员人数（只读、最小权限查询）
    const [{ data: courses }, { data: learnerCounts }] = await Promise.all([
      courseIds.length > 0
        ? svc.from('courses').select('id, title').in('id', courseIds)
        : Promise.resolve({ data: [] }),
      taskIds.length > 0
        ? svc.rpc('count_task_learners', { p_task_ids: taskIds })
        : Promise.resolve({ data: [] }),
    ]);

    const titleByCourseId = new Map((courses ?? []).map((c) => [c.id, c.title]));
    const countByTaskId = new Map(
      (learnerCounts ?? []).map((r: { task_id?: string; count?: number }) => [
        r.task_id,
        r.count ?? 0,
      ]),
    );

    const enriched = tasks.map((t) => ({
      ...t,
      course_title: titleByCourseId.get(t.course_id) ?? null,
      learner_count: countByTaskId.get(t.id) ?? 0,
    }));

    return NextResponse.json({ success: true, data: enriched });
  } catch (error: unknown) {
    console.error('[admin/learning-tasks] list failed:', error);
    return NextResponse.json(
      { success: false, error: '获取任务列表失败', errorCode: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}

// ============================================================
// POST
// ============================================================

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: '无效的 JSON 请求体', errorCode: 'INVALID_BODY' },
      { status: 400 },
    );
  }

  const rawCourseIds = Array.isArray(body.courseIds) ? body.courseIds : [body.courseId];
  const courseIds = [
    ...new Set(rawCourseIds.filter((id): id is string => typeof id === 'string' && id.length > 0)),
  ];
  const courseId = courseIds[0] ?? '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description : undefined;
  const taskType =
    typeof body.taskType === 'string' && body.taskType === 'remedial' ? 'remedial' : 'normal';
  const sourceTaskId =
    taskType === 'remedial' && typeof body.sourceTaskId === 'string'
      ? body.sourceTaskId
      : undefined;
  const rawLearnerIds = Array.isArray(body.learnerIds) ? body.learnerIds : [];
  const learnerIds: string[] = [
    ...new Set(rawLearnerIds.filter((id: unknown) => typeof id === 'string')),
  ];

  if (!courseId || !title) {
    return NextResponse.json(
      { success: false, error: '缺少必填字段', errorCode: 'MISSING_FIELDS' },
      { status: 400 },
    );
  }

  const startAt = typeof body.startAt === 'string' && body.startAt ? new Date(body.startAt) : null;
  const dueAt = typeof body.dueAt === 'string' && body.dueAt ? new Date(body.dueAt) : null;
  if (startAt && isNaN(startAt.getTime())) {
    return NextResponse.json(
      { success: false, error: '开始时间无效', errorCode: 'INVALID_TIME_RANGE' },
      { status: 400 },
    );
  }
  if (dueAt && isNaN(dueAt.getTime())) {
    return NextResponse.json(
      { success: false, error: '截止时间无效', errorCode: 'INVALID_TIME_RANGE' },
      { status: 400 },
    );
  }

  try {
    const serverSupabase = await getServerSupabase();
    const {
      data: { user },
    } = await serverSupabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { success: false, error: '未登录', errorCode: 'UNAUTHENTICATED' },
        { status: 401 },
      );
    }

    for (const selectedCourseId of courseIds) {
      const permission = await checkCoursePublishPermission(user.id, selectedCourseId);
      if (permission.ok) continue;
      const ec =
        permission.reason === 'course_not_found'
          ? 'COURSE_NOT_FOUND'
          : permission.reason === 'not_admin_or_teacher'
            ? 'FORBIDDEN'
            : 'COURSE_NOT_OWNED';
      return NextResponse.json(
        { success: false, error: '无权基于此课程创建任务', errorCode: ec },
        { status: ec === 'FORBIDDEN' ? 403 : 404 },
      );
    }

    // remedial source task 校验
    if (taskType === 'remedial' && sourceTaskId) {
      const { data: source } = await getServiceSupabase()
        .from('learning_tasks')
        .select('id, created_by')
        .eq('id', sourceTaskId)
        .maybeSingle();
      if (!source) {
        return NextResponse.json(
          { success: false, error: '补学源任务不存在', errorCode: 'TASK_NOT_FOUND' },
          { status: 404 },
        );
      }
    }

    const svc = getServiceSupabase();

    // 执行业务校验
    if (learnerIds.length > 0) {
      const { data: valid, error: le } = await svc
        .from('students')
        .select('id')
        .in('id', learnerIds)
        .is('disabled_at', null);
      if (le) throw le;
      const validSet = new Set((valid ?? []).map((l: { id: string }) => l.id));
      const bad = learnerIds.filter((id: string) => !validSet.has(id));
      if (bad.length > 0) {
        return NextResponse.json(
          {
            success: false,
            error: '所选人员中存在无效或已停用账号，请重新打开人员选择后确认。',
            errorCode: 'INVALID_LEARNERS',
          },
          { status: 400 },
        );
      }
    }

    // 使用 RPC 原子创建
    const { data: rpcResult, error: rpcError } = await svc.rpc('create_task_with_learners', {
      p_course_id: courseId,
      p_title: title,
      p_description: description ?? null,
      p_created_by: user.id,
      p_task_type: taskType,
      p_source_task_id: sourceTaskId ?? null,
      p_start_at: startAt?.toISOString() ?? null,
      p_due_at: dueAt?.toISOString() ?? null,
      p_learner_ids: learnerIds,
    });

    if (rpcError) throw rpcError;

    const taskId = (rpcResult as Record<string, unknown>).task_id;
    if (courseIds.length >= 1) {
      const { error: packageError } = await svc.rpc('replace_task_courses', {
        p_task_id: taskId,
        p_course_ids: courseIds,
      });
      if (packageError) throw packageError;
    }
    const { data: created } = await svc
      .from('learning_tasks')
      .select(
        'id, course_id, title, description, status, task_type, start_at, due_at, created_by, created_at, updated_at',
      )
      .eq('id', taskId)
      .single();

    return NextResponse.json({ success: true, data: created }, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Invalid or disabled')) {
      return NextResponse.json(
        { success: false, error: error.message, errorCode: 'INVALID_LEARNERS' },
        { status: 400 },
      );
    }
    if (error instanceof Error && error.message.includes('due_at cannot be before')) {
      return NextResponse.json(
        { success: false, error: error.message, errorCode: 'INVALID_TIME_RANGE' },
        { status: 400 },
      );
    }
    console.error('[admin/learning-tasks] create failed:', error);
    return NextResponse.json(
      { success: false, error: '创建任务失败', errorCode: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
