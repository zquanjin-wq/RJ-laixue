/**
 * GET    /api/admin/learning-tasks/[id]  — 任务详情
 * PATCH  /api/admin/learning-tasks/[id]  — 更新草稿任务
 * DELETE /api/admin/learning-tasks/[id]  — 删除草稿任务
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { getServiceSupabase } from '@/lib/supabase/server';
import { resolveActor, checkTaskManagePermission } from '@/lib/server/learning-tasks/permissions';

// ============================================================
// GET — 任务详情
// ============================================================

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

    const { id: taskId } = await params;
    const permission = await checkTaskManagePermission(user.id, taskId);
    if (!permission.ok) {
      const errorCode =
        permission.reason === 'not_admin_or_teacher'
          ? 'FORBIDDEN'
          : permission.reason === 'task_not_found'
            ? 'TASK_NOT_FOUND'
            : 'FORBIDDEN';
      const status = errorCode === 'TASK_NOT_FOUND' ? 404 : errorCode === 'FORBIDDEN' ? 403 : 403;
      return NextResponse.json({ success: false, error: '无权访问此任务', errorCode }, { status });
    }

    const serviceSupabase = getServiceSupabase();
    const { data: task, error } = await serviceSupabase
      .from('learning_tasks')
      .select(
        'id, course_id, title, description, status, task_type, start_at, due_at, share_token, published_at, created_by, created_at, updated_at, snapshot_id, source_task_id, completion_rule',
      )
      .eq('id', taskId)
      .single();

    if (error) {
      if ((error as { code?: string }).code === 'PGRST116') {
        return NextResponse.json(
          { success: false, error: '任务不存在', errorCode: 'TASK_NOT_FOUND' },
          { status: 404 },
        );
      }
      throw error;
    }

    // 附学员名单
    const { data: learners } = await serviceSupabase
      .from('task_learners')
      .select(
        'id, student_id, status, progress_percent, completed_scene_count, total_scene_count, assigned_at',
      )
      .eq('task_id', taskId);
    const learnerIds = (learners ?? []).map((learner) => learner.student_id);
    const { data: learnerProfiles } = learnerIds.length
      ? await serviceSupabase.from('students').select('id, name, email').in('id', learnerIds)
      : { data: [] };
    const learnerProfileById = new Map(
      (learnerProfiles ?? []).map((learner) => [learner.id, learner]),
    );

    const { data: taskCourses } = await serviceSupabase
      .from('task_courses')
      .select('course_id, position, is_required, snapshot_id')
      .eq('task_id', taskId)
      .order('position');
    const courseIds = (taskCourses ?? []).map((item) => item.course_id);
    const { data: courses } = courseIds.length
      ? await serviceSupabase.from('courses').select('id, title').in('id', courseIds)
      : { data: [] };
    const titleById = new Map((courses ?? []).map((course) => [course.id, course.title]));
    return NextResponse.json({
      success: true,
      data: {
        ...task,
        learners: (learners ?? []).map((learner) => ({
          ...learner,
          name: learnerProfileById.get(learner.student_id)?.name ?? '未知人员',
          email: learnerProfileById.get(learner.student_id)?.email ?? null,
        })),
        courses: (taskCourses ?? []).map((item) => ({
          ...item,
          title: titleById.get(item.course_id) ?? null,
        })),
      },
    });
  } catch (error: unknown) {
    console.error('[admin/learning-tasks/[id]] get failed:', error);
    return NextResponse.json(
      { success: false, error: '获取任务详情失败', errorCode: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}

// ============================================================
// PATCH — 更新草稿任务
// ============================================================

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let body: Record<string, unknown> = {};

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: '无效的 JSON 请求体', errorCode: 'INVALID_BODY' },
      { status: 400 },
    );
  }

  const { id: taskId } = await params;

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

    const permission = await checkTaskManagePermission(user.id, taskId);
    if (!permission.ok) {
      return NextResponse.json(
        {
          success: false,
          error: '无权修改此任务',
          errorCode: permission.reason === 'not_admin_or_teacher' ? 'FORBIDDEN' : 'FORBIDDEN',
        },
        { status: 403 },
      );
    }

    const serviceSupabase = getServiceSupabase();

    // 查当前状态
    const { data: task } = await serviceSupabase
      .from('learning_tasks')
      .select('id, status, created_by')
      .eq('id', taskId)
      .single();

    if (!task) {
      return NextResponse.json(
        { success: false, error: '任务不存在', errorCode: 'TASK_NOT_FOUND' },
        { status: 404 },
      );
    }

    if (task.status !== 'draft') {
      return NextResponse.json(
        { success: false, error: '只能修改草稿任务', errorCode: 'TASK_NOT_DRAFT' },
        { status: 400 },
      );
    }

    // 只允许修改部分字段
    const patch: Record<string, unknown> = {};
    if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim();
    if (typeof body.description === 'string') patch.description = body.description || null;

    if (typeof body.startAt === 'string' && body.startAt) {
      const d = new Date(body.startAt);
      if (isNaN(d.getTime())) {
        return NextResponse.json(
          { success: false, error: '开始时间无效', errorCode: 'INVALID_TIME_RANGE' },
          { status: 400 },
        );
      }
      patch.start_at = d.toISOString();
    }
    if (body.startAt === null) patch.start_at = null;

    if (typeof body.dueAt === 'string' && body.dueAt) {
      const d = new Date(body.dueAt);
      if (isNaN(d.getTime())) {
        return NextResponse.json(
          { success: false, error: '截止时间无效', errorCode: 'INVALID_TIME_RANGE' },
          { status: 400 },
        );
      }
      patch.due_at = d.toISOString();
    }
    if (body.dueAt === null) patch.due_at = null;

    if (Object.keys(patch).length === 0) {
      // 没有可更新的字段，直接返回当前任务
      return NextResponse.json({ success: true, data: task });
    }

    const { data: updated, error } = await serviceSupabase
      .from('learning_tasks')
      .update(patch)
      .eq('id', taskId)
      .select(
        'id, course_id, title, description, status, task_type, start_at, due_at, created_by, created_at, updated_at',
      )
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, data: updated });
  } catch (error: unknown) {
    console.error('[admin/learning-tasks/[id]] patch failed:', error);
    return NextResponse.json(
      { success: false, error: '更新任务失败', errorCode: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}

// ============================================================
// DELETE — 删除草稿任务
// ============================================================

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

    const { id: taskId } = await params;
    const permission = await checkTaskManagePermission(user.id, taskId);
    if (!permission.ok) {
      const errorCode = permission.reason === 'task_not_found' ? 'TASK_NOT_FOUND' : 'FORBIDDEN';
      return NextResponse.json(
        {
          success: false,
          error: errorCode === 'TASK_NOT_FOUND' ? '任务不存在' : '无权删除此任务',
          errorCode,
        },
        { status: errorCode === 'TASK_NOT_FOUND' ? 404 : 403 },
      );
    }

    const serviceSupabase = getServiceSupabase();
    const { data: task, error: taskError } = await serviceSupabase
      .from('learning_tasks')
      .select('id, status')
      .eq('id', taskId)
      .single();

    if (taskError || !task) {
      return NextResponse.json(
        { success: false, error: '任务不存在', errorCode: 'TASK_NOT_FOUND' },
        { status: 404 },
      );
    }
    if (task.status !== 'draft') {
      return NextResponse.json(
        { success: false, error: '只能删除草稿任务', errorCode: 'TASK_NOT_DRAFT' },
        { status: 400 },
      );
    }

    // 补学建议可能保留着该草稿的引用；删除前解除即可，其余任务明细会级联清理。
    const { error: suggestionError } = await serviceSupabase
      .from('ai_intervention_suggestions')
      .update({ created_task_id: null })
      .eq('created_task_id', taskId);
    if (suggestionError && (suggestionError as { code?: string }).code !== '42P01')
      throw suggestionError;

    const { error: deleteError } = await serviceSupabase
      .from('learning_tasks')
      .delete()
      .eq('id', taskId);
    if (deleteError) throw deleteError;

    return NextResponse.json({ success: true, data: { id: taskId } });
  } catch (error: unknown) {
    console.error('[admin/learning-tasks/[id]] delete failed:', error);
    return NextResponse.json(
      { success: false, error: '删除任务失败', errorCode: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
