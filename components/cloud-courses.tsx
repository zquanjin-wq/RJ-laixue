'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Eye, Loader2, MoreHorizontal, Pencil, Search, Share2, Trash2 } from 'lucide-react';
import { deleteCloudCourse, listCloudCourses, listMyCourses } from '@/lib/utils/cloud-sync';
import { useAuth } from '@/lib/auth/use-auth';

type CourseSaveState = 'draft' | 'ready' | 'failed';
type CourseFilter = 'all' | CourseSaveState;
type VideoExportStatus = 'queued' | 'rendering' | 'completed' | 'failed' | 'cancelled';

type CloudCourse = {
  id: string;
  title: string;
  topic: string | null;
  created_by: string | null;
  author_name: string | null;
  created_at: string;
  updated_at: string;
  save_state: CourseSaveState;
};

type VideoExport = {
  id: string;
  status: VideoExportStatus;
  downloadUrl: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

type VideoExportCapability = {
  available: boolean;
  code: 'VIDEO_RENDERER_NOT_CONFIGURED';
  message: string;
};

type VideoExportResponse = {
  success: boolean;
  capability?: VideoExportCapability;
  exports?: VideoExport[];
  error?: string;
};

const filters: Array<{ value: CourseFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'ready', label: '已保存' },
  { value: 'draft', label: '草稿' },
  { value: 'failed', label: '保存失败' },
];

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function latestVideoExport(exports: VideoExport[] | undefined) {
  return exports?.[0];
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function CourseStatus({ state }: { state: CourseSaveState }) {
  const status = {
    draft: { label: '草稿', className: 'border-amber-200 bg-amber-50 text-amber-700' },
    ready: { label: '已保存', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
    failed: { label: '保存失败', className: 'border-red-200 bg-red-50 text-red-700' },
  }[state];
  return <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-medium ${status.className}`}>{status.label}</span>;
}

function VideoStatus({ job, capability }: { job?: VideoExport; capability: VideoExportCapability | null }) {
  if (job?.status === 'completed') return <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700"><i className="size-2 rounded-full bg-emerald-500" />已生成</span>;
  if (job?.status === 'failed' || job?.status === 'cancelled') return <span className="inline-flex items-center gap-1.5 text-sm font-medium text-red-700"><i className="size-2 rounded-full bg-red-500" />{job.status === 'failed' ? '生成失败' : '已取消'}</span>;
  if (job) return <span className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700"><i className="size-2 animate-pulse rounded-full bg-blue-500" />{job.status === 'queued' ? '等待生成' : '生成中'}</span>;
  if (capability && !capability.available) return <span title={capability.message} className="inline-flex items-center gap-1.5 text-sm text-slate-500"><i className="size-2 rounded-full bg-slate-300" />未配置</span>;
  return <span className="text-sm text-slate-400">未生成</span>;
}

function videoActivity(job: VideoExport | undefined, capability: VideoExportCapability | null) {
  if (job) return job.status === 'failed' && job.failureReason ? job.failureReason : `视频${formatDate(job.updatedAt)}`;
  return capability && !capability.available ? '视频渲染服务未配置' : '尚无视频任务';
}

async function loadVideoExports(courseId: string) {
  const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/video-exports`, { cache: 'no-store' });
  const payload = (await response.json().catch(() => null)) as VideoExportResponse | null;
  if (!response.ok || !payload?.success) throw new Error(payload?.error || '获取视频任务失败');
  return { capability: payload.capability ?? null, exports: payload.exports ?? [] };
}

export default function CloudCourses() {
  const { user, profile, loading: authLoading } = useAuth();
  const [courses, setCourses] = useState<CloudCourse[]>([]);
  const [videoExports, setVideoExports] = useState<Record<string, VideoExport[]>>({});
  const [videoCapability, setVideoCapability] = useState<VideoExportCapability | null>(null);
  const [filter, setFilter] = useState<CourseFilter>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchCourses = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    setError(null);
    try {
      const rows = profile.role === 'admin' ? await listCloudCourses() : await listMyCourses();
      const videoResults = await Promise.all(rows.map((course) => loadVideoExports(course.id)));
      setCourses(rows);
      setVideoExports(Object.fromEntries(rows.map((course, index) => [course.id, videoResults[index].exports])));
      setVideoCapability(videoResults.map((result) => result.capability).find((capability) => capability !== null) ?? null);
    } catch (fetchError) {
      setError(getErrorMessage(fetchError, '获取云端课程失败。'));
    } finally {
      setLoading(false);
    }
  }, [profile]);

  useEffect(() => { void fetchCourses(); }, [fetchCourses]);

  const hasActiveVideoExport = useMemo(
    () => Object.values(videoExports).flat().some((job) => job.status === 'queued' || job.status === 'rendering'),
    [videoExports],
  );

  useEffect(() => {
    if (!hasActiveVideoExport) return;
    const timer = window.setInterval(() => void fetchCourses(), 10_000);
    return () => window.clearInterval(timer);
  }, [fetchCourses, hasActiveVideoExport]);

  const counts = useMemo(() => ({
    all: courses.length,
    ready: courses.filter((course) => course.save_state === 'ready').length,
    draft: courses.filter((course) => course.save_state === 'draft').length,
    failed: courses.filter((course) => course.save_state === 'failed').length,
  }), [courses]);

  const visibleCourses = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return courses.filter((course) => {
      const matchesFilter = filter === 'all' || course.save_state === filter;
      const matchesQuery = !normalizedQuery || [course.title, course.topic, course.author_name]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
      return matchesFilter && matchesQuery;
    });
  }, [courses, filter, query]);

  const shareCourse = async (courseId: string) => {
    setSharingId(courseId);
    try {
      const url = `${window.location.origin}/classroom/${courseId}?share=1`;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        window.alert('课程分享链接已复制。');
      } else {
        window.prompt('复制课程分享链接', url);
      }
    } catch (shareError) {
      window.alert(getErrorMessage(shareError, '分享链接复制失败。'));
    } finally {
      setSharingId(null);
      setActionMenuId(null);
    }
  };

  const removeCourse = async (courseId: string) => {
    if (!window.confirm('确定删除这门课程吗？此操作不可撤销。')) return;
    try {
      await deleteCloudCourse(courseId);
      setCourses((previous) => previous.filter((course) => course.id !== courseId));
      setVideoExports((previous) => {
        const next = { ...previous };
        delete next[courseId];
        return next;
      });
    } catch (deleteError) {
      window.alert(getErrorMessage(deleteError, '删除课程失败。'));
    } finally {
      setActionMenuId(null);
    }
  };

  if (authLoading || loading) return <div className="mt-8 flex justify-center py-12 text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />正在加载课程…</div>;
  if (error) return <div className="mt-8 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">课程暂不可用：{error}</div>;

  const isAdmin = profile?.role === 'admin';
  const sectionTitle = isAdmin ? '全部课程' : '我的课程';

  return (
    <section className="mt-8">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-semibold tracking-tight">{sectionTitle}</h2>
          <span className="text-sm text-muted-foreground">共 {courses.length} 门</span>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="课程保存状态筛选">
            {filters.map((item) => <button key={item.value} type="button" role="tab" aria-selected={filter === item.value} onClick={() => setFilter(item.value)} className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${filter === item.value ? 'bg-slate-900 text-white' : item.value === 'ready' ? 'bg-emerald-50 text-emerald-700' : item.value === 'draft' ? 'bg-amber-50 text-amber-700' : item.value === 'failed' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'}`}>{item.label} {counts[item.value]}</button>)}
          </div>
        </div>
        <label className="relative w-full lg:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索课程名称或主题" className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />
        </label>
      </div>

      {visibleCourses.length === 0 ? <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-12 text-center"><p className="text-sm font-medium text-slate-700">{courses.length === 0 ? '还没有保存到云端的课程' : '没有匹配的课程'}</p><p className="mt-2 text-sm text-slate-500">{courses.length === 0 ? '创建课程后保存到云端，即可在这里集中管理。' : '请调整搜索关键词或筛选条件后重试。'}</p>{courses.length === 0 && <Link href="/studio" className="mt-4 inline-flex h-9 items-center rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white transition-colors hover:bg-emerald-700">AI 创建课程</Link>}</div> : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="hidden grid-cols-[minmax(230px,2.2fr)_minmax(88px,0.8fr)_minmax(130px,1fr)_minmax(160px,1.2fr)_minmax(220px,1.6fr)] border-b bg-slate-50 px-5 py-3 text-xs font-medium text-slate-500 lg:grid"><span>课程</span><span>课程状态</span><span>视频状态</span><span>最近活动</span><span className="text-right">操作</span></div>
          {visibleCourses.map((course) => {
            const job = latestVideoExport(videoExports[course.id]);
            const expanded = expandedId === course.id;
            const isOwner = course.created_by === user?.id;
            const canManage = isOwner || isAdmin;
            const activity = videoActivity(job, videoCapability);
            return <div key={course.id} className="border-b border-slate-100 last:border-0">
              <div className="grid gap-4 px-5 py-4 hover:bg-slate-50/70 lg:grid-cols-[minmax(230px,2.2fr)_minmax(88px,0.8fr)_minmax(130px,1fr)_minmax(160px,1.2fr)_minmax(220px,1.6fr)] lg:items-center">
                <button type="button" onClick={() => setExpandedId(expanded ? null : course.id)} className="min-w-0 text-left"><p className="truncate font-medium text-slate-900">{course.title || course.topic || '未命名课程'}</p><p className="mt-1 truncate text-xs text-slate-400">{isAdmin && course.author_name ? `作者：${course.author_name} · ` : ''}更新于 {formatDate(course.updated_at)}</p></button>
                <div><CourseStatus state={course.save_state} /></div>
                <button type="button" onClick={() => setExpandedId(expanded ? null : course.id)} className="text-left"><VideoStatus job={job} capability={videoCapability} /></button>
                <div className="truncate text-xs text-slate-500" title={activity}>{activity}</div>
                <div className="flex min-w-0 flex-nowrap items-center gap-2 lg:justify-end">
                  {job?.status === 'completed' && job.downloadUrl && <a href={job.downloadUrl} className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 text-xs font-medium text-emerald-700 transition-colors hover:border-emerald-300 hover:bg-emerald-100"><Download className="size-3.5" />下载</a>}
                  <button type="button" onClick={() => window.open(`/classroom/${course.id}?view=1`, '_blank', 'noopener,noreferrer')} aria-label="预览课程" title="预览课程" className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700"><Eye className="size-4" /></button>
                  {canManage && <button type="button" onClick={() => window.open(`/classroom/${course.id}?editor=1`, '_blank', 'noopener,noreferrer')} className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50"><Pencil className="size-3.5 text-slate-400" />继续编辑</button>}
                  <div className="relative shrink-0"><button type="button" onClick={() => setActionMenuId((current) => current === course.id ? null : course.id)} aria-label="更多操作" title="更多操作" className="inline-flex size-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"><MoreHorizontal className="size-4" /></button>{actionMenuId === course.id && <div className="absolute right-0 z-10 mt-2 w-32 rounded-lg border bg-white p-1 shadow-lg"><button type="button" onClick={() => void shareCourse(course.id)} disabled={sharingId === course.id} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-slate-50 disabled:opacity-50"><Share2 className="size-3.5" />{sharingId === course.id ? '复制中…' : '分享链接'}</button>{canManage && <button type="button" onClick={() => void removeCourse(course.id)} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs text-red-600 hover:bg-red-50"><Trash2 className="size-3.5" />删除</button>}</div>}</div>
                </div>
              </div>
              {expanded && <div className="grid gap-3 border-t bg-slate-50 px-5 py-4 md:grid-cols-3"><div className="rounded-lg border bg-white p-3"><p className="text-xs font-medium text-slate-400">课程主题</p><p className="mt-2 text-sm font-medium text-slate-800">{course.topic || '未填写课程主题'}</p></div><div className="rounded-lg border bg-white p-3"><p className="text-xs font-medium text-slate-400">云端保存</p><p className="mt-2 text-sm font-medium text-slate-800">{course.save_state === 'ready' ? '已保存到云端' : course.save_state === 'draft' ? '草稿待保存' : '保存需要重试'}</p><p className="mt-1 text-xs text-slate-500">课程资产由云端资产库统一管理</p></div><div className="rounded-lg border bg-white p-3"><p className="text-xs font-medium text-slate-400">视频任务</p><div className="mt-2"><VideoStatus job={job} capability={videoCapability} /></div><p className="mt-1 text-xs text-slate-500">{activity}</p></div></div>}
            </div>;
          })}
        </div>
      )}
      <p className="mt-4 text-center text-xs text-slate-400">移动端会将课程行收拢为摘要，桌面端保留完整管理操作。</p>
    </section>
  );
}
