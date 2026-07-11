'use client';

// app/admin/students/_components/create-account-row.tsx
//
// Inline per-student form rendered next to each unbound student row
// in the admin roster. On submit it POSTs to
// /api/admin/students/create-account which uses the service-role
// client to provision an auth.users row and bind students.user_id.
//
// On success we surface the initial password once so the admin can
// read it back / write it down. The page is then reloaded so the row
// flips to the "已绑定账号" state.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Props {
  studentId: string;
  studentName: string;
}

interface SuccessPayload {
  email: string;
  initial_password: string;
}

const ERROR_COPY: Record<string, string> = {
  UNAUTHENTICATED: '管理员未登录，请刷新页面重新登录。',
  FORBIDDEN: '当前账号不是管理员，无法创建学员账号。',
  NOT_FOUND: '学员档案不存在，请刷新页面。',
  ALREADY_BOUND: '该学员已经绑定账号，请先解绑再创建。',
  AUTH_CREATE_FAILED: 'Supabase Auth 拒绝创建账号，可能邮箱已被占用。',
  BIND_FAILED: '账号已创建但绑定学员失败，请联系开发协助。',
  INVALID_REQUEST: '请检查表单填写是否完整。',
  INTERNAL_ERROR: '服务器异常，请重试。',
};

export function CreateAccountRow({ studentId, studentName }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState(studentName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<SuccessPayload | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/students/create-account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          student_id: studentId,
          email,
          display_name: displayName,
        }),
      });
      const data = (await res.json()) as
        | ({ success: true } & SuccessPayload & { student_id: string })
        | { success: false; errorCode: string; error: string };
      if (!res.ok || !('initial_password' in data)) {
        setError(
          ERROR_COPY[(data as any).errorCode] ??
            (data as any).error ??
            '创建失败，请重试。',
        );
        return;
      }
      setSuccess({ email: data.email, initial_password: data.initial_password });
      // Reload the roster so the row flips to "已绑定".
      router.refresh();
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="rounded-md border bg-muted/40 p-3 space-y-2">
        <p className="text-sm font-medium text-foreground">账号已创建</p>
        <p className="text-xs text-muted-foreground">
          请把下面的临时密码抄下来口头告知学员，下次刷新页面此密码将不可见。
        </p>
        <dl className="text-sm space-y-1">
          <div>
            <dt className="inline font-medium">邮箱：</dt>
            <dd className="inline font-mono">{success.email}</dd>
          </div>
          <div>
            <dt className="inline font-medium">初始密码：</dt>
            <dd className="inline font-mono select-all">{success.initial_password}</dd>
          </div>
        </dl>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor={`email-${studentId}`} className="text-xs">
          学员邮箱
        </Label>
        <Input
          id={`email-${studentId}`}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="例如：xiaoming@ruijie.com.cn"
          required
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`display-${studentId}`} className="text-xs">
          显示姓名（可选）
        </Label>
        <Input
          id={`display-${studentId}`}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={studentName}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button
        type="submit"
        size="sm"
        className="w-full"
        disabled={loading || email.length < 3}
      >
        {loading ? '创建中...' : '创建账号并绑定'}
      </Button>
    </form>
  );
}