/**
 * app/admin/students/page.tsx
 *
 * Admin-only learners management screen.
 *
 * Layout:
 *   - header: counts + return link
 *   - top-of-page "CreateStudentForm" — the admin's main entry point
 *     for adding a new learner. Creates the students row + auth.users
 *     row + initial password in a single round trip.
 *   - roster: every student with their email, access_code, status
 *     (active / disabled), and a compact action panel
 *     (reset password, disable/enable).
 *
 * RSC. Service-role bypasses RLS so we can read the full roster
 * regardless of the anon-friendly policies still in place on the
 * learning tables.
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CreateStudentForm } from './_components/create-student-form';
import { StudentActions } from './_components/student-actions';

type StudentRow = {
  id: string;
  name: string;
  email: string | null;
  access_code: string | null;
  user_id: string | null;
  disabled_at: string | null;
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

  const serviceSupabase = getServiceSupabase();
  const { data: callerProfile } = await serviceSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (!callerProfile || callerProfile.role !== 'admin') {
    redirect('/admin');
  }

  const { data: studentsData } = (await serviceSupabase
    .from('students')
    .select(
      'id, name, email, access_code, user_id, disabled_at, created_at',
    )
    .order('created_at', { ascending: false })) as { data: StudentRow[] | null };

  const students = studentsData ?? [];
  const activeCount = students.filter((s) => !s.disabled_at).length;
  const disabledCount = students.length - activeCount;

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">学员管理</h1>
            <p className="text-sm text-muted-foreground">
              {students.length} 位学员 · 启用 {activeCount} · 禁用 {disabledCount}
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/admin">返回管理端</Link>
            </Button>
          </div>
        </header>

        <section>
          <CreateStudentForm />
        </section>

        <section className="space-y-3">
          {students.length === 0 ? (
            <div className="rounded-lg border bg-background p-6 text-sm text-muted-foreground">
              暂无学员。用上方表单创建第一位学员。
            </div>
          ) : (
            students.map((s) => (
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
                    {s.disabled_at ? (
                      <Badge variant="destructive">已禁用</Badge>
                    ) : (
                      <Badge variant="default">已启用</Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    邮箱：{s.email || '—'}
                  </div>
                  {s.disabled_at && (
                    <div className="text-xs text-muted-foreground">
                      禁用时间：
                      {new Date(s.disabled_at).toLocaleString('zh-CN')}
                    </div>
                  )}
                </div>
                <div className="md:max-w-xs md:flex-shrink-0">
                  <StudentActions
                    studentId={s.id}
                    studentName={s.name}
                    disabled={!!s.disabled_at}
                  />
                </div>
              </article>
            ))
          )}
        </section>
      </div>
    </main>
  );
}