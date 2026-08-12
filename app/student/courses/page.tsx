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
            Please bind your learner account with the teacher invitation link.
          }
        </div>
      </main>
    );
  }
  if (student.disabled_at) {
    return (
      <main className="min-h-screen bg-background p-10">
        <div className="mx-auto max-w-3xl text-sm text-muted-foreground">
          This learner account is disabled.
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
            My learning tasks
          </h1>
          <p className="text-sm text-muted-foreground">
            Welcome, 
            {student.name}
            {
              . Your assigned tasks appear here.
            }
          </p>
        </header>
        {(tasks ?? []).length === 0 ? (
          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>No learning tasks yet</CardTitle>
              <CardDescription>
                {
                  Tasks appear here after your teacher assigns you.
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
                    {task.title || 'Untitled task'}
                  </CardTitle>
                  {task.description && (
                    <CardDescription className="line-clamp-2">{task.description}</CardDescription>
                  )}
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-3">
                  {task.due_at && (
                    <span className="text-xs text-muted-foreground">
                      Due: 
                      {new Date(task.due_at).toLocaleString('zh-CN')}
                    </span>
                  )}
                  <div className="ml-auto">
                    <Button asChild size="sm">
                      <Link href={`/learn/${task.share_token}`}>
                        Start learning
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
