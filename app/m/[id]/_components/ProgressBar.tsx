'use client';

/**
 * _components/ProgressBar.tsx
 *
 * One-line course progress indicator. Shows current chapter /
 * total + percentage. Used in the player footer above the audio
 * controls.
 */

interface ProgressBarProps {
  current: number;
  total: number;
  completed: number;
}

export function ProgressBar({ current, total, completed }: ProgressBarProps) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div className="mx-auto max-w-md w-full px-4 pb-2 pt-1 text-[11px] text-muted-foreground flex items-center gap-3">
      <div className="flex-1 h-1 bg-muted rounded overflow-hidden">
        <div
          className="h-full bg-primary/60 transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular-nums shrink-0">
        {current}/{total} 章 · {pct}%
      </span>
    </div>
  );
}