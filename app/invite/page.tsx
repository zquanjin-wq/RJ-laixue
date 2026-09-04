'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth/use-auth';

function InviteContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hasLegacyCode = Boolean(searchParams.get('code'));

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
    const loginHref = '/login?next=%2Fstudent%2Fcourses';
    return (
      <main className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-md rounded-lg">
          <CardHeader>
            <CardTitle>学员账号登录</CardTitle>
            <CardDescription>
              {hasLegacyCode
                ? '旧邀请码已停用。请使用管理员创建的账号和临时密码登录。'
                : '请使用管理员创建的账号和临时密码登录。'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={() => router.push(loginHref)}>前往登录</Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background flex items-center justify-center px-4">
      <Card className="w-full max-w-md rounded-lg">
        <CardHeader>
          <CardTitle>学员账号已迁移</CardTitle>
          <CardDescription>
            当前账号：{profile?.display_name ?? user.email ?? '匿名学员'}。
            {hasLegacyCode
              ? '旧邀请码不再绑定账号。管理员通过学习任务分配的课程会显示在学员首页。'
              : '管理员通过学习任务分配的课程会显示在学员首页。'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => router.push('/student/courses')} className="w-full">
            查看我的课程
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
