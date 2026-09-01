'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { saveAs } from 'file-saver';
import {
  Download,
  Eye,
  Loader2,
  MoreHorizontal,
  Pencil,
  Search,
  Share2,
  Trash2,
} from 'lucide-react';
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
    skippedScenes: Array<{ order: number; title: string; type: string; reason: string }>;
  };
};

type CourseFilter = 'all' | 'active' | 'downloadable' | 'failed';

const isActiveVideoJob = (job: VideoExportJob) =>
  ['uploading', 'queued', 'running'].includes(job.status);

function videoJobProgress(job: VideoExportJob) {
  if (!job.progressTotal || job.progressCurrent === undefined) return null;
  return Math.min(100, Math.round((job.progressCurrent / job.progressTotal) * 100));
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('zh-CN');
}

function formatActivity(job?: VideoExportJob) {
  if (!job) return null;
  const time = new Date(job.createdAt).toLocaleString('zh-CN');
  if (job.status === 'succeeded') return `生成于 ${time}`;
  if (job.status === 'failed') return `失败于 ${time}`;
  if (job.status === 'cancelled') return `取消于 ${time}`;
  return `任务创建于 ${time}`;
}

function VideoStatus({ job }: { job?: VideoExportJob }) {
  if (!job) return <span className="text-sm text-slate-400">— 未生成</span>;

  if (job.status === 'succeeded') {
    return <span className="inline-flex items-center gap-2 text-sm font-medium text-emerald-700"><i className="size-2 rounded-full bg-emerald-500" />已生成</span>;
  }

  if (job.status === 'failed' || job.status === 'cancelled') {
    return <span className="inline-flex items-center gap-2 text-sm font-medium text-red-700"><i className="size-2 rounded-full bg-red-500" />{job.status === 'failed' ? '生成失败' : '已取消'} · 查看详情</span>;
  }

  const progress = videoJobProgress(job);
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 text-sm font-medium text-blue-700">
        <i className="size-2 animate-pulse rounded-full bg-blue-500" />
        <span>{job.status === 'uploading' ? '准备素材中' : '生成中'} {progress === null ? '' : `${progress}%`}</span>
      </div>
      <div className="mt-2 h-1.5 w-24 overflow-hidden rounded-full bg-blue-100">
        <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${progress ?? (job.status === 'uploading' ? 12 : 24)}%` }} />
      </div>
    </div>
  );
}

function VideoPlan({ job }: { job?: VideoExportJob }) {
  if (!job) return <p className="text-sm text-slate-500">尚未创建视频任务</p>;
  if (isActiveVideoJob(job)) {
    const progress = videoJobProgress(job);
    return <><p className="font-medium text-slate-800">{job.status === 'uploading' ? '正在准备视频素材' : '正在合成画面与配音'}{progress === null ? '' : ` ${progress}%`}</p><p className="mt-1 text-xs text-slate-500">视频完成后会在此课程行中提供下载。</p></>;
  }
  if (job.status === 'failed') return <><p className="font-medium text-red-700">视频生成失败</p>{job.error && <p className="mt-1 text-xs text-red-600">{job.error}</p>}</>;
  if (job.status === 'succeeded') return <><p className="font-medium text-emerald-700">视频已生成</p>{job.exportPlan && <p className="mt-1 text-xs text-slate-500">本次合成检测 {job.exportPlan.totalScenes} 页，可合成 {job.exportPlan.includedCount} 页。</p>}</>;
  return <p className="text-sm text-slate-500">视频导出已取消。</p>;
}

export default function CloudCourses() {
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;
  const isGlobalManager = user?.email?.toLowerCase() === 'jinzengquan@ruijie.com.cn';
  const [myCourses, setMyCourses] = useState<CloudCourse[]>([]);
  const [videoJobs, setVideoJobs] = useState<VideoExportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CourseFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [downloadingVideoId, setDownloadingVideoId] = useState<string | null>(null);

  const fetchCourses = useCallback(async () => {
    try {
      setError('');
      const mine = await listMyCourses();
      setMyCourses(isGlobalManager ? await listCloudCourses() : mine);
      const response = await fetch('/api/video-exports');
      const body = (await response.json()) as { success?: boolean; jobs?: VideoExportJob[]; error?: string };
      if (!response.ok || body.success === false) throw new Error(body.error || '获取视频任务失败');
      setVideoJobs(body.jobs ?? []);
    } catch (fetchError) {
      setError(getErrorMessage(fetchError, '获取云端课程失败'));
    } finally {
      setLoading(false);
    }
  }, [isGlobalManager]);

  useEffect(() => { fetchCourses(); }, [fetchCourses]);
  useEffect(() => {
    if (!videoJobs.some(isActiveVideoJob)) return;
    const timer = window.setInterval(() => void fetchCourses(), 10000);
    return () => window.clearInterval(timer);
  }, [fetchCourses, videoJobs]);

  const latestVideoByCourse = useMemo(() => {
    const jobs = [...videoJobs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return new Map(jobs.map((job) => [job.courseId, job]));
  }, [videoJobs]);

  const counts = useMemo(() => ({
    active: videoJobs.filter(isActiveVideoJob).length,
    downloadable: videoJobs.filter((job) => job.status === 'succeeded' && job.downloadUrl).length,
    failed: videoJobs.filter((job) => job.status === 'failed').length,
  }), [videoJobs]);

  const courses = useMemo(() => myCourses.filter((course) => {
    const job = latestVideoByCourse.get(course.id);
    const searchable = `${course.title} ${course.topic} ${course.author_name ?? ''}`.toLowerCase();
    if (query && !searchable.includes(query.toLowerCase())) return false;
    if (filter === 'active') return Boolean(job && isActiveVideoJob(job));
    if (filter === 'downloadable') return Boolean(job?.status === 'succeeded' && job.downloadUrl);
    if (filter === 'failed') return job?.status === 'failed';
    return true;
  }), [filter, latestVideoByCourse, myCourses, query]);

  const openCourse = (courseId: string) => window.open(`/classroom/${courseId}?view=1`, '_blank');
  const editCourse = (courseId: string) => window.open(`/classroom/${courseId}?editor=1`, '_blank');

  const downloadVideo = async (job: VideoExportJob) => {
    if (!job.downloadUrl || downloadingVideoId) return;
    setDownloadingVideoId(job.id);
    try {
      // Fetching the signed MP4 first makes the browser save a file instead of
      // opening its built-in player. The button changes immediately while this runs.
      const response = await fetch(job.downloadUrl);
      if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
      saveAs(await response.blob(), 'course.mp4');
    } catch (error) {
      alert(getErrorMessage(error, '视频下载失败'));
    } finally {
      setDownloadingVideoId(null);
    }
  };

  const shareCourse = async (courseId: string) => {
    setSharingId(courseId);
    try {
      const url = `${window.location.origin}/classroom/${courseId}?share=1`;
      if (!navigator.clipboard?.writeText) return void window.prompt('复制课程链接', url);
      await navigator.clipboard.writeText(url);
      alert('课程链接已复制');
    } catch (shareError) {
      alert('分享失败：' + getErrorMessage(shareError, '未知错误'));
    } finally {
      setSharingId(null);
    }
  };

  const removeCourse = async (courseId: string) => {
    if (!confirm('确定要删除这门课程吗？此操作不可撤销。')) return;
    try {
      await deleteCloudCourse(courseId);
      setMyCourses((previous) => previous.filter((course) => course.id !== courseId));
    } catch (deleteError) {
      alert('删除失败：' + getErrorMessage(deleteError, '未知错误'));
    }
  };

  if (loading) return <div className="mt-8 text-center text-sm text-muted-foreground">正在加载课程...</div>;
  if (error) return <div className="mt-8 text-center text-sm text-muted-foreground">课程暂不可用（{error}）</div>;

  const filters: Array<{ key: CourseFilter; label: string; count: number }> = [
    { key: 'all', label: '全部', count: myCourses.length },
    { key: 'active', label: '生成中', count: counts.active },
    { key: 'downloadable', label: '可下载', count: counts.downloadable },
    { key: 'failed', label: '失败', count: counts.failed },
  ];

  return (
    <section className="mt-8">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-semibold tracking-tight">我的课程</h2>
          <span className="text-sm text-muted-foreground">共 {myCourses.length} 门</span>
          <div className="flex flex-wrap gap-2">
            {filters.map((item) => <button key={item.key} onClick={() => setFilter(item.key)} className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${filter === item.key ? 'bg-slate-900 text-white' : item.key === 'active' ? 'bg-blue-50 text-blue-700' : item.key === 'downloadable' ? 'bg-emerald-50 text-emerald-700' : item.key === 'failed' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'}`}>{item.label} {item.count}</button>)}
          </div>
        </div>
        <div className="relative w-full lg:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索课程" className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />
        </div>
      </div>

      {courses.length === 0 ? <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">没有匹配的课程。</p> : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="hidden grid-cols-[minmax(260px,2.5fr)_minmax(88px,1fr)_minmax(150px,1.3fr)_minmax(160px,1.3fr)_minmax(260px,1.8fr)] border-b bg-slate-50 px-5 py-3 text-xs font-medium text-slate-500 lg:grid">
            <span>课程</span><span>内容</span><span>视频</span><span>最近活动</span><span className="text-right">操作</span>
          </div>
          {courses.map((course) => {
            const job = latestVideoByCourse.get(course.id);
            const expanded = expandedId === course.id;
            const owner = course.created_by === currentUserId;
            return <div key={course.id} className="border-b border-slate-100 last:border-0">
              <div className="grid gap-4 px-5 py-4 hover:bg-slate-50/70 lg:grid-cols-[minmax(260px,2.5fr)_minmax(88px,1fr)_minmax(150px,1.3fr)_minmax(160px,1.3fr)_minmax(260px,1.8fr)] lg:items-center">
                <button onClick={() => setExpandedId(expanded ? null : course.id)} className="min-w-0 text-left">
                  <p className="truncate font-medium text-slate-900">{course.title || course.topic || '未命名课程'}</p>
                  <p className="mt-1 text-xs text-slate-400">{owner ? '我的创作' : course.author_name ? `作者：${course.author_name}` : '课程'} · 更新于 {formatDate(course.updated_at)}</p>
                </button>
                <div><span className="inline-flex rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">可编辑</span></div>
                <button onClick={() => setExpandedId(expanded ? null : course.id)} className="text-left"><VideoStatus job={job} /></button>
                <div className="text-xs text-slate-500">{formatActivity(job) ?? `更新于 ${formatDate(course.updated_at)}`}</div>
                <div className="flex min-w-0 flex-nowrap items-center gap-2 lg:justify-end">
                  {job?.status === 'succeeded' && job.downloadUrl && <button type="button" onClick={() => void downloadVideo(job)} disabled={Boolean(downloadingVideoId)} className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 text-xs font-medium text-emerald-700 transition-colors hover:border-emerald-300 hover:bg-emerald-100 disabled:cursor-wait disabled:opacity-70">{downloadingVideoId === job.id ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}{downloadingVideoId === job.id ? '正在准备下载…' : '下载'}</button>}
                  <button type="button" onClick={() => editCourse(course.id)} className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 active:bg-slate-100"><Pencil className="size-3.5 text-slate-400" />继续编辑</button>
                  <button type="button" onClick={() => openCourse(course.id)} aria-label="预览课程" title="预览课程" className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 active:bg-emerald-100"><Eye className="size-4" /></button>
                  <details className="relative shrink-0"><summary aria-label="更多操作" title="更多操作" className="flex size-8 cursor-pointer list-none items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"><MoreHorizontal className="size-4" /></summary><div className="absolute right-0 z-10 mt-2 w-32 rounded-lg border bg-white p-1 shadow-lg"><button type="button" onClick={() => shareCourse(course.id)} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-slate-50"><Share2 className="size-3.5" />{sharingId === course.id ? '复制中…' : '分享链接'}</button>{owner && <button type="button" onClick={() => removeCourse(course.id)} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs text-red-600 hover:bg-red-50"><Trash2 className="size-3.5" />删除</button>}</div></details>
                </div>
              </div>
              {expanded && <div className="grid gap-3 border-t bg-slate-50 px-5 py-4 md:grid-cols-3"><div className="rounded-lg border bg-white p-3"><p className="text-xs font-medium text-slate-400">课程内容</p><p className="mt-2 text-sm font-medium">可继续编辑</p><p className="mt-1 text-xs text-slate-500">最近更新 {formatDate(course.updated_at)}</p></div><div className="rounded-lg border bg-white p-3"><p className="text-xs font-medium text-slate-400">云端课程</p><p className="mt-2 text-sm font-medium">已保存到云端</p><p className="mt-1 text-xs text-slate-500">可分享给学员</p></div><div className="rounded-lg border bg-white p-3"><p className="text-xs font-medium text-slate-400">视频任务</p><div className="mt-2"><VideoPlan job={job} /></div></div></div>}
            </div>;
          })}
        </div>
      )}
      <p className="mt-4 text-center text-xs text-slate-400">移动端会将列表行收拢为课程摘要，保留核心操作。</p>
    </section>
  );
}
