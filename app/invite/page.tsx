'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth/use-auth';

const ERROR_COPY: Record<string, string> = {
  NOT_FOUND: '访问码不存在，请检查后重试。',
  CONFLICT: '此访问码已经绑定到其他账号，请联系老师重新分配。',
  UNAUTHENTICATED: '请重新登录后再试。',
  INTERNAL_ERROR: '服务器异常，请稍后重试。',
  INVALID_REQUEST: '请求异常，请刷新页面后再试。',
};

function normaliseCode(raw: string | null): string {
  if (!raw) return '';
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function InviteContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialCode = normaliseCode(searchParams.get('code'));

  const [code, setCode] = useState(initialCode);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const { user, profile, loading: authLoading } = useAuth();

  if (authLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">正在验证账号...</div>
      </main>
    );
  }

  // ---- Path 1: no signed-in user → ask them to log in first
  if (!user) {
    const next = initialCode ? `/invite?code=${initialCode}` : '/invite';
    const loginHref = `/login?next=${encodeURIComponent(next)}`;
    return (
      <main className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-md rounded-lg">
          <CardHeader>
            <CardTitle>绑定学员访问码</CardTitle>
            <CardDescription>
              {initialCode
                ? `检测到访问码 ${initialCode}。账号由管理员开通，请使用邮件里收到的临时密码登录后再绑定。`
                : '账号由管理员开通，请使用邮件里收到的临时密码登录后再访问邀请链接。'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={() => router.push(loginHref)}>前往登录</Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  // ---- Path 2: signed in but no code → tell them how to come back
  if (!initialCode) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-md rounded-lg">
          <CardHeader>
            <CardTitle>请使用邀请链接</CardTitle>
            <CardDescription>
              请使用老师分享的形如 <code className="font-mono">/invite?code=ABC123</code> 的链接绑定学员身份。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button variant="outline" onClick={() => router.push('/student/courses')}>
              查看我的课程
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  // ---- Path 3: signed in with a code → bind and continue
  async function handleBind() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/access-code/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const payload = (await res.json()) as
        | { success: true; studentName: string }
        | { success: false; errorCode: string; error: string };
      if (!res.ok || !('studentName' in payload)) {
        // Prefer the API's precise 'error' field over a local copy
        // map so business-specific copy (e.g. 'access_code already
        // used') reaches the admin / learner instead of a generic
        // fallback. ERROR_COPY only catches unhandled errorCode values.
        setError(payload.error ?? '绑定失败，请重试。');
        return;
      }
      router.replace(`/student/courses?bound=${encodeURIComponent(payload.studentName)}`);
      router.refresh();
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-background flex items-center justify-center px-4">
      <Card className="w-full max-w-md rounded-lg">
        <CardHeader>
          <CardTitle>绑定学员访问码</CardTitle>
          <CardDescription>
            当前账号：{profile?.display_name ?? user.email ?? '匿名学员'}。
            绑定后，老师后续分配的所有课程将自动出现在你的学员首页。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium block mb-2">访问码</label>
            <div className="text-3xl font-mono tracking-widest text-center py-2 border rounded-md bg-muted">
              {code || '——————'}
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={handleBind} disabled={loading || code.length < 1} className="w-full">
            {loading ? '正在绑定...' : '确认绑定'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => router.push('/student/courses')}
            className="w-full"
            type="button"
          >
            暂不绑定，先看我的课程
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-background flex items-center justify-center px-4">
          <div className="text-sm text-muted-foreground">正在加载邀请页...</div>
        </main>
      }
    >
      <InviteContent />
    </Suspense>
  );
}
