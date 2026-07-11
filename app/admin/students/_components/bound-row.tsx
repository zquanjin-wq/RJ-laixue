'use client';

// app/admin/students/_components/bound-row.tsx
//
// Inline control panel rendered next to each student that already
// has a bound auth account. Exposes:
//   - 重置密码 → POST /api/admin/students/reset-password, then
//     surfaces the new initial password so the admin can read it back.
//   - 解绑账号 → POST /api/admin/students/unbind, which deletes the
//     auth.users row + clears students.user_id. The roster reloads
//     so the row flips back to the unbound state.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Props {
  studentId: string;
  studentName: string;
}

const ERROR_COPY: Record<string, string> = {
  UNAUTHENTICATED: '管理员未登录，请刷新页面重新登录。',
  FORBIDDEN: '当前账号不是管理员。',
  NOT_FOUND: '该学员尚未绑定账号。',
  REFUSED: '不能解绑管理员账号。',
  AUTH_UPDATE_FAILED: '重置密码失败，请重试。',
  INVALID_REQUEST: '请求异常，请刷新页面后再试。',
  DB_ERROR: '数据库异常，请重试。',
};

export function BoundRow({ studentId, studentName }: Props) {
  const router = useRouter();
  const [resetting, setResetting] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [error, setError] = useState('');
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
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
      // Defer router.refresh() until the admin confirms they've copied
      // the new password — see the "我已抄下，关闭" button below.
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setResetting(false);
    }
  }

  async function unbind() {
    setUnbinding(true);
    setError('');
    try {
      const res = await fetch('/api/admin/students/unbind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ student_id: studentId }),
      });
      const data = (await res.json()) as
        | { success: true; warning?: string }
        | { success: false; errorCode: string; error: string };
      if (!res.ok || !('success' in data) || !data.success) {
        setError(
          ERROR_COPY[(data as any).errorCode] ??
            (data as any).error ??
            '解绑失败，请重试。',
        );
        return;
      }
      setConfirmUnbind(false);
      setConfirmText('');
      router.refresh();
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setUnbinding(false);
    }
  }

  if (newPassword) {
    return (
      <div className="rounded-md border bg-muted/40 p-3 space-y-2">
        <p className="text-sm font-medium text-foreground">密码已重置</p>
        <p className="text-xs text-muted-foreground">
          请抄下新密码口头告知学员，下次刷新页面此密码将不可见。
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

  if (confirmUnbind) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
        <p className="text-sm font-medium text-foreground">
          确认解绑 {studentName} 的账号？
        </p>
        <p className="text-xs text-muted-foreground">
          该学员的登录账号将被删除，且不可恢复。学员需要由你重新创建账号。
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
            variant="destructive"
            size="sm"
            disabled={unbinding || confirmText.trim() !== studentName}
            onClick={unbind}
          >
            {unbinding ? '解绑中...' : '确认解绑'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setConfirmUnbind(false);
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
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => setConfirmUnbind(true)}
        >
          解绑账号
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}