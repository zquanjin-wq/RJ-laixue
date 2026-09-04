import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentActor } from '@/lib/server/auth-context';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export const dynamic = 'force-dynamic';

export default async function AdminCoursesPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login?next=/admin/courses');
  if (actor.role !== 'admin') redirect('/admin');
  const courses = await new CourseRepository(getDatabasePool()).listCourses();

  return <main className="min-h-screen bg-background px-4 py-10"><div className="mx-auto max-w-4xl space-y-6"><header className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">课程管理</h1><p className="text-sm text-muted-foreground">{courses.length} 个已保存课程 · 点击查看可预览学习页面</p></div><div className="flex gap-2"><Button asChild variant="outline" size="sm"><Link href="/admin">返回管理端</Link></Button><Button asChild size="sm"><Link href="/studio">AI 创建课程</Link></Button></div></header><section className="space-y-3">{courses.length===0 ? <Card className="rounded-lg"><CardHeader><CardTitle>暂无课程</CardTitle><CardDescription>请先通过 AI 创建课程并保存。</CardDescription></CardHeader><CardContent><Button asChild><Link href="/studio">前往创建课程</Link></Button></CardContent></Card> : courses.map(course=><article key={course.id} className="flex flex-col gap-3 rounded-lg border bg-background p-4 md:flex-row md:items-center md:justify-between"><div className="min-w-0 flex-1 space-y-1"><p className="truncate font-medium">{course.title || '未命名课程'}</p>{course.topic && <p className="line-clamp-2 text-xs text-muted-foreground">{course.topic}</p>}<p className="text-xs text-muted-foreground">更新于 {course.updatedAt.toLocaleString('zh-CN')}</p></div><Button asChild variant="outline" size="sm"><Link href={`/classroom/${course.id}`} target="_blank">查看</Link></Button></article>)}</section></div></main>;
}
