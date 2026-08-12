'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Data = {
  overview: {
    courseCount: number;
    taskCount: number;
    learnerCount: number;
    effectiveSeconds: number;
  };
  courses: Array<{
    courseId: string;
    title: string;
    taskCount: number;
    learnerCount: number;
    completedCount: number;
    completionRate: number;
    effectiveSeconds: number;
  }>;
};
const empty: Data = {
  overview: { courseCount: 0, taskCount: 0, learnerCount: 0, effectiveSeconds: 0 },
  courses: [],
};
const duration = (seconds: number) =>
  seconds < 3600 ? `${Math.round(seconds / 60)} 分钟` : `${(seconds / 3600).toFixed(1)} 小时`;
export function CourseAnalyticsBoard() {
  const [data, setData] = useState<Data>(empty);
  useEffect(() => {
    fetch('/api/admin/course-analytics')
      .then((r) => r.json())
      .then((r) => {
        if (r.success) setData(r.data);
      })
      .catch(() => undefined);
  }, []);
  return (
    <section className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="课程资产" value={data.overview.courseCount} />
        <Metric label="任务引用" value={data.overview.taskCount} />
        <Metric label="覆盖学习人次" value={data.overview.learnerCount} />
        <Metric label="有效学习时长" value={duration(data.overview.effectiveSeconds)} />
      </section>
      <Card>
        <CardHeader>
          <CardTitle>课程资产学习表现</CardTitle>
          <CardDescription>跨任务汇总；进入课程分析后可查看任务对比与章节分析。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.courses.map((course) => (
            <Link
              key={course.courseId}
              href={`/courses/${course.courseId}`}
              className="block rounded-lg border p-4 hover:bg-muted/50"
            >
              <div className="flex justify-between gap-4">
                <p className="font-medium">{course.title}</p>
                <p className="text-sm">{course.completionRate}% 完成</p>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                引用任务 {course.taskCount} · 学习 {course.learnerCount} 人 · 已完成{' '}
                {course.completedCount} 人 · {duration(course.effectiveSeconds)}
              </p>
            </Link>
          ))}
          {!data.courses.length && (
            <p className="text-sm text-muted-foreground">暂无可分析的课程资产。</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}
