import { NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { resolveActor } from '@/lib/server/learning-tasks/permissions';
import { isGlobalCourseManager } from '@/lib/server/course-management-access';

export async function GET() {
  const server = await getServerSupabase();
  const {
    data: { user },
  } = await server.auth.getUser();
  if (!user)
    return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  const actor = await resolveActor(user.id);
  if (actor.role === 'learner')
    return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });

  const svc = getServiceSupabase();
  let query = svc
    .from('courses')
    .select('id, title, created_by, updated_at')
    .order('updated_at', { ascending: false });
  if (!isGlobalCourseManager(user.email)) query = query.eq('created_by', user.id);
  const { data: courses, error } = await query;
  if (error) throw error;
  const courseIds = (courses ?? []).map((course) => course.id);
  const { data: progress } = courseIds.length
    ? await svc
        .from('task_course_progress')
        .select('task_id, course_id, student_id, status, effective_seconds')
        .in('course_id', courseIds)
    : { data: [] };
  const rows = (courses ?? []).map((course) => {
    const items = (progress ?? []).filter((item) => item.course_id === course.id);
    const learners = new Set(items.map((item) => item.student_id));
    const completed = new Set(
      items.filter((item) => item.status === 'completed').map((item) => item.student_id),
    );
    const tasks = new Set(items.map((item) => item.task_id));
    return {
      courseId: course.id,
      title: course.title || '未命名课程',
      updatedAt: course.updated_at,
      taskCount: tasks.size,
      learnerCount: learners.size,
      completedCount: completed.size,
      completionRate: learners.size ? Math.round((completed.size / learners.size) * 100) : 0,
      effectiveSeconds: items.reduce((sum, item) => sum + Number(item.effective_seconds ?? 0), 0),
    };
  });
  return NextResponse.json({
    success: true,
    data: {
      overview: {
        courseCount: rows.length,
        taskCount: rows.reduce((sum, row) => sum + row.taskCount, 0),
        learnerCount: rows.reduce((sum, row) => sum + row.learnerCount, 0),
        effectiveSeconds: rows.reduce((sum, row) => sum + row.effectiveSeconds, 0),
      },
      courses: rows,
    },
  });
}
