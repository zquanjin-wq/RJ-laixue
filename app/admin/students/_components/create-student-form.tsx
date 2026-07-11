'use client';

// app/admin/students/_components/create-student-form.tsx
//
// Top-of-page form. The admin's primary entry point for adding a
// learner. On submit it POSTs to /api/admin/students/create which
// creates the auth.users + students + (via trigger) profiles rows
// in one shot, then returns the initial password for the admin to
// read back.
//
// After a successful create the form stays open with the new
// password visible until the admin explicitly closes it, so the
// password is never lost to a refresh.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface SuccessPayload {
  email: string;
  initial_password: string;
}

const ERROR_COPY: Record<string, string> = {
  UNAUTHENTICATED: '管理员未登录，请刷新页面重新登录。',
  FORBIDDEN: '当前账号不是管理员。',
  EMAIL_TAKEN: '该邮箱已被使用，请换一个。',
  AUTH_CREATE_FAILED: 'Supabase Auth 拒绝创建账号，请重试或换邮箱。',
  AUTH_LIST_FAILED: '查询账号列表失败，请重试。',
  DB_ERROR: '数据库异常，请重试。',
  INTERNAL_ERROR: '服务器异常，请重试。',
  INVALID_REQUEST: '请填写姓名和邮箱。',
};

export function CreateStudentForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<SuccessPayload | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/students/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, email }),
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
      setSuccess({
        email: data.email,
        initial_password: data.initial_password,
        access_code: data.access_code,
      });
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
        <div>
          <p className="text-sm font-medium text-foreground">学员账号已创建</p>
          <p className="text-xs text-muted-foreground">
            请把下面的信息抄下来口头告知学员，关闭后不可再次查看。
          </p>
        </div>
        <dl className="text-sm space-y-1">
          <div>
            <dt className="inline font-medium">邮箱：</dt>
            <dd className="inline font-mono">{success.email}</dd>
          </div>
          <div>
            <dt className="inline font-medium">初始密码：</dt>
            <dd className="inline font-mono select-all">
              {success.initial_password}
            </dd>
          </div>
        </dl>
        <Button
          variant="default"
          size="sm"
          className="w-full"
          type="button"
          onClick={() => {
            // Hard navigation beats router.refresh() in Next.js 16
            // dev mode: it guarantees the server component re-runs
            // with the freshly created roster rather than showing
            // a stale cached payload.
            window.location.assign('/admin/students?_=' + Date.now());
          }}
        >
          确认
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-lg border bg-background p-4 space-y-3"
    >
      <div>
        <p className="text-sm font-medium">创建新学员</p>
        <p className="text-xs text-muted-foreground">
          一次输入姓名 + 邮箱，自动生成初始密码并创建完整账号。
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="create-name" className="text-xs">
            学员姓名
          </Label>
          <Input
            id="create-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：张三"
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="create-email" className="text-xs">
            学员邮箱
          </Label>
          <Input
            id="create-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="例如：zhangsan@ruijie.com.cn"
            required
          />
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" disabled={loading || !name || !email}>
        {loading ? '创建中...' : '创建账号'}
      </Button>
    </form>
  );
}