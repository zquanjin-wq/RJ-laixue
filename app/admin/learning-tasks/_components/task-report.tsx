'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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
  chapters: Array<{
    id: string;
    title: string;
    completedLearners: number;
    completionRate: number;
    questionsAsked: number;
  }>;
};

export function TaskReport({ taskId }: { taskId: string }) {
  const [report, setReport] = useState<ReportData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/learning-tasks/${taskId}/report`)
      .then(async (response) => {
        const body = (await response.json()) as { success?: boolean; data?: ReportData };
        if (!cancelled && response.ok && body.success && body.data) setReport(body.data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (!report) return null;

  return (
    <section className="space-y-6">
      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle className="text-base">学习概览</CardTitle>
          <CardDescription>基于学员学习记录实时汇总。</CardDescription>
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

      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle className="text-base">章节分析</CardTitle>
          <CardDescription>仅展示课件页面完成情况与提问次数。</CardDescription>
        </CardHeader>
        <CardContent>
          {report.chapters.length === 0 ? (
            <p className="text-sm text-muted-foreground">发布后将按课程页面展示分析。</p>
          ) : (
            <div className="space-y-3">
              {report.chapters.map((chapter, index) => (
                <div
                  key={chapter.id}
                  className="flex items-center justify-between gap-4 border-b pb-3 text-sm last:border-0 last:pb-0"
                >
                  <span className="min-w-0 truncate">
                    {index + 1}. {chapter.title}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    完成 {chapter.completedLearners} 人（{chapter.completionRate}%）· 提问{' '}
                    {chapter.questionsAsked} 次
                  </span>
                </div>
              ))}
            </div>
          )}
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
