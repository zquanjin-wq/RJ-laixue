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
import { listTeachers, requireAdmin } from '@/lib/server/admin-teachers';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CreateTeacherForm } from './_components/create-teacher-form';
import { TeacherActions } from './_components/teacher-actions';

type TeacherProfile = {
  id: string;
  display_name: string;
  email: string;
  disabled_at: boolean;
  created_at: string;
};

export const dynamic = 'force-dynamic';

export default async function AdminTeachersPage() {
  let teachers: TeacherProfile[];
  try {
    await requireAdmin();
    teachers = await listTeachers();
  } catch {
    redirect('/login?next=/admin/teachers');
  }
  const activeCount = teachers.filter((t) => !t.disabled_at).length;
  const disabledCount = teachers.length - activeCount;

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
                    邮箱：{t.email}
                  </div>
                  <div className="text-xs text-muted-foreground break-all">
                    user_id：{t.id}
                  </div>
                  {t.disabled_at && (
                    <div className="text-xs text-muted-foreground">该账号当前已禁用。</div>
                  )}
                </div>
                <div className="md:max-w-xs md:flex-shrink-0">
                  <TeacherActions
                    teacherId={t.id}
                    teacherName={t.display_name || '该老师'}
                    disabled={t.disabled_at}
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
