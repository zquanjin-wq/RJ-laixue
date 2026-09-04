import { getDatabasePool } from '@/lib/server/db/pool';
import { checkTaskEntryPermission } from './permissions';
export type SnapshotLoadResult = | { ok: true; data: { stage: unknown; scenes: unknown[]; outlines: unknown[] }; actor: 'learner' | 'preview' } | { ok: false; error: string; errorCode: string; status: number };
export async function loadTaskSnapshot(userId: string, taskId: string, courseId?: string): Promise<SnapshotLoadResult> {
  const pool = getDatabasePool();
  const task = await pool.query<{ status: string; startAt: string | null }>(`SELECT status, start_at::text AS "startAt" FROM app.learning_tasks WHERE id = $1`, [taskId]);
  if (!task.rows[0]) return { ok:false,error:'Task not found.',errorCode:'TASK_NOT_FOUND',status:404 };
  if (task.rows[0].status !== 'published') return { ok:false,error:'Task is not available.',errorCode:'TASK_NOT_PUBLISHED',status:403 };
  const permission = await checkTaskEntryPermission(userId, taskId);
  if (!permission.ok) return { ok:false,error:'Not assigned to this task.',errorCode:'LEARNER_NOT_ASSIGNED',status:403 };
  if (permission.actor === 'learner' && task.rows[0].startAt && new Date(task.rows[0].startAt) > new Date()) return { ok:false,error:'Task has not started.',errorCode:'TASK_NOT_STARTED',status:403 };
  const snapshot = await pool.query<{ content: unknown }>(`SELECT s.content FROM app.task_courses tc JOIN app.course_snapshots s ON s.id = tc.snapshot_id WHERE tc.task_id = $1 AND ($2::text IS NULL OR tc.course_id = $2) ORDER BY tc.position LIMIT 1`, [taskId, courseId ?? null]);
  const data = snapshot.rows[0]?.content as { stage?: unknown; scenes?: unknown; outlines?: unknown } | undefined;
  if (!data?.stage || !Array.isArray(data.scenes)) return { ok:false,error:'Task course snapshot is unavailable.',errorCode:'SNAPSHOT_NOT_FOUND',status:404 };
  return { ok:true, data:{ stage:data.stage, scenes:data.scenes.map(stripQuizAnswers), outlines:Array.isArray(data.outlines)?data.outlines:[] }, actor:permission.actor };
}
function stripQuizAnswers(scene: unknown): unknown { if (!scene || typeof scene !== 'object') return scene; const source=scene as Record<string,unknown>; const content=source.content as Record<string,unknown>|undefined; if(source.type!=='quiz'||!Array.isArray(content?.questions)) return source; return {...source,content:{...content,questions:(content.questions as Array<Record<string,unknown>>).map(question=>{const safe={...question}; delete safe.answer; delete safe.correctAnswer; delete safe.explanation; delete safe.correctOptions; return safe;})}}; }
