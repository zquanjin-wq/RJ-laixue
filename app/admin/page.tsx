/**
 * app/admin/page.tsx
 *
 * Operator landing. Renders a tiny admin hub with links into the
 * sub-screens; deliberately lightweight so admins can find their
 * way even if they only remember "/admin".
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function AdminHubPage() {
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/admin');
  }

  const serviceSupabase = getServiceSupabase();
  const { data: profile } = await serviceSupabase
    .from('profiles')
    .select('role, display_name')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.role !== 'admin') {
    redirect('/student/courses');
  }

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">管理端</h1>
          <p className="text-sm text-muted-foreground">
            欢迎，{profile.display_name ?? user.email}。下面是你可以操作的区域。
          </p>
        </header>

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>学员管理</CardTitle>
              <CardDescription>
                列出所有学员、为学员开通登录账号、重置密码或禁用账号。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link href="/admin/students">进入学员管理</Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>老师管理</CardTitle>
              <CardDescription>
                创建可登录的老师账号。老师能创作课件、查看课件，但不能管理学员账号。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link href="/admin/teachers">进入老师管理</Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>课件管理</CardTitle>
              <CardDescription>
                查看已保存到云端的课件列表，以只读模式预览学员看到的内容。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link href="/admin/courses">进入课件管理</Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="rounded-lg opacity-60">
            <CardHeader>
              <CardTitle>运营报表</CardTitle>
              <CardDescription>
                查看学员学习完成度与课程活跃度。后续阶段提供。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" disabled>
                <span>即将开放</span>
              </Button>
            </CardContent>
          </Card>
        </div>

        <footer className="text-xs text-muted-foreground text-center pt-6">
          需要新增学员/课程，请在 Supabase Studio 的 students / course_assignments 表里维护数据。
        </footer>
      </div>
    </main>
  );
}