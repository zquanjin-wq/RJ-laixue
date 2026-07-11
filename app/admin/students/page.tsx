/**
 * app/admin/students/page.tsx
 *
 * Admin-only learners management screen.
 *
 * RSC: reads the signed-in user via getServerSupabase(), gates on
 * profile.role === 'admin', then lists every student via
 * getServiceSupabase() so the read works regardless of the current
 * RLS posture (anon-key friendly at this stage, will be tightened
 * in stage two).
 *
 * Each row that does not yet have a bound user renders the inline
 * CreateAccountRow client component so the admin can provision an
 * auth.users account and bind students.user_id in one step. Bound
 * rows render BoundRow which exposes reset-password + unbind
 * controls without leaving the page.
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CreateAccountRow } from './_components/create-account-row';
import { BoundRow } from './_components/bound-row';

type StudentRow = {
  id: string;
  name: string;
  email: string | null;
  access_code: string | null;
  user_id: string | null;
  created_at: string;
};

export const dynamic = 'force-dynamic';

export default async function AdminStudentsPage() {
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/admin/students');
  }

  // Gate on admin role. Service-role bypasses RLS so we can read the
  // caller's profile even if a future RLS tightening restricts it.
  const serviceSupabase = getServiceSupabase();
  const { data: profile } = await serviceSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.role !== 'admin') {
    redirect('/student/courses');
  }

  const { data: studentsData } = (await serviceSupabase
    .from('students')
    .select('id, name, email, access_code, user_id, created_at')
    .order('created_at', { ascending: false })) as { data: StudentRow[] | null };

  const students = studentsData ?? [];
  const boundCount = students.filter((s) => !!s.user_id).length;
  const unboundCount = students.length - boundCount;

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">学员管理</h1>
            <p className="text-sm text-muted-foreground">
              {students.length} 位学员 · 已绑定 {boundCount} · 未绑定 {unboundCount}
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/admin">返回管理端</Link>
            </Button>
          </div>
        </header>

        <section className="space-y-3">
          {students.length === 0 && (
            <div className="rounded-lg border bg-background p-6 text-sm text-muted-foreground">
              暂无学员。请先用 Supabase Studio 在 students 表插入若干行（含 name + access_code），
              再回到此页面创建账号。
            </div>
          )}

          {students.map((s) => (
            <article
              key={s.id}
              className="rounded-lg border bg-background p-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between"
            >
              <div className="space-y-1 min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{s.name}</span>
                  {s.access_code && (
                    <span className="font-mono text-xs px-2 py-0.5 rounded bg-muted">
                      {s.access_code}
                    </span>
                  )}
                  {s.user_id ? (
                    <Badge variant="default">已绑定账号</Badge>
                  ) : (
                    <Badge variant="secondary">未绑定</Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  邮箱：{s.email || '—'}
                </div>
                <div className="text-xs text-muted-foreground break-all">
                  user_id：{s.user_id ?? '尚未绑定'}
                </div>
              </div>
              <div className="md:max-w-md md:flex-shrink-0">
                {s.user_id ? (
                  <BoundRow studentId={s.id} studentName={s.name} />
                ) : (
                  <CreateAccountRow studentId={s.id} studentName={s.name} />
                )}
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}