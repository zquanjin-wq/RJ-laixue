import { supabase } from '@/lib/supabase/client';
import { db } from '@/lib/utils/database';
import { publishSceneAudioAssets } from '@/lib/audio/audio-publish';

async function readApiJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error || '璇锋眰澶辫触');
  }
  return data.data as T;
}
// ============================================================
// 浠?IndexedDB 璇诲彇瀹屾暣璇剧▼鏁版嵁
// ============================================================
async function collectStageData(stageId: string) {
  const [stage, scenes, outlines] = await Promise.all([
    db.stages.get(stageId),
    db.scenes.where('stageId').equals(stageId).toArray(),
    db.stageOutlines.where('stageId').equals(stageId).toArray(),
  ]);

  if (!stage) {
    throw new Error(`璇剧▼ ${stageId} 鍦ㄦ湰鍦颁笉瀛樺湪`);
  }

  const stageName = stage.name?.trim?.() || '';

  return {
    id: stage.id,
    title: stageName || '未命名课程',
    topic: stageName || '',
    stage,
    scenes,
    outlines,
  };
}
// ============================================================
// 淇濆瓨璇剧▼鍒颁簯绔?
// ============================================================
export async function saveStageToCloud(stageId: string) {
  const { id, title, topic, stage, scenes, outlines } =
    await collectStageData(stageId);

 const publishResult = await publishSceneAudioAssets(stageId, scenes as any);

  if (publishResult.failed.length > 0 || publishResult.missing.length > 0) {
    const failedCount = publishResult.failed.length;
    const missingCount = publishResult.missing.length;

    const failedPreview = publishResult.failed
      .slice(0, 3)
      .map((item) => `${item.audioId}: ${item.error}`)
      .join('；');

    const missingPreview = publishResult.missing
      .slice(0, 3)
      .map((item) => `${item.audioId}: ${item.reason}`)
      .join('；');

    const detailParts = [
      failedCount > 0 ? `上传失败 ${failedCount} 条${failedPreview ? `（${failedPreview}）` : ''}` : '',
      missingCount > 0 ? `本地音频缺失 ${missingCount} 条${missingPreview ? `（${missingPreview}）` : ''}` : '',
    ].filter(Boolean);

    throw new Error(
      `保存失败：部分语音无法发布到云端。${detailParts.join('；')}。请重新生成语音后再保存。`,
    );
  }

  const scenesToSave = publishResult.scenes;

  const response = await fetch('/api/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      title,
      topic,
      data: {
        stage,
        scenes: scenesToSave,
        outlines,
      },
    }),
  });

  await readApiJson(response);

  // 保存成功后，把补齐 audioUrl 的 scenes 回写本地，避免下次重复上传
  if (scenesToSave.length > 0) {
    await db.scenes.bulkPut(scenesToSave as any);
  }

  return {
    id,
    title,
    audioPublish: {
      uploaded: publishResult.uploaded.length,
      skipped: publishResult.skipped.length,
      missing: publishResult.missing.length,
      failed: publishResult.failed.length,
    },
  };
}
// ============================================================
// 鍒楀嚭浜戠璇剧▼
// ============================================================
export async function listCloudCourses() {
  const res = await fetch('/api/courses');
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || '获取云端课程失败');
  }
  return json.data;
}
// ============================================================
// 涓嬭浇璇剧▼鍒版湰鍦?IndexedDB
// ============================================================
export async function importCourseFromCloud(courseId: string) {
  const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}`);
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || '课程不存在');
  }
  const data = json.data;
  if (!data?.data) throw new Error('课程数据不完整');
  const { stage, scenes, outlines } = data.data;
  await db.transaction('rw', db.stages, db.scenes, db.stageOutlines, async () => {
    await db.stages.put(stage);
    await db.scenes.bulkPut(scenes);
    await db.stageOutlines.bulkPut(outlines);
  });
  return { id: data.id, title: data.title };
}
// ============================================================
// 鍒犻櫎浜戠璇剧▼
// ============================================================
export async function deleteCloudCourse(courseId: string) {
  // Route through the API (which uses service_role) instead of
  // deleting directly via the anon browser client. Once RLS is
  // enabled on public.courses, the anon key can no longer DELETE.
  const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || '删除云端课程失败');
  }
}

export interface StudentRecord {
  id: string;
  name: string;
  access_code?: string | null;
  email?: string | null;
  employee_no?: string | null;
  note?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CourseAssignmentRecord {
  id: string;
  course_id: string;
  student_id: string;
  status: 'not_started' | 'in_progress' | 'completed';
  assigned_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  last_seen_at?: string | null;
  students?: {
    id: string;
    name: string;
    email?: string | null;
    employee_no?: string | null;
  } | null;
}

export async function listStudents() {
  const response = await fetch('/api/students');
  return readApiJson<StudentRecord[]>(response);
}

export async function createStudent(input: {
  name: string;
  email?: string;
  employee_no?: string;
  note?: string;
}) {
  const response = await fetch('/api/students', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readApiJson<StudentRecord>(response);
}

export async function importStudents(students: Array<{
  name: string;
  email?: string;
  employee_no?: string;
  note?: string;
}>) {
  const response = await fetch('/api/students', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ students }),
  });
  return readApiJson<StudentRecord[]>(response);
}

export async function listCourseAssignments(courseId: string) {
  const response = await fetch(`/api/courses/${courseId}/assignments`);
  return readApiJson<CourseAssignmentRecord[]>(response);
}

export async function assignCourseToStudents(courseId: string, studentIds: string[]) {
  const response = await fetch(`/api/courses/${courseId}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentIds }),
  });
  return readApiJson<CourseAssignmentRecord[]>(response);
}

export async function verifyStudentAccess(courseId: string, accessCode: string) {
  const response = await fetch('/api/learning/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseId, accessCode }),
  });
  return readApiJson<{ studentId: string; studentName: string }>(response);
}

export async function recordLearningEvent(input: {
  courseId: string;
  studentId?: string;
  eventType: 'open_course' | 'view_scene' | 'complete_course';
  sceneId?: string;
  sceneOrder?: number;
  metadata?: Record<string, unknown>;
}) {
  const response = await fetch('/api/learning/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readApiJson<{ success: true }>(response);
}



