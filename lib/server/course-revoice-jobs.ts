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
import { fingerprintSpeechVoice, speechVoiceMatches } from '@/lib/audio/voice-fingerprint';

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
  /** Number of exhausted provider retry cycles. Kept with the durable job. */
  attempts?: number;
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

export function isRevoiceNoopError(error: unknown): boolean {
  return error instanceof Error && error.message === '所有讲解配音已符合所选音色，无需重新生成。';
}

// Keep a full run below the shared MiniMax default of 15 requests/minute.
// A one-minute lease after each batch prevents the cron runner and the initial
// request from together exceeding that provider quota.
const WORK_BATCH_SIZE = 12;
const WORK_CONCURRENCY = 3;
const MAX_ITEM_ATTEMPTS = 3;

function speechItems(scenes: Json[], targetVoice: StageTeacherVoiceConfig): RevoiceItem[] {
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
      // A missing fingerprint is deliberately treated as untrusted. This makes
      // the first revoice of historical/imported content establish a reliable
      // baseline; every later voice change touches only changed lines.
      if (speechVoiceMatches(action.audioVoiceFingerprint, action.text, targetVoice)) return [];
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

export function assertServerRevoiceVoice(voice: StageTeacherVoiceConfig) {
  const providerId = normalizeProviderId(voice.providerId);
  if (
    providerId === 'browser-native-tts' ||
    !isServerConfiguredProvider('tts', providerId) ||
    isServerTTSProviderDisabled(providerId)
  ) {
    throw new Error(
      '该音色不是服务器托管音色，暂不支持整课后台生成。请选择平台提供的 AI 音色。',
    );
  }
  return { ...voice, providerId };
}

export async function createCourseRevoiceJob(input: {
  courseId: string;
  userId: string;
  voice: StageTeacherVoiceConfig;
  snapshot: CourseRevoiceJob['snapshot'];
  sourceUpdatedAt: string;
}) {
  const voice = assertServerRevoiceVoice(input.voice);
  const items = speechItems(input.snapshot.scenes, voice);
  if (!items.length) throw new Error('所有讲解配音已符合所选音色，无需重新生成。');
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
    voice,
    snapshot: input.snapshot,
    source_updated_at: input.sourceUpdatedAt,
    items,
    total_items: items.length,
    completed_items: 0,
    failed_items: 0,
    message: '已加入重新配音队列',
  };
  const { error } = await service.from('course_revoice_jobs').insert(job);
  if (error?.code === '23505') {
    const { data: concurrent } = await service
      .from('course_revoice_jobs')
      .select('*')
      .eq('course_id', input.courseId)
      .in('status', ['queued', 'running'])
      .maybeSingle();
    if (concurrent) return concurrent as CourseRevoiceJob;
  }
  if (error) throw new Error(`创建重新配音任务失败：${error.message}`);
  return job;
}

/**
 * Loads a job by id. Authorization belongs to the course route: a course
 * owner/admin may inspect the course's active job even when another editor
 * originally started it.
 */
