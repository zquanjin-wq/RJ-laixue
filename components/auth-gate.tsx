'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth/use-auth';

export function AdminGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { profile, loading, signOut } = useAuth();

  useEffect(() => {
    if (!loading && !profile) {
      router.replace(`/login?next=${encodeURIComponent(pathname || '/')}`);
    }
  }, [loading, pathname, profile, router]);

  if (loading || !profile) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">正在验证账号...</div>
      </main>
    );
  }

  if (profile.role !== 'admin' && profile.role !== 'teacher') {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-md rounded-lg">
          <CardHeader>
            <CardTitle>学习账号已登录</CardTitle>
            <CardDescription>
              当前账号是学员角色。如需查看已分配的课件，请联系管理员获取访问权限。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button variant="outline" onClick={() => signOut()}>
              退出登录
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return <>{children}</>;
}

