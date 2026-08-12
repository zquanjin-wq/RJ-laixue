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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
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
  learners: Array<{
    id: string;
    student_id: string;
    status: string;
    progress_percent: number;
    completed_scene_count: number;
    total_scene_count: number;
    assigned_at: string;
  }>;
}

interface StudentOption {
  id: string;
  name: string;
  email: string | null;
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
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [course, setCourse] = useState<CourseInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startAt, setStartAt] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [selectedLearners, setSelectedLearners] = useState<Set<string>>(new Set());
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
  const assignedLearnerIds = new Set(task?.learners.map((learner) => learner.student_id) ?? []);
  const canUpdateLearners = isDraft || isPublished;

  const isArchived = task?.status === 'archived';

  const timeError = useMemo(() => {
    if (!startAt || !dueAt) return '';
    return new Date(dueAt) < new Date(startAt) ? '截止时间不能早于开始时间' : '';
  }, [startAt, dueAt]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [taskRes, studentsRes] = await Promise.all([
        fetch(`/api/admin/learning-tasks/${taskId}`),
        fetch('/api/admin/students'),
      ]);
      const taskJson = (await taskRes.json()) as {
        success: boolean;
        data?: TaskDetail;
        error?: string;
      };
      const studentsJson = (await studentsRes.json()) as {
        success: boolean;
        data?: StudentOption[];
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

      if (studentsJson.success && studentsJson.data) {
        setStudents(studentsJson.data);
      }

      // 课程标题
      const courseRes = await fetch(`/api/courses/${t.course_id}`);
      const courseJson = (await courseRes.json()) as {
        success: boolean;
        data?: { title?: string };
      };
      if (courseRes.ok && courseJson.success && courseJson.data) {
        setCourse({ id: t.course_id, title: courseJson.data.title ?? null });
      } else {
        setCourse({ id: t.course_id, title: null });
      }
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveDraft() {
    if (!task) return;
    if (timeError) {
      setError(timeError);
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
          startAt: startAt || null,
          dueAt: dueAt || null,
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string; errorCode?: string };
      if (!res.ok || !json.success) {
        setError(json.error ?? '保存失败');
        return;
      }
      await load();
    } catch {
      setError('网络异常，请重试。');
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
      const json = (await res.json()) as { success: boolean; error?: string; errorCode?: string };
      if (!res.ok || !json.success) {
        setError(json.error ?? '更新学员名单失败');
        return;
      }
      await load();
    } catch {
      setError('网络异常，请重试。');
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
        setError(json.error ?? '发布失败');
        return;
      }
      const token = json.data?.share_token;
      if (token) {
        const link = `${window.location.origin}/learn/${token}`;
        setPublishResult({ shareToken: token, link });
      }
      await load();
    } catch {
      setError('网络异常，请重试。');
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
      await load();
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

  function toggleLearner(id: string) {
    setSelectedLearners((prev) => {
      if (isPublished && assignedLearnerIds.has(id)) {
        return prev;
      }

      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
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
      <div className="mx-auto max-w-3xl space-y-6">
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

        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle className="text-base">学员名单</CardTitle>
            <CardDescription>
              {isDraft ? '选择参与本次任务的学员。' : '已发布任务的学员名单已冻结。'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {students.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无可选学员。</p>
            ) : (
              <div className="rounded-md border p-3 space-y-2 max-h-64 overflow-y-auto">
                {students.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={selectedLearners.has(s.id)}
                      onCheckedChange={() => toggleLearner(s.id)}
                      disabled={!canUpdateLearners || (isPublished && assignedLearnerIds.has(s.id))}
                    />
                    <span>{s.name}</span>
                    {s.email && <span className="text-muted-foreground text-xs">({s.email})</span>}
                  </label>
                ))}
              </div>
            )}
            {canUpdateLearners && (
              <Button onClick={saveLearners} disabled={saving}>
                {saving ? '保存中...' : '更新学员名单'}
              </Button>
            )}
          </CardContent>
        </Card>

        <TaskReport taskId={task.id} />

        <TaskAiBrief taskId={task.id} />

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

        <Dialog open={confirmPublish} onOpenChange={setConfirmPublish}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>确认发布任务？</DialogTitle>
              <DialogDescription>
                发布后任务关键字段和学员名单将冻结，并生成学员进入链接。
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
