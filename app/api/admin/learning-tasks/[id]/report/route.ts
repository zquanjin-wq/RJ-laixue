import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { checkTaskManagePermission } from '@/lib/server/learning-tasks/permissions';
import {
  buildTaskReport,
  toLearnerReportRow,
  type ReportScene,
} from '@/lib/server/learning-tasks/report';

type SnapshotData = {
  scenes?: Array<{ id?: unknown; type?: unknown; title?: unknown; order?: unknown; seq?: unknown }>;
};

function snapshotSlides(snapshot: unknown): ReportScene[] {
  const scenes = (snapshot as SnapshotData | null)?.scenes;
  if (!Array.isArray(scenes)) return [];
  return scenes
    .filter((scene) => scene.type === 'slide' || scene.type == null)
    .map((scene, index) => ({
      id: typeof scene.id === 'string' ? scene.id : '',
      title: typeof scene.title === 'string' && scene.title ? scene.title : `第 ${index + 1} 节`,
      order:
        typeof scene.order === 'number'
          ? scene.order
          : typeof scene.seq === 'number'
            ? scene.seq
            : null,
    }))
    .filter((scene) => scene.id);
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const serverSupabase = await getServerSupabase();
    const {
      data: { user },
    } = await serverSupabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { success: false, error: '请先登录', errorCode: 'UNAUTHENTICATED' },
        { status: 401 },
      );
    }

    const { id: taskId } = await params;
    const permission = await checkTaskManagePermission(user.id, taskId);
    if (!permission.ok) {
      const status = permission.reason === 'task_not_found' ? 404 : 403;
      return NextResponse.json(
        {
          success: false,
          error: status === 404 ? '任务不存在' : '无权查看此任务报表',
          errorCode: status === 404 ? 'TASK_NOT_FOUND' : 'FORBIDDEN',
        },
        { status },
      );
    }

    const serviceSupabase = getServiceSupabase();
    const { data: task, error: taskError } = await serviceSupabase
      .from('learning_tasks')
      .select('id, due_at, snapshot_id')
      .eq('id', taskId)
      .maybeSingle();
    if (taskError) throw taskError;
    if (!task) {
      return NextResponse.json(
        { success: false, error: '任务不存在', errorCode: 'TASK_NOT_FOUND' },
        { status: 404 },
      );
    }

    const [
      { data: learnerRows, error: learnerError },
      { data: eventRows, error: eventError },
      { data: taskCourses },
      { data: courseProgress },
    ] = await Promise.all([
      serviceSupabase
        .from('task_learners')
        .select(
          'student_id, status, progress_percent, mastery_percent, effective_seconds, last_seen_at',
        )
        .eq('task_id', taskId),
      serviceSupabase
        .from('task_learning_events')
        .select('student_id, event_type, scene_id')
        .eq('task_id', taskId),
      serviceSupabase
        .from('task_courses')
        .select('course_id, position, is_required')
        .eq('task_id', taskId),
      serviceSupabase
        .from('task_course_progress')
        .select('course_id, student_id, status, progress_percent, effective_seconds')
        .eq('task_id', taskId),
    ]);
    if (learnerError) throw learnerError;
    if (eventError) throw eventError;

    const studentIds = (learnerRows ?? []).map((row) => row.student_id);
    const { data: students, error: studentError } = studentIds.length
      ? await serviceSupabase.from('students').select('id, name').in('id', studentIds)
      : { data: [], error: null };
    if (studentError) throw studentError;
    const names = new Map((students ?? []).map((student) => [student.id, student.name]));

    const packageCourseIds = (taskCourses ?? []).map((item) => item.course_id);
    const { data: courseRows } = packageCourseIds.length
      ? await serviceSupabase.from('courses').select('id, title').in('id', packageCourseIds)
      : { data: [] };
    const courseTitles = new Map((courseRows ?? []).map((course) => [course.id, course.title]));
    const courses = [...(taskCourses ?? [])]
      .sort((a, b) => a.position - b.position)
      .map((item) => {
        const rows = (courseProgress ?? []).filter((row) => row.course_id === item.course_id);
        const completed = rows.filter((row) => row.status === 'completed').length;
        const started = rows.filter((row) => row.status !== 'not_started').length;
        return {
          courseId: item.course_id,
          title: courseTitles.get(item.course_id) ?? '未命名课程',
          position: item.position,
          isRequired: item.is_required,
          learnerCount: rows.length,
          startedCount: started,
          completedCount: completed,
          completionRate: rows.length ? Math.round((completed / rows.length) * 100) : 0,
          effectiveSeconds: rows.reduce((sum, row) => sum + Number(row.effective_seconds ?? 0), 0),
        };
      });

    const { data: snapshot, error: snapshotError } = task.snapshot_id
      ? await serviceSupabase
          .from('course_snapshots')
          .select('snapshot_data')
          .eq('id', task.snapshot_id)
          .maybeSingle()
      : { data: null, error: null };
    if (snapshotError) throw snapshotError;

    const report = buildTaskReport({
      dueAt: task.due_at,
      learners: (learnerRows ?? []).map((row) =>
        toLearnerReportRow(row, names.get(row.student_id) ?? ''),
      ),
      events: (eventRows ?? []).map((row) => ({
        student_id: row.student_id,
        event_type: row.event_type,
        scene_id: row.scene_id,
      })),
      scenes: snapshotSlides(snapshot?.snapshot_data),
    });

    return NextResponse.json({ success: true, data: { ...report, courses } });
  } catch (error) {
    console.error('[admin/learning-tasks/[id]/report] get failed:', error);
    return NextResponse.json(
      { success: false, error: '获取学习报表失败', errorCode: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
