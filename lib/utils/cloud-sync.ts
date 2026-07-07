import { supabase } from '@/lib/supabase/client';
import { db } from '@/lib/utils/database';
// ============================================================
// 从 IndexedDB 读取完整课程数据
// ============================================================
async function collectStageData(stageId: string) {
  const [stage, scenes, outlines] = await Promise.all([
    db.stages.get(stageId),
    db.stageScenes.where('stageId').equals(stageId).toArray(),
    db.stageOutlines.where('stageId').equals(stageId).toArray(),
  ]);
  if (!stage) {
    throw new Error(`课程 ${stageId} 在本地不存在`);
  }
  return {
    id: stage.id,
    title: (stage as any).title || (stage as any).topic || '',
    topic: (stage as any).topic || '',
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
  await db.transaction('rw', db.stages, db.stageScenes, db.stageOutlines, async () => {
    await db.stages.put(stage);
    await db.stageScenes.bulkPut(scenes);
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