export async function getCourseRevoiceJob(jobId: string) {
  const { data, error } = await getServiceSupabase()
    .from('course_revoice_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw error;
  return data as CourseRevoiceJob | null;
}

/** Cancellation is authorized by the course route before this mutation runs. */
export async function cancelCourseRevoiceJob(jobId: string) {
  const { data, error } = await getServiceSupabase()
    .from('course_revoice_jobs')
    .update({
      status: 'cancelled',
      message: '已取消，课程继续使用原音色',
      completed_at: new Date().toISOString(),
      locked_until: null,
    })
    .eq('id', jobId)
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

async function synthesizeWithRetry(job: CourseRevoiceJob, item: RevoiceItem) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await synthesize(job, item);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
}

/**
 * Applies generated clips to the most recently saved course snapshot.
 *
 * A revoice job can run for minutes. Replacing the job's original snapshot at
 * the end would discard ordinary edits made while it was running. Match by
 * scene/action id *and* the original speech text, so an edited line keeps its
 * newer text and audio instead of receiving a clip for stale words.
 */
export function mergeRevoiceResults(
  snapshot: CourseRevoiceJob['snapshot'],
  items: RevoiceItem[],
  voice: StageTeacherVoiceConfig,
) {
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
        return item && action.type === 'speech' && action.text === item.text
          ? {
              ...action,
              audioId: item.audioId,
              audioUrl: item.audioUrl,
              audioVoiceFingerprint: fingerprintSpeechVoice(item.text, voice),
            }
          : action;
      },
    ),
  }));
  return {
    stage: { ...snapshot.stage, teacherVoiceConfig: voice },
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
          const audio = await synthesizeWithRetry(job, item);
          nextItems[index] = { ...item, ...audio, status: 'done' };
        } catch (error) {
          const attempts = (item.attempts ?? 0) + 1;
          nextItems[index] = {
            ...item,
            // A transient provider/network failure must not discard an entire
            // course. Keep this item queued for a later lease; a genuinely
            // bad item still fails decisively after a bounded number of cycles.
            status: attempts >= MAX_ITEM_ATTEMPTS ? 'failed' : 'queued',
            attempts,
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
    const retrying = nextItems.filter((item) => item.status === 'queued' && item.attempts).length;
    await service
      .from('course_revoice_jobs')
      .update({
        items: nextItems,
        completed_items: completed,
        message: retrying
          ? `正在重试配音 ${completed}/${job.total_items}`
          : `正在生成配音 ${completed}/${job.total_items}`,
        locked_until: new Date(Date.now() + 60_000).toISOString(),
      })
      .eq('id', job.id)
      .eq('status', 'running');
    return { ...job, items: nextItems, completed_items: completed };
  }
  // Re-read immediately before commit. A normal course save while the job ran
  // is not a reason to throw its changes away: merge only generated clips into
  // that latest snapshot, then use its version for the final CAS commit.
  const { data: currentCourse, error: currentCourseError } = await service
    .from('courses')
    .select('data, updated_at')
    .eq('id', job.course_id)
    .maybeSingle();
  if (currentCourseError) throw currentCourseError;
  if (!currentCourse) throw new Error('课程在重新配音期间已被删除');
  const currentData = currentCourse.data as Partial<CourseRevoiceJob['snapshot']>;
  if (!currentData.stage || !Array.isArray(currentData.scenes))
    throw new Error('课程内容不完整，无法合并重新配音结果');
  const final = mergeRevoiceResults(
    {
      stage: currentData.stage,
      scenes: currentData.scenes,
      outlines: Array.isArray(currentData.outlines) ? currentData.outlines : [],
    },
    nextItems,
    job.voice,
  );
  const courseData = {
    stage: final.stage,
    scenes: final.scenes,
    outlines: Array.isArray(currentData.outlines) ? currentData.outlines : [],
    saveState: 'ready',
    audioGeneration: {
      attempted: true,
      completedAt: new Date().toISOString(),
      source: 'server-revoice-job',
    },
  };
  // Persist final item progress before the atomic course commit. The RPC locks
  // the job row and only updates the course while its status is still running.
  const { error: progressError } = await service
    .from('course_revoice_jobs')
    .update({ items: nextItems, completed_items: completed })
    .eq('id', job.id)
    .eq('status', 'running');
  if (progressError) throw progressError;
  const { data: commitStatus, error: commitError } = await service.rpc(
    'commit_course_revoice_job',
    {
      p_job_id: job.id,
      p_course_id: job.course_id,
      p_source_updated_at: currentCourse.updated_at,
      p_course_data: courseData,
    },
  );
  if (commitError) throw commitError;
  const status = commitStatus === 'succeeded'
    ? 'succeeded'
    : commitStatus === 'conflict'
      ? 'conflict'
      : 'cancelled';
  return { ...job, status: status as CourseRevoiceStatus };
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
