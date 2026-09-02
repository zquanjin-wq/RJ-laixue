/**
 * app/admin/teachers/page.tsx
 *
 * Admin-only teacher roster. Reads profiles WHERE role='teacher'
 * via service_role so RLS posture is irrelevant.
 *
 * Teachers can create / view courses on the authoring home, but
 * cannot enter /admin/students. This page is the only place an
 * admin can provision, reset, or disable a teacher account.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CreateTeacherForm } from './_components/create-teacher-form';
import { TeacherActions } from './_components/teacher-actions';

type TeacherProfile = {
  id: string;
  display_name: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
};

export const dynamic = 'force-dynamic';

export default async function AdminTeachersPage() {
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();
  if (!user) {
    redirect('/login?next=/admin/teachers');
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

  const { data: teachersData } = (await serviceSupabase
    .from('profiles')
    .select('id, display_name, disabled_at, created_at, updated_at')
    .eq('role', 'teacher')
    .order('created_at', { ascending: false })) as {
    data: TeacherProfile[] | null;
  };

  const teachers = teachersData ?? [];
  const activeCount = teachers.filter((t) => !t.disabled_at).length;
  const disabledCount = teachers.length - activeCount;

  // Look up the matching auth.users email for each teacher. We can't
  // join profiles → auth.users, so we listUsers once and index by id.
  const { data: authUsers } = await serviceSupabase.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  const emailById = new Map<string, string>();
  for (const u of authUsers?.users ?? []) {
    if (u.email) emailById.set(u.id, u.email);
  }

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">老师管理</h1>
            <p className="text-sm text-muted-foreground">
              {teachers.length} 位老师 · 启用 {activeCount} · 禁用 {disabledCount}
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/admin">返回管理端</Link>
            </Button>
          </div>
        </header>

        <section>
          <CreateTeacherForm />
        </section>

        <section className="space-y-3">
          {teachers.length === 0 ? (
            <div className="rounded-lg border bg-background p-6 text-sm text-muted-foreground">
              暂无老师账号。用上方表单创建第一位老师。
            </div>
          ) : (
            teachers.map((t) => (
              <article
                key={t.id}
                className="rounded-lg border bg-background p-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between"
              >
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">
                      {t.display_name || '（未命名老师）'}
                    </span>
                    {t.disabled_at ? (
                      <Badge variant="destructive">已禁用</Badge>
                    ) : (
                      <Badge variant="default">已启用</Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground break-all">
                    邮箱：{emailById.get(t.id) || '—'}
                  </div>
                  <div className="text-xs text-muted-foreground break-all">
                    user_id：{t.id}
                  </div>
                  {t.disabled_at && (
                    <div className="text-xs text-muted-foreground">
                      禁用时间：
                      {new Date(t.disabled_at).toLocaleString('zh-CN')}
                    </div>
                  )}
                </div>
                <div className="md:max-w-xs md:flex-shrink-0">
                  <TeacherActions
                    teacherId={t.id}
                    teacherName={t.display_name || '该老师'}
                    disabled={!!t.disabled_at}
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