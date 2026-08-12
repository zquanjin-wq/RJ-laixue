'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  Bot,
  CalendarClock,
  ChevronRight,
  ClipboardList,
  GraduationCap,
  Plus,
  Sparkles,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type Task = { id: string; title: string | null; status: string; due_at: string | null };
type DashboardData = {
  courseCount: number;
  taskCount: number;
  activeTaskCount: number;
  learnerCount: number;
  startedCount: number;
  completedCount: number;
  effectiveSeconds: number;
  dueSoon: Task[];
  recentTasks: Task[];
};

const initial: DashboardData = {
  courseCount: 0,
  taskCount: 0,
  activeTaskCount: 0,
  learnerCount: 0,
  startedCount: 0,
  completedCount: 0,
  effectiveSeconds: 0,
  dueSoon: [],
  recentTasks: [],
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
  const metrics = [
    { label: '我的课程', value: data.courseCount, icon: BookOpen, hint: '可继续编辑或创建任务' },
    {
      label: '进行中任务',
      value: data.activeTaskCount,
      icon: ClipboardList,
      hint: `全部任务 ${data.taskCount} 个`,
    },
    {
      label: '参学人次',
      value: data.learnerCount,
      icon: Users,
      hint: `已开始 ${data.startedCount} 人次`,
    },
    {
      label: '有效学习时长',
      value: formatDuration(data.effectiveSeconds),
      icon: BarChart3,
      hint: '来自已发布学习任务',
    },
  ];

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 dark:bg-background">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-primary">来学 · 教学驾驶舱</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">
              把课程变成可管理的学习结果
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              查看教学进展、发现需要关注的学员，并继续创建下一门课程。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href="/courses">
                <BookOpen className="mr-2 size-4" />
                课程管理
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/admin/learning-tasks/new">
                <ClipboardList className="mr-2 size-4" />
                创建任务
              </Link>
            </Button>
            <Button asChild>
              <Link href="/studio">
                <Sparkles className="mr-2 size-4" />
                AI 创建课程
              </Link>
            </Button>
          </div>
        </header>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric) => (
            <Card key={metric.label} className="border-none shadow-sm">
              <CardContent className="flex items-start justify-between p-5">
                <div>
                  <p className="text-sm text-muted-foreground">{metric.label}</p>
                  <p className="mt-2 text-3xl font-semibold">{loading ? '—' : metric.value}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{metric.hint}</p>
                </div>
                <metric.icon className="size-5 text-primary" />
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.45fr_0.85fr]">
          <Card className="shadow-sm">
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>学习进展</CardTitle>
                <CardDescription>所有已发布任务的汇总</CardDescription>
              </div>
              <Button asChild variant="ghost" size="sm">
                <Link href="/admin/learning-tasks">
                  查看任务 <ChevronRight className="ml-1 size-4" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <ProgressItem
                  label="开始率"
                  value={startedRate}
                  detail={`${data.startedCount} / ${data.learnerCount} 人次已开始`}
                />
                <ProgressItem
                  label="完成率"
                  value={completedRate}
                  detail={`${data.completedCount} / ${data.learnerCount} 人次已完成`}
                />
              </div>
              <div className="rounded-lg bg-muted/60 p-4 text-sm">
                <span className="font-medium">教学提示：</span>
                {data.learnerCount === 0
                  ? '先创建并发布一项学习任务，数据会从学员开始学习后逐步出现。'
                  : data.startedCount === data.learnerCount
                    ? '所有已分配学员都已开始学习，可以重点关注完成率与章节问题。'
                    : `还有 ${data.learnerCount - data.startedCount} 人次尚未开始，适合发送提醒或安排补学。`}
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bot className="size-5 text-primary" />
                AI 教学助手
              </CardTitle>
              <CardDescription>基于任务和学习数据，帮助你判断下一步。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg border bg-background p-3 text-sm">
                “哪些学员还没开始？”
              </div>
              <div className="rounded-lg border bg-background p-3 text-sm">
                “帮我生成本周教学简报”
              </div>
              <div className="rounded-lg border bg-background p-3 text-sm">
                “哪个章节最需要补学？”
              </div>
              <Button asChild className="w-full" variant="outline">
                <Link href="/admin/learning-tasks">进入任务数据与 AI 简报</Link>
              </Button>
              <p className="text-xs text-muted-foreground">
                数据对话将在下一阶段接入；当前可在任务详情生成 AI 教学简报和补学建议。
              </p>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-6 xl:grid-cols-2">
          <Card className="shadow-sm">
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>临近截止</CardTitle>
                <CardDescription>未来 7 天内需要关注的任务</CardDescription>
              </div>
              <CalendarClock className="size-5 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-muted-foreground">加载中…</p>
              ) : data.dueSoon.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂时没有临近截止的学习任务。</p>
              ) : (
                <TaskList tasks={data.dueSoon} />
              )}
            </CardContent>
          </Card>
          <Card className="shadow-sm">
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>最近任务</CardTitle>
                <CardDescription>继续处理最近创建的教学任务</CardDescription>
              </div>
              <GraduationCap className="size-5 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-muted-foreground">加载中…</p>
              ) : data.recentTasks.length === 0 ? (
                <EmptyTasks />
              ) : (
                <TaskList tasks={data.recentTasks} />
              )}
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <QuickLink
            icon={Sparkles}
            title="AI 创建课程"
            description="从一句需求开始，生成结构化课程。"
            href="/studio"
            action="开始创建"
          />
          <QuickLink
            icon={ClipboardList}
            title="学习任务"
            description="分配学员、发布任务、查看学习进展。"
            href="/admin/learning-tasks"
            action="管理任务"
          />
          <QuickLink
            icon={Plus}
            title="课程资源库"
            description="浏览、复用并维护你的课程资产。"
            href="/courses"
            action="查看课程"
          />
        </section>
      </div>
    </main>
  );
}

function ProgressItem({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-baseline justify-between">
        <span className="font-medium">{label}</span>
        <span className="text-2xl font-semibold">{value}%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${value}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}
function TaskList({ tasks }: { tasks: Task[] }) {
  return (
    <div className="space-y-2">
      {tasks.map((task) => (
        <Link
          key={task.id}
          href={`/admin/learning-tasks/${task.id}`}
          className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-muted/50"
        >
          <div>
            <p className="font-medium">{task.title || '未命名任务'}</p>
            {task.due_at && (
              <p className="mt-1 text-xs text-muted-foreground">
                截止：{new Date(task.due_at).toLocaleString('zh-CN')}
              </p>
            )}
          </div>
          <Badge variant={task.status === 'published' ? 'default' : 'secondary'}>
            {task.status === 'published' ? '进行中' : '草稿'}
          </Badge>
        </Link>
      ))}
    </div>
  );
}
function EmptyTasks() {
  return (
    <div className="rounded-lg border border-dashed p-5 text-center">
      <p className="text-sm text-muted-foreground">还没有创建学习任务。</p>
      <Button asChild className="mt-3" size="sm">
        <Link href="/admin/learning-tasks/new">创建第一个任务</Link>
      </Button>
    </div>
  );
}
function QuickLink({
  icon: Icon,
  title,
  description,
  href,
  action,
}: {
  icon: typeof Sparkles;
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
