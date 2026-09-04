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
import { getCurrentActor } from '@/lib/server/auth-context';
import { resolveTaskEntry } from '@/lib/server/learning-tasks/task-entry';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function LearnTaskPage({ params }: PageProps) {
  const { token } = await params;

  const actor = await getCurrentActor();
  if (!actor) {
    const next = `/learn/${encodeURIComponent(token)}`;
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  const entry = await resolveTaskEntry(actor.userId, token);

  if (!entry.ok) {
    if (entry.reason === 'not_found') notFound();

    return (
      <main className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-md rounded-lg">
          <CardHeader>
            <CardTitle>无法进入学习任务</CardTitle>
            <CardDescription>
              {entry.reason === 'forbidden' ? '你没有权限访问此任务。' : '任务加载失败，请稍后重试。'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">Please contact your teacher if you think this is incorrect.</p>
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

  if ((entry.courses?.length ?? 0) > 1) {
    return (
      <TaskCoursePackage
        taskId={entry.taskId}
        title={entry.title}
        token={token}
        courses={(entry.courses ?? []).map((course) => ({ courseId: course.id, title: course.title, position: course.position }))}
      />
    );
  }
  const target = `/classroom/${encodeURIComponent(entry.courseId)}?task=${encodeURIComponent(entry.taskId)}&token=${encodeURIComponent(token)}&share=1`;
  redirect(target);
}

function TaskCoursePackage({
  taskId,
  title,
  token,
  courses,
}: {
  taskId: string;
  title: string | null;
  token: string;
  courses: Array<{ courseId: string; title: string | null; position: number }>;
}) {
  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <p className="text-sm font-medium text-primary">学习任务</p>
          <h1 className="mt-1 text-2xl font-semibold">{title || '课程学习任务'}</h1>
          <p className="mt-2 text-sm text-muted-foreground">请按顺序学习本次任务中的课程。</p>
        </header>
        <Card>
          <CardContent className="space-y-3 p-5">
            {courses.map((course) => (
              <Link
                key={course.courseId}
                href={`/classroom/${encodeURIComponent(course.courseId)}?task=${encodeURIComponent(taskId)}&token=${encodeURIComponent(token)}&course=${encodeURIComponent(course.courseId)}&share=1`}
                className="flex items-center justify-between rounded-lg border p-4 hover:bg-muted/50"
              >
                <div>
                  <p className="text-xs text-muted-foreground">第 {course.position} 门</p>
                  <p className="mt-1 font-medium">{course.title || '未命名课程'}</p>
                </div>
                <span className="text-sm text-primary">进入学习</span>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Button asChild variant="outline">
          <Link
            href={`/student/courses?task=${encodeURIComponent(taskId)}&token=${encodeURIComponent(token)}`}
          >
            返回学习首页
          </Link>
        </Button>
      </div>
    </main>
  );
}
