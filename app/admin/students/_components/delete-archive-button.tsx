'use client';

// app/admin/students/_components/delete-archive-button.tsx
//
// Shared destructive button used by both CreateAccountRow (for
// unbound rows the admin no longer wants) and BoundRow (for bound
// rows being fully removed from the platform).
//
// Two-step confirmation: first click reveals a destructive-styled
// panel asking the admin to retype the student name so a stray click
// cannot delete a record.

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
  REFUSED: '不能删除管理员关联的学员档案。',
  NOT_FOUND: '学员档案不存在。',
  DB_ERROR: '数据库异常，请重试。',
  INVALID_REQUEST: '请求异常，请刷新页面后再试。',
};

export function DeleteArchiveButton({ studentId, studentName }: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  async function doDelete() {
    setDeleting(true);
    setError('');
    try {
      const res = await fetch('/api/admin/students/delete', {
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
            '删除失败，请重试。',
        );
        return;
      }
      // Server deleted both rows; refresh so the row vanishes.
      router.refresh();
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setDeleting(false);
    }
  }

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive w-full"
        onClick={() => setConfirming(true)}
      >
        删除学员档案
      </Button>
    );
  }

  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
      <p className="text-sm font-medium text-foreground">
        确认删除 {studentName} 的档案？
      </p>
      <p className="text-xs text-muted-foreground">
        会从数据库永久删除学员档案（含访问码、姓名、邮箱等），若已绑定登录账号也会一并删除，不可恢复。
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
          disabled={deleting || confirmText.trim() !== studentName}
          onClick={doDelete}
        >
          {deleting ? '删除中...' : '确认删除'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setConfirming(false);
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