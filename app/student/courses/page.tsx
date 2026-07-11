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

type CourseRow = {
  id: string;
  title: string | null;
  topic: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type StudentRow = {
  id: string;
  name: string;
  access_code: string;
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
    .select('id, name, access_code, disabled_at')
    .eq('user_id', user.id)
    .maybeSingle()) as {
    data: (StudentRow & { disabled_at: string | null }) | null;
  };

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

  if (student.disabled_at) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-md rounded-lg">
          <CardHeader>
            <CardTitle>账号已停用</CardTitle>
            <CardDescription>
              你的账号被管理员停用了（停用时间：
              {new Date(student.disabled_at).toLocaleString('zh-CN')}）。
              如需恢复请联系培训管理员。
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  // Per the new design: every active learner sees every cloud course.
  // course_assignments is intentionally no longer used here.
  const { data: coursesData } = (await serviceSupabase
    .from('courses')
    .select('id, title, topic, created_at, updated_at')
    .order('updated_at', { ascending: false })) as { data: CourseRow[] | null };

  const courses = coursesData ?? [];

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
            下方为所有已保存到云端的课件。
          </p>
        </header>

        {courses.length === 0 && (
          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>暂无课件</CardTitle>
              <CardDescription>
                目前云端还没有任何课件。老师保存课件后，列表会自动更新。
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {courses.length > 0 && (
          <div className="space-y-3">
            {courses.map((c) => (
              <Card key={c.id} className="rounded-lg">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    {c.title || '未命名课件'}
                  </CardTitle>
                  {c.topic && (
                    <CardDescription className="line-clamp-2">
                      {c.topic}
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-3">
                  <div className="text-xs text-muted-foreground">
                    ID: <span className="font-mono">{c.id}</span>
                  </div>
                  {c.updated_at && (
                    <span className="text-xs text-muted-foreground">
                      更新于 {new Date(c.updated_at).toLocaleString('zh-CN')}
                    </span>
                  )}
                  <div className="ml-auto">
                    <Button asChild size="sm">
                      <a href={`/classroom/${c.id}?share=1`}>进入教室</a>
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
