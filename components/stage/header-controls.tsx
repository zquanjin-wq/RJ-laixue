'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudUpload, Film, Download, FileDown, Loader2, Package, Pencil } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useCourseCloudSaveStore } from '@/lib/store/course-cloud-save';
import { useExportPPTX } from '@/lib/export/use-export-pptx';
import { useExportCourseVideo } from '@/lib/export/use-export-course-video';
import { cn } from '@/lib/utils';
import type { StageMode } from '@/lib/types/stage';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

type CourseVideoExport = {
  id: string;
  status: 'queued' | 'rendering' | 'completed' | 'failed' | 'cancelled';
  downloadUrl: string | null;
  progress?: number | null;
  queuePosition?: number | null;
  estimatedWaitSeconds?: number | null;
};

type CourseVideoExportsResponse = {
  success?: boolean;
  exports?: CourseVideoExport[];
};

interface HeaderControlsProps {
  readonly mode?: StageMode;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
  readonly hideProMode?: boolean;
  readonly canAuthor?: boolean;
  /**
   * `default` — the chunky h-9 pill used in the playback Stage Header.
   * `compact` — slightly tighter padding for embedding in CommandBar's
   * right slot (Pro mode chrome already eats height, so the pill backs
   * off ring weight / blur to keep the CommandBar quiet).
   */
  readonly variant?: 'default' | 'compact';
}

/**
 * Stage-level authoring controls. Course actions intentionally own the
 * primary slot: save, edit, and export/video are actionable on every course,
 * while display preferences belong in the ordinary product settings surface.
 *
 * Only one instance is ever mounted at a time (Stage renders Header
 * for playback and EditShell.CommandBar's trailing slot for edit, but
 * never both), so dropdown / dialog state and refs stay co-located
 * here without cross-instance leakage.
 */
