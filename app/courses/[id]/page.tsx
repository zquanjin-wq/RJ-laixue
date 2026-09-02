import Link from 'next/link';
import { AdminGate } from '@/components/auth-gate';
import { CourseDataReport } from '@/components/course-data-report';
import { Button } from '@/components/ui/button';

export default async function CourseDataPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminGate>
      <main className="min-h-screen bg-background px-4 py-10">
        <div className="mx-auto max-w-5xl space-y-6">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-primary">课程数据中心</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">课程学习效果</h1>
              <p className="mt-1 text-sm text-muted-foreground">跨任务查看这门课的学习情况。</p>
            </div>
            <Button asChild variant="outline">
              <Link href="/courses">返回课程管理</Link>
            </Button>
          </header>
          <CourseDataReport courseId={id} />
        </div>
      </main>
    </AdminGate>
  );
}
