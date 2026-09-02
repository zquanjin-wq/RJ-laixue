import Link from 'next/link';
import { AdminGate } from '@/components/auth-gate';
import CloudCourses from '@/components/cloud-courses';
import { Button } from '@/components/ui/button';

export default function CoursesPage() {
  return (
    <AdminGate>
      <main className="min-h-screen bg-background px-4 py-10">
        <div className="mx-auto max-w-6xl">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">课程管理</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                维护自己的课程，并从资源库发现可复用内容。
              </p>
            </div>
            <div className="flex gap-2">
              <Button asChild variant="outline">
                <Link href="/">返回驾驶舱</Link>
              </Button>
              <Button asChild>
                <Link href="/studio">AI 创建课程</Link>
              </Button>
            </div>
          </header>
          <CloudCourses />
        </div>
      </main>
    </AdminGate>
  );
}
