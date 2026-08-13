import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import { generateTTS } from '@/lib/audio/tts-providers';
import type { TTSProviderId } from '@/lib/audio/types';
import { COURSE_ASSET_BUCKET } from '@/lib/course-assets/shared';
import {
  isServerConfiguredProvider,
  isServerTTSProviderDisabled,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
} from '@/lib/server/provider-config';
import { getServiceSupabase } from '@/lib/supabase/server';
import type { StageTeacherVoiceConfig } from '@/lib/teacher/apply-teacher-voice';

export type CourseRevoiceStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'conflict';
type Json = Record<string, unknown>;
type RevoiceItem = {
  sceneId: string;
  actionId: string;
  text: string;
  status: 'queued' | 'done' | 'failed';
  audioId?: string;
  audioUrl?: string;
  error?: string;
};
export type CourseRevoiceJob = {
  id: string;
  course_id: string;
  requested_by: string;
  status: CourseRevoiceStatus;
  voice: StageTeacherVoiceConfig;
  snapshot: { stage: Json; scenes: Json[]; outlines: unknown[] };
  source_updated_at: string;
  items: RevoiceItem[];
  total_items: number;
  completed_items: number;
  failed_items: number;
  message: string;
  error?: string | null;
  created_at: string;
  updated_at: string;
};

// Keep a full run below the shared MiniMax default of 15 requests/minute.
// A one-minute lease after each batch prevents the cron runner and the initial
// request from together exceeding that provider quota.
const WORK_BATCH_SIZE = 12;
const WORK_CONCURRENCY = 3;

function speechItems(scenes: Json[]): RevoiceItem[] {
  return scenes.flatMap((scene) => {
    const sceneId = typeof scene.id === 'string' ? scene.id : '';
    const actions = Array.isArray(scene.actions) ? (scene.actions as Json[]) : [];
    return actions.flatMap((action, index) => {
      if (
        action.type !== 'speech' ||
        typeof action.text !== 'string' ||
        !action.text.trim() ||
        !sceneId
      )
        return [];
      return [
        {
          sceneId,
          actionId: typeof action.id === 'string' ? action.id : `${sceneId}-${index}`,
          text: action.text.trim(),
          status: 'queued' as const,
        },
      ];
    });
  });
}

function normalizeProviderId(providerId: string) {
  return providerId.endsWith('-tts') ? providerId : `${providerId}-tts`;
}

export async function createCourseRevoiceJob(input: {
  courseId: string;
  userId: string;
  voice: StageTeacherVoiceConfig;
  snapshot: CourseRevoiceJob['snapshot'];
  sourceUpdatedAt: string;
}) {
  const providerId = normalizeProviderId(input.voice.providerId);
  if (
    providerId === 'browser-native-tts' ||
    !isServerConfiguredProvider('tts', providerId) ||
    isServerTTSProviderDisabled(providerId)
  ) {
    throw new Error(
      '该音色不是服务器托管音色，暂不支持离开页面后继续生成。请选择平台提供的 AI 音色。',
    );
  }
  const items = speechItems(input.snapshot.scenes);
  if (!items.length) throw new Error('课程中没有可重新生成的讲解配音。');
  // One course can only have one active replacement. This is enforced on the
  // server as well as in the UI so double-clicks and multiple tabs cannot
  // create competing jobs that race to overwrite the course.
  const service = getServiceSupabase();
  const { data: active, error: activeError } = await service
    .from('course_revoice_jobs')
    .select('*')
    .eq('course_id', input.courseId)
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeError) throw activeError;
  if (active) return active as CourseRevoiceJob;
  const job = {
    id: nanoid(16),
    course_id: input.courseId,
    requested_by: input.userId,
    status: 'queued' as const,
    voice: { ...input.voice, providerId },
    snapshot: input.snapshot,
    source_updated_at: input.sourceUpdatedAt,
    items,
    total_items: items.length,
    completed_items: 0,
    failed_items: 0,
    message: '已加入重新配音队列',
  };
  const { error } = await service.from('course_revoice_jobs').insert(job);
  if (error) throw new Error(`创建重新配音任务失败：${error.message}`);
  return job;
}

export async function getCourseRevoiceJob(jobId: string, userId: string) {
  const { data, error } = await getServiceSupabase()
    .from('course_revoice_jobs')
    .select('*')
    .eq('id', jobId)
    .eq('requested_by', userId)
    .maybeSingle();
  if (error) throw error;
  return data as CourseRevoiceJob | null;
}

export async function cancelCourseRevoiceJob(jobId: string, userId: string) {
  const { data, error } = await getServiceSupabase()
    .from('course_revoice_jobs')
    .update({
      status: 'cancelled',
      message: '已取消，课程继续使用原音色',
      completed_at: new Date().toISOString(),
      locked_until: null,
    })
    .eq('id', jobId)
    .eq('requested_by', userId)
    .in('status', ['queued', 'running'])
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data as CourseRevoiceJob | null;
}

async function uploadAudio(
  courseId: string,
  jobId: string,
  item: RevoiceItem,
  bytes: Uint8Array,
  format: string,
) {
  const ext = format === 'mpeg' ? 'mp3' : (format || 'mp3').replace(/^\./, '');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const path = `courses/${courseId}/audio/revoice/${jobId}/${hash}.${ext}`;
  const service = getServiceSupabase();
  const { error } = await service.storage.from(COURSE_ASSET_BUCKET).upload(path, bytes, {
    upsert: true,
    contentType: ext === 'mp3' ? 'audio/mpeg' : `audio/${ext}`,
  });
  if (error) throw new Error(`上传配音失败：${error.message}`);
  return {
    audioId: `voice_${jobId}_${item.sceneId.slice(0, 8)}_${item.actionId.slice(0, 8)}`,
    audioUrl: service.storage.from(COURSE_ASSET_BUCKET).getPublicUrl(path).data.publicUrl,
  };
}

