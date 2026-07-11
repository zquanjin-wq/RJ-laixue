/**
 * app/admin/courses/page.tsx
 *
 * Admin-only roster of cloud-stored courses. Reads public.courses via
 * service_role (RLS posture is irrelevant here — admin reads always
 * go through service role). Each row links into the existing
 * /classroom/[id] route so the admin can preview the same playback
 * experience a learner would see.
 *
 * IMPORTANT: this only shows courses that have been explicitly
 * "saved to cloud" via OPENMAIC's existing 云同步 button on the
 * authoring page. Any course still living only in IndexedDB will
 * not appear here — that's expected, not a bug.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export const dynamic = 'force-dynamic';

type CourseRow = {
  id: string;
  title: string | null;
  topic: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export default async function AdminCoursesPage() {
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();
  if (!user) {
    redirect('/login?next=/admin/courses');
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

  const { data: coursesData } = (await serviceSupabase
    .from('courses')
    .select('id, title, topic, created_at, updated_at')
    .order('updated_at', { ascending: false })) as { data: CourseRow[] | null };

  const courses = coursesData ?? [];

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">课件管理</h1>
            <p className="text-sm text-muted-foreground">
              {courses.length} 个云端课件 · 点击「查看」以只读模式预览
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/admin">返回管理端</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/">创作新课件</Link>
            </Button>
          </div>
        </header>

        <section className="space-y-3">
          {courses.length === 0 ? (
            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle>暂无云端课件</CardTitle>
                <CardDescription>
                  课件需要先在创作首页生成，并点击「保存到云端」后才会出现在这里。学员也只能看到已发布到云端的课件。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild>
                  <Link href="/">前往创作首页</Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            courses.map((c) => (
              <article
                key={c.id}
                className="rounded-lg border bg-background p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
              >
                <div className="space-y-1 min-w-0 flex-1">
                  <p className="font-medium truncate">{c.title || '未命名课件'}</p>
                  {c.topic && (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {c.topic}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    ID: <span className="font-mono">{c.id}</span>
                  </p>
                  {c.updated_at && (
                    <p className="text-xs text-muted-foreground">
                      更新于 {new Date(c.updated_at).toLocaleString('zh-CN')}
                    </p>
                  )}
                </div>
                <div className="flex gap-2 md:flex-shrink-0">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/classroom/${c.id}`} target="_blank">
                      查看
                    </Link>
                  </Button>
                </div>
              </article>
            ))
          )}
        </section>
      </div>
    </main>
  );
}