import { supabase } from '@/lib/supabase/client';
import { db } from '@/lib/utils/database';

async function readApiJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error || '请求失败');
  }
  return data.data as T;
}
// ============================================================
// 从 IndexedDB 读取完整课程数据
// ============================================================
async function collectStageData(stageId: string) {
  const [stage, scenes, outlines] = await Promise.all([
    db.stages.get(stageId),
   db.scenes.where('stageId').equals(stageId).toArray(),
    db.stageOutlines.where('stageId').equals(stageId).toArray(),
  ]);
  if (!stage) {
    throw new Error(`课程 ${stageId} 在本地不存在`);
  }
  const stageName = stage.name.trim();
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
// 保存课程到云端
// ============================================================
export async function saveStageToCloud(stageId: string) {
  const { id, title, topic, stage, scenes, outlines } =
    await collectStageData(stageId);
  const { error } = await supabase.from('courses').upsert(
    {
      id,
      title,
      topic,
      data: { stage, scenes, outlines },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) throw error;
  return { id, title };
}
// ============================================================
// 列出云端课程
// ============================================================
export async function listCloudCourses() {
  const { data, error } = await supabase
    .from('courses')
    .select('id, title, topic, created_at, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data;
}
// ============================================================
// 下载课程到本地 IndexedDB
// ============================================================
export async function importCourseFromCloud(courseId: string) {
  const { data, error } = await supabase
    .from('courses')
    .select('id, title, data')
    .eq('id', courseId)
    .single();
  if (error) throw error;
  if (!data) throw new Error('课程不存在');
  const { stage, scenes, outlines } = data.data;
  await db.transaction('rw', db.stages, db.scenes, db.stageOutlines, async () => {
    await db.stages.put(stage);
    await db.scenes.bulkPut(scenes);
    await db.stageOutlines.bulkPut(outlines);
  });
  return { id: data.id, title: data.title };
}
// ============================================================
// 删除云端课程
// ============================================================
export async function deleteCloudCourse(courseId: string) {
  const { error } = await supabase
    .from('courses')
    .delete()
    .eq('id', courseId);
  if (error) throw error;
}

export interface StudentRecord {
  id: string;
  name: string;
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