async function synthesize(job: CourseRevoiceJob, item: RevoiceItem) {
  const providerId = normalizeProviderId(job.voice.providerId);
  const result = await generateTTS(
    {
      providerId: providerId as TTSProviderId,
      modelId: resolveTTSModel(providerId, job.voice.modelId),
      voice: job.voice.voiceId,
      speed: 1,
      apiKey: resolveTTSApiKey(providerId),
      baseUrl: resolveTTSBaseUrl(providerId),
    },
    item.text,
  );
  return uploadAudio(job.course_id, job.id, item, result.audio, result.format);
}

function applyResults(snapshot: CourseRevoiceJob['snapshot'], items: RevoiceItem[]) {
  const byAction = new Map(
    items
      .filter((item) => item.status === 'done')
      .map((item) => [`${item.sceneId}:${item.actionId}`, item]),
  );
  const scenes = snapshot.scenes.map((scene) => ({
    ...scene,
    actions: (Array.isArray(scene.actions) ? (scene.actions as Json[]) : []).map(
      (action, index) => {
        const key = `${scene.id}:${typeof action.id === 'string' ? action.id : `${scene.id}-${index}`}`;
        const item = byAction.get(key);
        return item ? { ...action, audioId: item.audioId, audioUrl: item.audioUrl } : action;
      },
    ),
  }));
  return {
    stage: { ...snapshot.stage, teacherVoiceConfig: snapshot.stage.teacherVoiceConfig },
    scenes,
  };
}

export async function runCourseRevoiceJob(jobId: string) {
  const service = getServiceSupabase();
  const { data: claimed, error: claimError } = await service.rpc('claim_course_revoice_job', {
    p_job_id: jobId,
  });
  if (claimError) throw claimError;
  const job = (claimed?.[0] ?? null) as CourseRevoiceJob | null;
  if (!job) return null;
  const pending = job.items.filter((item) => item.status === 'queued').slice(0, WORK_BATCH_SIZE);
  const nextItems = [...job.items];
  for (let offset = 0; offset < pending.length; offset += WORK_CONCURRENCY) {
    const group = pending.slice(offset, offset + WORK_CONCURRENCY);
    await Promise.all(
      group.map(async (item) => {
        const index = nextItems.findIndex(
          (candidate) => candidate.sceneId === item.sceneId && candidate.actionId === item.actionId,
        );
        try {
          const audio = await synthesize(job, item);
          nextItems[index] = { ...item, ...audio, status: 'done' };
        } catch (error) {
          nextItems[index] = {
            ...item,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }
  const completed = nextItems.filter((item) => item.status === 'done').length;
  const failed = nextItems.filter((item) => item.status === 'failed').length;
  const remaining = nextItems.filter((item) => item.status === 'queued').length;
  if (failed) {
    await service
      .from('course_revoice_jobs')
      .update({
        items: nextItems,
        completed_items: completed,
        failed_items: failed,
        status: 'failed',
        error: nextItems.find((item) => item.status === 'failed')?.error,
        message: '重新配音失败，课程仍使用原音色',
        completed_at: new Date().toISOString(),
        locked_until: null,
      })
      .eq('id', job.id)
      .eq('status', 'running');
    return { ...job, status: 'failed' as const };
  }
  if (remaining) {
    await service
      .from('course_revoice_jobs')
      .update({
        items: nextItems,
        completed_items: completed,
        message: `正在生成配音 ${completed}/${job.total_items}`,
        locked_until: new Date(Date.now() + 60_000).toISOString(),
      })
      .eq('id', job.id)
      .eq('status', 'running');
    return { ...job, items: nextItems, completed_items: completed };
  }
  const final = applyResults(
    { ...job.snapshot, stage: { ...job.snapshot.stage, teacherVoiceConfig: job.voice } },
    nextItems,
  );
  const { data: updated, error: updateError } = await service
    .from('courses')
    .update({
      data: {
        stage: final.stage,
        scenes: final.scenes,
        outlines: job.snapshot.outlines,
        saveState: 'ready',
        audioGeneration: {
          attempted: true,
          completedAt: new Date().toISOString(),
          source: 'server-revoice-job',
        },
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.course_id)
    .eq('updated_at', job.source_updated_at)
    .select('id')
    .maybeSingle();
  if (updateError) throw updateError;
  const conflict = !updated;
  await service
    .from('course_revoice_jobs')
    .update({
      items: nextItems,
      completed_items: completed,
      status: conflict ? 'conflict' : 'succeeded',
      message: conflict ? '课程在生成期间已被编辑，未覆盖新内容' : '重新配音已完成并保存到云端',
      completed_at: new Date().toISOString(),
      locked_until: null,
    })
    .eq('id', job.id)
    .eq('status', 'running');
  return { ...job, status: conflict ? ('conflict' as const) : ('succeeded' as const) };
}

export async function runNextCourseRevoiceJob() {
  const { data, error } = await getServiceSupabase()
    .from('course_revoice_jobs')
    .select('id')
    .in('status', ['queued', 'running'])
    .or('locked_until.is.null,locked_until.lt.' + new Date().toISOString())
    .order('created_at')
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? runCourseRevoiceJob(data.id) : null;
}
