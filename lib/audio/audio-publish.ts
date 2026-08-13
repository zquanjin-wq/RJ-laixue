import type { Action, SpeechAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import { db, type AudioFileRecord } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';
import { uploadCourseBlob, uploadCourseBlobsConcurrently } from '@/lib/course-assets/client';
import { enqueueTTSFetchTask } from '@/lib/audio/tts-queue';

const log = createLogger('AudioPublish');

export interface PublishedAudioItem {
  sceneId: string;
  sceneOrder?: number;
  actionId?: string;
  audioId: string;
  audioUrl?: string;
}

export interface MissingAudioItem {
  sceneId: string;
  sceneOrder?: number;
  actionId?: string;
  audioId: string;
  reason: string;
}

export interface FailedAudioItem {
  sceneId: string;
  sceneOrder?: number;
  actionId?: string;
  audioId: string;
  error: string;
}

/** New: items that were regenerated via TTS during publish (no prior blob existed). */
export interface RegeneratedAudioItem {
  sceneId: string;
  sceneOrder?: number;
  actionId?: string;
  audioId: string;
  audioUrl: string;
  textLength: number;
}

export interface PublishSceneAudioAssetsResult {
  scenes: Scene[];
  uploaded: PublishedAudioItem[];
  skipped: PublishedAudioItem[];
  missing: MissingAudioItem[];
  failed: FailedAudioItem[];
  regenerated: RegeneratedAudioItem[];
}

/**
 * Course audio lives under `courses/<courseId>/audio/`. A URL in another
 * course's namespace is never a reusable asset: keeping it would make this
 * course play the other course's narration (and potentially its voice).
 */
function audioUrlBelongsToCourse(audioUrl: string, courseId: string): boolean {
  const match = audioUrl.match(/\/courses\/([^/?#]+)\/audio\//i);
  return !match || decodeURIComponent(match[1]) === courseId;
}

function hasUsableTeacherVoice(config?: TeacherVoiceConfig | null): boolean {
  return !!config?.providerId && !!config.voiceId;
}

function isSpeechAction(action: Action): action is SpeechAction {
  return action.type === 'speech';
}

function normalizeAudioFormat(format?: string): string {
  const normalized = (format || 'mp3').trim().toLowerCase();
  if (!normalized) return 'mp3';
  if (normalized === 'mpeg') return 'mp3';
  return normalized.replace(/^\./, '');
}

function contentTypeForAudio(format?: string): string {
  const normalized = normalizeAudioFormat(format);
  if (normalized === 'mp3') return 'audio/mpeg';
  if (normalized === 'wav') return 'audio/wav';
  if (normalized === 'ogg') return 'audio/ogg';
  if (normalized === 'webm') return 'audio/webm';
  if (normalized === 'm4a') return 'audio/mp4';
  return `audio/${normalized}`;
}

/** Upload a raw ArrayBuffer/Blob directly to Supabase Storage. */
async function uploadBlobToCloud(input: {
  stageId: string;
  audioId: string;
  data: ArrayBuffer;
  format: string;
}): Promise<string> {
  const { stageId, data, format } = input;
  return uploadCourseBlob(
    stageId,
    'audio',
    new Blob([data], { type: contentTypeForAudio(format) }),
  );
}

/**
 * Resolve TTS configuration for regeneration during publish.
 *
 * Priority (strict):
 *   1. stage.teacherVoiceConfig — course-level authoritative voice
 *   2. settings store — user-configured TTS provider (fallback only)
 *   3. minimax-tts / female-yujie — hard fallback
 */
export interface TeacherVoiceConfig {
  providerId?: string;
  voiceId?: string;
  modelId?: string;
}

export interface PublishSceneAudioAssetsOptions {
  /** Ignore every existing audio reference and synthesize with the supplied voice. */
  forceRegenerate?: boolean;
  /** Stop the in-flight revoice without committing a new course snapshot. */
  signal?: AbortSignal;
  /** Progress for the required per-speech audio assets (not optional narration). */
  onProgress?: (progress: { completed: number; total: number; sceneId: string }) => void;
}

async function resolveTtsConfigForPublish(
  teacherVoiceConfig?: TeacherVoiceConfig | null,
  sceneId?: string,
): Promise<{
  providerId: string;
  voice: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  source: 'stage.teacherVoiceConfig' | 'settings' | 'provider-default';
}> {
  // ── Priority 1: stage.teacherVoiceConfig ──
  if (teacherVoiceConfig?.providerId && teacherVoiceConfig.voiceId) {
    const providerId = teacherVoiceConfig.providerId.endsWith('-tts')
      ? teacherVoiceConfig.providerId
      : `${teacherVoiceConfig.providerId}-tts`;
    const voice = teacherVoiceConfig.voiceId;
    const modelId = teacherVoiceConfig.modelId || 'speech-2.8-hd';

    // Read apiKey/baseUrl from settings store for the resolved provider.
    let apiKey: string | undefined;
    let baseUrl: string | undefined;
    try {
      const { useSettingsStore } = await import('@/lib/store/settings');
      const s = useSettingsStore.getState();
      const cfg = s.ttsProvidersConfig as unknown as Record<
        string,
        { apiKey?: string; baseUrl?: string; customDefaultBaseUrl?: string; modelId?: string }
      >;
      const providerCfg = cfg?.[providerId];
      apiKey = providerCfg?.apiKey;
      baseUrl = providerCfg?.baseUrl || providerCfg?.customDefaultBaseUrl;
    } catch {
      // Settings store unavailable — TTS API may reject, but we log the source correctly.
    }

    const result = {
      providerId,
      voice,
      modelId,
      apiKey,
      baseUrl,
      source: 'stage.teacherVoiceConfig' as const,
    };
    console.info(
      '[MOBILE PUBLISH][TTS Voice Resolve]',
      JSON.stringify({
        sceneId: sceneId ?? '(unknown)',
        source: result.source,
        providerId: result.providerId,
        voiceId: result.voice,
        modelId: result.modelId,
      }),
    );
    return result;
  }

  // ── Priority 2: settings store ──
  try {
    const { useSettingsStore } = await import('@/lib/store/settings');
    const settings = useSettingsStore.getState();

    const providerId = settings.ttsProviderId || 'minimax-tts';
    const voice = settings.ttsVoice || 'female-yujie';
    const cfg = settings.ttsProvidersConfig as unknown as Record<
      string,
      { apiKey?: string; baseUrl?: string; customDefaultBaseUrl?: string; modelId?: string }
    >;
    const providerCfg = cfg?.[providerId];
    const modelId = providerCfg?.modelId || 'speech-2.8-hd';
    const apiKey = providerCfg?.apiKey;
    const baseUrl = providerCfg?.baseUrl || providerCfg?.customDefaultBaseUrl;

    const result = { providerId, voice, modelId, apiKey, baseUrl, source: 'settings' as const };
    console.info(
      '[MOBILE PUBLISH][TTS Voice Resolve]',
      JSON.stringify({
        sceneId: sceneId ?? '(unknown)',
        source: result.source,
        providerId: result.providerId,
        voiceId: result.voice,
        modelId: result.modelId,
      }),
    );
    return result;
  } catch {
    // Settings store not available — fall through to hard default.
  }

  // ── Priority 3: hard fallback ──
  const result = {
    providerId: 'minimax-tts',
    voice: 'female-yujie',
    modelId: 'speech-2.8-hd',
    source: 'provider-default' as const,
  };
  console.info(
    '[MOBILE PUBLISH][TTS Voice Resolve]',
    JSON.stringify({
      sceneId: sceneId ?? '(unknown)',
      source: result.source,
      providerId: result.providerId,
      voiceId: result.voice,
      modelId: result.modelId,
    }),
  );
  return result;
}

/**
 * Call /api/generate/tts and return decoded ArrayBuffer + format.
 *
 * TTS voice is resolved from stage.teacherVoiceConfig (priority 1),
 * then settings store (priority 2), then hard fallback (priority 3).
 */
async function generateTTSForText(
  text: string,
  audioId: string,
  teacherVoiceConfig?: TeacherVoiceConfig | null,
  sceneId?: string,
  signal?: AbortSignal,
): Promise<{
  data: ArrayBuffer;
  format: string;
}> {
  const ttsConfig = await resolveTtsConfigForPublish(teacherVoiceConfig, sceneId);

  const queueResult = await enqueueTTSFetchTask(audioId, () =>
    fetch('/api/generate/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        audioId,
        ttsProviderId: ttsConfig.providerId,
        ttsModelId: ttsConfig.modelId,
        ttsVoice: ttsConfig.voice,
        ttsSpeed: 1.0,
        ttsApiKey: ttsConfig.apiKey || undefined,
        ttsBaseUrl: ttsConfig.baseUrl || undefined,
      }),
      // A Vercel function can terminate while the browser fetch stays pending.
      // Never leave a course-level revoice spinner running indefinitely.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(45_000)])
        : AbortSignal.timeout(45_000),
    }),
  );

  if (!queueResult.success || !queueResult.response) {
    throw new Error(queueResult.error || 'TTS queue failed');
  }

  const response = queueResult.response;

  const json = await response.json();

  // /api/generate/tts 的 apiSuccess 是扁平结构 { success, audioId, base64, format }
  //（lib/server/api-response.ts）。历史上这里按嵌套 { data: { base64 } } 解析，
  // 导致发布期 TTS 重生成 100% 抛"TTS 返回数据缺失"。两种结构都兼容。
  const base64Payload: string | undefined = json.base64 ?? json.data?.base64;
  if (!json.success || !base64Payload) {
    throw new Error(json.message || json.error || 'TTS 返回数据缺失');
  }

  const binary = atob(base64Payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const format = json.format ?? json.data?.format ?? 'mp3';

  return { data: bytes.buffer as ArrayBuffer, format };
}

/**
 * Extract narration text from a single speech action for TTS regeneration.
 *
 * Priority:
 *   1. speechAction.text (the original narration script)
 *   2. scene.narrationText
 *   3. scene.content (fallback)
 */
function extractNarrationTextForTTS(scene: Scene, speechAction: SpeechAction): string {
  if (speechAction.text && speechAction.text.trim()) {
    return speechAction.text.trim();
  }
  const narrationText = (scene as unknown as Record<string, unknown>).narrationText as
    | string
    | undefined;
  if (narrationText?.trim()) return narrationText.trim();
  const content = (scene as unknown as Record<string, unknown>).content as string | undefined;
  if (content?.trim()) return content.trim();
  return '';
}

/**
 * Extract FULL chapter narration by joining ALL speech actions' text.
 * Used to generate a single combined audio per scene for mobile podcast mode.
 */
function extractFullNarrationText(scene: Scene): string {
  const actions = scene.actions ?? [];
  const speechActions = actions.filter((a) => isSpeechAction(a));
  const parts: string[] = [];
  for (const a of speechActions) {
    const sa = a as SpeechAction;
    if (sa.text?.trim()) parts.push(sa.text.trim());
  }
  return parts.join('\n\n').trim();
}

// ─── Simple stable hash ──────────────────────────────────────────
// djb2-style — deterministic, fast, no crypto dependency.
// Used to detect whether narration text or voice config changed,
// so we can skip re-generating unchanged chapter audio.
function stableHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

// ─── Interactive scene filter (mirrors lib/mobile/scene-helpers) ────

const INTERACTIVE_SCENE_KINDS = new Set(['quiz', 'interactive', 'pbl']);

function isInteractiveScene(scene: Scene): boolean {
  const kind = (scene as unknown as Record<string, unknown>).kind as string | undefined;
  if (kind && INTERACTIVE_SCENE_KINDS.has(kind)) return true;

  const interactionType = (scene as unknown as Record<string, unknown>).interactionType as
    | string
    | undefined;
  if (interactionType && INTERACTIVE_SCENE_KINDS.has(interactionType)) return true;

  const content = scene.content as unknown as Record<string, unknown> | undefined;
  if (content) {
    const contentStr = JSON.stringify(content).toLowerCase();
    for (const keyword of ['quiz', 'poll', 'exercise', 'interactive', 'choice']) {
      if (contentStr.includes(keyword)) return true;
    }
  }

  return false;
}

/**
 * Ensure speech actions have cloud-playable audioUrl before course publishing.
 *
 * Three-tier strategy per speech action:
 *
 *   1. audioUrl already exists → skip (fastest).
 *   2. No audioUrl but has audioId + IndexedDB blob → upload blob to cloud.
 *   3. No audioUrl, no blob → regenerate TTS from text → upload to cloud.
 *
 * audioId = browser-local IndexedDB cache key.
 * audioUrl = cloud URL required by shared/student playback.
 */
export async function publishSceneAudioAssets(
  stageId: string,
  scenes: Scene[],
  teacherVoiceConfig?: TeacherVoiceConfig | null,
  options: PublishSceneAudioAssetsOptions = {},
): Promise<PublishSceneAudioAssetsResult> {
  console.info(
    '[MOBILE PUBLISH][Audio Assets Start]',
    JSON.stringify({
      stageId,
      totalScenes: scenes.length,
      timestamp: new Date().toISOString(),
    }),
  );

  const nextScenes = structuredClone(scenes) as Scene[];

  // Never preserve an audio file owned by a different course.  Do this before
  // the normal Tier-1 shortcut so a copied scene cannot silently retain a
  // foreign voice.  Regeneration must use an explicit course voice; falling
  // back to the editor's local default here was the source of mixed voices.
  let foreignAudioCount = 0;
  for (const scene of nextScenes) {
    for (const action of scene.actions ?? []) {
      if (!isSpeechAction(action)) continue;
      const speech = action as SpeechAction & { audioId?: string; audioUrl?: string };
      if (speech.audioUrl && !audioUrlBelongsToCourse(speech.audioUrl, stageId)) {
        delete speech.audioId;
        delete speech.audioUrl;
        foreignAudioCount++;
      }
    }
  }
  if (foreignAudioCount > 0 && !hasUsableTeacherVoice(teacherVoiceConfig)) {
    throw new Error(
      '检测到来自其他课程的配音。请先在“课堂阵容 → AI教师”中选定本课音色，再保存或重新配音。',
    );
  }
  if (foreignAudioCount > 0) {
    log.warn(`Removed ${foreignAudioCount} foreign course audio references before publish`);
  }

  const uploaded: PublishedAudioItem[] = [];
  const skipped: PublishedAudioItem[] = [];
  const missing: MissingAudioItem[] = [];
  const failed: FailedAudioItem[] = [];
  const regenerated: RegeneratedAudioItem[] = [];
  const requiredSpeechTotal = nextScenes.reduce(
    (total, scene) =>
      total +
      (!options.forceRegenerate && isInteractiveScene(scene)
        ? 0
        : (scene.actions ?? []).filter(isSpeechAction).length),
    0,
  );
  let requiredSpeechCompleted = 0;
  const reportSpeechProgress = (sceneId: string) => {
    requiredSpeechCompleted++;
    options.onProgress?.({
      completed: requiredSpeechCompleted,
      total: requiredSpeechTotal,
      sceneId,
    });
  };

  /**
   * Compute a content hash for TTS idempotency: same (voice, speed, text)
   * → same hash → skip re-generation. Uses simple djb2 for speed.
   */
  function ttsContentHash(voice: string, speed: number, text: string): string {
    const key = `v:${voice}|s:${speed}|t:${text}`;
    let hash = 5381;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
    }
    return `tts_${(hash >>> 0).toString(16)}`;
  }

  // Batch-upload pool: collect blobs during the loop, flush at the end.
  const pendingUploads: {
    speechAction: SpeechAction & { audioId?: string; audioUrl?: string };
    sceneId: string;
    sceneOrder: number;
    actionId: string;
    audioId: string;
    blob: Blob;
    source: 'indexeddb' | 'regenerated';
    textLength?: number;
  }[] = [];

  for (const scene of nextScenes) {
    if (options.signal?.aborted) throw new DOMException('已停止重新配音', 'AbortError');
    // Normal publishing skips interactive scenes for mobile podcast mode.
    // A deliberate course revoice must still replace every teacher speech
    // action so desktop/classroom playback cannot retain the previous voice.
    if (!options.forceRegenerate && isInteractiveScene(scene)) continue;

    const actions = scene.actions ?? [];

    for (const action of actions) {
      if (!isSpeechAction(action)) continue;

      const speechAction = action as SpeechAction & {
        audioId?: string;
        audioUrl?: string;
      };

      const sceneId = scene.id;
      const sceneOrder = scene.order;
      const actionId = speechAction.id;
      const audioId = speechAction.audioId;

      if (options.forceRegenerate) {
        delete speechAction.audioId;
        delete speechAction.audioUrl;
      }

      // ── Tier 1: Already has cloud URL ──
      if (!options.forceRegenerate && speechAction.audioUrl) {
        skipped.push({
          sceneId,
          sceneOrder,
          actionId,
          audioId: audioId || '',
          audioUrl: speechAction.audioUrl,
        });
        reportSpeechProgress(sceneId);
        continue;
      }

      // ── Tier 2: Has an ownership-tagged local blob → upload ──
      // Generated and imported courses use different key formats. Ownership
      // therefore lives on the cache record instead of being inferred from id.
      if (!options.forceRegenerate && audioId) {
        const record = await db.audioFiles.get(audioId);

        if (record?.blob && record.stageId === stageId) {
          // Defer upload to batch pool (flushed at end of function).
          pendingUploads.push({
            speechAction,
            sceneId,
            sceneOrder,
            actionId,
            audioId,
            blob: record.blob,
            source: 'indexeddb',
          });
          console.info(
            '[MOBILE PUBLISH][Audio Queued]',
            JSON.stringify({
              audioId,
              sceneId,
              source: 'indexeddb-blob',
              timestamp: new Date().toISOString(),
            }),
          );
          continue;
        }

        // audioId exists but no blob in IndexedDB — fall through to Tier 3
        console.info(
          '[MOBILE PUBLISH][Audio Blob Missing Generate TTS]',
          JSON.stringify({
            audioId,
            sceneId,
            timestamp: new Date().toISOString(),
          }),
        );
        log.info(`audioId ${audioId} is missing or belongs to another course; will regenerate TTS`);
      }

      // ── Tier 3: No audioUrl, no blob → regenerate TTS ──
      const narrationText = extractNarrationTextForTTS(scene, speechAction);

      console.info(
        '[TTS INPUT][Scene Audio]',
        JSON.stringify({
          sceneId,
          sceneTitle: scene.title || `(order ${sceneOrder})`,
          speechActionCount: (actions as unknown as SpeechAction[]).filter(isSpeechAction).length,
          firstSpeechTextLength: narrationText.length,
          fullTextLength: narrationText.length, // single-action = same as first
          fullTextPreview: narrationText.slice(0, 120),
          sourceField: `speechAction[${actionId}].text (individual)`,
        }),
      );

      if (!narrationText) {
        missing.push({
          sceneId,
          sceneOrder,
          actionId,
          audioId: audioId || `(auto-${Date.now()})`,
          reason: '无法提取章节文字内容（speechAction.text / narrationText / content 均为空）',
        });
        reportSpeechProgress(sceneId);
        continue;
      }

      const regenAudioId = options.forceRegenerate
        ? `voice_${sceneId.slice(0, 8)}_${actionId.slice(0, 8)}_${Date.now()}`
        : audioId || `pub_${sceneId.slice(0, 8)}_${Date.now()}`;

      // Content-idempotent check: same (voice, speed, text) → reuse existing audio
      const ttsVoice = teacherVoiceConfig?.voiceId ?? 'default';
      const ttsSpeed = 1.0; // publish always uses speed 1.0
      const contentHash = ttsContentHash(ttsVoice, ttsSpeed, narrationText);
      const existingAudio = options.forceRegenerate
        ? undefined
        : await db.audioFiles.get(contentHash);

      if (existingAudio?.blob) {
        speechAction.audioId = regenAudioId;
        pendingUploads.push({
          speechAction,
          sceneId,
          sceneOrder,
          actionId,
          audioId: regenAudioId,
          blob: existingAudio.blob,
          source: 'regenerated',
          textLength: narrationText.length,
        });
        log.info(`TTS content-idempotent hit: hash=${contentHash}, reusing existing audio`);
        continue;
      }

      try {
        log.info(
          `Regenerating TTS for scene=${sceneId} action=${actionId} (${narrationText.length} chars)`,
        );

        const { data, format } = await generateTTSForText(
          narrationText,
          regenAudioId,
          teacherVoiceConfig,
          sceneId,
          options.signal,
        );

        // Defer upload to batch pool (flushed at end of function).
        speechAction.audioId = regenAudioId;
        pendingUploads.push({
          speechAction,
          sceneId,
          sceneOrder,
          actionId,
          audioId: regenAudioId,
          blob: new Blob([data], { type: contentTypeForAudio(format) }),
          source: 'regenerated',
          textLength: narrationText.length,
        });

        // Store under content hash for future idempotent reuse
        db.audioFiles
          .put({
            id: contentHash,
            stageId,
            blob: new Blob([data], { type: contentTypeForAudio(format) }),
            format: normalizeAudioFormat(format),
            mimeType: contentTypeForAudio(format),
            size: data.byteLength,
            createdAt: Date.now(),
          } as AudioFileRecord)
          .catch((e) => {
            // Best-effort: idempotent cache failures must not block publish
            log.warn(`Failed to cache TTS idempotent entry for hash=${contentHash}:`, e);
          });

        console.info(
          '[TTS OUTPUT][Scene Audio]',
          JSON.stringify({
            sceneId,
            audioId: regenAudioId,
            inputTextLength: narrationText.length,
            source: 'individual-speech-action-queued',
            timestamp: new Date().toISOString(),
          }),
        );

        log.info(`TTS regenerated (queued for batch upload): ${regenAudioId}`);
      } catch (error) {
        if (options.signal?.aborted) {
          throw new DOMException('已停止重新配音', 'AbortError');
        }
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error(`TTS regeneration failed for ${regenAudioId}:`, errMsg);

        failed.push({
          sceneId,
          sceneOrder,
          actionId,
          audioId: regenAudioId,
          error: `TTS 重新生成失败: ${errMsg}`,
        });
      }
      reportSpeechProgress(sceneId);
    }

    // ── Scene-level narration audio (best-effort, non-blocking) ──
    // The mobile player's PRIMARY playback path is audioSegments
    // (sequential speechAction.audioUrl playback). This narration
    // field is an OPTIONAL optimization for single-file chapters.
    //
    // Generation is best-effort only:
    //   - Short text (≤500 chars) → try direct TTS
    //   - Long text  (>500 chars) → SKIP (MiniMax can't handle it)
    //   - Failure          → console.warn, do NOT push to `failed`
    //   - Validation        → only checks speechAction.audioUrl
    const allSpeechActions = (actions as unknown as SpeechAction[]).filter(isSpeechAction);
    if (allSpeechActions.length > 0) {
      const fullText = extractFullNarrationText(scene);
      const sceneRaw = scene as unknown as Record<string, unknown>;
      if (options.forceRegenerate) {
        delete sceneRaw.narrationAudioUrl;
        delete sceneRaw.narrationAudioId;
        delete sceneRaw.narrationAudioTextHash;
      }

      // Only attempt narration TTS for short texts that fit in one API call.
      const NARRATION_MAX_CHARS = 500;
      if (fullText && fullText.length <= NARRATION_MAX_CHARS) {
        const textHash = stableHash(fullText + JSON.stringify(teacherVoiceConfig ?? {}));
        const narrationAudioId = `narration_${scene.id.slice(0, 8)}_${textHash.slice(0, 12)}`;
        const existingUrl = sceneRaw.narrationAudioUrl as string | undefined;
        const existingHash = sceneRaw.narrationAudioTextHash as string | undefined;
        const shouldRegenerate = !(existingUrl && existingHash === textHash);

        console.info(
          '[TTS INPUT][Scene Narration Audio]',
          JSON.stringify({
            sceneId: scene.id,
            sceneTitle: scene.title || `(order ${scene.order})`,
            speechActionCount: allSpeechActions.length,
            fullTextLength: fullText.length,
            fullTextPreview: fullText.slice(0, 120),
            textHash,
            narrationAudioId,
            existingNarrationAudioUrl: existingUrl ?? '(none)',
            shouldRegenerate,
            sourceField: 'scene.actions[*].text joined (narration, short)',
          }),
        );

        if (!shouldRegenerate) {
          console.info(
            '[TTS SKIP][Scene Narration Audio]',
            JSON.stringify({
              sceneId: scene.id,
              narrationAudioId,
              textHash,
              reason: 'hash match — unchanged',
            }),
          );
        } else {
          try {
            const { data: narrData, format: narrFormat } = await generateTTSForText(
              fullText,
              narrationAudioId,
              teacherVoiceConfig,
              scene.id,
            );

            const narrAudioUrl = await uploadBlobToCloud({
              stageId,
              audioId: narrationAudioId,
              data: narrData,
              format: narrFormat,
            });

            sceneRaw.narrationAudioUrl = narrAudioUrl;
            sceneRaw.narrationAudioId = narrationAudioId;
            sceneRaw.narrationAudioTextHash = textHash;

            console.info(
              '[TTS OUTPUT][Scene Narration Audio]',
              JSON.stringify({
                sceneId: scene.id,
                narrationAudioUrl: narrAudioUrl.slice(0, 80),
                narrationAudioId,
                inputTextLength: fullText.length,
                textHash,
                timestamp: new Date().toISOString(),
              }),
            );

            regenerated.push({
              sceneId: scene.id,
              sceneOrder: scene.order,
              actionId: '(narration)',
              audioId: narrationAudioId,
              audioUrl: narrAudioUrl,
              textLength: fullText.length,
            });

            log.info(
              `Narration TTS generated for scene=${scene.id} (${fullText.length} chars) → ${narrAudioUrl.slice(0, 60)}...`,
            );
          } catch (error) {
            // BEST-EFFORT: warn but NEVER block publish or push to failed[].
            // The mobile player will use audioSegments (speech action audios) instead.
            const errMsg = error instanceof Error ? error.message : String(error);
            log.warn(
              `Narration TTS best-effort failed for scene=${scene.id} (non-blocking): ${errMsg}`,
            );
            console.warn(
              '[TTS OUTPUT][Scene Narration Audio]',
              JSON.stringify({
                sceneId: scene.id,
                error: errMsg,
                source: 'narration-audio best-effort FAILED (non-blocking)',
                fallback: 'mobile player will use audioSegments (speech action audios)',
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }
      } else if (fullText) {
        // Text too long for single TTS call — skip narration generation.
        // Mobile player uses audioSegments path (sequential speech action playback).
        console.info(
          '[TTS SKIP][Scene Narration Audio]',
          JSON.stringify({
            sceneId: scene.id,
            reason: `text too long (${fullText.length} chars > ${NARRATION_MAX_CHARS} limit), mobile player uses audioSegments`,
            speechActionCount: allSpeechActions.length,
            fallback: 'audioSegments (speechAction.audioUrl sequential playback)',
          }),
        );
      }
    }
  }

  console.info(
    '[MOBILE PUBLISH][Audio Assets Done]',
    JSON.stringify({
      stageId,
      skipped: skipped.length,
      uploaded: uploaded.length,
      regenerated: regenerated.length,
      missing: missing.length,
      failed: failed.length,
      timestamp: new Date().toISOString(),
    }),
  );

  // ── Batch-upload all pending audio blobs (6-concurrency pool) ──
  if (pendingUploads.length > 0) {
    console.info(
      '[MOBILE PUBLISH][Batch Upload Start]',
      JSON.stringify({
        totalPending: pendingUploads.length,
        timestamp: new Date().toISOString(),
      }),
    );

    const tasks = pendingUploads.map((p) => ({
      id: p.audioId,
      courseId: stageId,
      kind: 'audio' as const,
      blob: p.blob,
    }));

    const poolResults = await uploadCourseBlobsConcurrently(tasks, 6, 2);

    let batchUploaded = 0;
    let batchFailed = 0;
    for (let i = 0; i < pendingUploads.length; i++) {
      const p = pendingUploads[i];
      const r = poolResults[i];

      if (r.success && r.publicUrl) {
        p.speechAction.audioUrl = r.publicUrl;
        uploaded.push({
          sceneId: p.sceneId,
          sceneOrder: p.sceneOrder,
          actionId: p.actionId,
          audioId: p.audioId,
          audioUrl: r.publicUrl,
        });
        if (p.source === 'regenerated') {
          regenerated.push({
            sceneId: p.sceneId,
            sceneOrder: p.sceneOrder,
            actionId: p.actionId,
            audioId: p.audioId,
            audioUrl: r.publicUrl,
            textLength: p.textLength ?? 0,
          });
        }
        batchUploaded++;
      } else {
        failed.push({
          sceneId: p.sceneId,
          sceneOrder: p.sceneOrder,
          actionId: p.actionId,
          audioId: p.audioId,
          error: r.error || '批量上传失败',
        });
        batchFailed++;
      }
    }
    pendingUploads.length = 0;

    console.info(
      '[MOBILE PUBLISH][Batch Upload Done]',
      JSON.stringify({
        uploaded: batchUploaded,
        failed: batchFailed,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  return {
    scenes: nextScenes,
    uploaded,
    skipped,
    missing,
    failed,
    regenerated,
  };
}

// ─── Validation ────────────────────────────────────────────────

export type AudioAssetValidationReason =
  | 'missing-speech-action'
  | 'missing-audio-url'
  | 'tts-generate-failed'
  | 'upload-failed';

export interface AudioAssetValidationIssue {
  sceneId: string;
  sceneTitle?: string;
  sceneOrder?: number;
  reason: AudioAssetValidationReason;
  detail?: string;
}

export interface AudioAssetValidationResult {
  ok: boolean;
  totalLearnableScenes: number;
  validScenes: number;
  issues: AudioAssetValidationIssue[];
}

/**
 * Validate that all non-interactive learnable scenes have published audio.
 *
 * Called after publishSceneAudioAssets() to verify the result before
 * saving to cloud. Also usable independently for pre-flight checks.
 */
export function validatePublishedAudioAssets(scenes: Scene[]): AudioAssetValidationResult {
  const issues: AudioAssetValidationIssue[] = [];
  let totalLearnable = 0;
  let validCount = 0;

  for (const scene of scenes) {
    if (isInteractiveScene(scene)) continue;

    totalLearnable++;

    const sceneTitle =
      ((scene as unknown as Record<string, unknown>).name as string) ||
      ((scene as unknown as Record<string, unknown>).title as string) ||
      undefined;

    const actions = scene.actions ?? [];
    const speechActions = actions.filter((a) => isSpeechAction(a));

    if (speechActions.length === 0) {
      issues.push({
        sceneId: scene.id,
        sceneTitle,
        sceneOrder: scene.order,
        reason: 'missing-speech-action',
        detail: '该场景没有 speech 类型的 action',
      });
      continue;
    }

    const hasAudioUrl = speechActions.some(
      (a) => !!(a as SpeechAction & { audioUrl?: string }).audioUrl,
    );

    if (!hasAudioUrl) {
      issues.push({
        sceneId: scene.id,
        sceneTitle,
        sceneOrder: scene.order,
        reason: 'missing-audio-url',
        detail: `该场景的 ${speechActions.length} 个 speech action 均无 audioUrl`,
      });
      continue;
    }

    validCount++;
  }

  return {
    ok: issues.length === 0,
    totalLearnableScenes: totalLearnable,
    validScenes: validCount,
    issues,
  };
}
