import { NextRequest, NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { AccessRepository } from '@/lib/server/db/access-repository';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  if (actor.role === 'learner') return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });
  const { id: courseId } = await params;
  const pool = getDatabasePool();
  const course = await new CourseRepository(pool).getCourse(courseId);
  if (!course) return NextResponse.json({ success: false, errorCode: 'COURSE_NOT_FOUND' }, { status: 404 });
  if (!(await new AccessRepository(pool).canManageCourse(actor, courseId))) {
    return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });
  }
  const [packageItems, tasks, progress, events] = await Promise.all([
    pool.query<{ taskId: string; position: number }>(`SELECT task_id::text AS "taskId", position FROM app.task_courses WHERE course_id = $1`, [courseId]),
    pool.query<{ id: string; title: string; status: string }>(`SELECT t.id::text, t.title, t.status FROM app.learning_tasks t JOIN app.task_courses tc ON tc.task_id = t.id WHERE tc.course_id = $1`, [courseId]),
    pool.query<{ taskId: string; studentId: string; status: string; effectiveSeconds: number }>(`SELECT task_id::text AS "taskId", user_id AS "studentId", status, effective_seconds::double precision AS "effectiveSeconds" FROM app.task_course_progress WHERE course_id = $1`, [courseId]),
    pool.query<{ studentId: string; sceneId: string | null; eventType: string }>(`SELECT user_id AS "studentId", scene_id AS "sceneId", event_type AS "eventType" FROM app.learning_events WHERE course_id = $1`, [courseId]),
  ]);
  const learners = new Map<string, { completed: boolean; effectiveSeconds: number }>();
  for (const row of progress.rows) {
    const previous = learners.get(row.studentId) ?? { completed: false, effectiveSeconds: 0 };
    learners.set(row.studentId, { completed: previous.completed || row.status === 'completed', effectiveSeconds: previous.effectiveSeconds + Number(row.effectiveSeconds ?? 0) });
  }
  const tasksById = new Map(tasks.rows.map((task) => [task.id, task]));
  const taskReports = packageItems.rows.map((item) => {
    const rows = progress.rows.filter((row) => row.taskId === item.taskId);
    const completed = rows.filter((row) => row.status === 'completed').length;
    return { taskId: item.taskId, taskTitle: tasksById.get(item.taskId)?.title ?? 'Untitled task', status: tasksById.get(item.taskId)?.status ?? 'unknown', learnerCount: rows.length, completedCount: completed, completionRate: rows.length ? Math.round((completed / rows.length) * 100) : 0, effectiveSeconds: rows.reduce((total, row) => total + Number(row.effectiveSeconds ?? 0), 0) };
  });
  const sceneTitles = new Map<string, string>();
  const scenes = (course.content as { scenes?: Array<{ id?: unknown; title?: unknown }> }).scenes ?? [];
  for (const scene of scenes) if (typeof scene.id === 'string') sceneTitles.set(scene.id, typeof scene.title === 'string' ? scene.title : scene.id);
  const completedScenes = new Map<string, Set<string>>();
  const questions = new Map<string, number>();
  for (const event of events.rows) {
    if (!event.sceneId) continue;
    if (event.eventType === 'question_asked') questions.set(event.sceneId, (questions.get(event.sceneId) ?? 0) + 1);
    if (event.eventType === 'scene_completed') { const ids = completedScenes.get(event.sceneId) ?? new Set<string>(); ids.add(event.studentId); completedScenes.set(event.sceneId, ids); }
  }
  const chapters = [...new Set([...questions.keys(), ...completedScenes.keys()])].map((sceneId) => ({ sceneId, title: sceneTitles.get(sceneId) ?? sceneId, completedLearners: completedScenes.get(sceneId)?.size ?? 0, questionsAsked: questions.get(sceneId) ?? 0 })).sort((a, b) => b.questionsAsked - a.questionsAsked || b.completedLearners - a.completedLearners).slice(0, 12);
  const completedCount = [...learners.values()].filter((learner) => learner.completed).length;
  return NextResponse.json({ success: true, data: { course: { id: course.id, title: course.title }, overview: { taskCount: packageItems.rows.length, learnerCount: learners.size, completedCount, completionRate: learners.size ? Math.round((completedCount / learners.size) * 100) : 0, effectiveSeconds: [...learners.values()].reduce((total, learner) => total + learner.effectiveSeconds, 0) }, tasks: taskReports, chapters } });
}
