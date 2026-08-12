import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type StudentRow = {
  id: string;
  name: string;
  disabled_at: string | null;
};

export const dynamic = 'force-dynamic';

export default async function StudentCoursesPage() {
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();
  if (!user) redirect('/login?next=/student/courses');

  const serviceSupabase = getServiceSupabase();
  const { data: callerProfile } = await serviceSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (callerProfile?.role === 'admin') redirect('/admin');

  const { data: student } = (await serviceSupabase
    .from('students')
    .select('id, name, disabled_at')
    .eq('user_id', user.id)
    .maybeSingle()) as { data: StudentRow | null };

  if (!student) {
    return (
      <main className="min-h-screen bg-background p-10">
        <div className="mx-auto max-w-3xl text-sm text-muted-foreground">
          {
            '\\u8bf7\\u4f7f\\u7528\\u8001\\u5e08\\u53d1\\u9001\\u7684\\u9080\\u8bf7\\u94fe\\u63a5\\u7ed1\\u5b9a\\u5b66\\u5458\\u8d26\\u53f7\\u3002'
          }
        </div>
      </main>
    );
  }
  if (student.disabled_at) {
    return (
      <main className="min-h-screen bg-background p-10">
        <div className="mx-auto max-w-3xl text-sm text-muted-foreground">
          {'\\u8d26\\u53f7\\u5df2\\u88ab\\u505c\\u7528\\u3002'}
        </div>
      </main>
    );
  }

  const { data: taskLearners } = await serviceSupabase
    .from('task_learners')
    .select('task_id')
    .eq('student_id', student.id);
  const taskIds = (taskLearners ?? []).map((item) => item.task_id);
  const { data: tasks } = taskIds.length
    ? await serviceSupabase
        .from('learning_tasks')
        .select('id, title, description, share_token, due_at, created_at')
        .in('id', taskIds)
        .eq('status', 'published')
        .order('created_at', { ascending: false })
    : { data: [] };

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {'\\u6211\\u7684\\u5b66\\u4e60\\u4efb\\u52a1'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {'\\u6b22\\u8fce\\uff0c'}
            {student.name}
            {
              '\\u3002\\u8fd9\\u91cc\\u5c55\\u793a\\u8001\\u5e08\\u5206\\u914d\\u7ed9\\u4f60\\u7684\\u5b66\\u4e60\\u4efb\\u52a1\\u3002'
            }
          </p>
        </header>
        {(tasks ?? []).length === 0 ? (
          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>{'\\u6682\\u65e0\\u5b66\\u4e60\\u4efb\\u52a1'}</CardTitle>
              <CardDescription>
                {
                  '\\u8001\\u5e08\\u53d1\\u5e03\\u5e76\\u5c06\\u4f60\\u52a0\\u5165\\u4efb\\u52a1\\u540e\\uff0c\\u4f1a\\u5728\\u8fd9\\u91cc\\u663e\\u793a\\u3002'
                }
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="space-y-3">
            {(tasks ?? []).map((task) => (
              <Card key={task.id} className="rounded-lg">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    {task.title || '\\u672a\\u547d\\u540d\\u4efb\\u52a1'}
                  </CardTitle>
                  {task.description && (
                    <CardDescription className="line-clamp-2">{task.description}</CardDescription>
                  )}
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-3">
                  {task.due_at && (
                    <span className="text-xs text-muted-foreground">
                      {'\\u622a\\u6b62\\uff1a'}
                      {new Date(task.due_at).toLocaleString('zh-CN')}
                    </span>
                  )}
                  <div className="ml-auto">
                    <Button asChild size="sm">
                      <Link href={`/learn/${task.share_token}`}>
                        {'\\u8fdb\\u5165\\u5b66\\u4e60'}
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
