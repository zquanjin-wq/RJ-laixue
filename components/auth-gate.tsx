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

  if (profile.role !== 'admin') {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-md rounded-lg">
          <CardHeader>
            <CardTitle>学习账号已登录</CardTitle>
            <CardDescription>
              当前账号是学员角色。学员课程入口将在下一阶段开放，请先使用老师分享的课程链接学习。
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

