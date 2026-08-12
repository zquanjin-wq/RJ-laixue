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
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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

function statusLabel(status: string) {
  switch (status) {
    case 'draft':
      return '草稿';
    case 'published':
      return '已发布';
    case 'closed':
      return '已关闭';
    case 'archived':
      return '已归档';
    default:
      return status;
  }
}

function statusBadgeVariant(status: string) {
  switch (status) {
    case 'draft':
      return 'secondary';
    case 'published':
      return 'default';
    case 'closed':
      return 'destructive';
    case 'archived':
      return 'outline';
    default:
      return 'secondary';
  }
}

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

  const courseIds = [...new Set(tasks.map((t) => t.course_id).filter(Boolean))];
  const taskIds = tasks.map((t) => t.id);

  const [{ data: courses }, { data: learnerCounts }] = await Promise.all([
    courseIds.length > 0
      ? svc.from('courses').select('id, title').in('id', courseIds)
      : Promise.resolve({ data: [] }),
    taskIds.length > 0
      ? svc.rpc('count_task_learners', { p_task_ids: taskIds })
      : Promise.resolve({ data: [] }),
  ]);

  const titleByCourseId = new Map((courses ?? []).map((c) => [c.id, c.title]));
  const countByTaskId = new Map(
    (learnerCounts ?? []).map((r: { task_id?: string; count?: number }) => [
      r.task_id,
      r.count ?? 0,
    ]),
  );

  const enriched = tasks.map((t) => ({
    ...t,
    course_title: (titleByCourseId.get(t.course_id) as string | null | undefined) ?? null,
    learner_count: (countByTaskId.get(t.id) as number | undefined) ?? 0,
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
              <Link href="/admin">返回管理端</Link>
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

          {enriched.map((t) => (
            <article
              key={t.id}
              className="rounded-lg border bg-background p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
            >
              <div className="space-y-1 min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium truncate">{t.title || '未命名任务'}</span>
                  <Badge variant={statusBadgeVariant(t.status) as any}>
                    {statusLabel(t.status)}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  课程：{t.course_title || t.course_id}
                </div>
                <div className="text-xs text-muted-foreground">
                  学员 {t.learner_count} 人
                  {t.start_at && ` · 开始 ${new Date(t.start_at).toLocaleString('zh-CN')}`}
                  {t.due_at && ` · 截止 ${new Date(t.due_at).toLocaleString('zh-CN')}`}
                </div>
                <div className="text-xs text-muted-foreground">
                  创建于 {new Date(t.created_at).toLocaleString('zh-CN')}
                </div>
              </div>
              <div className="flex gap-2 md:flex-shrink-0">
                <Button asChild variant="outline" size="sm">
                  <Link href={`/admin/learning-tasks/${t.id}`}>查看详情</Link>
                </Button>
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
