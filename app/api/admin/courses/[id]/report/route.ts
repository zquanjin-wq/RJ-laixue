import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { resolveActor } from '@/lib/server/learning-tasks/permissions';
import { isGlobalCourseManager } from '@/lib/server/course-management-access';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: courseId } = await params;
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();
  if (!user)
    return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  const actor = await resolveActor(user.id);
  if (actor.role === 'learner')
    return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });
  const svc = getServiceSupabase();
  const { data: course } = await svc
    .from('courses')
    .select('id, title, created_by, data')
    .eq('id', courseId)
    .maybeSingle();
  if (!course)
    return NextResponse.json({ success: false, errorCode: 'COURSE_NOT_FOUND' }, { status: 404 });
  if (!isGlobalCourseManager(user.email) && course.created_by !== user.id)
    return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });

  const { data: packageItems } = await svc
    .from('task_courses')
    .select('task_id, position')
    .eq('course_id', courseId);
  const taskIds = (packageItems ?? []).map((item) => item.task_id);
  const [{ data: tasks }, { data: progress }, { data: events }] = await Promise.all([
    taskIds.length
      ? svc.from('learning_tasks').select('id, title, status, due_at').in('id', taskIds)
      : Promise.resolve({ data: [] }),
    taskIds.length
      ? svc
          .from('task_course_progress')
          .select('task_id, student_id, status, progress_percent, effective_seconds')
          .eq('course_id', courseId)
          .in('task_id', taskIds)
      : Promise.resolve({ data: [] }),
    taskIds.length
      ? svc
          .from('task_learning_events')
          .select('student_id, scene_id, event_type, payload')
          .eq('course_id', courseId)
          .in('task_id', taskIds)
      : Promise.resolve({ data: [] }),
  ]);
  const studentIds = [
    ...new Set([
      ...(progress ?? []).map((row) => row.student_id),
      ...(events ?? []).map((event) => event.student_id),
    ]),
  ];
  const { data: students } = studentIds.length
    ? await svc.from('students').select('id, name').in('id', studentIds)
    : { data: [] };
  const studentNames = new Map((students ?? []).map((student) => [student.id, student.name]));
  const learners = new Map<string, { completed: boolean; effectiveSeconds: number }>();
  for (const row of progress ?? []) {
    const previous = learners.get(row.student_id) ?? { completed: false, effectiveSeconds: 0 };
    learners.set(row.student_id, {
      completed: previous.completed || row.status === 'completed',
      effectiveSeconds: previous.effectiveSeconds + Number(row.effective_seconds ?? 0),
    });
  }
  const tasksById = new Map((tasks ?? []).map((task) => [task.id, task]));
  const taskReports = (packageItems ?? []).map((item) => {
    const rows = (progress ?? []).filter((row) => row.task_id === item.task_id);
    const completed = rows.filter((row) => row.status === 'completed').length;
    return {
      taskId: item.task_id,
      taskTitle: tasksById.get(item.task_id)?.title || '未命名任务',
      status: tasksById.get(item.task_id)?.status || 'unknown',
      learnerCount: rows.length,
      completedCount: completed,
      completionRate: rows.length ? Math.round((completed / rows.length) * 100) : 0,
      effectiveSeconds: rows.reduce((sum, row) => sum + Number(row.effective_seconds ?? 0), 0),
    };
  });
  const sceneTitles = new Map<string, string>();
  const scenes =
    (course.data as { scenes?: Array<{ id?: unknown; title?: unknown }> } | null)?.scenes ?? [];
  for (const scene of scenes)
    if (typeof scene.id === 'string')
      sceneTitles.set(scene.id, typeof scene.title === 'string' ? scene.title : scene.id);
  const completedScenes = new Map<string, Set<string>>();
  const questions = new Map<string, number>();
  const chapterQuestions = new Map<string, string[]>();
  for (const event of events ?? []) {
    if (!event.scene_id) continue;
    if (event.event_type === 'question_asked') {
      questions.set(event.scene_id, (questions.get(event.scene_id) ?? 0) + 1);
      const question =
        event.payload && typeof event.payload === 'object'
          ? (event.payload as { question?: unknown }).question
          : null;
      if (typeof question === 'string' && question.trim()) {
        const existing = chapterQuestions.get(event.scene_id) ?? [];
        chapterQuestions.set(event.scene_id, [...existing, question.trim()]);
      }
    }
    if (event.event_type === 'scene_completed') {
      const ids = completedScenes.get(event.scene_id) ?? new Set<string>();
      ids.add(event.student_id);
      completedScenes.set(event.scene_id, ids);
    }
  }
  const sceneIds = new Set([...questions.keys(), ...completedScenes.keys()]);
  const chapters = [...sceneIds]
    .map((sceneId) => ({
      sceneId,
      title: sceneTitles.get(sceneId) ?? sceneId,
      completedLearners: completedScenes.get(sceneId)?.size ?? 0,
      questionsAsked: questions.get(sceneId) ?? 0,
      completedLearnerNames: [...(completedScenes.get(sceneId) ?? [])].map(
        (studentId) => studentNames.get(studentId) ?? '未知学员',
      ),
      questions: chapterQuestions.get(sceneId) ?? [],
    }))
    .sort(
      (a, b) => b.questionsAsked - a.questionsAsked || b.completedLearners - a.completedLearners,
    )
    .slice(0, 12);
  const totalEffectiveSeconds = [...learners.values()].reduce(
    (sum, learner) => sum + learner.effectiveSeconds,
    0,
  );
  return NextResponse.json({
    success: true,
    data: {
      course: { id: course.id, title: course.title },
      overview: {
        taskCount: taskIds.length,
        learnerCount: studentIds.length,
        completedCount: [...learners.values()].filter((learner) => learner.completed).length,
        completionRate: studentIds.length
          ? Math.round(
              ([...learners.values()].filter((learner) => learner.completed).length /
                studentIds.length) *
                100,
            )
          : 0,
        effectiveSeconds: totalEffectiveSeconds,
      },
      tasks: taskReports,
      chapters,
    },
  });
}
