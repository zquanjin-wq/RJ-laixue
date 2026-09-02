'use client';

// app/login/page.tsx
//
// Login-only screen. Self-registration is intentionally removed:
// accounts are provisioned by an admin via /admin/students and
// delivered out-of-band (verbal handoff in MVP). Fly / Lark SSO
// is on the roadmap but not wired yet.
//
// Accounts are managed through the Better Auth personnel API.

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { authClient } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { safeNextPath } from '@/lib/utils/safe-next';

function LoginContent() {
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      const { error: signInError } = await authClient.signIn.email({
        email,
        password,
      });
      if (signInError) throw signInError;
      const me = await fetch('/api/me', { cache: 'no-store' });
      const payload = me.ok
        ? ((await me.json()) as { actor?: { mustChangePassword?: boolean } })
        : null;
      window.location.assign(
        payload?.actor?.mustChangePassword
          ? `/change-password?next=${encodeURIComponent(next)}`
          : next,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-background flex items-center justify-center px-4">
      <Card className="w-full max-w-sm rounded-lg">
        <CardHeader>
          <CardTitle>登录来学</CardTitle>
          <CardDescription>账号由管理员开通。如未收到账号，请联系培训管理员。</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">邮箱</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={6}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? '处理中...' : '登录'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-background flex items-center justify-center px-4">
          <div className="text-sm text-muted-foreground">正在加载登录页...</div>
        </main>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
