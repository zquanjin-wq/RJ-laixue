'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { toTaskTimestamp } from '@/lib/utils/task-datetime';

interface CourseOption {
  id: string;
  title: string | null;
}

interface StudentOption {
  id: string;
  name: string;
  email: string | null;
  disabled_at: string | null;
}

interface CreateTaskFormProps {
  courses: CourseOption[];
  students: StudentOption[];
}

const ERROR_COPY: Record<string, string> = {
  UNAUTHENTICATED: '未登录，请刷新后重试。',
  FORBIDDEN: '当前账号没有权限创建任务。',
  MISSING_FIELDS: '请填写课程和任务标题。',
  INVALID_TIME_RANGE: '时间范围无效或截止时间早于开始时间。',
  INVALID_LEARNERS: '学员名单包含无效或已禁用的学员。',
  COURSE_NOT_FOUND: '所选课程不存在。',
  COURSE_NOT_OWNED: '你只能基于自己有权发布的课程创建任务。',
  INTERNAL_ERROR: '服务器异常，请重试。',
};

export function CreateTaskForm({ courses, students }: CreateTaskFormProps) {
  const router = useRouter();
  const [courseId, setCourseId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startAt, setStartAt] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [selectedLearners, setSelectedLearners] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const activeStudents = useMemo(() => students.filter((s) => !s.disabled_at), [students]);

  const timeError = useMemo(() => {
    if (!startAt || !dueAt) return '';
    return new Date(dueAt) < new Date(startAt) ? '截止时间不能早于开始时间' : '';
  }, [startAt, dueAt]);

  function toggleLearner(id: string) {
    setSelectedLearners((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (!courseId || !title.trim()) {
      setError(ERROR_COPY.MISSING_FIELDS);
      return;
    }
    if (timeError) {
      setError(timeError);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/admin/learning-tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          courseId,
          title: title.trim(),
          description: description.trim() || undefined,
          startAt: toTaskTimestamp(startAt),
          dueAt: toTaskTimestamp(dueAt),
          learnerIds: Array.from(selectedLearners),
        }),
      });
      const data = (await res.json()) as
        | { success: true; data: { id: string } }
        | { success: false; errorCode: string; error: string };

      if (!res.ok || !data.success || !('id' in (data as any).data)) {
        setError(
          (data as any).error ?? ERROR_COPY[(data as any).errorCode] ?? '创建任务失败，请重试。',
        );
        return;
      }

      router.push(`/admin/learning-tasks/${(data as any).data.id}`);
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="course">课程 *</Label>
        <Select value={courseId} onValueChange={setCourseId} disabled={courses.length === 0}>
          <SelectTrigger id="course" className="w-full md:w-96">
            <SelectValue placeholder={courses.length === 0 ? '暂无可用课程' : '选择课程'} />
          </SelectTrigger>
          <SelectContent>
            {courses.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.title || '未命名课件'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="title">任务标题 *</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：新员工入职培训第一周"
          className="w-full md:w-96"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">任务说明</Label>
        <Textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="补充说明、学习目标或注意事项"
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
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="dueAt">截止时间</Label>
          <Input
            id="dueAt"
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
        </div>
      </div>
      {timeError && <p className="text-xs text-destructive">{timeError}</p>}

      <div className="space-y-2">
        <Label>学员名单</Label>
        {activeStudents.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无可选学员。</p>
        ) : (
          <div className="rounded-md border p-3 space-y-2 max-h-64 overflow-y-auto">
            {activeStudents.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={selectedLearners.has(s.id)}
                  onCheckedChange={() => toggleLearner(s.id)}
                />
                <span>{s.name}</span>
                {s.email && <span className="text-muted-foreground text-xs">({s.email})</span>}
              </label>
            ))}
          </div>
        )}
        {selectedLearners.size > 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            已选择 <Badge variant="secondary">{selectedLearners.size}</Badge> 位学员
          </div>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={loading || !!timeError}>
          {loading ? '保存中...' : '保存草稿'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push('/admin/learning-tasks')}
        >
          取消
        </Button>
      </div>
    </form>
  );
}
