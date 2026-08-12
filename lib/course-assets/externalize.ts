import { uploadCourseDataUri } from './client';

type RecordLike = Record<string, unknown>;

export interface ExternalizedCourseAssets {
  stage: RecordLike;
  scenes: RecordLike[];
  converted: { images: number; audio: number };
}

const dataUriKind = (value: unknown): 'images' | 'audio' | null => {
  if (typeof value !== 'string') return null;
  if (/^data:image\//i.test(value)) return 'images';
  if (/^data:audio\//i.test(value)) return 'audio';
  return null;
};

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
    for (const key of Object.keys(value as RecordLike)) {
      (value as RecordLike)[key] = await externalizeValue((value as RecordLike)[key]);
    }
    return value;
  };

  await externalizeValue(stage);
  await externalizeValue(scenes);
  return { stage, scenes, converted: { images, audio } };
}
