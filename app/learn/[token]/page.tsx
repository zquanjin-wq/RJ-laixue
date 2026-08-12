/**
 * /learn/[token]
 *
 * 学习任务学员入口。
 *   - 未登录：引导登录并保留回跳路径；
 *   - 名单内学员：校验时间后进入 /classroom/{courseId}?task={taskId}&share=1；
 *   - 非名单学员：403 友好页面，不泄漏任务详情；
 *   - 未开始任务：显示尚未开始；
 *   - 无效 token：404；
 *   - admin/teacher：preview，不冒充学员。
 */
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getServerSupabase } from '@/lib/supabase/server';
import { resolveTaskEntry } from '@/lib/server/learning-tasks/task-entry';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function LearnTaskPage({ params }: PageProps) {
  const { token } = await params;

  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();

  if (!user) {
    const next = `/learn/${encodeURIComponent(token)}`;
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  const entry = await resolveTaskEntry(user.id, token);

  if (!entry.ok) {
    if (entry.status === 404) {
      notFound();
    }

    return (
      <main className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-md rounded-lg">
          <CardHeader>
            <CardTitle>无法进入学习任务</CardTitle>
            <CardDescription>
              {entry.status === 403 ? '你没有权限访问此任务。' : '任务加载失败，请稍后重试。'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{entry.error}</p>
            <Button asChild variant="outline" size="sm">
              <Link href="/student/courses">返回学员首页</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (entry.status === 'not_started_yet') {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-md rounded-lg">
          <CardHeader>
            <CardTitle>任务尚未开始</CardTitle>
            <CardDescription>请等待老师设定的开始时间后再进入。</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm">
              <Link href="/student/courses">返回学员首页</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const target = `/classroom/${encodeURIComponent(entry.courseId)}?task=${encodeURIComponent(entry.taskId)}&share=1`;
  redirect(target);
}