export function HeaderControls({
  mode,
  canEdit,
  onToggleEditMode,
  hideProMode = false,
  canAuthor = false,
  variant = 'default',
}: HeaderControlsProps) {
  const { t } = useI18n();
  const router = useRouter();
  const [savingToCloud, setSavingToCloud] = useState(false);
  const cloudSaveStatus = useCourseCloudSaveStore((state) => state.status);
  const selectCloudCourse = useCourseCloudSaveStore((state) => state.selectCourse);
  const setCloudSaveStatus = useCourseCloudSaveStore((state) => state.setStatus);

  // Export plumbing — uses the stage / media task stores to check
  // readiness, then hands off to the export hooks. Available in both
  // playback and edit chrome so the icon's screen position is stable
  // across mode swaps (was previously in `Header` only, missing from
  // CommandBar's right cluster).
  const scenes = useStageStore((s) => s.scenes);
  const courseId = useStageStore((s) => s.stage?.id);
  const generatingOutlines = useStageStore((s) => s.generatingOutlines);
  const failedOutlines = useStageStore((s) => s.failedOutlines);
  const mediaTasks = useMediaGenerationStore((s) => s.tasks);
  const { exporting: isExporting, exportPPTX, exportResourcePack } = useExportPPTX();
  const { preparing: isPreparingVideo, start: exportCourseVideo } = useExportCourseVideo();
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [checkingCloudSave, setCheckingCloudSave] = useState(false);
  const [latestVideoExport, setLatestVideoExport] = useState<CourseVideoExport | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  const refreshVideoExport = useCallback(async () => {
    if (!courseId) {
      setLatestVideoExport(null);
      return;
    }
    try {
      const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/video-exports`, {
        cache: 'no-store',
      });
      const payload = (await response
        .json()
        .catch(() => null)) as CourseVideoExportsResponse | null;
      setLatestVideoExport(response.ok && payload?.success ? (payload.exports?.[0] ?? null) : null);
    } catch {
      setLatestVideoExport(null);
    }
  }, [courseId]);

  useEffect(() => {
    void refreshVideoExport();
  }, [refreshVideoExport]);

  // Saving creates a new immutable course revision. Refresh immediately so a
  // completed video from the previous revision can no longer be downloaded.
  useEffect(() => {
    if (cloudSaveStatus === 'saved') void refreshVideoExport();
  }, [cloudSaveStatus, refreshVideoExport]);

  useEffect(() => {
    if (latestVideoExport?.status !== 'queued' && latestVideoExport?.status !== 'rendering') return;
    const timer = window.setInterval(() => void refreshVideoExport(), 5_000);
    return () => window.clearInterval(timer);
  }, [latestVideoExport?.status, refreshVideoExport]);

  const canExport =
    scenes.length > 0 &&
    generatingOutlines.length === 0 &&
    failedOutlines.length === 0 &&
    Object.values(mediaTasks).every((task) => task.status === 'done' || task.status === 'failed');

  const videoExportStatusText = (() => {
    if (latestVideoExport?.status === 'rendering') {
      const progress =
        typeof latestVideoExport.progress === 'number'
          ? ` ${Math.round(latestVideoExport.progress * 100)}%`
          : '';
      return `正在渲染${progress}`;
    }
    if (latestVideoExport?.status === 'queued') {
      const position = latestVideoExport.queuePosition;
      const wait = latestVideoExport.estimatedWaitSeconds;
      const waitText =
        typeof wait === 'number' && wait > 0 ? `，预计等待约 ${Math.ceil(wait / 60)} 分钟` : '';
      return typeof position === 'number' ? `队列第 ${position} 位${waitText}` : '正在等待渲染';
    }
    return '生成包含配音的 MP4 视频';
  })();

  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (exportMenuOpen && exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    },
    [exportMenuOpen],
  );
  useEffect(() => {
    if (!exportMenuOpen) return;
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [exportMenuOpen, handleClickOutside]);

  const compact = variant === 'compact';
  useEffect(() => {
    selectCloudCourse(courseId ?? null);
  }, [courseId, selectCloudCourse]);

  const saveCourse = useCallback(async () => {
    if (!courseId || savingToCloud) return;
    setSavingToCloud(true);
    setCloudSaveStatus(courseId, 'saving');
    try {
      const { saveStageToCloud } = await import('@/lib/utils/cloud-sync');
      await saveStageToCloud(courseId);
      setCloudSaveStatus(courseId, 'saved');
      toast.success('课程已保存到云端');
    } catch (error) {
      setCloudSaveStatus(courseId, 'failed');
      const message = error instanceof Error ? error.message : '未知错误';
      toast.error(`保存到云端失败：${message}`);
    } finally {
      setSavingToCloud(false);
    }
  }, [courseId, savingToCloud, setCloudSaveStatus]);

  const openEditor = useCallback(() => {
    if (!courseId) return;
    if (onToggleEditMode) {
      void onToggleEditMode();
      return;
    }
    router.push(`/classroom/${encodeURIComponent(courseId)}?editor=1`);
  }, [courseId, onToggleEditMode, router]);

  const openExportMenu = useCallback(async () => {
    if (!courseId || checkingCloudSave) return;
    if (cloudSaveStatus === 'dirty' || cloudSaveStatus === 'saving') {
      toast.warning('课程还有未保存的修改，请先保存到云端。');
      return;
    }
    if (cloudSaveStatus === 'failed') {
      toast.warning('课程最近一次保存失败，请重新保存到云端。');
      return;
    }
    setCheckingCloudSave(true);
    try {
      const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}`, {
        cache: 'no-store',
      });
      const payload = (await response.json().catch(() => null)) as {
        success?: boolean;
        data?: { save_state?: string };
      } | null;
      if (!response.ok || !payload?.success || payload.data?.save_state !== 'ready') {
        toast.warning('课程还未保存到云端，请先点击“保存到云端”。');
        return;
      }
      setExportMenuOpen((open) => !open);
    } catch {
      toast.error('暂时无法确认课程保存状态，请稍后重试。');
    } finally {
      setCheckingCloudSave(false);
    }
  }, [checkingCloudSave, cloudSaveStatus, courseId]);

  // Self-contained spacing so the control cluster is identical regardless of
  // host. The playback Header (`gap-4`) and the edit CommandBar's trailing
  // slot (`gap-2`) would otherwise impose different inter-control spacing on
  // these fragment children, making the pill/switch/export cluster visibly
  // shift width and position across the mode swap. A fixed internal gap keeps
  // the cluster pixel-stable; both hosts pad to `px-8`, so the right edge
  // anchors identically too.
  return (
    <div className="flex items-center gap-2">
      {canAuthor && courseId && !hideProMode && (
        <button
          type="button"
          onClick={() => void saveCourse()}
          disabled={savingToCloud}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60',
            compact && 'px-2.5 py-1.5',
          )}
        >
          {savingToCloud ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CloudUpload className="h-3.5 w-3.5" />
          )}
          {savingToCloud ? '保存中' : '保存到云端'}
        </button>
      )}

      {canAuthor && courseId && !hideProMode && (
        <button
          type="button"
          onClick={openEditor}
          disabled={mode !== 'edit' && !canEdit}
          title={mode === 'edit' ? '完成编辑' : '编辑课程'}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700',
            mode === 'edit' && 'border-violet-400 text-violet-700 dark:text-violet-300',
            compact && 'px-2.5 py-1.5',
          )}
        >
          <Pencil className="h-3.5 w-3.5" />
          {mode === 'edit' ? '完成编辑' : '编辑课程'}
        </button>
      )}

      {/* Export / Download — lives to the right of the Pro Switch.
          Not a settings function so it does not belong inside the
          settings pill; kept as a separate sibling sitting between the
          Pro Switch and the right edge of the chrome. */}
      {canAuthor && !hideProMode && (
        <div className="relative" ref={exportRef}>
          <button
            onClick={() => {
              if (canExport && !isExporting && !isPreparingVideo && !checkingCloudSave) {
                void openExportMenu();
              }
            }}
            disabled={!canExport || isExporting || isPreparingVideo || checkingCloudSave}
            title={
              canExport
                ? isExporting || isPreparingVideo || checkingCloudSave
                  ? t('export.exporting')
                  : t('export.pptx')
                : t('share.notReady')
            }
            className={cn(
              'shrink-0 p-2 rounded-full transition-all',
              canExport && !isExporting && !isPreparingVideo && !checkingCloudSave
                ? 'text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed opacity-50',
            )}
            aria-label={t('export.pptx')}
          >
            {isExporting || isPreparingVideo || checkingCloudSave ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
          </button>
          {exportMenuOpen && (
            <div className="absolute top-full mt-2 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden z-50 min-w-[200px]">
              <button
                onClick={() => {
                  setExportMenuOpen(false);
                  exportPPTX();
                }}
                className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2.5"
              >
                <FileDown className="w-4 h-4 text-gray-400 shrink-0" />
                <span>{t('export.pptx')}</span>
              </button>
              <button
                onClick={() => {
                  setExportMenuOpen(false);
                  exportResourcePack();
                }}
                className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2.5"
              >
                <Package className="w-4 h-4 text-gray-400 shrink-0" />
                <div>
                  <div>{t('export.resourcePack')}</div>
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">
                    {t('export.resourcePackDesc')}
                  </div>
                </div>
              </button>
              {latestVideoExport?.status === 'completed' && latestVideoExport.downloadUrl && (
                <a
                  href={latestVideoExport.downloadUrl}
                  onClick={() => setExportMenuOpen(false)}
                  className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2.5"
                >
                  <Download className="w-4 h-4 text-emerald-600 shrink-0" />
                  <div>
                    <div>下载课程视频</div>
                    <div className="text-[11px] text-gray-400 dark:text-gray-500">
                      MP4 视频已生成
                    </div>
                  </div>
                </a>
              )}
              {latestVideoExport?.status === 'queued' ||
              latestVideoExport?.status === 'rendering' ? (
                <button
                  disabled
                  className="flex w-full cursor-not-allowed items-center gap-2.5 px-4 py-2.5 text-left text-sm opacity-60"
                >
                  <Film className="w-4 h-4 text-gray-400 shrink-0" />
                  <div>
                    <div>课程视频生成中</div>
                    <div className="text-[11px] text-gray-400 dark:text-gray-500">
                      {videoExportStatusText}
                    </div>
                  </div>
                </button>
              ) : (
                <button
                  onClick={() => {
                    setExportMenuOpen(false);
                    void exportCourseVideo().finally(() =>
                      window.setTimeout(() => void refreshVideoExport(), 1_000),
                    );
                  }}
                  disabled={isPreparingVideo}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <Film className="w-4 h-4 text-emerald-600 shrink-0" />
                  <div>
                    <div>生成课程视频</div>
                    <div className="text-[11px] text-gray-400 dark:text-gray-500">720p · 20fps</div>
                  </div>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
