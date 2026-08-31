'use client';
import { useState, useEffect, useCallback } from 'react';
import { saveAs } from 'file-saver';
import { listCloudCourses, listMyCourses, deleteCloudCourse } from '@/lib/utils/cloud-sync';
import { useAuth } from '@/lib/auth/use-auth';

interface CloudCourse {
  id: string;
  title: string;
  topic: string;
  created_by: string | null;
  author_name: string | null;
  created_at: string;
  updated_at: string;
}

type VideoExportJob = {
  id: string;
  courseId: string;
  status: 'uploading' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  message: string;
  error?: string;
  progressCurrent?: number;
  progressTotal?: number;
  sourceLabel?: string;
  createdAt: string;
  downloadUrl?: string;
  exportPlan?: {
    totalScenes: number;
    includedCount: number;
    skippedCount: number;
    skippedScenes: Array<{
      order: number;
      title: string;
      type: string;
      reason: string;
    }>;
  };
};

const isActiveVideoJob = (job: VideoExportJob) =>
  ['uploading', 'queued', 'running'].includes(job.status);

function videoJobLabel(job: VideoExportJob) {
  if (job.status === 'succeeded') return '视频已生成';
  if (job.status === 'failed') return '视频生成失败';
  if (job.status === 'cancelled') return '视频导出已取消';
  if (job.progressTotal && job.progressCurrent !== undefined) {
    return `视频生成中 ${Math.min(100, Math.round((job.progressCurrent / job.progressTotal) * 100))}%`;
  }
  return job.status === 'uploading' ? '正在准备视频素材' : '视频后台生成中';
}

function videoJobProgress(job: VideoExportJob) {
  if (!job.progressTotal || job.progressCurrent === undefined) return null;
  return Math.min(100, Math.round((job.progressCurrent / job.progressTotal) * 100));
}

