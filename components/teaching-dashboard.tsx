'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  Bot,
  Box,
  ChevronRight,
  ClipboardList,
  RefreshCw,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { TeachingDataChat } from '@/components/teaching-data-chat';

type DashboardData = {
  courseCount: number;
  taskCount: number;
  activeTaskCount: number;
  learnerCount: number;
  startedCount: number;
  completedCount: number;
  effectiveSeconds: number;
};
const initial: DashboardData = {
  courseCount: 0,
  taskCount: 0,
  activeTaskCount: 0,
  learnerCount: 0,
  startedCount: 0,
  completedCount: 0,
  effectiveSeconds: 0,
};
const percentage = (part: number, total: number) => (total ? Math.round((part / total) * 100) : 0);
function formatDuration(seconds: number) {
  return seconds < 3600
    ? `${Math.round(seconds / 60)} 分钟`
    : `${(seconds / 3600).toFixed(1)} 小时`;
}

export function TeachingDashboard() {
  const [data, setData] = useState<DashboardData>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const response = await fetch('/api/admin/teaching-dashboard');
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error('dashboard request failed');
      setData(result.data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);
  const dashboardState = data.courseCount === 0 ? 'no-course' : data.taskCount === 0 ? 'no-task' : 'active';
  const startedRate = percentage(data.startedCount, data.learnerCount);
  const completedRate = percentage(data.completedCount, data.learnerCount);

  return (
    <main className="min-h-screen bg-[#f6fcf8] text-[#14281d] [background-image:radial-gradient(ellipse_900px_420px_at_50%_-10%,rgba(28,172,93,.08),transparent_62%),linear-gradient(rgba(7,148,71,.06)_1px,transparent_1px),linear-gradient(90deg,rgba(7,148,71,.06)_1px,transparent_1px)] [background-size:auto,28px_28px,28px_28px]">
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-8 sm:px-6">
        <header className="flex min-h-12 items-center justify-between border-b border-emerald-950/10">
          <div className="flex items-center gap-2.5 font-semibold"><span className="grid size-7 place-items-center rounded-sm bg-[#079447] text-white"><Box className="size-4" /></span>来学·教师驾驶舱</div>
          <nav className="flex items-center text-sm"><Link className="rounded-md px-3 py-2 text-[#08743b] hover:bg-white/75" href="/">返回课程创作 <ArrowRight className="ml-1 inline size-4" /></Link></nav>
        </header>
        <section className="flex flex-col gap-3 py-6 md:flex-row md:items-end md:justify-between">
          <div><h1 className="text-3xl font-semibold leading-[1.3]">教师驾驶舱</h1><p className="mt-1 text-sm text-[#5f6f66]">将课程用于教学交付，并持续跟进学习效果。</p></div>
          {!loading && dashboardState === 'active' && <p className="w-fit rounded-full border border-emerald-900/10 bg-white/70 px-3 py-1.5 text-xs text-[#5f6f66]">当前共有 {data.taskCount} 项任务</p>}
        </section>
        {error ? (
          <section className="rounded-2xl border border-red-200 bg-white p-8 text-center"><h2 className="font-semibold">驾驶舱数据暂时无法加载</h2><p className="mt-1 text-sm text-[#5f6f66]">课程与任务本身不受影响，请稍后重试。</p><Button className="mt-5" variant="outline" onClick={() => void loadDashboard()}><RefreshCw className="mr-2 size-4" />重新加载</Button></section>
        ) : (
          <div className="grid overflow-hidden rounded-2xl border border-emerald-950/15 bg-white shadow-[0_18px_50px_-36px_rgba(20,40,29,.35)] min-[950px]:grid-cols-[1.65fr_1fr]">
            <section className="min-w-0 bg-white">
              <div className="border-b border-emerald-950/10 px-5 py-4"><h2 className="text-xl font-semibold">教学运营</h2><p className="mt-1 text-sm text-[#5f6f66]">沿着真实教学链路，快速进入下一步工作。</p></div>
              <div className="grid md:grid-cols-3">
                <ActionCard icon={BookOpen} title="课程准备" description="维护已有课程与交付内容。" href="/courses" action="课程管理" />
                <ActionCard icon={ClipboardList} title="任务发布" description="组合课程、分配学员并发布。" href="/admin/learning-tasks" action="学习任务" />
                <ActionCard icon={BarChart3} title="效果跟进" description="查看参学、完成与有效学习情况。" href="/teaching-data" action="数据中心" />
              </div>
              <div className="border-t border-emerald-950/10 px-5 py-4">
                <div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">教学概览</h2><p className="mt-1 text-xs text-[#5f6f66]">已发布学习任务的聚合数据</p></div><Link href="/teaching-data" className="text-sm font-medium text-[#08743b]">查看完整数据 <ArrowRight className="inline size-4" /></Link></div>
                {!loading && dashboardState !== 'active' ? (
                  <InlineEmptyState state={dashboardState} courseCount={data.courseCount} />
                ) : (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <Metric label="我的课程" value={data.courseCount} hint="课程总数" icon={BookOpen} loading={loading} href="/courses" />
                      <Metric label="进行中任务" value={data.activeTaskCount} hint={`共 ${data.taskCount} 个任务`} icon={ClipboardList} loading={loading} href="/admin/learning-tasks" />
                      <Metric label="参学人次" value={data.learnerCount} hint={`已开始 ${data.startedCount} 人次`} icon={Users} loading={loading} />
                      <Metric label="有效学习时长" value={formatDuration(data.effectiveSeconds)} hint={`开始率 ${startedRate}% · 完成率 ${completedRate}%`} icon={BarChart3} loading={loading} />
                    </div>
                    <div className="mt-5 rounded-xl bg-[#f5f8f6] p-4 text-sm"><span className="font-semibold">教学提示：</span>{data.learnerCount === 0 ? '先发布一项学习任务，学员开始学习后数据会逐步出现。' : data.startedCount === data.learnerCount ? '所有已分配学员都已开始学习，可重点关注完成情况。' : `还有 ${data.learnerCount - data.startedCount} 人次尚未开始，建议发送提醒或安排补学。`}</div>
                  </>
                )}
              </div>
            </section>
            <aside className="min-w-0 border-t border-emerald-950/15 bg-[#f8fbf9] p-5 text-[#14281d] min-[950px]:border-t-0 min-[950px]:border-l"><div className="flex items-center gap-2"><span className="size-2 rounded-full bg-[#079447]" /><Bot className="size-5 text-[#079447]" /><h2 className="text-xl font-semibold">问 AI</h2><span className="ml-auto font-mono text-[10px] font-semibold tracking-[.08em] text-[#08743b]">READ ONLY</span></div><p className="mt-2 text-sm leading-6 text-[#5f6f66]">根据已发布任务的数据，解释现状并给出跟进建议。</p><div className="mt-4 border-t border-emerald-950/10 pt-4"><TeachingDataChat disabled={!loading && dashboardState !== 'active'} /></div></aside>
          </div>
        )}
      </div>
    </main>
  );
}

function InlineEmptyState({ state, courseCount }: { state: 'no-course' | 'no-task'; courseCount: number }) {
  const noCourse = state === 'no-course';
  return <div className="flex flex-col gap-5 rounded-xl border-l-2 border-[#079447] bg-[#f4faf6] p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-mono text-[10px] font-semibold tracking-[.12em] text-[#08743b]">{noCourse ? 'FIRST COURSE' : 'READY TO DELIVER'}</p><h3 className="mt-2 font-semibold">{noCourse ? '还没有课程' : '已有课程，尚无学习任务'}</h3><p className="mt-1 text-sm leading-6 text-[#5f6f66]">{noCourse ? '先完成第一门课程，之后可按需进入教学交付。' : `你已有 ${courseCount} 门课程；需要教学交付时，再将课程组合为学习任务。`}</p></div><Button asChild className="shrink-0 bg-[#079447] hover:bg-[#08743b]"><Link href={noCourse ? '/' : '/admin/learning-tasks'}>{noCourse ? '返回课程创作' : '创建学习任务'}<ChevronRight className="ml-1 size-4" /></Link></Button></div>;
}

function Metric({
  label,
  value,
  hint,
  icon: Icon,
  loading,
  href,
}: {
  label: string;
  value: string | number;
  hint: string;
  icon: typeof BookOpen;
  loading: boolean;
  href?: string;
}) {
  const content = (
    <>
      <Icon className="size-5 text-[#079447]" />
      <p className="mt-4 text-sm text-[#5f6f66]">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{loading ? '—' : value}</p>
      <p className="mt-2 text-xs text-[#5f6f66]">{hint}</p>
    </>
  );
  return href ? (
    <Link href={href} className="rounded-lg border p-4 transition-colors hover:bg-muted/50">
      {content}
    </Link>
  ) : (
    <div className="rounded-lg border p-4">{content}</div>
  );
}

function ActionCard({
  icon: Icon,
  title,
  description,
  href,
  action,
}: {
  icon: typeof BookOpen;
  title: string;
  description: string;
  href: string;
  action: string;
}) {
  return (
    <Card className="gap-0 rounded-none border-0 border-b border-emerald-950/10 py-0 shadow-none last:border-b-0 md:border-r md:border-b-0 md:last:border-r-0">
      <CardContent className="p-5">
        <Icon className="size-5 text-[#079447]" />
        <h2 className="mt-3 font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-[#5f6f66]">{description}</p>
        <Button asChild className="mt-2 h-8 px-0 text-[#08743b]" variant="link">
          <Link href={href}>
            {action}
            <ChevronRight className="ml-1 size-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
