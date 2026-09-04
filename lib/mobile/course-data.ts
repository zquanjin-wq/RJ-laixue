import type { Scene } from '@/lib/types/stage';
import { getDatabasePool } from '@/lib/server/db/pool';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { loadTaskSnapshot } from '@/lib/server/learning-tasks/snapshot-loader';

export interface MobileCourse {
  id: string;
  title: string;
  topic: string;
  created_at: string;
  updated_at: string;
  data: {
    stage: unknown;
    scenes: Scene[];
    outlines: unknown[];
    audioGeneration?: unknown;
  };
  teacherVoiceConfig?: {
    providerId: string;
    voiceId: string;
    modelId?: string;
  };
}

export async function loadMobileCourse(
  userId: string,
  courseId: string,
  taskId?: string,
): Promise<MobileCourse | null> {
  if (taskId) {
    const result = await loadTaskSnapshot(userId, taskId, courseId);
    if (!result.ok) return null;
    const stage = result.data.stage as Record<string, unknown> | undefined;
    const teacherVoiceConfig = stage?.teacherVoiceConfig as MobileCourse['teacherVoiceConfig'];
    return {
      id: courseId,
      title: (stage?.name as string) || '未命名课件',
      topic: (stage?.topic as string) || '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      data: {
        stage: result.data.stage,
        scenes: result.data.scenes as Scene[],
        outlines: result.data.outlines,
      },
      teacherVoiceConfig,
    };
  }

  const course = await new CourseRepository(getDatabasePool()).getCourse(courseId);
  if (!course) return null;
  const data = (course.content ?? {}) as MobileCourse['data'];
  const stage = data.stage as Record<string, unknown> | undefined;
  return {
    id: course.id,
    title: course.title || '未命名课件',
    topic: course.topic || '',
    created_at: course.createdAt.toISOString(),
    updated_at: course.updatedAt.toISOString(),
    data: {
      stage: data.stage,
      scenes: Array.isArray(data.scenes) ? data.scenes : [],
      outlines: Array.isArray(data.outlines) ? data.outlines : [],
      audioGeneration: data.audioGeneration,
    },
    teacherVoiceConfig: stage?.teacherVoiceConfig as MobileCourse['teacherVoiceConfig'],
  };
}
