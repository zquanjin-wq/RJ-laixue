'use client';
import { useState, useEffect, useCallback } from 'react';
import { listCloudCourses, deleteCloudCourse } from '@/lib/utils/cloud-sync';
interface CloudCourse {
  id: string;
  title: string;
  topic: string;
  created_at: string;
  updated_at: string;
}
function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
export default function CloudCourses() {
  const [courses, setCourses] = useState<CloudCourse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const fetchCourses = useCallback(async () => {
    try {
      setError('');
      const data = await listCloudCourses();
      setCourses(data);
    } catch (e: unknown) {
      setError(getErrorMessage(e, '获取云端课程失败'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    fetchCourses();
  }, [fetchCourses]);
  const handleDelete = async (courseId: string) => {
    if (!confirm('确定要从云端删除这门课程吗？')) return;
    try {
      await deleteCloudCourse(courseId);
      setCourses((prev) => prev.filter((c) => c.id !== courseId));
    } catch (e: unknown) {
      alert('删除失败：' + getErrorMessage(e, '未知错误'));
    }
  };
  if (loading) {
    return (
      <div className="mt-8 text-center text-sm text-muted-foreground">
        ☁️ 正在加载云端课程...
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-8 text-center text-sm text-muted-foreground">
        ☁️ 云端课程暂不可用（{error}）
      </div>
    );
  }
  if (courses.length === 0) {
    return (
      <div className="mt-8 text-center text-sm text-muted-foreground">
        ☁️ 云端暂无课程，创建课程后点击「保存到云端」即可
      </div>
    );
  }
  return (
    <div className="mt-8">
      <h2 className="mb-4 text-lg font-semibold">☁️ 云端课程</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {courses.map((course) => (
          <div
            key={course.id}
            className="rounded-lg border p-4 hover:shadow-md transition-shadow"
          >
            <h3 className="font-medium truncate">
              {course.title || course.topic || '未命名课程'}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              更新于 {new Date(course.updated_at).toLocaleDateString('zh-CN')}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => window.open(`/classroom/${course.id}`, '_blank')}
                className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:opacity-90"
              >
                打开
              </button>
              <button
                onClick={() => handleDelete(course.id)}
                className="rounded border px-3 py-1 text-xs text-muted-foreground hover:text-destructive"
              >
                🗑 删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

