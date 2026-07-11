'use client';

// app/admin/students/_components/student-actions.tsx
//
// Compact action panel for each roster row. Three actions:
//
//   - 重置密码 → POST /api/admin/students/reset-password, then shows
//     the new password in a once-visible block until the admin closes.
//   - 禁用 / 启用 → POST /disable or /enable, flipping the
//     students.disabled_at flag (soft delete).
//
// "禁用" sets disabled_at = now() but keeps the row, the auth user,
// the assignments, and the progress events intact so the operator
// can re-enable later. Disabled learners can't sign in to
// /student/courses.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Props {
  studentId: string;
  studentName: string;
  disabled: boolean;
}

const ERROR_COPY: Record<string, string> = {
  UNAUTHENTICATED: '管理员未登录，请刷新页面重新登录。',
  FORBIDDEN: '当前账号不是管理员。',
  NOT_FOUND: '学员档案不存在。',
  AUTH_UPDATE_FAILED: '重置密码失败，请重试。',
  DB_ERROR: '数据库异常，请重试。',
};

export function StudentActions({
  studentId,
  studentName,
  disabled,
}: Props) {
  const router = useRouter();
  const [resetting, setResetting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState('');
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [confirmToggle, setConfirmToggle] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  async function resetPassword() {
    setResetting(true);
    setError('');
    try {
      const res = await fetch('/api/admin/students/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ student_id: studentId }),
      });
      const data = (await res.json()) as
        | { success: true; initial_password: string }
        | { success: false; errorCode: string; error: string };
      if (!res.ok || !('initial_password' in data)) {
        setError(
          ERROR_COPY[(data as any).errorCode] ??
            (data as any).error ??
            '重置失败，请重试。',
        );
        return;
      }
      setNewPassword(data.initial_password);
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setResetting(false);
    }
  }

  async function toggleDisabled() {
    setToggling(true);
    setError('');
    try {
      const path = disabled
        ? `/api/admin/students/${studentId}/enable`
        : `/api/admin/students/${studentId}/disable`;
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const data = (await res.json()) as
        | { success: true }
        | { success: false; errorCode: string; error: string };
      if (!res.ok || !data.success) {
        setError(
          ERROR_COPY[(data as any).errorCode] ??
            (data as any).error ??
            '操作失败，请重试。',
        );
        return;
      }
      setConfirmToggle(false);
      setConfirmText('');
      router.refresh();
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setToggling(false);
    }
  }

  if (newPassword) {
    return (
      <div className="rounded-md border bg-muted/40 p-3 space-y-2">
        <p className="text-sm font-medium text-foreground">密码已重置</p>
        <p className="text-xs text-muted-foreground">
          请抄下新密码口头告知学员。
        </p>
        <dl className="text-sm space-y-1">
          <div>
            <dt className="inline font-medium">新初始密码：</dt>
            <dd className="inline font-mono select-all">{newPassword}</dd>
          </div>
        </dl>
        <Button
          variant="default"
          size="sm"
          className="w-full"
          type="button"
          onClick={() => {
            setNewPassword(null);
            router.refresh();
          }}
        >
          我已抄下，关闭
        </Button>
      </div>
    );
  }

  if (confirmToggle) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
        <p className="text-sm font-medium text-foreground">
          确认{disabled ? '启用' : '禁用'} {studentName}？
        </p>
        <p className="text-xs text-muted-foreground">
          {disabled
            ? '该学员将可以重新登录。'
            : '该学员将无法登录 /student/courses，但档案、账号、课程分配与历史进度记录保留。'}
        </p>
        <p className="text-xs text-muted-foreground">
          为防误操作，输入学员姓名 <span className="font-mono">{studentName}</span> 确认：
        </p>
        <Input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={studentName}
          className="h-8"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button
            variant={disabled ? 'default' : 'destructive'}
            size="sm"
            disabled={toggling || confirmText.trim() !== studentName}
            onClick={toggleDisabled}
          >
            {toggling ? '处理中...' : disabled ? '确认启用' : '确认禁用'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setConfirmToggle(false);
              setConfirmText('');
              setError('');
            }}
            type="button"
          >
            取消
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          onClick={resetPassword}
          disabled={resetting}
        >
          {resetting ? '重置中...' : '重置密码'}
        </Button>
        <Button
          variant={disabled ? 'default' : 'ghost'}
          size="sm"
          className={disabled ? '' : 'text-destructive hover:text-destructive'}
          onClick={() => setConfirmToggle(true)}
        >
          {disabled ? '启用账号' : '禁用账号'}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}