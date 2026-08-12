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

function formatDuration(seconds: number) {
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

function percentage(part: number, total: number) {
  return total ? Math.round((part / total) * 100) : 0;
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
                <CardDescription>所有已发布学习任务的汇总。</CardDescription>
              </div>
              <Button asChild variant="ghost" size="sm">
                <Link href="/admin/learning-tasks">
                  查看任务 <ChevronRight className="ml-1 size-4" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
                  hint="来自已发布任务"
                  icon={BarChart3}
                  loading={loading}
                />
                <Metric
                  label="开始率"
                  value={`${startedRate}%`}
                  hint={`${data.startedCount} / ${data.learnerCount} 人次`}
                  icon={ClipboardList}
                  loading={loading}
                />
                <Metric
                  label="完成率"
                  value={`${completedRate}%`}
                  hint={`${data.completedCount} / ${data.learnerCount} 人次`}
                  icon={BookOpen}
                  loading={loading}
                />
              </div>
              <div className="rounded-lg bg-muted/60 p-4 text-sm">
                <span className="font-medium">教学提示：</span>{' '}
                {data.learnerCount === 0
                  ? '先发布一项学习任务，学员开始学习后数据会逐步出现。'
                  : data.startedCount === data.learnerCount
                    ? '所有已分配学员都已开始学习，可重点关注完成情况与章节问题。'
                    : `还有 ${data.learnerCount - data.startedCount} 人次尚未开始，建议发送提醒或安排补学。`}
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bot className="size-5 text-primary" />问 AI
              </CardTitle>
              <CardDescription>用教学数据帮你判断下一步。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg border bg-background p-3 text-sm">
                “哪些学员还没开始？”
              </div>
              <div className="rounded-lg border bg-background p-3 text-sm">
                “哪个章节最需要补学？”
              </div>
              <div className="rounded-lg border bg-background p-3 text-sm">
                “帮我生成本周教学简报”
              </div>
              <Button asChild className="w-full" variant="outline">
                <Link href="/admin/learning-tasks">在任务详情中使用 AI 简报</Link>
              </Button>
              <p className="text-xs text-muted-foreground">
                对话式数据问答即将接入；当前可在任务详情生成 AI 教学简报和补学建议。
              </p>
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
}: {
  label: string;
  value: string | number;
  hint: string;
  icon: typeof BookOpen;
  loading: boolean;
}) {
  return (
    <div className="rounded-lg border p-4">
      <Icon className="size-5 text-primary" />
      <p className="mt-4 text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{loading ? '—' : value}</p>
      <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
    </div>
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
