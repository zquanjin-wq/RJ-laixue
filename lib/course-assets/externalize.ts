import { uploadCourseDataUri } from './client';

type RecordLike = Record<string, unknown>;

export interface ExternalizedCourseAssets {
  stage: RecordLike;
  scenes: RecordLike[];
  converted: { images: number; audio: number };
  foreignAudioRemoved: number;
}

const dataUriKind = (value: unknown): 'images' | 'audio' | null => {
  if (typeof value !== 'string') return null;
  if (/^data:image\//i.test(value)) return 'images';
  if (/^data:audio\//i.test(value)) return 'audio';
  return null;
};

/** Extract the owning course from our public course-audio URL, when present. */
function courseIdFromAudioUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/\/courses\/([^/?#]+)\/audio\//i);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Deep-copy and replace every persisted inline image/audio with an HTTPS URL. */
export async function externalizeCourseAssets(
  courseId: string,
  stageInput: RecordLike,
  scenesInput: RecordLike[],
): Promise<ExternalizedCourseAssets> {
  const stage = structuredClone(stageInput);
  const scenes = structuredClone(scenesInput);
  let images = 0;
  let audio = 0;
  let foreignAudioRemoved = 0;
  const uploaded = new Map<string, Promise<string>>();
  const visited = new WeakSet<object>();

  const externalizeValue = async (value: unknown): Promise<unknown> => {
    const kind = dataUriKind(value);
    if (kind && typeof value === 'string') {
      const cacheKey = `${kind}:${value}`;
      let upload = uploaded.get(cacheKey);
      if (!upload) {
        upload = uploadCourseDataUri(courseId, kind, value);
        uploaded.set(cacheKey, upload);
        if (kind === 'images') images++;
        else audio++;
      }
      return upload;
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return value;
    visited.add(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) value[index] = await externalizeValue(value[index]);
      return value;
    }
    // A speech action imported from another course can contain a perfectly
    // valid public URL, but it is still not this course's audio. Strip both
    // references before the generic traversal: the publisher will regenerate
    // it under the current course namespace instead of preserving a foreign
    // voice or looking up its ambiguous browser-local cache key.
    const record = value as RecordLike;
    const audioOwner = courseIdFromAudioUrl(record.audioUrl);
    if (audioOwner && audioOwner !== courseId) {
      delete record.audioUrl;
      delete record.audioId;
      foreignAudioRemoved++;
    }
    for (const key of Object.keys(record)) {
      record[key] = await externalizeValue(record[key]);
    }
    return value;
  };

  await externalizeValue(stage);
  await externalizeValue(scenes);
  const voice = stage.teacherVoiceConfig as { providerId?: string; voiceId?: string } | undefined;
  if (foreignAudioRemoved > 0 && (!voice?.providerId || !voice.voiceId)) {
    throw new Error(
      '检测到来自其他课程的配音。请先在“课堂阵容 → AI教师”中选定本课音色，再保存或重新配音。',
    );
  }
  return { stage, scenes, converted: { images, audio }, foreignAudioRemoved };
}
