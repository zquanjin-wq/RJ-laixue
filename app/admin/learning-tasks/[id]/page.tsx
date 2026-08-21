/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * /admin/learning-tasks/[id]
 *
 * 任务详情页：展示任务信息、学员名单，支持编辑草稿、发布、复制链接、关闭/归档。
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LearnerPickerDialog } from '../_components/learner-picker-dialog';
import { TaskReport } from '@/app/admin/learning-tasks/_components/task-report';
import { TaskAiBrief } from '@/app/admin/learning-tasks/_components/task-ai-brief';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toTaskTimestamp } from '@/lib/utils/task-datetime';

type TaskStatus = 'draft' | 'published' | 'closed' | 'archived';

interface TaskDetail {
  id: string;
  course_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  task_type: string;
  start_at: string | null;
  due_at: string | null;
  share_token: string | null;
  published_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  snapshot_id: string | null;
  source_task_id: string | null;
  completion_rule: unknown;
  courses: Array<{
    course_id: string;
    position: number;
    is_required: boolean;
    snapshot_id: string | null;
    title: string | null;
  }>;
  learners: Array<{
    id: string;
    student_id: string;
    status: string;
    progress_percent: number;
    completed_scene_count: number;
    total_scene_count: number;
    mastery_percent: number | null;
    effective_seconds: number;
    last_seen_at: string | null;
    assigned_at: string;
    name: string;
    email: string | null;
  }>;
}

interface CourseInfo {
  id: string;
  title: string | null;
}

function statusLabel(status: TaskStatus) {
  switch (status) {
    case 'draft':
      return '草稿';
    case 'published':
      return '已发布';
    case 'closed':
      return '已关闭';
    case 'archived':
      return '已归档';
  }
}

function statusBadgeVariant(status: TaskStatus) {
  switch (status) {
    case 'draft':
      return 'secondary';
    case 'published':
      return 'default';
    case 'closed':
      return 'destructive';
    case 'archived':
      return 'outline';
  }
}