function VideoExportPlan({ job }: { job: VideoExportJob }) {
  const plan = job.exportPlan;
  if (!plan) return null;
  return (
    <div className="mt-3 rounded-lg bg-white/80 p-3 dark:bg-slate-950/60">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">本次合成计划</h4>
        <span className="text-xs text-slate-500">共检测 {plan.totalScenes} 页</span>
      </div>
      <div className="mt-3 flex gap-8">
        <div>
          <p className="text-xs text-slate-500">可合成</p>
          <p className="mt-1 text-base font-semibold text-emerald-600">{plan.includedCount} 页</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">跳过互动</p>
          <p className="mt-1 text-base font-semibold text-amber-600">{plan.skippedCount} 页</p>
        </div>
      </div>
      {plan.skippedCount > 0 && (
        <details className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-700">
          <summary className="cursor-pointer text-xs font-medium text-slate-700 dark:text-slate-200">
            查看跳过的互动页面
          </summary>
          <p className="mt-3 text-xs text-slate-500">
            Quiz、讨论和需要学员操作的页面不会进入视频，原课件不受影响。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {plan.skippedScenes.map((scene) => (
              <span
                key={`${scene.order}-${scene.title}`}
                className="rounded-lg border border-amber-200 bg-white px-2.5 py-1 text-xs text-amber-800 dark:bg-slate-950"
              >
                第 {scene.order + 1} 页 · {scene.title}（{scene.reason}）
              </span>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

interface CourseCardProps {
  course: CloudCourse;
  isOwner: boolean;
  sharingId: string | null;
  /** Which list this card belongs to — drives tag text and share button copy. */
  section: 'mine' | 'library';
  videoJob?: VideoExportJob;
  featured?: boolean;
  onOpen: (id: string) => void;
  onShare: (id: string) => void;
  onDelete: (id: string) => void;
}

function CourseCard({
  course,
  isOwner,
  sharingId,
  section, // 'mine' | 'library' — picks tag text + button labels per section
  videoJob,
  featured = false,
  onOpen,
  onShare,
  onDelete,
}: CourseCardProps) {
  const videoProgress = videoJob ? videoJobProgress(videoJob) : null;
  // Per-section labels. The "open" verb used to be ambiguous between a
  // teacher's own course and a public library entry — make the verb match
  // the section's semantics.
  const openLabel = '预览';
  const editLabel = '继续编辑';
  const shareLabel = section === 'mine' ? '分享学员链接' : '分享课程';
  const tagLabel =
    section === 'library'
      ? '资源库'
      : isOwner
        ? '我的创作'
        : course.author_name
          ? `作者：${course.author_name}`
          : null;
  const tagClass =
    section === 'mine' && isOwner
      ? 'shrink-0 inline-flex items-center rounded-full bg-violet-100 dark:bg-violet-900/30 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300'
      : 'shrink-0 inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:text-slate-300';

  return (
    <article
      className={`rounded-2xl border bg-background p-5 transition-shadow hover:shadow-md ${
        featured ? 'border-emerald-300 ring-1 ring-emerald-100 lg:col-span-2' : 'border-slate-200'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium truncate flex-1 min-w-0">
          {course.title || course.topic || '未命名课程'}
        </h3>
        {tagLabel && <span className={tagClass}>{tagLabel}</span>}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        更新于 {new Date(course.updated_at).toLocaleDateString('zh-CN')}
      </p>
      {isOwner && videoJob && (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:bg-slate-900/50">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-sm shadow-sm">
                ▶
              </span>
              <div>
                <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">课程视频</p>
                <p
                  className={`mt-0.5 text-[11px] font-medium ${
                    videoJob.status === 'failed'
                      ? 'text-red-600 dark:text-red-400'
                      : videoJob.status === 'succeeded'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-blue-600 dark:text-blue-400'
                  }`}
                >
                  {videoJobLabel(videoJob)}
                </p>
              </div>
            </div>
            <span className="text-[11px] text-slate-500">
              {new Date(videoJob.createdAt).toLocaleString('zh-CN')}
            </span>
          </div>
          {isActiveVideoJob(videoJob) && (
            <div className="mt-3">
              <div className="mb-1.5 flex justify-between text-[11px] text-slate-500">
                <span>
                  {videoJob.status === 'uploading' ? '正在准备视频素材' : '正在合成画面与配音'}
                </span>
                <span>{videoProgress === null ? '等待进度' : `${videoProgress}%`}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{
                    width: `${videoProgress ?? (videoJob.status === 'uploading' ? 12 : 24)}%`,
                  }}
                />
              </div>
            </div>
          )}
          {videoJob.status === 'failed' && videoJob.error && (
            <p className="mt-2 text-xs text-red-600">{videoJob.error}</p>
          )}
          <VideoExportPlan job={videoJob} />
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={() => onOpen(course.id)}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          {openLabel}
        </button>
        {isOwner && (
          <button
            onClick={() => window.open(`/courses/${course.id}`, '_blank')}
            className="rounded-lg border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            查看数据
          </button>
        )}
        {isOwner && videoJob?.status === 'succeeded' && videoJob.downloadUrl && (
          <button
            onClick={() => void downloadVideo(videoJob)}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
          >
            下载视频
          </button>
        )}
        {isOwner && (
          <button
            onClick={() => window.open(`/classroom/${course.id}?editor=1`, '_blank')}
            className="rounded-lg bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:opacity-90"
          >
            {editLabel}
          </button>
        )}
        <button
          onClick={() => onShare(course.id)}
          disabled={sharingId === course.id}
          className="rounded-lg border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {sharingId === course.id ? '复制中…' : shareLabel}
        </button>
        {isOwner && (
          <button
            onClick={() => onDelete(course.id)}
            className="rounded-lg border px-3 py-1.5 text-xs text-muted-foreground hover:text-destructive"
          >
            删除
          </button>
        )}
      </div>
    </article>
  );
}

async function downloadVideo(job: VideoExportJob) {
  try {
    if (!job.downloadUrl) return;
    const response = await fetch(job.downloadUrl);
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
    saveAs(await response.blob(), 'course.mp4');
  } catch (error) {
    alert(getErrorMessage(error, '视频下载失败'));
  }
}

export default function CloudCourses() {
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;
  const isGlobalManager = user?.email?.toLowerCase() === 'jinzengquan@ruijie.com.cn';

  const [myCourses, setMyCourses] = useState<CloudCourse[]>([]);
  const allCourses: CloudCourse[] = [];
  const [videoJobs, setVideoJobs] = useState<VideoExportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [error, setError] = useState('');

  const fetchCourses = useCallback(async () => {
    try {
      setError('');
      // Fetch BOTH scopes in parallel. The 'mine' scope is filtered
      // server-side by created_by=user.id. The 'all' scope is the
      // full discover list.
      const mine = await listMyCourses();
      setMyCourses(isGlobalManager ? await listCloudCourses() : mine);
      const videoResponse = await fetch('/api/video-exports');
      const videoBody = (await videoResponse.json()) as {
        success?: boolean;
        jobs?: VideoExportJob[];
        error?: string;
      };
      if (!videoResponse.ok || videoBody.success === false) {
        throw new Error(videoBody.error || '获取视频任务失败');
      }
      setVideoJobs(videoBody.jobs ?? []);
    } catch (e: unknown) {
      setError(getErrorMessage(e, '获取云端课程失败'));
    } finally {
      setLoading(false);
    }
  }, [isGlobalManager]);

  useEffect(() => {
    fetchCourses();
  }, [fetchCourses]);

  useEffect(() => {
    if (!videoJobs.some(isActiveVideoJob)) return;
    const timer = window.setInterval(() => void fetchCourses(), 10000);
    return () => window.clearInterval(timer);
  }, [fetchCourses, videoJobs]);

  const latestVideoByCourse = new Map<string, VideoExportJob>();
  for (const job of videoJobs) {
    if (!latestVideoByCourse.has(job.courseId)) latestVideoByCourse.set(job.courseId, job);
  }

  const handleOpen = (courseId: string) => {
    // Pure viewer mode — no Pro Mode, no save button. Owner can edit
    // via the dedicated '编辑' button next to '打开'.
    window.open(`/classroom/${courseId}?view=1`, '_blank');
  };

  const handleShare = async (courseId: string) => {
    setSharingId(courseId);
    setShareMessage(null);
    try {
      const url = `${window.location.origin}/classroom/${courseId}?share=1`;
      if (!navigator.clipboard?.writeText) {
        window.prompt('复制课程链接', url);
        setShareMessage('已显示链接，请手动复制');
        return;
      }
      await navigator.clipboard.writeText(url);
      // ALSO keep the URL on window.lastShareUrl as a recovery hook —
      // some browsers report navigator.clipboard.writeText as successful
      // while actually no-op'ing (permission not granted). Users can
      // retrieve the URL from devtools even after the toast disappears.
      (window as unknown as { lastShareUrl?: string }).lastShareUrl = url;
      const msg = '✅ 课程链接已复制：' + url;
      setShareMessage(msg);
      // Also toast — keeps it visible while the user navigates.
      // Skip if navigator.clipboard threw (handled in catch above).
      const banner = document.createElement('div');
      banner.textContent = msg;
      banner.style.cssText =
        'position:fixed;top:20px;left:50%;transform:translateX(-50%);' +
        'background:#16a34a;color:white;padding:12px 20px;border-radius:8px;' +
        'box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:9999;max-width:90vw;' +
        'font-size:14px;font-family:sans-serif;';
      document.body.appendChild(banner);
      setTimeout(() => banner.remove(), 4000);
    } catch (e: unknown) {
      setShareMessage('❌ 分享失败：' + getErrorMessage(e, '未知错误'));
    } finally {
      setSharingId(null);
    }
  };

  const handleDelete = async (courseId: string) => {
    if (!confirm('确定要删除这门课程吗？此操作不可撤销。')) return;
    try {
      await deleteCloudCourse(courseId);
      // Remove from both lists (a deleted course can't be in either).
      setMyCourses((prev) => prev.filter((c) => c.id !== courseId));
    } catch (e: unknown) {
      alert('删除失败：' + getErrorMessage(e, '未知错误'));
    }
  };

  if (loading) {
    return <div className="mt-8 text-center text-sm text-muted-foreground">☁️ 正在加载课程...</div>;
  }
  if (error) {
    return (
      <div className="mt-8 text-center text-sm text-muted-foreground">
        ☁️ 课程暂不可用（{error}）
      </div>
    );
  }

  // Discover section: courses NOT created by me (or all if user is null).
  const discoverCourses = allCourses;
  return (
    <div className="mt-8 space-y-10">
      {/* 我的创作 — courses I created (or have edit rights to). Edit + Delete only here. */}
      <section id="video-exports">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="mb-1 text-lg font-semibold">我的课程</h2>
            <p className="text-sm text-muted-foreground">
              课程编辑、视频生成进度和下载结果都在同一处管理
            </p>
          </div>
          {videoJobs.length > 0 && (
            <div className="flex gap-2 text-xs">
              {videoJobs.some(isActiveVideoJob) && (
                <span className="rounded-full bg-blue-50 px-3 py-1.5 text-blue-700">
                  生成中 {videoJobs.filter(isActiveVideoJob).length}
                </span>
              )}
              {videoJobs.some((job) => job.status === 'succeeded') && (
                <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-emerald-700">
                  可下载 {videoJobs.filter((job) => job.status === 'succeeded').length}
                </span>
              )}
            </div>
          )}
        </div>
        {myCourses.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            你还没有创建过课程。生成课件后点击「保存到云端」即可在这里看到。
          </p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {myCourses.map((course) => (
              <CourseCard
                key={course.id}
                course={course}
                isOwner={course.created_by === currentUserId}
                sharingId={sharingId}
                section="mine"
                videoJob={latestVideoByCourse.get(course.id)}
                featured={Boolean(
                  latestVideoByCourse.get(course.id) &&
                  isActiveVideoJob(latestVideoByCourse.get(course.id)!),
                )}
                onOpen={handleOpen}
                onShare={handleShare}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </section>

      {false && (
        <section>
          <h2 className="mb-1 text-lg font-semibold">🌐 课程资源库</h2>
          <p className="mb-4 text-sm text-muted-foreground">发现可预览或复用的公开课程</p>
          {discoverCourses.length === 0 ? (
            <p className="text-sm text-muted-foreground">资源库暂无其他老师分享的课程。</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {discoverCourses.map((course) => (
                <CourseCard
                  key={course.id}
                  course={course}
                  isOwner={false}
                  sharingId={sharingId}
                  section="library"
                  videoJob={latestVideoByCourse.get(course.id)}
                  onOpen={handleOpen}
                  onShare={handleShare}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {shareMessage && !sharingId && (
        <p className="mt-4 text-sm text-muted-foreground text-center">{shareMessage}</p>
      )}
    </div>
  );
}
