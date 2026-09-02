export type TaskLearningClientEvent =
  | 'task_opened'
  | 'scene_started'
  | 'scene_completed'
  | 'heartbeat'
  | 'question_asked'
  | 'check_submitted'
  | 'check_reviewed'
  | 'task_completed';

export async function recordTaskLearningEvent(input: {
  taskId: string;
  courseId: string;
  eventType: TaskLearningClientEvent;
  sceneId?: string;
  sceneOrder?: number;
  metadata?: Record<string, unknown>;
}) {
  const response = await fetch('/api/learning/task-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, clientEventId: crypto.randomUUID() }),
  });
  const result = await response.json();
  if (!response.ok || result.success !== true) throw new Error(result.error || '学习事件写入失败');
  return result as { success: true; recorded: boolean; completed?: boolean };
}
