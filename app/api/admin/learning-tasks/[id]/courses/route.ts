import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import {
  checkCoursePublishPermission,
  checkTaskManagePermission,
} from '@/lib/server/learning-tasks/permissions';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();
  if (!user)
    return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  const permission = await checkTaskManagePermission(user.id, taskId);
  if (!permission.ok)
    return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });
  const svc = getServiceSupabase();
  const { data, error } = await svc
    .from('task_courses')
    .select('course_id, position, is_required, snapshot_id')
    .eq('task_id', taskId)
    .order('position');
  if (error) throw error;
  const courseIds = (data ?? []).map((item) => item.course_id);
  const { data: courses } = courseIds.length
    ? await svc.from('courses').select('id, title').in('id', courseIds)
    : { data: [] };
  const titleById = new Map((courses ?? []).map((course) => [course.id, course.title]));
  return NextResponse.json({
    success: true,
    data: (data ?? []).map((item) => ({ ...item, title: titleById.get(item.course_id) ?? null })),
  });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  const body = await request.json().catch(() => ({}));
  const candidateCourseIds: unknown[] = Array.isArray(body.courseIds) ? body.courseIds : [];
  const courseIds = [
    ...new Set(
      candidateCourseIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  if (!courseIds.length)
    return NextResponse.json({ success: false, errorCode: 'MISSING_COURSES' }, { status: 400 });
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();
  if (!user)
    return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  const taskPermission = await checkTaskManagePermission(user.id, taskId);
  if (!taskPermission.ok)
    return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });
  for (const courseId of courseIds) {
    const coursePermission = await checkCoursePublishPermission(user.id, courseId);
    if (!coursePermission.ok)
      return NextResponse.json({ success: false, errorCode: 'COURSE_NOT_OWNED' }, { status: 403 });
  }
  const svc = getServiceSupabase();
  const { error } = await svc.rpc('replace_task_courses', {
    p_task_id: taskId,
    p_course_ids: courseIds,
  });
  if (error)
    return NextResponse.json(
      { success: false, errorCode: error.code === 'P0021' ? 'TASK_NOT_DRAFT' : 'UPDATE_FAILED' },
      { status: 400 },
    );
  return GET(request, { params: Promise.resolve({ id: taskId }) });
}
