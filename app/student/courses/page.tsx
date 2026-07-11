/**
 * app/student/courses/page.tsx
 *
 * Stage-one learner landing page. Resolves the signed-in Supabase
 * Auth user to a student row via students.user_id, then lists
 * their course_assignments.
 *
 * RSC server component — relies on getServerSupabase() for the
 * signed-in user and getServiceSupabase() to bypass the current
 * over-permissive anon-key RLS while still keeping the read on the
 * server. Stage two will replace the service-role call with a
 * learner-scoped policy.
 *
 * Intentionally does NOT touch the existing classroom module. The
 * "进入教室" affordance surfaces the course_id so learners can use
 * the existing share-link + StudentGate flow; wiring an automated
 * entry to classroom/[id] is left for stage three where the
 * classroom route itself will be extended to honour the auth user.
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  getServerSupabase,
  getServiceSupabase,
} from '@/lib/supabase/server';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type AssignmentRow = {
  id: string;
  course_id: string;
  status: 'not_started' | 'in_progress' | 'completed';
  assigned_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_seen_at: string | null;
};

type StudentRow = {
  id: string;
  name: string;
  access_code: string;
};

const STATUS_LABEL: Record<AssignmentRow['status'], string> = {
  not_started: '未开始',
  in_progress: '学习中',
  completed: '已完成',
};

export const dynamic = 'force-dynamic';

export default async function StudentCoursesPage({
  searchParams,
}: {
  searchParams: Promise<{ bound?: string }>;
}) {
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/student/courses');
  }

  const serviceSupabase = getServiceSupabase();

  // Admins are operators, not learners. Bounce them back to /admin so
  // they don't accidentally end up on the "no student bound" empty
  // state. The role check is intentionally on the server so we don't
  // flash the empty card before the redirect kicks in.
  const { data: callerProfile } = await serviceSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (callerProfile?.role === 'admin') {
    redirect('/admin');
  }

  const { data: student } = (await serviceSupabase
    .from('students')
    .select('id, name, access_code')
    .eq('user_id', user.id)
    .maybeSingle()) as { data: StudentRow | null };

  if (!student) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-md rounded-lg">
          <CardHeader>
            <CardTitle>还没绑定学员号</CardTitle>
            <CardDescription>
              账号 {user.email ?? user.id} 还没有关联任何学员档案。
              请使用老师发的形如 <code className="font-mono">/invite?code=XXXXXX</code> 的邀请链接绑定后即可看到分配的课程。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/invite">前往绑定</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const { data: assignments } = (await serviceSupabase
    .from('course_assignments')
    .select(
      'id, course_id, status, assigned_at, started_at, completed_at, last_seen_at',
    )
    .eq('student_id', student.id)
    .order('assigned_at', { ascending: false })) as { data: AssignmentRow[] | null };

  const sp = await searchParams;
  const welcomeName = sp?.bound ? decodeURIComponent(sp.bound) : '';

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            学员首页
          </h1>
          <p className="text-sm text-muted-foreground">
            欢迎，{welcomeName || student.name}。
            {student.access_code && (
              <>
                {' '}你的访问码：<span className="font-mono">{student.access_code}</span>
              </>
            )}
          </p>
        </header>

        {(!assignments || assignments.length === 0) && (
          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>暂无课程分配</CardTitle>
              <CardDescription>
                老师还没有给你分配课程。如果有疑问请联系老师或访问班级分享链接。
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {assignments && assignments.length > 0 && (
          <div className="space-y-3">
            {assignments.map((a) => (
              <Card key={a.id} className="rounded-lg">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    课程编号：{a.course_id}
                  </CardTitle>
                  <CardDescription>
                    分配于 {new Date(a.assigned_at).toLocaleString('zh-CN')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-3">
                  <Badge variant={a.status === 'completed' ? 'default' : 'secondary'}>
                    {STATUS_LABEL[a.status]}
                  </Badge>
                  {a.last_seen_at && (
                    <span className="text-xs text-muted-foreground">
                      最近活跃：{new Date(a.last_seen_at).toLocaleString('zh-CN')}
                    </span>
                  )}
                  <div className="ml-auto flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (typeof window !== 'undefined' && navigator.clipboard) {
                          void navigator.clipboard.writeText(
                            `${window.location.origin}/classroom/${a.course_id}?share=1`,
                          );
                        }
                      }}
                    >
                      复制分享链接
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <footer className="text-xs text-muted-foreground text-center pt-6">
          如需退出账号，请回到主页右上角的退出。
        </footer>
      </div>
    </main>
  );
}
