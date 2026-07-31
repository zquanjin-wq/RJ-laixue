'use client';

/**
 * GenerationProgressSidebar — 侧边栏顶部专用的精简版创建进度面板。
 *
 * 与画布内部的 GenerationProgress 组件职责互补：
 * - GenerationProgress（画布中央）：详细列表，每个 outline 一行 + 单页重试
 * - GenerationProgressSidebar（本组件）：常驻在侧边栏顶部，仅展示"汇总"
 *   + 失败项清单（按需展开），老师任何时候都能看到生成状态并一键重试失败的页面。
 *
 * 设计动机：
 * - 画布内的进度面板被 16:9 容器 + overflow-hidden 裁切，outlines 多时无法滚动。
 * - sidebar 已有滚动容器，本组件作为 sidebar 第一块常驻内容随 sidebar 一起滚。
 * - failedOutlines 永远进不了 sidebar 缩略图列表（它们没生成完，没有 scene），所以
 *   老师无从在 sidebar 里点中失败页 → 本组件弥补这一缺口。
 *
 * 仅在 !generationComplete || failedOutlines.length > 0 时渲染（由调用方控制）。
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, AlertCircle, Loader2 } from 'lucide-react';
import { useStageStore } from '@/lib/store/stage';
import type { SceneOutline } from '@/lib/types/generation';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

export interface GenerationProgressSidebarProps {
  /** 单页重试处理（来自 useSceneGenerator().retrySingleOutline） */
  readonly onRetry?: (outlineId: string) => Promise<void> | void;
}

export function GenerationProgressSidebar({ onRetry }: GenerationProgressSidebarProps) {
  const { t } = useI18n();
  const outlines = useStageStore((s) => s.outlines);
  const scenes = useStageStore((s) => s.scenes);
  const generatingOutlines = useStageStore((s) => s.generatingOutlines);
  const failedOutlines = useStageStore((s) => s.failedOutlines);
  const generationComplete = useStageStore((s) => s.generationComplete);

  // 计算状态分布（与 GenerationProgress.tsx 中的判定一致）
  const completedOrders = new Set(scenes.map((s) => s.order));
  const generatingIds = new Set(generatingOutlines.map((o) => o.id));

  const isFailed = (o: SceneOutline) => failedOutlines.some((f) => f.id === o.id);
  const isCompleted = (o: SceneOutline) => completedOrders.has(o.order);
  const isGenerating = (o: SceneOutline) => generatingIds.has(o.id);

  const total = outlines.length;
  // Use scenes.length (not outlines.filter(isCompleted)) as the source of
  // truth for "completed". The sidebar's thumbnail list renders scenes[]
  // directly, so this keeps the "X / Y" number in lockstep with what the
  // user actually sees. Orphan scenes or order drift can otherwise make
  // the two counts disagree.
  const completedCount = scenes.length;
  const failedCount = failedOutlines.length;
  const generatingCount = outlines.filter(isGenerating).length;
  const progressPct = total > 0 ? Math.round((completedCount / total) * 100) : 0;

  // 失败项默认展开（这是用户最关心的），若失败为 0 则收起
  const [failedExpanded, setFailedExpanded] = useState(failedCount > 0);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  if (total === 0) return null;

  const handleRetry = async (outlineId: string) => {
    if (!onRetry) return;
    setRetryingId(outlineId);
    try {
      await onRetry(outlineId);
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <div
      className="px-2 pb-3 mb-2 border-b border-gray-100 dark:border-gray-800"
      data-testid="generation-progress-sidebar"
    >
      {/* 标题 + 总进度数字 */}
      <div className="flex items-center justify-between gap-2 px-1 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {generationComplete ? (
            <span className="text-xs">✅</span>
          ) : generatingCount > 0 ? (
            <Loader2 className="w-3 h-3 text-blue-500 animate-spin shrink-0" />
          ) : (
            <span className="text-xs">⏳</span>
          )}
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-200 truncate">
            {generationComplete
              ? t('generation.progress.complete')
              : t('generation.progress.generating')}
          </span>
        </div>
        <span className="text-[10px] font-bold text-gray-500 dark:text-gray-400 shrink-0 tabular-nums">
          {completedCount} / {total}
        </span>
      </div>

      {/* 聚合进度条 */}
      <div
        className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-1 overflow-hidden mb-2"
        role="progressbar"
        aria-valuenow={progressPct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn(
            'h-1 rounded-full transition-all duration-500',
            failedCount > 0 && completedCount + failedCount === total
              ? 'bg-amber-400'
              : 'bg-blue-500',
          )}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* 失败项区（默认展开，有失败时） */}
      {failedCount > 0 && (
        <div className="rounded-md bg-red-50/60 dark:bg-red-950/20 ring-1 ring-red-100 dark:ring-red-900/30 overflow-hidden">
          <button
            type="button"
            onClick={() => setFailedExpanded((v) => !v)}
            className="w-full flex items-center justify-between gap-1 px-2 py-1.5 text-[11px] font-semibold text-red-700 dark:text-red-300 hover:bg-red-100/60 dark:hover:bg-red-950/40 transition-colors"
            aria-expanded={failedExpanded}
            data-testid="generation-progress-sidebar-failed-toggle"
          >
            <span className="flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {failedCount} {t('generation.progress.statusFailed')}
            </span>
            {failedExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </button>
          {failedExpanded && (
            <ul className="px-1.5 pb-1.5 space-y-0.5" data-testid="generation-progress-sidebar-failed-list">
              {failedOutlines.map((outline) => {
                const isRetrying = retryingId === outline.id;
                return (
                  <li
                    key={outline.id}
                    className="flex items-center justify-between gap-1.5 py-1 px-1.5 rounded bg-white/60 dark:bg-gray-900/30"
                    data-status="failed"
                  >
                    <span
                      className="text-[11px] text-red-700 dark:text-red-300 truncate min-w-0 flex-1"
                      title={outline.title}
                    >
                      {outline.title || t('generation.progress.untitledPage', { index: outline.order })}
                    </span>
                    {onRetry && (
                      <button
                        type="button"
                        onClick={() => {
                          void handleRetry(outline.id);
                        }}
                        disabled={isRetrying}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/60 active:scale-95 disabled:opacity-50 disabled:active:scale-100 transition-colors shrink-0"
                        data-testid="generation-progress-sidebar-retry"
                      >
                        <RefreshCw className={cn('w-2.5 h-2.5', isRetrying && 'animate-spin')} />
                        {t('generation.progress.retry')}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}