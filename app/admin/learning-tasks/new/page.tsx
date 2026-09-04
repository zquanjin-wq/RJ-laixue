/**
 * /admin/learning-tasks/new
 *
 * 创建学习任务草稿。教师只能选择自己有权发布的课程；
 * 学员多选来自 /api/admin/students。
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/server/auth-context';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';
import { Button } from '@/components/ui/button';
import { CreateTaskForm } from '../_components/create-task-form';

export const dynamic = 'force-dynamic';

export default async function NewLearningTaskPage() {
  let courses: Array<{ id: string; title: string }>;
  try {
    const actor = await requireUser();
    if (actor.role === 'learner') redirect('/admin');
    const repository = new CourseRepository(getDatabasePool());
    const records = actor.role === 'admin'
      ? await repository.listCourses()
      : await repository.listOwnedCourses(actor.userId);
    courses = records.map((course) => ({ id: course.id, title: course.title }));
  } catch {
    redirect('/login?next=/admin/learning-tasks/new');
  }

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">新建学习任务</h1>
            <p className="text-sm text-muted-foreground">
              填写任务信息并保存草稿，随后可在详情页发布。
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/learning-tasks">返回任务列表</Link>
          </Button>
        </header>

        <div className="rounded-lg border bg-background p-6">
          <CreateTaskForm courses={courses} />
        </div>
      </div>
    </main>
  );
}
