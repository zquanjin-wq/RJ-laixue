'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  Bot,
  ChevronRight,
  ClipboardList,
  Sparkles,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  useEffect(() => {
    fetch('/api/admin/teaching-dashboard')
      .then((response) => response.json())
      .then((result) => {
        if (result.success) setData(result.data);
      })
      .finally(() => setLoading(false));
  }, []);
  const startedRate = percentage(data.startedCount, data.learnerCount);
  const completedRate = percentage(data.completedCount, data.learnerCount);

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 dark:bg-background">
      <div className="mx-auto max-w-7xl space-y-6">
        <header>
          <p className="text-sm font-medium text-primary">来学 · 教学驾驶舱</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">把课程变成可管理的学习结果</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            课程、学习任务和教学数据，都从这里开始。
          </p>
        </header>
        <section className="grid gap-4 md:grid-cols-3">
          <ActionCard
            icon={BookOpen}
            title="课程管理"
            description="查看、整理和继续编辑你的课程。"
            href="/courses"
            action="进入课程管理"
          />
          <ActionCard
            icon={ClipboardList}
            title="学习任务"
            description="创建任务、分配学员、跟进学习。"
            href="/admin/learning-tasks"
            action="进入任务管理"
          />
          <ActionCard
            icon={Sparkles}
            title="AI 创建课程"
            description="从一句需求开始，生成结构化课程。"
            href="/studio"
            action="开始创建"
          />
        </section>
        <section className="grid gap-6 xl:grid-cols-[1.45fr_0.85fr]">
          <Card className="shadow-sm">
            <CardHeader className="flex-row items-center justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="size-5 text-primary" />
                  学习数据看板
                </CardTitle>
                <CardDescription>当前权限范围内已发布学习任务的汇总。</CardDescription>
              </div>
              <Button asChild variant="ghost" size="sm">
                <Link href="/teaching-data">
                  进入数据中心 <ChevronRight className="ml-1 size-4" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Metric
                  label="我的课程"
                  value={data.courseCount}
                  hint="进入课程管理"
                  icon={BookOpen}
                  loading={loading}
                  href="/courses"
                />
                <Metric
                  label="进行中任务"
                  value={data.activeTaskCount}
                  hint={`共 ${data.taskCount} 个任务`}
                  icon={ClipboardList}
                  loading={loading}
                  href="/admin/learning-tasks"
                />
                <Metric
                  label="参学人次"
                  value={data.learnerCount}
                  hint={`已开始 ${data.startedCount} 人次`}
                  icon={Users}
                  loading={loading}
                />
                <Metric
                  label="有效学习时长"
                  value={formatDuration(data.effectiveSeconds)}
                  hint={`开始率 ${startedRate}% · 完成率 ${completedRate}%`}
                  icon={BarChart3}
                  loading={loading}
                />
              </div>
              <div className="rounded-lg bg-muted/60 p-4 text-sm">
                <span className="font-medium">教学提示：</span>
                {data.learnerCount === 0
                  ? '先发布一项学习任务，学员开始学习后数据会逐步出现。'
                  : data.startedCount === data.learnerCount
                    ? '所有已分配学员都已开始学习，可重点关注完成情况。'
                    : `还有 ${data.learnerCount - data.startedCount} 人次尚未开始，建议发送提醒或安排补学。`}
              </div>
            </CardContent>
          </Card>
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bot className="size-5 text-primary" />问 AI
              </CardTitle>
              <CardDescription>用你权限范围内的教学数据判断下一步。</CardDescription>
            </CardHeader>
            <CardContent>
              <TeachingDataChat />
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  );
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
      <Icon className="size-5 text-primary" />
      <p className="mt-4 text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{loading ? '—' : value}</p>
      <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
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
    <Card className="shadow-sm">
      <CardContent className="p-5">
        <Icon className="size-5 text-primary" />
        <h2 className="mt-4 font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        <Button asChild className="mt-4 px-0" variant="link">
          <Link href={href}>
            {action}
            <ChevronRight className="ml-1 size-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
