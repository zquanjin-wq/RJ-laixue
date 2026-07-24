'use client';

/**
 * GenerationProgress — per-outline live status panel.
 *
 * Shown while a course is mid-generation. Replaces the previous generic
 * "generating next page…" spinner with a per-outline breakdown so the
 * teacher sees which pages are done, which are pending, which failed,
 * and which are currently generating. Pure read-side component: every
 * field it shows is derived from existing useStageStore arrays — no new
 * state is introduced here. The retry button calls back up through the
 * onRetryOutline prop, which originates at useSceneGenerator() in
 * `app/classroom/[id]/page.tsx`.
 *
 * Status derivation (no new fields on SceneOutline required):
 *   failed       ← outline id appears in failedOutlines
 *   completed    ← outline.order has a matching scene in scenes[]
 *   generating   ← outline id appears in generatingOutlines
 *   pending      ← none of the above
 *
 * Note that the four arrays are not mutually exclusive in theory
 * (failedOutlines still holds the outline while it's being retried),
 * so we check in priority order: failed first, then completed, then
 * generating, then pending. This matches the natural lifecycle: an
 * outline can be marked failed → user retries → it moves back to
 * generating → it succeeds and the scene materializes.
 */

import { Circle, Loader2, CheckCircle2, XCircle, RotateCw } from 'lucide-react';
import { useStageStore } from '@/lib/store/stage';
import type { SceneOutline } from '@/lib/types/generation';
import { useI18n } from '@/lib/hooks/use-i18n';

export type GenerationOutlineStatus = 'pending' | 'generating' | 'completed' | 'failed';

export interface GenerationProgressProps {
  /** Retry handler from useSceneGenerator().retrySingleOutline */
  readonly onRetry?: (outlineId: string) => Promise<void> | void;
}

export function GenerationProgress({ onRetry }: GenerationProgressProps) {
  const { t } = useI18n();
  const outlines = useStageStore((s) => s.outlines);
  const scenes = useStageStore((s) => s.scenes);
  const generatingOutlines = useStageStore((s) => s.generatingOutlines);
  const failedOutlines = useStageStore((s) => s.failedOutlines);
  const generationComplete = useStageStore((s) => s.generationComplete);

  // Build a set of orders that have a materialized scene for O(1) lookup.
  const completedOrders = new Set(scenes.map((s) => s.order));
  const failedIds = new Set(failedOutlines.map((o) => o.id));
  const generatingIds = new Set(generatingOutlines.map((o) => o.id));

  const statusOf = (outline: SceneOutline): GenerationOutlineStatus => {
    if (failedIds.has(outline.id)) return 'failed';
    if (completedOrders.has(outline.order)) return 'completed';
    if (generatingIds.has(outline.id)) return 'generating';
    return 'pending';
  };

  const total = outlines.length;
  const completedCount = outlines.filter((o) => statusOf(o) === 'completed').length;
  const failedCount = outlines.filter((o) => statusOf(o) === 'failed').length;
  const progressPct = total > 0 ? Math.round((completedCount / total) * 100) : 0;

  return (
    <div
      className="w-full max-w-lg mx-auto px-6 py-8"
      data-testid="generation-progress"
    >
      {/* Title */}
      <p className="text-sm font-semibold mb-4 text-gray-700 dark:text-gray-200">
        {generationComplete
          ? t('generation.progress.complete')
          : t('generation.progress.generating')}
      </p>

      {/* Per-outline list */}
      <div className="space-y-1.5 mb-5">
        {outlines.map((outline, idx) => {
          const status = statusOf(outline);
          return (
            <div
              key={outline.id}
              className="flex items-center justify-between py-1.5 border-b border-gray-50 dark:border-gray-800 last:border-b-0"
              data-status={status}
            >
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <StatusIcon status={status} />
                <span
                  className={`text-sm truncate ${
                    status === 'failed'
                      ? 'text-red-600 dark:text-red-400'
                      : status === 'completed'
                        ? 'text-gray-700 dark:text-gray-300'
                        : status === 'generating'
                          ? 'text-blue-700 dark:text-blue-400 font-medium'
                          : 'text-gray-400 dark:text-gray-500'
                  }`}
                  title={outline.title}
                >
                  {outline.title || t('generation.progress.untitledPage', { index: idx + 1 })}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <StatusLabel status={status} />
                {status === 'failed' && onRetry && (
                  <button
                    type="button"
                    onClick={() => {
                      void onRetry(outline.id);
                    }}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-md bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors active:scale-95"
                    data-testid="generation-progress-retry"
                  >
                    <RotateCw className="size-3" />
                    {t('generation.progress.retry')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Aggregate progress bar + counts */}
      <div className="pt-3 border-t border-gray-100 dark:border-gray-800">
        <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1.5">
          <span>{t('generation.progress.overallLabel')}</span>
          <span>
            {completedCount} / {total} {t('generation.progress.pageUnit')}
          </span>
        </div>
        <div
          className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-1.5 overflow-hidden"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="bg-blue-500 h-1.5 rounded-full transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        {failedCount > 0 && (
          <p className="text-xs text-red-500 mt-2">
            {t('generation.progress.failedHint', { count: failedCount })}
          </p>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: GenerationOutlineStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="size-4 shrink-0 text-green-500" />;
    case 'generating':
      return <Loader2 className="size-4 shrink-0 text-blue-500 animate-spin" />;
    case 'failed':
      return <XCircle className="size-4 shrink-0 text-red-500" />;
    default:
      return <Circle className="size-4 shrink-0 text-gray-300 dark:text-gray-600" />;
  }
}

function StatusLabel({ status }: { status: GenerationOutlineStatus }) {
  const { t } = useI18n();
  const labelMap: Record<GenerationOutlineStatus, string> = {
    pending: t('generation.progress.statusPending'),
    generating: t('generation.progress.statusGenerating'),
    completed: t('generation.progress.statusCompleted'),
    failed: t('generation.progress.statusFailed'),
  };
  return (
    <span
      className={`text-xs ${
        status === 'failed'
          ? 'text-red-500'
          : status === 'completed'
            ? 'text-green-600'
            : status === 'generating'
              ? 'text-blue-600'
              : 'text-gray-400'
      }`}
    >
      {labelMap[status]}
    </span>
  );
}