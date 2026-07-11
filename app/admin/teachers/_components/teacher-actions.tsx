'use client';

// app/admin/teachers/_components/teacher-actions.tsx
//
// Inline panel for each teacher row. Same controls as the student
// roster (reset password, disable/enable) but acting on profiles
// (not students) so we use teacher_id everywhere instead.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Props {
  teacherId: string;
  teacherName: string;
  disabled: boolean;
}

const ERROR_COPY: Record<string, string> = {
  UNAUTHENTICATED: '管理员未登录，请刷新页面重新登录。',
  FORBIDDEN: '当前账号不是管理员。',
  NOT_FOUND: '老师账号不存在。',
  AUTH_UPDATE_FAILED: '重置密码失败，请重试。',
  DB_ERROR: '数据库异常，请重试。',
};

export function TeacherActions({
  teacherId,
  teacherName,
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
      const res = await fetch('/api/admin/teachers/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teacher_id: teacherId }),
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
        ? `/api/admin/teachers/enable`
        : `/api/admin/teachers/disable`;
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teacher_id: teacherId }),
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
          请抄下新密码口头告知该老师。
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
          确认
        </Button>
      </div>
    );
  }

  if (confirmToggle) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
        <p className="text-sm font-medium text-foreground">
          确认{disabled ? '启用' : '禁用'} {teacherName}？
        </p>
        <p className="text-xs text-muted-foreground">
          {disabled
            ? '该老师将可以重新登录。'
            : '该老师将无法登录，但其创建过的课件保留在云端。'}
        </p>
        <p className="text-xs text-muted-foreground">
          为防误操作，输入老师姓名 <span className="font-mono">{teacherName}</span> 确认：
        </p>
        <Input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={teacherName}
          className="h-8"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button
            variant={disabled ? 'default' : 'destructive'}
            size="sm"
            disabled={toggling || confirmText.trim() !== teacherName}
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