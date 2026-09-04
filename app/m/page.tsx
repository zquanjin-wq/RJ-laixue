import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { getCurrentActor } from '@/lib/server/auth-context';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export const dynamic = 'force-dynamic';

export default async function MobileCoursesPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login?next=/m');

  const courses = await new CourseRepository(getDatabasePool()).listCourses();
  const displayName = actor.name || actor.email.split('@')[0] || '同学';
  const isStaff = actor.role === 'admin' || actor.role === 'teacher';

  return (
    <main className="min-h-screen px-4 pt-6 pb-10">
      <header className="mx-auto mb-6 max-w-md">
        <h1 className="text-xl font-semibold tracking-tight">欢迎，{displayName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isStaff ? '管理者预览 · ' : ''}下方为可学习的课程
        </p>
      </header>

      <div className="mx-auto max-w-md space-y-3">
        {courses.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            暂无课程。管理员发布后会显示在这里。
          </div>
        )}

        {courses.map((course) => (
          <Link
            key={course.id}
            href={`/m/${course.id}`}
            className="block rounded-lg border bg-card p-4 transition-colors hover:bg-accent"
          >
            <h2 className="text-base font-medium leading-snug">{course.title || '未命名课件'}</h2>
            {course.topic && (
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{course.topic}</p>
            )}
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>更新于 {course.updatedAt.toLocaleDateString('zh-CN')}</span>
              <Button size="sm" variant="default" className="h-8 px-3 text-xs">
                开始学习 →
              </Button>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
