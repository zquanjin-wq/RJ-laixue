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
        setError('Access code not found');
      } else if (msg.includes('not assigned')) {
        setError('You are not assigned to this course');
      } else {
        setError('Verification failed, please try again');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="w-full max-w-sm rounded-xl border bg-background p-8 shadow-sm">
        <h2 className="text-lg font-semibold text-center mb-1">Course Login</h2>
        <p className="text-sm text-muted-foreground text-center mb-6">
          Enter your access code to start learning
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="text"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value.toUpperCase())}
              placeholder="6-digit access code"
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
            {loading ? 'Verifying...' : 'Enter Course'}
          </button>
        </form>
      </div>
    </div>
  );
}
