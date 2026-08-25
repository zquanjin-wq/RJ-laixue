'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { getCurrentModelConfig } from '@/lib/utils/model-config';

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
  const [question, setQuestion] = useState('');
  const [insight, setInsight] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
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
  async function askInsight(nextQuestion = question) {
    const text = nextQuestion.trim();
    if (!text) return;
    setQuestion(text);
    setAnalyzing(true);
    setInsight('');
    try {
      const response = await fetch(`/api/admin/courses/${courseId}/insight`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: text, report, ...getCurrentModelConfig() }),
      });
      const body = (await response.json()) as {
        success?: boolean;
        data?: { answer?: string };
        error?: string;
      };
      setInsight(
        response.ok && body.success
          ? body.data?.answer || '暂无可用解读。'
          : body.error || '暂时无法生成解读，请稍后重试。',
      );
    } catch {
      setInsight('网络异常，请稍后重试。');
    } finally {
      setAnalyzing(false);
    }
  }
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
          <CardTitle>AI 课程数据解读</CardTitle>
          <CardDescription>根据本课程跨任务学习数据，辅助判断下一步教学重点。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {['这门课当前最需要关注什么？', '哪些章节值得优先优化？', '请给出下一步教学建议。'].map(
              (prompt) => (
                <Button
                  key={prompt}
                  variant="outline"
                  size="sm"
                  onClick={() => void askInsight(prompt)}
                  disabled={analyzing}
                >
                  {prompt}
                </Button>
              ),
            )}
          </div>
          <Textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="例如：为什么这门课完成率不高？"
            rows={3}
          />
          <Button
            className="w-full"
            onClick={() => void askInsight()}
            disabled={analyzing || !question.trim()}
          >
            {analyzing ? '正在分析…' : '问 AI'}
          </Button>
          {insight && (
            <div className="rounded-lg bg-muted/60 p-3 text-sm leading-6 whitespace-pre-wrap">
              {insight}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            AI 只解释当前可见的课程汇总数据，不会自动修改课程或创建任务。
          </p>
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
