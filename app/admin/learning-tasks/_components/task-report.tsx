'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type ReportData = {
  overview: {
    total: number;
    notStarted: number;
    inProgress: number;
    completed: number;
    overdue: number;
    startRate: number;
    completionRate: number;
    effectiveSeconds: number;
  };
  learners: Array<{
    studentId: string;
    name: string;
    displayStatus: 'not_started' | 'in_progress' | 'completed' | 'overdue';
    progressPercent: number;
    masteryPercent: number | null;
    effectiveSeconds: number;
    lastSeenAt: string | null;
  }>;
  courses: Array<{
    courseId: string;
    title: string;
    position: number;
    isRequired: boolean;
    learnerCount: number;
    startedCount: number;
    completedCount: number;
    completionRate: number;
    effectiveSeconds: number;
  }>;
};

export function TaskReport({ taskId }: { taskId: string }) {
  const [report, setReport] = useState<ReportData | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (showLoading = false) => {
      if (showLoading) setRefreshing(true);
      try {
        const response = await fetch(`/api/admin/learning-tasks/${taskId}/report`);
        const body = (await response.json()) as { success?: boolean; data?: ReportData };
        if (response.ok && body.success && body.data) setReport(body.data);
      } catch {
        // Keep the last successful report visible while a short network interruption recovers.
      } finally {
        if (showLoading) setRefreshing(false);
      }
    },
    [taskId],
  );

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (!report) {
    return <p className="py-8 text-center text-sm text-muted-foreground">正在加载学习数据…</p>;
  }

  return (
    <section className="space-y-6">
      <Card className="rounded-lg">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">学习概览</CardTitle>
              <CardDescription>
                基于本任务内学员的学习记录实时汇总，每 30 秒自动更新。
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load(true)}
              disabled={refreshing}
            >
              {refreshing ? '刷新中…' : '刷新数据'}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="应学" value={report.overview.total} />
            <Metric label="未开始" value={report.overview.notStarted} />
            <Metric label="学习中" value={report.overview.inProgress} />
            <Metric label="已完成" value={report.overview.completed} />
            <Metric label="逾期" value={report.overview.overdue} />
            <Metric label="开始率" value={`${report.overview.startRate}%`} />
            <Metric label="完成率" value={`${report.overview.completionRate}%`} />
            <Metric label="有效时长" value={formatDuration(report.overview.effectiveSeconds)} />
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle className="text-base">课程组合进度</CardTitle>
          <CardDescription>以本任务为范围，查看每门课程的学习率与完成率。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {report.courses.map((course) => (
            <div key={course.courseId} className="rounded-md border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">
                    第 {course.position} 门：{course.title}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {course.isRequired ? '必修' : '选修'} · 已开始 {course.startedCount}/
                    {course.learnerCount} 人
                  </p>
                </div>
                <span className="text-sm font-medium">{course.completionRate}% 完成</span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${course.completionRate}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                已完成 {course.completedCount}/{course.learnerCount} 人 · 有效时长{' '}
                {formatDuration(course.effectiveSeconds)}
              </p>
            </div>
          ))}
          {report.courses.length === 0 && (
            <p className="text-sm text-muted-foreground">暂无课程组合数据。</p>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle className="text-base">学员明细</CardTitle>
          <CardDescription>掌握度仅在有可靠检查题结果时展示。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">姓名</th>
                  <th className="pb-2 font-medium">状态</th>
                  <th className="pb-2 font-medium">进度</th>
                  <th className="pb-2 font-medium">掌握度</th>
                  <th className="pb-2 font-medium">有效时长</th>
                  <th className="pb-2 font-medium">最后学习</th>
                </tr>
              </thead>
              <tbody>
                {report.learners.map((learner) => (
                  <tr key={learner.studentId} className="border-b last:border-0">
                    <td className="py-3">{learner.name}</td>
                    <td className="py-3">{statusLabel(learner.displayStatus)}</td>
                    <td className="py-3">{learner.progressPercent}%</td>
                    <td className="py-3">
                      {learner.masteryPercent == null ? '—' : `${learner.masteryPercent}%`}
                    </td>
                    <td className="py-3">{formatDuration(learner.effectiveSeconds)}</td>
                    <td className="py-3 text-muted-foreground">
                      {learner.lastSeenAt
                        ? new Date(learner.lastSeenAt).toLocaleString('zh-CN')
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {report.learners.length === 0 && (
              <p className="py-4 text-sm text-muted-foreground">暂未指定学员。</p>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

function statusLabel(status: ReportData['learners'][number]['displayStatus']) {
  return { not_started: '未开始', in_progress: '学习中', completed: '已完成', overdue: '逾期' }[
    status
  ];
}
