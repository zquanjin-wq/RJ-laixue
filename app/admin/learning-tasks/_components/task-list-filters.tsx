'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type TaskStatus = 'draft' | 'published' | 'closed' | 'archived';

export type TaskListItem = {
  id: string;
  title: string | null;
  status: TaskStatus;
  startAt: string | null;
  dueAt: string | null;
  createdAt: string;
  courseCount: number;
  learnerCount: number;
  completedCount: number;
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: '草稿',
  published: '已发布',
  closed: '已关闭',
  archived: '已归档',
};

function deadlineLabel(task: TaskListItem, now: number) {
  if (task.status !== 'published' || !task.dueAt) return null;
  const due = new Date(task.dueAt).getTime();
  if (due < now) return { label: '已逾期', className: 'border-destructive/40 text-destructive' };
  if (due - now <= 3 * 24 * 60 * 60 * 1000)
    return { label: '即将截止', className: 'border-amber-500/40 text-amber-700' };
  return null;
}

export function TaskListFilters({ tasks }: { tasks: TaskListItem[] }) {
  const router = useRouter();
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<'all' | TaskStatus>('all');
  const [taskToDelete, setTaskToDelete] = useState<TaskListItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const now = Date.now();

  async function deleteDraftTask() {
    if (!taskToDelete) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/admin/learning-tasks/${taskToDelete.id}`, {
        method: 'DELETE',
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        toast.error(result.error || '删除任务失败');
        return;
      }
      toast.success('草稿任务已删除。');
      setTaskToDelete(null);
      router.refresh();
    } catch {
      toast.error('删除任务失败，请稍后重试。');
    } finally {
      setIsDeleting(false);
    }
  }

  const visibleTasks = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return tasks.filter((task) => {
      const matchesStatus = status === 'all' || task.status === status;
      const matchesKeyword = !query || (task.title || '未命名任务').toLowerCase().includes(query);
      return matchesStatus && matchesKeyword;
    });
  }, [keyword, status, tasks]);

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center">
        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索任务名称"
          className="sm:max-w-sm"
        />
        <div className="flex flex-wrap gap-2">
          {(['all', 'draft', 'published', 'closed', 'archived'] as const).map((item) => (
            <Button
              key={item}
              type="button"
              size="sm"
              variant={status === item ? 'default' : 'outline'}
              onClick={() => setStatus(item)}
            >
              {item === 'all' ? '全部' : STATUS_LABEL[item]}
            </Button>
          ))}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">显示 {visibleTasks.length} 个任务</p>

      {visibleTasks.map((task) => {
        const deadline = deadlineLabel(task, now);
        const completion = task.learnerCount
          ? Math.round((task.completedCount / task.learnerCount) * 100)
          : 0;

        return (
          <article
            key={task.id}
            className="flex flex-col gap-3 rounded-lg border bg-background p-4 md:flex-row md:items-center md:justify-between"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{task.title || '未命名任务'}</span>
                <Badge variant={task.status === 'published' ? 'default' : 'secondary'}>
                  {STATUS_LABEL[task.status]}
                </Badge>
                {deadline && (
                  <Badge variant="outline" className={deadline.className}>
                    {deadline.label}
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground">课程包：{task.courseCount} 门课程</div>
              <div className="text-xs text-muted-foreground">
                学员 {task.learnerCount} 人 · 已完成 {task.completedCount} 人 · 完成率 {completion}%
                {task.startAt && ` · 开始 ${new Date(task.startAt).toLocaleString('zh-CN')}`}
                {task.dueAt && ` · 截止 ${new Date(task.dueAt).toLocaleString('zh-CN')}`}
              </div>
              <div className="text-xs text-muted-foreground">
                创建于 {new Date(task.createdAt).toLocaleString('zh-CN')}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 md:flex-shrink-0">
              <Button asChild variant="outline" size="sm">
                <Link href={`/admin/learning-tasks/${task.id}`}>查看详情</Link>
              </Button>
              {task.status === 'draft' && (
                <>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/admin/learning-tasks/${task.id}`}>编辑</Link>
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => setTaskToDelete(task)}>
                    删除
                  </Button>
                </>
              )}
            </div>
          </article>
        );
      })}

      {visibleTasks.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          没有符合当前条件的任务。
        </div>
      )}

      <AlertDialog
        open={Boolean(taskToDelete)}
        onOpenChange={(open) => !open && setTaskToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除草稿任务？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除“{taskToDelete?.title || '未命名任务'}”及其已选课程、学习对象。此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isDeleting}
              onClick={(event) => {
                event.preventDefault();
                void deleteDraftTask();
              }}
            >
              {isDeleting ? '删除中…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
