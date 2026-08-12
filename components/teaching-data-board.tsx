'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, BarChart3, Clock3, TriangleAlert, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Task = {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  learnerCount: number;
  completedCount: number;
  completionRate: number;
  courseCount: number;
  overdueCount: number;
  notStartedCount: number;
};
type Learner = {
  taskId: string;
  taskTitle: string;
  studentId: string;
  studentName: string;
  status: string;
  progressPercent: number;
  effectiveSeconds: number;
  lastSeenAt: string | null;
};
type Data = {
  overview: {
    total: number;
    started: number;
    completed: number;
    overdue: number;
    effectiveSeconds: number;
    startRate: number;
    completionRate: number;
  };
  tasks: Task[];
  needsAttention: Learner[];
};

const initial: Data = {
  overview: {
    total: 0,
    started: 0,
    completed: 0,
    overdue: 0,
    effectiveSeconds: 0,
    startRate: 0,
    completionRate: 0,
  },
  tasks: [],
  needsAttention: [],
};
function formatDuration(seconds: number) {
  return seconds < 3600
    ? `${Math.round(seconds / 60)} 分钟`
    : `${(seconds / 3600).toFixed(1)} 小时`;
}
function label(status: string) {
  return status === 'overdue'
    ? '已逾期'
    : status === 'not_started'
      ? '未开始'
      : status === 'completed'
        ? '已完成'
        : '学习中';
}

export function TeachingDataBoard() {
  const [data, setData] = useState<Data>(initial);
  const [taskId, setTaskId] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    fetch(
      `/api/admin/teaching-data?status=published${taskId ? `&taskId=${encodeURIComponent(taskId)}` : ''}`,
    )
      .then((response) => response.json())
      .then((result) => {
        if (result.success) setData(result.data);
      })
      .finally(() => setLoading(false));
  }, [taskId]);
  const overview = data.overview;
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 dark:bg-background">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-primary">来学 · 教学数据中心</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">教学数据看板</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              从整体进度定位需要关注的任务与学员。
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href="/">
              <ArrowLeft className="mr-2 size-4" />
              返回教学驾驶舱
            </Link>
          </Button>
        </header>
        <div className="flex items-center gap-3">
          <label htmlFor="task" className="text-sm font-medium">
            查看任务
          </label>
          <select
            id="task"
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm"
          >
            <option value="">所有进行中任务</option>
            {data.tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </div>
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            icon={Users}
            label="参学人次"
            value={overview.total}
            hint={`已开始 ${overview.started}`}
            loading={loading}
          />
          <Stat
            icon={BarChart3}
            label="完成率"
            value={`${overview.completionRate}%`}
            hint={`已完成 ${overview.completed}`}
            loading={loading}
          />
          <Stat
            icon={Clock3}
            label="有效学习时长"
            value={formatDuration(overview.effectiveSeconds)}
            hint={`开始率 ${overview.startRate}%`}
            loading={loading}
          />
          <Stat
            icon={TriangleAlert}
            label="需关注"
            value={overview.overdue}
            hint="已逾期未完成"
            loading={loading}
          />
        </section>
        <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <Card>
            <CardHeader>
              <CardTitle>任务进度</CardTitle>
              <CardDescription>点击某项任务查看详细学员、章节和 AI 简报。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.tasks.map((task) => (
                <Link
                  key={task.id}
                  href={`/admin/learning-tasks/${task.id}`}
                  className="block rounded-lg border p-4 hover:bg-muted/50"
                >
                  <div className="flex justify-between gap-3">
                    <span className="font-medium">{task.title}</span>
                    <span className="text-sm text-muted-foreground">
                      {task.completionRate}% 完成
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {task.courseCount} 门课程 · {task.completedCount} / {task.learnerCount} 人已完成
                    {task.dueAt ? ` · 截止 ${new Date(task.dueAt).toLocaleString('zh-CN')}` : ''}
                  </p>
                  {(task.overdueCount > 0 || task.notStartedCount > 0) && (
                    <p className="mt-1 text-xs text-amber-700">
                      已逾期 {task.overdueCount} 人 · 未开始 {task.notStartedCount} 人
                    </p>
                  )}
                </Link>
              ))}
              {!loading && !data.tasks.length && (
                <p className="text-sm text-muted-foreground">暂无进行中任务。</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>需要关注的学员</CardTitle>
              <CardDescription>未开始或已逾期的学员。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.needsAttention.map((learner) => (
                <Link
                  key={`${learner.taskId}-${learner.studentId}`}
                  href={`/admin/learning-tasks/${learner.taskId}`}
                  className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/50"
                >
                  <div>
                    <p className="font-medium">{learner.studentName}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{learner.taskTitle}</p>
                  </div>
                  <span className="text-sm text-amber-700">{label(learner.status)}</span>
                </Link>
              ))}
              {!loading && !data.needsAttention.length && (
                <p className="text-sm text-muted-foreground">目前没有需要紧急关注的学员。</p>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  loading,
}: {
  icon: typeof Users;
  label: string;
  value: string | number;
  hint: string;
  loading: boolean;
}) {
  return (
    <Card className="shadow-sm">
      <CardContent className="p-5">
        <Icon className="size-5 text-primary" />
        <p className="mt-4 text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold">{loading ? '—' : value}</p>
        <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
