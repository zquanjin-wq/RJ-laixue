'use client';
import { useState, useEffect, useCallback } from 'react';
import { listCloudCourses, listMyCourses, deleteCloudCourse } from '@/lib/utils/cloud-sync';
import { useAuth } from '@/lib/auth/use-auth';

interface CloudCourse {
  id: string;
  title: string;
  topic: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

interface CourseCardProps {
  course: CloudCourse;
  isOwner: boolean;
  currentUserId: string | null;
  sharingId: string | null;
  /** Which list this card belongs to — drives tag text and share button copy. */
  section: 'mine' | 'library';
  onOpen: (id: string) => void;
  onShare: (id: string) => void;
  onDelete: (id: string) => void;
}

function CourseCard({
  course,
  isOwner,
  currentUserId,
  sharingId,
  section, // 'mine' | 'library' — picks tag text + button labels per section
  onOpen,
  onShare,
  onDelete,
}: CourseCardProps) {
  // Per-section labels. The "open" verb used to be ambiguous between a
  // teacher's own course and a public library entry — make the verb match
  // the section's semantics.
  const openLabel = '预览';
  const editLabel = '继续编辑';
  const shareLabel = section === 'mine' ? '分享学员链接' : '分享课程';
  const tagLabel = section === 'mine' ? '我的创作' : '资源库';
  const tagClass =
    section === 'mine'
      ? 'shrink-0 inline-flex items-center rounded-full bg-violet-100 dark:bg-violet-900/30 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300'
      : 'shrink-0 inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:text-slate-300';

  return (
    <div className="rounded-lg border p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium truncate flex-1 min-w-0">
          {course.title || course.topic || '未命名课程'}
        </h3>
        <span className={tagClass}>{tagLabel}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        更新于 {new Date(course.updated_at).toLocaleDateString('zh-CN')}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => onOpen(course.id)}
          className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:opacity-90"
        >
          {openLabel}
        </button>
        {isOwner && (
          <button
            onClick={() =>
              window.open(`/classroom/${course.id}?editor=1`, '_blank')
            }
            className="rounded bg-secondary px-3 py-1 text-xs text-secondary-foreground hover:opacity-90"
          >
            ✎ {editLabel}
          </button>
        )}
        <button
          onClick={() => onShare(course.id)}
          disabled={sharingId === course.id}
          className="rounded border px-3 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {sharingId === course.id ? '复制中…' : shareLabel}
        </button>
        {isOwner && (
          <button
            onClick={() => onDelete(course.id)}
            className="rounded border px-3 py-1 text-xs text-muted-foreground hover:text-destructive"
          >
            🗑 删除
          </button>
        )}
      </div>
    </div>
  );
}

export default function CloudCourses() {
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;

  const [myCourses, setMyCourses] = useState<CloudCourse[]>([]);
  const [allCourses, setAllCourses] = useState<CloudCourse[]>([]);
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
      const [mine, all] = await Promise.all([
        listMyCourses().catch(() => []),
        listCloudCourses().catch(() => []),
      ]);
      setMyCourses(mine);
      setAllCourses(all);
    } catch (e: unknown) {
      setError(getErrorMessage(e, '获取云端课程失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCourses();
  }, [fetchCourses]);

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
      setAllCourses((prev) => prev.filter((c) => c.id !== courseId));
    } catch (e: unknown) {
      alert('删除失败：' + getErrorMessage(e, '未知错误'));
    }
  };

  if (loading) {
    return (
      <div className="mt-8 text-center text-sm text-muted-foreground">
        ☁️ 正在加载课程...
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-8 text-center text-sm text-muted-foreground">
        ☁️ 课程暂不可用（{error}）
      </div>
    );
  }

  // Discover section: courses NOT created by me (or all if user is null).
  const discoverCourses = currentUserId
    ? allCourses.filter((c) => c.created_by !== currentUserId)
    : allCourses;

  return (
    <div className="mt-8 space-y-10">
      {/* 我的创作 — courses I created (or have edit rights to). Edit + Delete only here. */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">📚 我的创作</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          你创建或可以编辑的课程
        </p>
        {myCourses.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            你还没有创建过课程。生成课件后点击「保存到云端」即可在这里看到。
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {myCourses.map((course) => (
              <CourseCard
                key={course.id}
                course={course}
                isOwner={true}
                currentUserId={currentUserId}
                sharingId={sharingId}
                section="mine"
                onOpen={handleOpen}
                onShare={handleShare}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </section>

      {/* 课程资源库 — public courses created by others (replaces "云端课程（发现）"). */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">🌐 课程资源库</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          发现可预览或复用的公开课程
        </p>
        {discoverCourses.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            资源库暂无其他老师分享的课程。
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {discoverCourses.map((course) => (
              <CourseCard
                key={course.id}
                course={course}
                isOwner={false}
                currentUserId={currentUserId}
                sharingId={sharingId}
                section="library"
                onOpen={handleOpen}
                onShare={handleShare}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </section>

      {shareMessage && !sharingId && (
        <p className="mt-4 text-sm text-muted-foreground text-center">
          {shareMessage}
        </p>
      )}
    </div>
  );
}