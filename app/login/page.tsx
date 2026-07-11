'use client';

// app/login/page.tsx
//
// Login-only screen. Self-registration is intentionally removed:
// accounts are provisioned by an admin via /admin/students and
// delivered out-of-band (verbal handoff in MVP). Fly / Lark SSO
// is on the roadmap but not wired yet.
//
// See app/admin/students/page.tsx for the admin flow that creates
// the auth.users rows that log in here.

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') || '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) throw signInError;
      // Force a full page navigation rather than router.replace(next)
      // + router.refresh(). The client-side transition was racing the
      // Supabase auth cookie write: the RSC at /admin ran before the
      // browser cookie store was fully updated and bounced us back to
      // /login. window.location.assign triggers a brand-new request
      // that the server reads cookies from cleanly.
      window.location.assign(next);
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
          <CardDescription>
            账号由管理员开通。如未收到账号，请联系培训管理员。
          </CardDescription>
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