import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getCurrentActor } from '@/lib/server/auth-context';
import { getAccountManagementAccess } from '@/lib/server/account-management';

export const dynamic = 'force-dynamic';

export default async function AdminHubPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login?next=/admin');
  if (actor.role !== 'admin' && actor.role !== 'teacher') redirect('/student/courses');
  const isAdmin = actor.role === 'admin';
  const accountAccess = await getAccountManagementAccess(actor);

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-4xl space-y-8">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">管理端</h1>
          <p className="text-sm text-muted-foreground">
            欢迎，{actor.name || actor.email}。下面是你可以操作的区域。
          </p>
        </header>
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">教学工作台</h2>
            <p className="text-sm text-muted-foreground">备课、维护课程并向学员发布学习任务。</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <AdminCard
              title="课程管理"
              description="查看和维护已保存的课程内容。"
              href="/courses"
              label="进入课程管理"
            />
            <AdminCard
              title="学习任务"
              description="创建、分配并发布学习任务。"
              href="/admin/learning-tasks"
              label="进入学习任务"
            />
          </div>
        </section>
        {accountAccess && (
          <section className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold">组织与账号</h2>
              <p className="text-sm text-muted-foreground">
                {isAdmin
                  ? '管理组织归属、成员账号和教师账号管理权。'
                  : '管理你获授权的组织范围内的学员账号。'}
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <AdminCard
                title="成员账号"
                description={
                  isAdmin ? '统一管理管理员、教师和学员。' : '创建、重置、启停本组织学员。'
                }
                href="/admin/accounts"
                label="进入组织与账号"
              />
              {isAdmin && (
                <AdminCard
                  title="旧版教师管理"
                  description="过渡期保留的教师创建与维护入口。"
                  href="/admin/teachers"
                  label="进入教师管理"
                />
              )}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function AdminCard({
  title,
  description,
  href,
  label,
}: {
  title: string;
  description: string;
  href: string;
  label: string;
}) {
  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild>
          <Link href={href}>{label}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
