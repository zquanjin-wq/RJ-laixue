'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Report = {
  course: { title: string | null };
  overview: {
    taskCount: number;
    learnerCount: number;
    completedCount: number;
    completionRate: number;
    effectiveSeconds: number;
  };
  tasks: Array<{
    taskId: string;
    taskTitle: string;
    status: string;
    learnerCount: number;
    completedCount: number;
    completionRate: number;
    effectiveSeconds: number;
  }>;
  chapters: Array<{
    sceneId: string;
    title: string;
    completedLearners: number;
    questionsAsked: number;
    completedLearnerNames: string[];
    questions: string[];
  }>;
};
function duration(seconds: number) {
  return seconds < 3600
    ? `${Math.round(seconds / 60)} 分钟`
    : `${(seconds / 3600).toFixed(1)} 小时`;
}
export function CourseDataReport({ courseId }: { courseId: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/admin/courses/${courseId}/report`)
      .then((response) => response.json())
      .then((result) => {
        if (result.success) setReport(result.data);
      })
      .catch(() => undefined);
  }, [courseId]);
  if (!report) return <p className="text-sm text-muted-foreground">正在加载课程数据…</p>;
  const selectedChapter = report.chapters.find((chapter) => chapter.sceneId === selectedSceneId);
  return (
    <section className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{report.course.title || '未命名课程'}</CardTitle>
          <CardDescription>课程为内容资产，以下数据汇总自不同任务。</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="使用任务" value={report.overview.taskCount} />
          <Metric label="学习人数" value={report.overview.learnerCount} />
          <Metric label="完成率" value={`${report.overview.completionRate}%`} />
          <Metric label="有效时长" value={duration(report.overview.effectiveSeconds)} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>任务对比</CardTitle>
          <CardDescription>该课程在每个任务中的学习效果。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {report.tasks.map((task) => (
            <Link
              key={task.taskId}
              href={`/admin/learning-tasks/${task.taskId}`}
              className="block rounded-md border p-4 hover:bg-muted/50"
            >
              <div className="flex justify-between gap-3">
                <span className="font-medium">{task.taskTitle}</span>
                <span className="text-sm">{task.completionRate}% 完成</span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {task.completedCount}/{task.learnerCount} 人完成 · {duration(task.effectiveSeconds)}
              </p>
            </Link>
          ))}
          {!report.tasks.length && (
            <p className="text-sm text-muted-foreground">还没有任务使用这门课程。</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>章节分析与提问热点</CardTitle>
          <CardDescription>跨任务查看章节完成人数与提问次数。</CardDescription>
        </CardHeader>
        <CardContent>
          {report.chapters.length ? (
            <div className="space-y-3">
              {report.chapters.map((item) => (
                <button
                  type="button"
                  key={item.sceneId}
                  onClick={() =>
                    setSelectedSceneId((current) =>
                      current === item.sceneId ? null : item.sceneId,
                    )
                  }
                  className="flex w-full items-center justify-between gap-4 rounded-md border-b px-1 py-3 text-left text-sm last:border-0 hover:bg-muted/50"
                >
                  <span>{item.title}</span>
                  <span className="shrink-0 text-muted-foreground">
                    完成 {item.completedLearners} 人 · 提问 {item.questionsAsked} 次 · 查看详情
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">暂无章节学习数据。</p>
          )}
          {selectedChapter && (
            <div className="mt-4 rounded-md border bg-muted/20 p-4 text-sm">
              <p className="font-medium">{selectedChapter.title}</p>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">完成该章节的学员</p>
                  <p className="mt-1">
                    {selectedChapter.completedLearnerNames.length
                      ? selectedChapter.completedLearnerNames.join('、')
                      : '暂无完成记录'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">学员提问</p>
                  {selectedChapter.questions.length ? (
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {selectedChapter.questions.map((question, index) => (
                        <li key={`${selectedChapter.sceneId}-${index}`}>{question}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1">暂无提问记录</p>
                  )}
                </div>
              </div>
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
