'use client';

/**
 * _components/AIQuestionDialog.tsx
 *
 * Half-sheet modal for AI Q&A. Caller (MobilePlayer) is responsible
 * for managing open state and for calling /api/chat. This component
 * just renders the bottom-sheet UI, the input, and the streamed
 * response.
 *
 * Per PRD-mobile §3.1 #6 — AI 伴学 appears in the reply only because
 * the chat endpoint already dispatches the teacher agent + a
 * companion agent in the same Q&A turn. The visual styling
 * differentiates them.
 */

import { useEffect, useRef, useState } from 'react';
import { QUESTION_LIMIT } from '@/lib/mobile/question-limit';

interface AIQuestionDialogProps {
  open: boolean;
  onClose: () => void;
  onAsk: (question: string) => Promise<string>;
  courseTitle: string;
  chapterTitle: string;
  chapterText: string;
  remaining: number;
}

export function AIQuestionDialog({
  open,
  onClose,
  onAsk,
  courseTitle,
  chapterTitle,
  chapterText,
  remaining,
}: AIQuestionDialogProps) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Reset state when the dialog opens
  useEffect(() => {
    if (open) {
      setQuestion('');
      setAnswer('');
      setError(null);
      setLoading(false);
      // Focus input shortly after open (animation)
      const id = window.setTimeout(() => inputRef.current?.focus(), 100);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const canAsk = remaining > 0 && !loading && question.trim().length > 0;

  const submit = async () => {
    if (!canAsk) return;
    setLoading(true);
    setError(null);
    setAnswer('');
    try {
      const reply = await onAsk(question.trim());
      setAnswer(reply);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md bg-background rounded-t-2xl shadow-xl flex flex-col max-h-[75vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div>
            <h3 className="text-sm font-semibold">AI 问答</h3>
            <p className="text-[11px] text-muted-foreground">
              {courseTitle} · {chapterTitle}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-sm text-muted-foreground px-2 py-1"
            aria-label="关闭"
          >
            关闭 ✕
          </button>
        </div>

        {/* Body: chapter context + Q&A */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground">
              查看当前章节上下文
            </summary>
            <p className="mt-2 whitespace-pre-wrap text-foreground/80 leading-relaxed">
              {chapterText.slice(0, 600)}
              {chapterText.length > 600 ? '…' : ''}
            </p>
          </details>

          {answer && (
            <div className="rounded-lg bg-muted p-3 text-sm leading-relaxed whitespace-pre-wrap">
              <div className="text-[11px] text-primary font-semibold mb-1">
                AI 讲师 + AI 伴学
              </div>
              {answer}
            </div>
          )}

          {loading && (
            <div className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
              AI 正在思考…
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        {/* Footer: input + send */}
        <div className="border-t px-3 py-3 flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            placeholder={
              remaining > 0
                ? '输入你的问题…'
                : `本课程提问次数已用完（${QUESTION_LIMIT}/${QUESTION_LIMIT}）`
            }
            disabled={remaining <= 0 || loading}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="flex-1 resize-none rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
          <button
            onClick={submit}
            disabled={!canAsk}
            className="shrink-0 bg-primary text-primary-foreground text-sm px-4 py-2 rounded disabled:opacity-40"
          >
            发送
          </button>
        </div>

        <p className="px-3 pb-3 text-[11px] text-muted-foreground text-center">
          剩余 {remaining}/{QUESTION_LIMIT} 次提问 · 试点期间每门课程 5 次
        </p>
      </div>
    </div>
  );
}