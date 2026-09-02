'use client';

import { useState } from 'react';
import { verifyStudentAccess } from '@/lib/utils/cloud-sync';

interface StudentGateProps {
  courseId: string;
  onVerified: (studentId: string, studentName: string) => void;
}

export function StudentGate({ courseId, onVerified }: StudentGateProps) {
  const [accessCode, setAccessCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessCode.trim()) return;
    setLoading(true);
    setError('');
    try {
      const result = await verifyStudentAccess(courseId, accessCode.trim());
      onVerified(result.studentId, result.studentName);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('not found')) {
        setError('访问码不存在，请检查后重试');
      } else if (msg.includes('not assigned')) {
        setError('您未被分配此课程，请联系老师');
      } else {
        setError('验证失败，请重试');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="w-full max-w-sm rounded-xl border bg-background p-8 shadow-sm">
        <h2 className="text-lg font-semibold text-center mb-1">课程登录</h2>
        <p className="text-sm text-muted-foreground text-center mb-6">
          请输入访问码开始学习
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="text"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value.toUpperCase())}
            placeholder="请输入6位访问码"
              maxLength={6}
              className="w-full rounded-md border px-3 py-2 text-center text-lg tracking-widest font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary"
              autoFocus
            />
          </div>
          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading || accessCode.length < 1}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? '验证中...' : '进入课程'}
          </button>
        </form>
      </div>
    </div>
  );
}
