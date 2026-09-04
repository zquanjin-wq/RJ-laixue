/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * /admin/learning-tasks
 *
 * 教师端学习任务列表。admin 可查看全部，teacher 只看自己创建的任务。
 * 显示任务标题、课程名称、状态、学员人数、开始/截止时间、创建时间、可执行操作。
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/server/auth-context';
import { getDatabasePool } from '@/lib/server/db/pool';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TaskListFilters } from './_components/task-list-filters';

export const dynamic = 'force-dynamic';

type TaskRow = {
  id: string;
  title: string | null;
  status: string;
  start_at: string | null;
  due_at: string | null;
  created_by: string;
  created_at: string;
};

export default async function AdminLearningTasksPage() {
  let enriched: Array<TaskRow & { course_count: number; learner_count: number; completed_count: number }> = [];
  let hasError = false;
  try {
    const actor = await requireUser();
    if (actor.role === 'learner') redirect('/admin');
    const result = await getDatabasePool().query<TaskRow & { course_count: number; learner_count: number; completed_count: number }>(
      `SELECT t.id, t.title, t.status, t.start_at, t.due_at, t.created_by, t.created_at,
              count(DISTINCT tc.course_id)::integer AS course_count,
              count(DISTINCT ta.user_id)::integer AS learner_count,
              count(DISTINCT tcp.user_id) FILTER (WHERE tcp.status = 'completed')::integer AS completed_count
       FROM app.learning_tasks t
       LEFT JOIN app.task_courses tc ON tc.task_id = t.id
       LEFT JOIN app.task_assignments ta ON ta.task_id = t.id
       LEFT JOIN app.task_course_progress tcp ON tcp.task_id = t.id
       WHERE ($1 = 'admin' OR t.created_by = $2)
       GROUP BY t.id
       ORDER BY t.created_at DESC`,
      [actor.role, actor.userId],
    );
    enriched = result.rows;
  } catch {
    hasError = true;
  }

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">学习任务</h1>
            <p className="text-sm text-muted-foreground">
              {enriched.length} 个任务 · 创建草稿并发布给指定学员
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/">返回教学驾驶舱</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/admin/learning-tasks/new">新建任务</Link>
            </Button>
          </div>
        </header>

        {hasError && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            获取任务列表失败，请稍后重试。
          </div>
        )}

        <section className="space-y-3">
          {enriched.length === 0 && !hasError && (
            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle>暂无学习任务</CardTitle>
                <CardDescription>点击右上角「新建任务」创建第一个学习任务草稿。</CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild>
                  <Link href="/admin/learning-tasks/new">新建任务</Link>
                </Button>
              </CardContent>
            </Card>
          )}

          {enriched.length > 0 && (
            <TaskListFilters
              tasks={enriched.map((task) => ({
                id: task.id,
                title: task.title,
                status: task.status as 'draft' | 'published' | 'closed' | 'archived',
                startAt: task.start_at,
                dueAt: task.due_at,
                createdAt: task.created_at,
                courseCount: task.course_count,
                learnerCount: task.learner_count,
                completedCount: task.completed_count,
              }))}
            />
          )}
        </section>
      </div>
    </main>
  );
}
