/**
 * Per-speech managed-TTS helpers for the timeline editor.
 *
 * Audio is stored under a course-scoped key,
 * `tts_<stageId>_s<sceneOrder>_<actionId>`. Synthesis delegates to
 * `generateAndStoreTTS`, keeping the request/store contract shared with the
 * generation pipeline while preventing copied courses from sharing a blob.
 */
import { db } from '@/lib/utils/database';
import { useSettingsStore } from '@/lib/store/settings';
import { generateAndStoreTTS } from '@/lib/hooks/use-scene-generator';

/** Canonical audio cache key — matches the generation pipeline. */
export function speechAudioId(stageId: string, sceneOrder: number, actionId: string): string {
  return `tts_${stageId}_s${sceneOrder}_${actionId}`;
}

/**
 * The audio key for a speech action: its stamped `audioId` (set by the pipeline
 * or a prior regen) if present, else the canonical derived key. Single source
 * of truth for "what blob belongs to this speech line".
 */
export function resolveSpeechAudioId(
  stageId: string,
  sceneOrder: number,
  action: { id?: string; audioId?: string },
): string {
  return action.audioId || speechAudioId(stageId, sceneOrder, action.id ?? '');
}

/** Managed (server) TTS is on — browser-native TTS has no cached file to manage. */
export function isManagedTtsActive(): boolean {
  const s = useSettingsStore.getState();
  return s.ttsEnabled && s.ttsProviderId !== 'browser-native-tts';
}

/** True if an audio blob is cached under this exact audioId. */
export async function audioExists(audioId: string, stageId?: string): Promise<boolean> {
  const record = await db.audioFiles.get(audioId);
  return !!record && (!stageId || record.stageId === stageId);
}

/** Existence for many audioIds in one IndexedDB round-trip. */
export async function audioExistsBulk(audioIds: string[]): Promise<Set<string>> {
  if (audioIds.length === 0) return new Set();
  const recs = await db.audioFiles.bulkGet(audioIds);
  const have = new Set<string>();
  recs.forEach((r, i) => {
    if (r) have.add(audioIds[i]);
  });
  return have;
}

/** Object URL for the audio cached under this exact audioId (caller revokes). */
export async function audioObjectUrl(audioId: string, stageId?: string): Promise<string | null> {
  const rec = await db.audioFiles.get(audioId);
  return rec && (!stageId || rec.stageId === stageId) ? URL.createObjectURL(rec.blob) : null;
}

/**
 * Discard the cached audio for a speech line (both its stamped audioId, if any,
 * and the canonical derived key). Called when the user edits a line's text: the
 * cache key is derived from sceneOrder+actionId (not the text), so without this
 * the stale blob would keep replaying for the new wording. After this the line
 * reads as "not voiced" and must be regenerated.
 */
export async function discardSpeechAudio(
  stageId: string,
  sceneOrder: number,
  action: { id?: string; audioId?: string },
): Promise<void> {
  if (!action.id) return;
  const ids = new Set([speechAudioId(stageId, sceneOrder, action.id)]);
  if (action.audioId) ids.add(action.audioId);
  const keys = [...ids];
  const records = await db.audioFiles.bulkGet(keys);
  const ownedIds = records.flatMap((record, index) =>
    record?.stageId === stageId ? [keys[index]] : [],
  );
  if (ownedIds.length) await db.audioFiles.bulkDelete(ownedIds);
}

/**
 * (Re)generate TTS for one speech line and cache it under the canonical key.
 * Returns the audioId on success, or null when TTS isn't applicable. Throws if
 * synthesis fails. Delegates to the pipeline's `generateAndStoreTTS`.
 */
export async function regenerateSpeechAudio(
  stageId: string,
  sceneOrder: number,
  action: { id?: string; text?: string },
  language?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!isManagedTtsActive()) return null;
  const text = action.text?.trim();
  if (!text || !action.id) return null;
  const audioId = speechAudioId(stageId, sceneOrder, action.id);
  await generateAndStoreTTS(audioId, text, language, signal);
  return audioId;
}
