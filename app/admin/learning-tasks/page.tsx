/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * /admin/learning-tasks
 *
 * 教师端学习任务列表。admin 可查看全部，teacher 只看自己创建的任务。
 * 显示任务标题、课程名称、状态、学员人数、开始/截止时间、创建时间、可执行操作。
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { resolveActor } from '@/lib/server/learning-tasks/permissions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TaskListFilters } from './_components/task-list-filters';

export const dynamic = 'force-dynamic';

type TaskRow = {
  id: string;
  course_id: string;
  title: string | null;
  status: string;
  start_at: string | null;
  due_at: string | null;
  created_by: string;
  created_at: string;
};

export default async function AdminLearningTasksPage() {
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/admin/learning-tasks');
  }

  const actor = await resolveActor(user.id);
  if (actor.role === 'learner') {
    redirect('/admin');
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

  const { data: tasksData, error: queryError } = (await query) as {
    data: TaskRow[] | null;
    error: unknown;
  };
  const tasks = tasksData ?? [];
  const hasError = !!queryError;

  const taskIds = tasks.map((t) => t.id);

  const [{ data: taskCourses }, { data: learnerCounts }, { data: learnerProgress }] =
    await Promise.all([
      taskIds.length > 0
        ? svc.from('task_courses').select('task_id, course_id').in('task_id', taskIds)
        : Promise.resolve({ data: [] }),
      taskIds.length > 0
        ? svc.rpc('count_task_learners', { p_task_ids: taskIds })
        : Promise.resolve({ data: [] }),
      taskIds.length > 0
        ? svc.from('task_learners').select('task_id, status').in('task_id', taskIds)
        : Promise.resolve({ data: [] }),
    ]);

  const courseCountByTaskId = new Map<string, number>();
  for (const item of taskCourses ?? [])
    courseCountByTaskId.set(item.task_id, (courseCountByTaskId.get(item.task_id) ?? 0) + 1);
  const countByTaskId = new Map(
    (learnerCounts ?? []).map((r: { task_id?: string; count?: number }) => [
      r.task_id,
      r.count ?? 0,
    ]),
  );

  const enriched = tasks.map((t) => ({
    ...t,
    course_count: courseCountByTaskId.get(t.id) ?? 1,
    learner_count: (countByTaskId.get(t.id) as number | undefined) ?? 0,
    completed_count: (learnerProgress ?? []).filter(
      (item) => item.task_id === t.id && item.status === 'completed',
    ).length,
  }));

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