export default function LearningTaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = params.id as string;

  const [task, setTask] = useState<TaskDetail | null>(null);
  const [course, setCourse] = useState<CourseInfo | null>(null);
  const [availableCourses, setAvailableCourses] = useState<CourseInfo[]>([]);
  const [coursesLoading, setCoursesLoading] = useState(false);
  const [selectedCourses, setSelectedCourses] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startAt, setStartAt] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [selectedLearners, setSelectedLearners] = useState<Set<string>>(new Set());
  const [rosterDirty, setRosterDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [publishResult, setPublishResult] = useState<{ shareToken: string; link: string } | null>(
    null,
  );
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const isDraft = task?.status === 'draft';
  const isPublished = task?.status === 'published';
  const isClosed = task?.status === 'closed';
  const canUpdateLearners = isDraft || isPublished;

  const isArchived = task?.status === 'archived';

  const timeError = useMemo(() => {
    if (!startAt || !dueAt) return '';
    return new Date(dueAt) < new Date(startAt) ? '截止时间不能早于开始时间' : '';
  }, [startAt, dueAt]);

  const loadAvailableCourses = useCallback(async () => {
    setCoursesLoading(true);
    try {
      const response = await fetch('/api/courses');
      const result = (await response.json()) as {
        success?: boolean;
        data?: Array<{ id: string; title?: string | null }>;
      };
      if (response.ok && result.success) {
        setAvailableCourses(
          (result.data ?? []).map((item) => ({ id: item.id, title: item.title ?? null })),
        );
      }
    } finally {
      setCoursesLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const taskRes = await fetch(`/api/admin/learning-tasks/${taskId}`);
      const taskJson = (await taskRes.json()) as {
        success: boolean;
        data?: TaskDetail;
        error?: string;
      };

      if (!taskRes.ok || !taskJson.success || !taskJson.data) {
        setError(taskJson.error ?? '获取任务详情失败');
        return;
      }

      const t = taskJson.data;
      setTask(t);
      setTitle(t.title);
      setDescription(t.description ?? '');
      setStartAt(t.start_at ? formatForDatetimeLocal(t.start_at) : '');
      setDueAt(t.due_at ? formatForDatetimeLocal(t.due_at) : '');
      setSelectedLearners(new Set(t.learners.map((l) => l.student_id)));
      setRosterDirty(false);
      setSelectedCourses(t.courses?.map((item) => item.course_id) ?? [t.course_id]);
      const primaryCourse = t.courses.find((item) => item.course_id === t.course_id);
      setCourse({ id: t.course_id, title: primaryCourse?.title ?? null });

      // 课程选择器只在草稿可编辑时才需要，而且不应阻塞任务信息的首屏展示。
      if (t.status === 'draft') void loadAvailableCourses();
      else setAvailableCourses([]);
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setLoading(false);
    }
  }, [loadAvailableCourses, taskId]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveDraft() {
    if (!task) return;
    if (timeError) {
      setError(timeError);
      toast.error(timeError);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/learning-tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          startAt: toTaskTimestamp(startAt) ?? null,
          dueAt: toTaskTimestamp(dueAt) ?? null,
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        error?: string;
        errorCode?: string;
      };
      if (!res.ok || !json.success) {
        const message = json.error ?? '保存失败';
        setError(message);
        toast.error(message);
        return;
      }
      setTask((current) =>
        current
          ? {
              ...current,
              title: title.trim(),
              description: description.trim() || null,
              start_at: toTaskTimestamp(startAt) ?? null,
              due_at: toTaskTimestamp(dueAt) ?? null,
            }
          : current,
      );
      toast.success('任务信息已保存。');
    } catch {
      setError('网络异常，请重试。');
      toast.error('网络异常，请重试。');
    } finally {
      setSaving(false);
    }
  }

  async function saveLearners() {
    if (!task) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/learning-tasks/${task.id}/learners`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ learnerIds: Array.from(selectedLearners) }),
      });
      const json = (await res.json()) as {
        success: boolean;
        data?: TaskDetail['learners'];
        error?: string;
        errorCode?: string;
      };
      if (!res.ok || !json.success) {
        const message = json.error ?? '更新学员名单失败';
        setError(message);
        toast.error(message);
        return;
      }
      if (json.data) {
        setTask((current) =>
          current ? { ...current, learners: json.data ?? current.learners } : current,
        );
      }
      setRosterDirty(false);
      toast.success('学员名单已保存。');
    } catch {
      setError('网络异常，请重试。');
      toast.error('网络异常，请重试。');
    } finally {
      setSaving(false);
    }
  }

  async function saveCoursePackage() {
    if (!task || !selectedCourses.length) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/learning-tasks/${task.id}/courses`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ courseIds: selectedCourses }),
      });
      const json = (await res.json()) as {
        success: boolean;
        data?: TaskDetail['courses'];
        error?: string;
      };
      if (!res.ok || !json.success) {
        const message = json.error ?? '保存课程组合失败';
        setError(message);
        toast.error(message);
        return;
      }
      setTask((current) =>
        current
          ? {
              ...current,
              courses: (json.data ?? []) as TaskDetail['courses'],
            }
          : current,
      );
      const primaryCourse = (json.data ?? []).find((item) => item.course_id === task.course_id);
      if (primaryCourse) {
        setCourse({ id: task.course_id, title: primaryCourse.title ?? null });
      }
      toast.success('课程组合已保存。');
    } catch {
      setError('网络异常，请重试。');
      toast.error('网络异常，请重试。');
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    if (!task) return;
    setPublishing(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/learning-tasks/${task.id}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const json = (await res.json()) as {
        success: boolean;
        data?: { share_token?: string };
        error?: string;
      };
      if (!res.ok || !json.success) {
        const message = json.error ?? '发布失败';
        setError(message);
        toast.error(message);
        return;
      }
      const token = json.data?.share_token;
      if (token) {
        const link = `${window.location.origin}/learn/${token}`;
        setPublishResult({ shareToken: token, link });
      }
      setTask((current) =>
        current
          ? {
              ...current,
              status: 'published',
              share_token: token ?? current.share_token,
            }
          : current,
      );
      toast.success('任务已发布。');
    } catch {
      setError('网络异常，请重试。');
      toast.error('网络异常，请重试。');
    } finally {
      setPublishing(false);
      setConfirmPublish(false);
    }
  }

  async function archive() {
    if (!task) return;
    setArchiving(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/learning-tasks/${task.id}/archive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const json = (await res.json()) as {
        success: boolean;
        data?: { status: TaskStatus };
        error?: string;
      };
      if (!res.ok || !json.success) {
        setError(json.error ?? '归档失败');
        return;
      }
      const nextStatus = json.data?.status;
      if (nextStatus) {
        setTask((current) => (current ? { ...current, status: nextStatus } : current));
      }
      toast.success(isPublished ? '任务已关闭。' : '任务已归档。');
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setArchiving(false);
      setConfirmArchive(false);
    }
  }

  function copyLink() {
    if (!publishResult) return;
    navigator.clipboard.writeText(publishResult.link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-background px-4 py-10">
        <div className="mx-auto max-w-3xl text-sm text-muted-foreground">加载中…</div>
      </main>
    );
  }

  if (error && !task) {
    return (
      <main className="min-h-screen bg-background px-4 py-10">
        <div className="mx-auto max-w-3xl">
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
          <div className="mt-4">
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/learning-tasks">返回任务列表</Link>
            </Button>
          </div>
        </div>
      </main>
    );
  }

  if (!task) return null;

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-semibold tracking-tight">
                {task.title || '未命名任务'}
              </h1>
              <Badge variant={statusBadgeVariant(task.status) as any}>
                {statusLabel(task.status)}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              课程：{course?.title || task.course_id} · 创建于{' '}
              {new Date(task.created_at).toLocaleString('zh-CN')}
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/learning-tasks">返回任务列表</Link>
          </Button>
        </header>

        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        <Tabs defaultValue="overview" className="space-y-5">
          <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-lg border bg-background p-1">
            <TabsTrigger value="overview">基本信息</TabsTrigger>
            <TabsTrigger value="courses">课程内容</TabsTrigger>
            <TabsTrigger value="learners">学员管理（{task.learners.length}）</TabsTrigger>
            {!isDraft && <TabsTrigger value="progress">学习进展</TabsTrigger>}
            {!isDraft && <TabsTrigger value="ai">AI 简报</TabsTrigger>}
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle className="text-base">任务信息</CardTitle>
                <CardDescription>
                  {isDraft ? '草稿状态可编辑标题、说明和时间。' : '已发布任务的关键字段已冻结。'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="title">任务标题</Label>
                  <Input
                    id="title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={!isDraft}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">任务说明</Label>
                  <Textarea
                    id="description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={!isDraft}
                  />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="startAt">开始时间</Label>
                    <Input
                      id="startAt"
                      type="datetime-local"
                      value={startAt}
                      onChange={(e) => setStartAt(e.target.value)}
                      disabled={!isDraft}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="dueAt">截止时间</Label>
                    <Input
                      id="dueAt"
                      type="datetime-local"
                      value={dueAt}
                      onChange={(e) => setDueAt(e.target.value)}
                      disabled={!isDraft}
                    />
                  </div>
                </div>
                {timeError && <p className="text-xs text-destructive">{timeError}</p>}
                {isDraft && (
                  <Button onClick={saveDraft} disabled={saving || !!timeError}>
                    {saving ? '保存中...' : '保存修改'}
                  </Button>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="courses">
            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle className="text-base">课程组合</CardTitle>
                <CardDescription>
                  {isDraft
                    ? '可添加、删除或调整课程顺序；发布后组合会保留发布时版本。'
                    : '本次任务的课程组合与学习顺序。'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2 rounded-md border p-3">
                  {isDraft && coursesLoading && (
                    <p className="text-sm text-muted-foreground">正在加载可选课程…</p>
                  )}
                  {(isDraft
                    ? availableCourses
                    : task.courses.map((item) => ({ id: item.course_id, title: item.title }))
                  ).map((item) => {
                    const selected = selectedCourses.includes(item.id);
                    const index = selectedCourses.indexOf(item.id);
                    const move = (direction: -1 | 1) => {
                      const nextIndex = index + direction;
                      if (nextIndex < 0 || nextIndex >= selectedCourses.length) return;
                      const next = [...selectedCourses];
                      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
                      setSelectedCourses(next);
                    };
                    return (
                      <div key={item.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={selected}
                          disabled={!isDraft}
                          onCheckedChange={() =>
                            setSelectedCourses(
                              selected
                                ? selectedCourses.filter((id) => id !== item.id)
                                : [...selectedCourses, item.id],
                            )
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {item.title || '未命名课程'}
                        </span>
                        {selected && (
                          <>
                            <span className="text-xs text-muted-foreground">第 {index + 1} 门</span>
                            {isDraft && (
                              <>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  disabled={index === 0}
                                  onClick={() => move(-1)}
                                >
                                  上移
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  disabled={index === selectedCourses.length - 1}
                                  onClick={() => move(1)}
                                >
                                  下移
                                </Button>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                  {!task.courses.length && !isDraft && (
                    <p className="text-sm text-muted-foreground">暂无课程组合记录。</p>
                  )}
                </div>
                {isDraft && (
                  <Button onClick={saveCoursePackage} disabled={saving || !selectedCourses.length}>
                    {saving ? '保存中...' : '保存课程组合'}
                  </Button>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="learners">
            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle className="text-base">学员名单</CardTitle>
                <CardDescription>
                  {isDraft
                    ? '选择参与本次任务的人员。'
                    : '已发布任务也可添加或移除人员；仍在名单中的学习记录会保留。'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="border-b bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3 font-medium">姓名</th>
                        <th className="px-4 py-3 font-medium">邮箱</th>
                        <th className="px-4 py-3 font-medium">学习状态</th>
                        <th className="px-4 py-3 font-medium">进度</th>
                        <th className="px-4 py-3 font-medium">有效时长</th>
                        <th className="px-4 py-3 font-medium">最后学习</th>
                        {canUpdateLearners && <th className="px-4 py-3 font-medium">操作</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {task.learners
                        .filter((learner) => selectedLearners.has(learner.student_id))
                        .map((learner) => (
                          <tr key={learner.id} className="border-b last:border-0">
                            <td className="px-4 py-3 font-medium">{learner.name}</td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {learner.email ?? '—'}
                            </td>
                            <td className="px-4 py-3">{learnerStatusLabel(learner.status)}</td>
                            <td className="px-4 py-3">{Number(learner.progress_percent ?? 0)}%</td>
                            <td className="px-4 py-3">
                              {formatDuration(learner.effective_seconds)}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {learner.last_seen_at
                                ? new Date(learner.last_seen_at).toLocaleString('zh-CN')
                                : '—'}
                            </td>
                            {canUpdateLearners && (
                              <td className="px-4 py-3">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setSelectedLearners((current) => {
                                      const next = new Set(current);
                                      next.delete(learner.student_id);
                                      return next;
                                    });
                                    setRosterDirty(true);
                                  }}
                                >
                                  移除
                                </Button>
                              </td>
                            )}
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {task.learners.filter((learner) => selectedLearners.has(learner.student_id))
                    .length === 0 && (
                    <p className="p-4 text-sm text-muted-foreground">暂未添加学员。</p>
                  )}
                </div>
                <LearnerPickerDialog
                  selectedIds={Array.from(selectedLearners)}
                  onSelectedIdsChange={(ids) => {
                    setSelectedLearners(new Set(ids));
                    setRosterDirty(true);
                  }}
                  initialLearners={task.learners.map((learner) => ({
                    id: learner.student_id,
                    name: learner.name,
                    email: learner.email,
                  }))}
                  disabled={!canUpdateLearners}
                  actionLabel={task.learners.length ? '添加或调整学员' : '添加学员'}
                />
                {rosterDirty && (
                  <p className="text-sm text-amber-700">名单已调整，点击保存后生效。</p>
                )}
                {canUpdateLearners && (
                  <Button onClick={saveLearners} disabled={saving}>
                    {saving ? '保存中...' : '更新学员名单'}
                  </Button>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {!isDraft && (
            <TabsContent value="progress">
              <TaskReport taskId={task.id} />
            </TabsContent>
          )}

          {!isDraft && (
            <TabsContent value="ai">
              <TaskAiBrief taskId={task.id} />
            </TabsContent>
          )}

          <TabsContent value="overview">
            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle className="text-base">操作</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {isDraft && (
                  <Button onClick={() => setConfirmPublish(true)} disabled={publishing}>
                    {publishing ? '发布中...' : '发布任务'}
                  </Button>
                )}

                {isPublished && task.share_token && (
                  <div className="space-y-2">
                    <Label>分享链接</Label>
                    <div className="flex gap-2">
                      <Input
                        readOnly
                        value={`${typeof window !== 'undefined' ? window.location.origin : ''}/learn/${task.share_token}`}
                      />
                      <Button
                        variant="outline"
                        onClick={() =>
                          navigator.clipboard
                            .writeText(`${window.location.origin}/learn/${task.share_token}`)
                            .then(() => {
                              setCopied(true);
                              setTimeout(() => setCopied(false), 2000);
                            })
                        }
                      >
                        {copied ? '已复制' : '复制'}
                      </Button>
                    </div>
                  </div>
                )}

                {(isDraft || isPublished || isClosed) && (
                  <div>
                    <Button
                      variant={isDraft ? 'ghost' : 'outline'}
                      onClick={() => setConfirmArchive(true)}
                      disabled={archiving}
                    >
                      {isPublished ? '关闭任务' : '归档任务'}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Dialog open={confirmPublish} onOpenChange={setConfirmPublish}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>确认发布任务？</DialogTitle>
              <DialogDescription>
                发布后课程组合和任务关键字段将冻结；学员名单仍可随时调整，并生成学员进入链接。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmPublish(false)}>
                取消
              </Button>
              <Button onClick={publish} disabled={publishing}>
                确认发布
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={confirmArchive} onOpenChange={setConfirmArchive}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{isPublished ? '确认关闭任务？' : '确认归档任务？'}</DialogTitle>
              <DialogDescription>
                {isPublished
                  ? '关闭后学员将无法再进入；如需彻底归档，可在关闭后再次操作。'
                  : '归档后任务将变为只读，无法再次发布或编辑。'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmArchive(false)}>
                取消
              </Button>
              <Button onClick={archive} disabled={archiving}>
                确认
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {publishResult && (
          <Dialog open onOpenChange={() => setPublishResult(null)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>任务已发布</DialogTitle>
                <DialogDescription>学员可通过下方链接进入学习。</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Input readOnly value={publishResult.link} />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPublishResult(null)}>
                  关闭
                </Button>
                <Button onClick={copyLink}>{copied ? '已复制' : '复制链接'}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </main>
  );
}

function formatForDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function learnerStatusLabel(status: string) {
  return (
    {
      not_started: '未开始',
      in_progress: '学习中',
      completed: '已完成',
    }[status] ?? status
  );
}

function formatDuration(seconds: number | null | undefined) {
  const value = Number(seconds ?? 0);
  if (value < 60) return `${value} 秒`;
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}
