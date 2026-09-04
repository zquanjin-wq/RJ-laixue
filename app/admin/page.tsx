import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getCurrentActor } from '@/lib/server/auth-context';

export const dynamic = 'force-dynamic';

export default async function AdminHubPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login?next=/admin');
  if (actor.role !== 'admin' && actor.role !== 'teacher') redirect('/student/courses');
  const isAdmin = actor.role === 'admin';

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">管理端</h1>
          <p className="text-sm text-muted-foreground">欢迎，{actor.name || actor.email}。下面是你可以操作的区域。</p>
        </header>
        <div className="grid gap-4 md:grid-cols-2">
          {isAdmin && <AdminCard title="学员管理" description="创建、重置密码、启用或停用学员账号。" href="/admin/students" label="进入学员管理" />}
          {isAdmin && <AdminCard title="教师管理" description="创建、重置密码、启用或停用教师账号。" href="/admin/teachers" label="进入教师管理" />}
          <AdminCard title="课程管理" description="查看和维护已保存的课程内容。" href="/courses" label="进入课程管理" />
          <AdminCard title="学习任务" description="创建、分配并发布学习任务。" href="/admin/learning-tasks" label="进入学习任务" />
        </div>
      </div>
    </main>
  );
}

function AdminCard({ title, description, href, label }: { title: string; description: string; href: string; label: string }) {
  return <Card className="rounded-lg"><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent><Button asChild><Link href={href}>{label}</Link></Button></CardContent></Card>;
}
