'use client';

import { useCallback, useRef } from 'react';
import { useStageStore } from '@/lib/store/stage';
import { isSceneEditLocked } from '@/lib/edit/regen-lock';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useSettingsStore } from '@/lib/store/settings';
import { db } from '@/lib/utils/database';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  UserRequirements,
} from '@/lib/types/generation';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import type { Scene } from '@/lib/types/stage';
import type { Action, SpeechAction } from '@/lib/types/action';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { resolveAgentVoiceOptions, pickNarratorAgent } from '@/lib/audio/agent-voice';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { lazyBoundedMap } from '@/lib/utils/concurrency';
import { createLogger } from '@/lib/logger';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  isAbortError,
  withGenerationRetry,
  type GenerationRetryOptions,
} from '@/lib/generation/generation-retry';
import { saveStageToCloud } from '@/lib/utils/cloud-sync';
import { toast } from 'sonner';

const log = createLogger('SceneGenerator');

/**
 * Per-outline generation timeout. If an outline stays in `generating`
 * longer than this, the watchdog marks it failed so the user sees a
 * retry button instead of an infinite spinner. Tuned conservatively
 * because scene generation can include content + actions + TTS passes,
 * each of which may take up to ~30s on the slowest day; 3 minutes is
 * generous for any single outline on a healthy network.
 */
const OUTLINE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Total batch generation timeout. Belt-and-braces — under normal flow,
 * the per-outline timeout should fire first. This exists so that in the
 * parallel-content mode where some outlines might never get visited by
 * the serial loop, we still bail out and surface the situation to the
 * teacher rather than leaving them with a half-finished deck.
 */
const TOTAL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Fire-and-forget cloud save after successful generation completes.
 *
 * Why fire-and-forget (not awaited): generation itself is already slow,
 * and saveStageToCloud bundles an audio publish pass that can add
 * another 5-30s. Blocking the caller on top of that would keep
 * `generationComplete` truthy-but-frozen, making the user stare at a
 * "生成中" UI while their course is already done. Instead we flip the
 * completion flag immediately and let the upload run in the background;
 * a toast tells the user when it lands or when it failed (in which case
 * they can fall back to the manual "保存到云端" button).
 *
 * Not called from the `paused` / `aborted` paths — if generation is
 * incomplete, the user may still want to retry outlines, and an upload
 * of half-baked data is more harmful than helpful.
 */
function fireAndForgetAutoSave(stageId: string): void {
  saveStageToCloud(stageId)
    .then(() => {
      toast.success('课程已自动保存到云端');
    })
    .catch((err: unknown) => {
      log.error('[AutoSave] saveStageToCloud failed:', err);
      toast.warning('自动保存失败，请手动点击"保存到云端"');
    });
}

interface SceneContentResult {
  success: boolean;
  content?: unknown;
  effectiveOutline?: SceneOutline;
  error?: string;
}

interface SceneActionsResult {
  success: boolean;
  scene?: Scene;
  previousSpeeches?: string[];
  error?: string;
}

type ClientRetryOptions<T> = Partial<
  Omit<GenerationRetryOptions<T>, 'label' | 'shouldRetryResult' | 'signal'>
>;

function getApiHeaders(): HeadersInit {
  const config = getCurrentModelConfig();
  const settings = useSettingsStore.getState();
  const imageProviderConfig = settings.imageProvidersConfig?.[settings.imageProviderId];
  const videoProviderConfig = settings.videoProvidersConfig?.[settings.videoProviderId];

  return {
    'Content-Type': 'application/json',
    'x-model': config.modelString || '',
    'x-api-key': config.apiKey || '',
    'x-base-url': config.baseUrl || '',
    'x-provider-type': config.providerType || '',
    // Image generation provider
    'x-image-provider': settings.imageProviderId || '',
    'x-image-model': settings.imageModelId || '',
    'x-image-api-key': imageProviderConfig?.apiKey || '',
    'x-image-base-url': imageProviderConfig?.baseUrl || '',
    // Video generation provider
    'x-video-provider': settings.videoProviderId || '',
    'x-video-model': settings.videoModelId || '',
    'x-video-api-key': videoProviderConfig?.apiKey || '',
    'x-video-base-url': videoProviderConfig?.baseUrl || '',
    // Media generation toggles
    'x-image-generation-enabled': String(settings.imageGenerationEnabled ?? false),
    'x-video-generation-enabled': String(settings.videoGenerationEnabled ?? false),
  };
}

function withThinkingConfig<T extends Record<string, unknown>>(body: T): T {
  const { thinkingConfig } = getCurrentModelConfig();
  return thinkingConfig ? ({ ...body, thinkingConfig } as T) : body;
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({
    error: response.statusText || 'Request failed',
  }));
}

function createHttpError(
  response: Response,
  data: { details?: unknown; error?: unknown },
  fallback: string,
): Error & { statusCode?: number } {
  const message =
    typeof data.details === 'string'
      ? data.details
      : typeof data.error === 'string'
        ? data.error
        : `${fallback}: HTTP ${response.status}`;
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = response.status;
  return error;
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function stripPdfImagePayload(img: PdfImage): PdfImage {
  return {
    ...img,
    // Full base64 image data is restored from imageMapping on the server.
    // Keeping it here can push Vercel's request body over the 4.5MB limit.
    src: '',
  };
}

function getSuggestedImageIds(outline: SceneOutline): string[] {
  return outline.suggestedImageIds ?? [];
}

function slimPdfImagesForOutline(
  outline: SceneOutline,
  pdfImages?: PdfImage[],
): PdfImage[] | undefined {
  if (!pdfImages) return undefined;

  const suggestedIds = getSuggestedImageIds(outline);
  if (suggestedIds.length === 0) return undefined;

  const suggestedIdSet = new Set(suggestedIds);
  const slimImages = pdfImages
    .filter((img) => suggestedIdSet.has(img.id))
    .map(stripPdfImagePayload);

  return slimImages.length > 0 ? slimImages : undefined;
}

function slimImageMappingForOutline(
  outline: SceneOutline,
  imageMapping?: ImageMapping,
): ImageMapping | undefined {
  if (!imageMapping) return undefined;

  const suggestedIds = getSuggestedImageIds(outline);
  if (suggestedIds.length === 0) return undefined;

  const slimMapping: ImageMapping = {};
  for (const id of suggestedIds) {
    if (imageMapping[id]) {
      slimMapping[id] = imageMapping[id];
    }
  }

  return Object.keys(slimMapping).length > 0 ? slimMapping : undefined;
}

type SceneContentRequestParams = {
  outline: SceneOutline;
  allOutlines: SceneOutline[];
  stageId: string;
  pdfImages?: PdfImage[];
  imageMapping?: ImageMapping;
  stageInfo: {
    name: string;
    description?: string;
    language?: string;
    style?: string;
  };
  agents?: AgentInfo[];
  languageDirective?: string;
  requirements?: UserRequirements;
};

const SCENE_CONTENT_BODY_WARN_BYTES = 3_500_000;

function trimImageMappingToFit(payload: SceneContentRequestParams): SceneContentRequestParams {
  if (!payload.imageMapping) return payload;

  let bodySize = JSON.stringify(withThinkingConfig(payload)).length;
  if (bodySize <= SCENE_CONTENT_BODY_WARN_BYTES) return payload;

  const orderedIds = getSuggestedImageIds(payload.outline).filter((id) => payload.imageMapping?.[id]);
  const nextMapping: ImageMapping = { ...payload.imageMapping };

  for (let i = orderedIds.length - 1; i >= 0; i -= 1) {
    delete nextMapping[orderedIds[i]];
    bodySize = JSON.stringify(withThinkingConfig({ ...payload, imageMapping: nextMapping })).length;
    if (bodySize <= SCENE_CONTENT_BODY_WARN_BYTES) {
      return {
        ...payload,
        imageMapping: Object.keys(nextMapping).length > 0 ? nextMapping : undefined,
      };
    }
  }

  return { ...payload, imageMapping: undefined };
}

function slimSceneContentPayload(params: SceneContentRequestParams): SceneContentRequestParams {
  const payload = {
    ...params,
    pdfImages: slimPdfImagesForOutline(params.outline, params.pdfImages),
    imageMapping: slimImageMappingForOutline(params.outline, params.imageMapping),
  };

  return trimImageMappingToFit(payload);
}

/** Call POST /api/generate/scene-content (step 1) */
export async function fetchSceneContent(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    stageId: string;
    pdfImages?: PdfImage[];
    imageMapping?: ImageMapping;
    stageInfo: {
      name: string;
      description?: string;
      language?: string;
      style?: string;
    };
    agents?: AgentInfo[];
    languageDirective?: string;
    requirements?: UserRequirements;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneContentResult>,
): Promise<SceneContentResult> {
  try {
    return await withGenerationRetry(
      async () => {
        const payload = slimSceneContentPayload(params);
        const response = await fetch('/api/generate/scene-content', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(withThinkingConfig(payload)),
          signal,
        });

        const data = await readJsonResponse(response);
        if (!response.ok) {
          throw createHttpError(response, data, 'Scene content request failed');
        }

        return data as unknown as SceneContentResult;
      },
      {
        label: `scene content "${params.outline.title}"`,
        shouldRetryResult: (result) => !result.success || !result.content,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { success: false, error: messageFromError(error, 'Content generation failed') };
  }
}

/** Call POST /api/generate/scene-actions (step 2) */
export async function fetchSceneActions(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    content: unknown;
    stageId: string;
    agents?: AgentInfo[];
    previousSpeeches?: string[];
    userProfile?: string;
    languageDirective?: string;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneActionsResult>,
): Promise<SceneActionsResult> {
  try {
    return await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/scene-actions', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(withThinkingConfig(params)),
          signal,
        });

        const data = await readJsonResponse(response);
        if (!response.ok) {
          throw createHttpError(response, data, 'Scene actions request failed');
        }

        return data as unknown as SceneActionsResult;
      },
      {
        label: `scene actions "${params.outline.title}"`,
        shouldRetryResult: (result) => !result.success || !result.scene,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { success: false, error: messageFromError(error, 'Actions generation failed') };
  }
}

interface TTSApiResponse {
  success?: boolean;
  base64?: string;
  format?: string;
  error?: string;
  details?: string;
}

/** Generate TTS for one speech action and store in IndexedDB */
export async function generateAndStoreTTS(
  audioId: string,
  text: string,
  language?: string,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<TTSApiResponse>,
): Promise<void> {
  const settings = useSettingsStore.getState();
  if (settings.ttsProviderId === 'browser-native-tts') return;
  // Don't server-generate against a disabled/unconfigured provider (#665).
  if (
    !isTTSProviderEnabled(
      settings.ttsProviderId,
      settings.ttsProvidersConfig?.[settings.ttsProviderId],
    )
  )
    return;

  const ttsProviderConfig = settings.ttsProvidersConfig?.[settings.ttsProviderId];
  // Narration is the teacher's voice — resolve it from the teacher agent profile
  // through the single resolver (registers + references by id for stable timbre).
  const teacher = pickNarratorAgent(useAgentRegistry.getState().listAgents());
  const providerOptions = await resolveAgentVoiceOptions(teacher, {
    providerId: settings.ttsProviderId,
    providerConfig: ttsProviderConfig,
    voiceId: settings.ttsVoice,
    language,
  });
  const data = await withGenerationRetry(
    async () => {
      const response = await fetch('/api/generate/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          audioId,
          ttsProviderId: settings.ttsProviderId,
          ttsModelId: ttsProviderConfig?.modelId,
          ttsVoice: settings.ttsVoice,
          ttsSpeed: settings.ttsSpeed,
          ttsApiKey: ttsProviderConfig?.apiKey || undefined,
          // Managed providers resolve their base URL server-side; only send the
          // client's own base URL (custom providers).
          ttsBaseUrl:
            ttsProviderConfig?.baseUrl || ttsProviderConfig?.customDefaultBaseUrl || undefined,
          ttsProviderOptions: providerOptions,
        }),
        signal,
      });

      const data = (await readJsonResponse(response)) as TTSApiResponse;
      if (!response.ok) {
        throw createHttpError(response, data, 'TTS request failed');
      }
      return data;
    },
    {
      label: `tts "${audioId}"`,
      shouldRetryResult: (result) => !result.success || !result.base64 || !result.format,
      ...retryOptions,
      signal,
    },
  );
  if (!data.success || !data.base64 || !data.format) {
    const err = new Error(
      data.details || data.error || 'TTS request failed: invalid response payload',
    );
    log.warn('TTS failed for', audioId, ':', err);
    throw err;
  }

  const binary = atob(data.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: `audio/${data.format}` });
  await db.audioFiles.put({
    id: audioId,
    blob,
    format: data.format,
    createdAt: Date.now(),
  });
}

/** Generate TTS for all speech actions in a scene. Returns result. */
async function generateTTSForScene(
  scene: Scene,
  language?: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; failedCount: number; error?: string }> {
  const providerId = useSettingsStore.getState().ttsProviderId;
  scene.actions = splitLongSpeechActions(scene.actions || [], providerId);
  const speechActions = (scene.actions as Action[]).filter(
    (a): a is SpeechAction => a.type === 'speech' && !!a.text,
  );
  if (speechActions.length === 0) return { success: true, failedCount: 0 };

  let failedCount = 0;
  let lastError: string | undefined;

  // Use scene order to make audio IDs unique across scenes
  // This prevents audio collision when action IDs are sequential (e.g., action_1, action_2)
  const sceneOrder = scene.order;

  for (const action of speechActions) {
    // Include scene order in audioId to prevent collision across scenes
    const audioId = `tts_s${sceneOrder}_${action.id}`;
    action.audioId = audioId;
    try {
      await generateAndStoreTTS(audioId, action.text, language, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;

      failedCount++;
      lastError = error instanceof Error ? error.message : `TTS failed for action ${action.id}`;
      log.warn('TTS generation failed:', {
        providerId,
        actionId: action.id,
        sceneOrder,
        audioId,
        textLength: action.text.length,
        error: lastError,
      });
    }
  }

  return {
    success: failedCount === 0,
    failedCount,
    error: lastError,
  };
}

export interface UseSceneGeneratorOptions {
  onSceneGenerated?: (scene: Scene, index: number) => void;
  onSceneFailed?: (outline: SceneOutline, error: string) => void;
  onPhaseChange?: (phase: 'content' | 'actions', outline: SceneOutline) => void;
  onComplete?: () => void;
}

export interface GenerationParams {
  pdfImages?: PdfImage[];
  imageMapping?: ImageMapping;
  stageInfo: {
    name: string;
    description?: string;
    language?: string;
    style?: string;
  };
  agents?: AgentInfo[];
  userProfile?: string;
  languageDirective?: string;
}

export function useSceneGenerator(options: UseSceneGeneratorOptions = {}) {
  const { t } = useI18n();
  const abortRef = useRef(false);
  const generatingRef = useRef(false);
  const mediaAbortRef = useRef<AbortController | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const lastParamsRef = useRef<GenerationParams | null>(null);
  const generateRemainingRef = useRef<((params: GenerationParams) => Promise<void>) | null>(null);
  // Per-outline watchdog timers. Keyed by outline id so a stuck outline
  // fires its own timeout regardless of sibling progress. Cleared at the
  // success / failure / removal boundaries below — see startOutlineTimeout
  // and clearOutlineTimeout for the contract.
  const timeoutMapRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  // Batch watchdog: started when generateRemaining kicks off, cleared on
  // successful completion. Fires once if the whole run stalls.
  const totalTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const store = useStageStore;

  // ────────────────────────────────────────────────────────────────
  // Watchdog helpers
  // ────────────────────────────────────────────────────────────────

  /**
   * Start (or reset) the 3-minute watchdog for one outline.
   *
   * Always called BEFORE the corresponding setGeneratingOutlines push so
   * the timer is armed by the time the UI sees "generating". The function
   * is idempotent — calling it again for the same id clears the previous
   * timer first, which keeps the retry path sane (each retry restarts the
   * clock; we don't carry over a stale 3-minute budget).
   */
  const startOutlineTimeout = (outline: SceneOutline): void => {
    const existing = timeoutMapRef.current.get(outline.id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      // Only fire if the outline is STILL in generatingOutlines. If it
      // already moved to completed/failed/removed, this is a stale timer
      // and we silently drop it.
      const stillGenerating = store
        .getState()
        .generatingOutlines.some((o) => o.id === outline.id);
      if (!stillGenerating) {
        timeoutMapRef.current.delete(outline.id);
        return;
      }
      log.warn(
        `[Timeout] Outline "${outline.title || outline.id}" exceeded ${OUTLINE_TIMEOUT_MS / 1000}s`,
      );
      // Move outline to failedOutlines and remove from generatingOutlines
      // in a single store transaction. Do NOT touch scenes — partial output
      // is still recoverable and the retry path will decide what to redo.
      store.getState().addFailedOutline(outline);
      store
        .getState()
        .setGeneratingOutlines(
          store.getState().generatingOutlines.filter((o) => o.id !== outline.id),
        );
      timeoutMapRef.current.delete(outline.id);
      toast.warning(
        t('generation.timeout.outlineTimeout', { title: outline.title || outline.id }),
      );
    }, OUTLINE_TIMEOUT_MS);
    timeoutMapRef.current.set(outline.id, timer);
  };

  /**
   * Stop the watchdog for one outline. Safe to call even if no timer
   * exists for the id. Always called BEFORE removing the outline from
   * generatingOutlines so we don't fire after the fact.
   */
  const clearOutlineTimeout = (outlineId: string): void => {
    const existing = timeoutMapRef.current.get(outlineId);
    if (existing) {
      clearTimeout(existing);
      timeoutMapRef.current.delete(outlineId);
    }
  };

  /** Clear every per-outline timer (called on batch completion / abort). */
  const clearAllOutlineTimeouts = (): void => {
    for (const timer of timeoutMapRef.current.values()) clearTimeout(timer);
    timeoutMapRef.current.clear();
  };

  /**
   * Wrapper around store.addFailedOutline that ALSO disarms the watchdog
   * for the outline. Every failure path (content / actions / TTS / catch)
   * routes through here so we can never leak a timer after a failure has
   * been recorded — which would otherwise fire on the next retry and
   * immediately re-mark the outline as failed.
   */
  const markOutlineFailed = (outline: SceneOutline): void => {
    clearOutlineTimeout(outline.id);
    store.getState().addFailedOutline(outline);
  };

  /** Start the 15-minute batch watchdog. Idempotent. */
  const startTotalTimeout = (): void => {
    if (totalTimeoutRef.current) clearTimeout(totalTimeoutRef.current);
    totalTimeoutRef.current = setTimeout(() => {
      // Only fire if the batch is still running. If the user already
      // landed on a clean completed state, this is a stale timer.
      const state = store.getState();
      if (state.generationComplete) {
        totalTimeoutRef.current = null;
        return;
      }
      log.error(
        `[Timeout] Total generation exceeded ${TOTAL_TIMEOUT_MS / 1000}s — aborting batch`,
      );
      // Promote every outline still in generatingOutlines to failedOutlines.
      // Surviving outlines stay where they are (pending / already completed).
      const stillGenerating = state.generatingOutlines;
      for (const outline of stillGenerating) {
        state.addFailedOutline(outline);
      }
      state.setGeneratingOutlines([]);
      state.setGenerationStatus('paused');
      totalTimeoutRef.current = null;
      toast.error(t('generation.timeout.totalTimeout'));
    }, TOTAL_TIMEOUT_MS);
  };

  const clearTotalTimeout = (): void => {
    if (totalTimeoutRef.current) {
      clearTimeout(totalTimeoutRef.current);
      totalTimeoutRef.current = null;
    }
  };

  const generateRemaining = useCallback(
    async (params: GenerationParams) => {
      lastParamsRef.current = params;
      if (generatingRef.current) return;
      generatingRef.current = true;
      abortRef.current = false;
      const removeGeneratingOutline = (outlineId: string) => {
        const current = store.getState().generatingOutlines;
        if (!current.some((o) => o.id === outlineId)) return;
        store.getState().setGeneratingOutlines(current.filter((o) => o.id !== outlineId));
      };

      // Create a new AbortController for this generation run
      fetchAbortRef.current = new AbortController();
      const signal = fetchAbortRef.current.signal;

      const state = store.getState();
      const { outlines, scenes, stage } = state;
      const startEpoch = state.generationEpoch;
      if (!stage || outlines.length === 0) {
        generatingRef.current = false;
        return;
      }

      store.getState().setGenerationStatus('generating');

      // Determine pending outlines
      const completedOrders = new Set(scenes.map((s) => s.order));
      const pending = outlines
        .filter((o) => !completedOrders.has(o.order))
        .sort((a, b) => a.order - b.order);

      if (pending.length === 0) {
        store.getState().setGenerationStatus('completed');
        store.getState().setGeneratingOutlines([]);
        store.getState().setGenerationComplete(true);
        options.onComplete?.();
        fireAndForgetAutoSave(stage.id);
        // Nothing to wait on — disarm both watchdogs proactively.
        clearAllOutlineTimeouts();
        clearTotalTimeout();
        generatingRef.current = false;
        return;
      }

      store.getState().setGeneratingOutlines(pending);
      // Arm the watchdog for every outline we're about to process. Done as
      // a single batch right after the store push so timers cover exactly
      // the set the UI sees as "generating".
      for (const outline of pending) startOutlineTimeout(outline);
      // Start the 15-minute batch watchdog too — covers edge cases where
      // the per-outline timer misses (e.g. parallel content phase left
      // outlines stranded without the serial loop visiting them).
      startTotalTimeout();

      // Launch media generation in parallel — does not block content/action generation
      mediaAbortRef.current = new AbortController();
      generateMediaForOutlines(outlines, stage.id, mediaAbortRef.current.signal).catch((err) => {
        log.warn('Media generation error:', err);
      });

      // Get previousSpeeches from last completed scene
      let previousSpeeches: string[] = [];
      const sortedScenes = [...scenes].sort((a, b) => a.order - b.order);
      if (sortedScenes.length > 0) {
        const lastScene = sortedScenes[sortedScenes.length - 1];
          previousSpeeches = ((lastScene.actions || []) as Action[])
            .filter((a): a is SpeechAction => a.type === 'speech')
            .map((a) => a.text);
      }

      // #572: opt-in parallel content fetch. Concurrency is server-configured
      // (PARALLEL_SCENE_CONCURRENCY), default 0 = off, so out-of-box behaviour is
      // unchanged.
      const parallelConcurrency = Math.max(
        0,
        // Belt-and-suspenders: the value is already clamped server-side and again
        // in the settings store; re-clamp here so a stale/garbage store value can
        // never spawn an unbounded fetch fan-out.
        Math.floor(useSettingsStore.getState().parallelSceneConcurrency ?? 0),
      );
      const useParallelContent = parallelConcurrency > 1 && pending.length > 1;

      // Pipelined generation loop (#572). When parallelism is on, scene *content*
      // fetches are kicked off up front with bounded concurrency (lazyBoundedMap)
      // but CONSUMED IN ORDER inside the serial loop below — there is no barrier.
      // So the first scene paints after content(1)+actions(1)+TTS(1) (same as
      // serial) while later content fetches run hidden behind earlier scenes'
      // actions/TTS. Content has no cross-scene dependency, so running it ahead is
      // safe; actions + TTS stay strictly serial to preserve previousSpeeches
      // threading and the pause-on-failure UX. With parallelism off this is exactly
      // the original one-at-a-time loop.
      try {
        const fetchContent = (outline: SceneOutline) =>
          fetchSceneContent(
            {
              outline,
              allOutlines: outlines,
              stageId: stage.id,
              pdfImages: params.pdfImages,
              imageMapping: params.imageMapping,
              stageInfo: params.stageInfo,
              agents: params.agents,
              languageDirective: params.languageDirective,
            },
            signal,
          );

        // Pre-warm content fetches (<= parallelConcurrency in flight), keyed by
        // outline id. Each promise resolves to a result and never rejects, so an
        // unexpected throw routes through the same mark-failed path as the serial
        // loop instead of taking sibling fetches down with it.
        const contentPromises = useParallelContent
          ? new Map(
              lazyBoundedMap(
                pending,
                parallelConcurrency,
                async (outline): Promise<SceneContentResult> => {
                  options.onPhaseChange?.('content', outline);
                  try {
                    return await fetchContent(outline);
                  } catch (err) {
                    return {
                      success: false,
                      error: err instanceof Error ? err.message : 'Content generation failed',
                    };
                  }
                },
                {
                  shouldContinue: () =>
                    !abortRef.current && store.getState().generationEpoch === startEpoch,
                },
              ).map((promise, i) => [pending[i].id, promise] as const),
            )
          : null;

        let pausedByFailureOrAbort = false;
        let hadContentFailure = false;
        for (const outline of pending) {
          if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          store.getState().setCurrentGeneratingOrder(outline.order);

          // Step 1: content — await this outline's pre-warmed fetch (parallel),
          // which usually resolved while the previous scene's actions/TTS ran; or
          // fetch it now (serial).
          let contentResult: SceneContentResult;
          if (contentPromises) {
            contentResult = (await contentPromises.get(outline.id)) ?? {
              success: false,
              error: 'Content generation failed',
            };
          } else {
            options.onPhaseChange?.('content', outline);
            contentResult = await fetchContent(outline);
          }

          if (!contentResult.success || !contentResult.content) {
            if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            markOutlineFailed(outline);
            options.onSceneFailed?.(outline, contentResult.error || 'Content generation failed');
            if (contentPromises) {
              // Parallel: surface the failure but keep going with the other scenes
              // (their content is already in flight).
              hadContentFailure = true;
              removeGeneratingOutline(outline.id);
              continue;
            }
            // Serial: pause the batch (unchanged behaviour).
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          // Step 2: Generate actions + assemble scene
          options.onPhaseChange?.('actions', outline);
          const actionsResult = await fetchSceneActions(
            {
              outline: contentResult.effectiveOutline || outline,
              allOutlines: outlines,
              content: contentResult.content,
              stageId: stage.id,
              agents: params.agents,
              previousSpeeches,
              userProfile: params.userProfile,
              languageDirective: params.languageDirective,
            },
            signal,
          );

          if (actionsResult.success && actionsResult.scene) {
            const scene = actionsResult.scene;
            const settings = useSettingsStore.getState();

            // TTS generation — failure means the whole scene fails
            if (
              settings.ttsEnabled &&
              settings.ttsProviderId !== 'browser-native-tts' &&
              isTTSProviderEnabled(
                settings.ttsProviderId,
                settings.ttsProvidersConfig?.[settings.ttsProviderId],
              )
            ) {
              const ttsResult = await generateTTSForScene(
                scene,
                params.languageDirective || params.stageInfo.language,
                signal,
              );
              if (!ttsResult.success) {
                if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
                  pausedByFailureOrAbort = true;
                  break;
                }
                markOutlineFailed(outline);
                options.onSceneFailed?.(outline, ttsResult.error || 'TTS generation failed');
                store.getState().setGenerationStatus('paused');
                pausedByFailureOrAbort = true;
                break;
              }
            }

            // Epoch changed — stage switched, discard this scene
            if (store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }

            removeGeneratingOutline(outline.id);
            store.getState().addScene(scene);
            options.onSceneGenerated?.(scene, outline.order);
            previousSpeeches = actionsResult.previousSpeeches || [];
          } else {
            if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            markOutlineFailed(outline);
            options.onSceneFailed?.(outline, actionsResult.error || 'Actions generation failed');
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }
        }

        if (!abortRef.current && !pausedByFailureOrAbort) {
          if (hadContentFailure) {
            // Parallel content phase left some outlines failed but kept going;
            // surface them for retry instead of signalling a clean completion.
            store.getState().setGenerationStatus('paused');
            // Failure path: disarm any watchdog still in flight (outlines
            // that didn't get visited will stay failed/pending in store).
            clearAllOutlineTimeouts();
            clearTotalTimeout();
          } else {
            store.getState().setGenerationStatus('completed');
            store.getState().setGeneratingOutlines([]);
            store.getState().setGenerationComplete(true);
            options.onComplete?.();
            fireAndForgetAutoSave(stage.id);
            // Clean completion: disarm both watchdogs so no late firing
            // can race the auto-save toast.
            clearAllOutlineTimeouts();
            clearTotalTimeout();
          }
        }
      } catch (err: unknown) {
        // AbortError is expected when stop() is called — don't treat as failure
        if (isAbortError(err)) {
          log.info('Generation aborted');
          store.getState().setGenerationStatus('paused');
        } else {
          throw err;
        }
      } finally {
        generatingRef.current = false;
        fetchAbortRef.current = null;
        // Always disarm watchdogs in finally — covers both the success
        // path (already cleared above) and the abort/throw path so we
        // never leave a 3-minute or 15-minute timer ticking after the
        // user has navigated away or stop() was called.
        clearAllOutlineTimeouts();
        clearTotalTimeout();
      }
    },
    [options, store],
  );

  // Keep ref in sync so retrySingleOutline can call it
  generateRemainingRef.current = generateRemaining;

  const stop = useCallback(() => {
    abortRef.current = true;
    store.getState().bumpGenerationEpoch();
    fetchAbortRef.current?.abort();
    mediaAbortRef.current?.abort();
    // user-initiated stop: disarm watchdogs immediately so we don't keep
    // a 3-minute timer alive after they've already given up.
    clearAllOutlineTimeouts();
    clearTotalTimeout();
  }, [store]);

  const isGenerating = useCallback(() => generatingRef.current, []);

  /** Retry a single failed outline from scratch (content → actions → TTS). */
  const retrySingleOutline = useCallback(
    async (outlineId: string) => {
      const state = store.getState();
      const outline = state.failedOutlines.find((o) => o.id === outlineId);
      const params = lastParamsRef.current;
      if (!outline || !state.stage || !params) return;

      // Regen-lock (#571): never silently replace a scene that is open in
      // edit mode. Failed outlines have no completed scene yet so this is
      // structurally a no-op today, but the guard is in place for the
      // moment a "regenerate a successful scene" path routes through here.
      const lockedScene = state.scenes.find((s) => s.order === outline.order);
      if (
        lockedScene &&
        isSceneEditLocked({
          sceneId: lockedScene.id,
          mode: state.mode,
          currentSceneId: state.currentSceneId,
        })
      ) {
        return;
      }

      const removeGeneratingOutline = () => {
        const current = store.getState().generatingOutlines;
        if (!current.some((o) => o.id === outlineId)) return;
        store.getState().setGeneratingOutlines(current.filter((o) => o.id !== outlineId));
        // Disarm the watchdog on the success path. markOutlineFailed
        // does this for failure paths; this wrapper only fires on success.
        clearOutlineTimeout(outlineId);
        // If this retry was the last outline in flight, disarm the batch
        // watchdog too — it has done its job for this run.
        if (store.getState().generatingOutlines.length === 0) {
          clearTotalTimeout();
        }
      };

      // Remove from failed list and mark as generating
      store.getState().retryFailedOutline(outlineId);
      store.getState().setGenerationStatus('generating');
      const currentGenerating = store.getState().generatingOutlines;
      if (!currentGenerating.some((o) => o.id === outline.id)) {
        store.getState().setGeneratingOutlines([...currentGenerating, outline]);
      }
      // Arm the per-outline watchdog for this retry. startOutlineTimeout
      // is idempotent — clears any prior timer for the same id before
      // arming a new one, so the 3-minute budget restarts cleanly.
      startOutlineTimeout(outline);
      // A retry can also trigger the batch watchdog if no other generation
      // is in flight. Safe to call repeatedly: startTotalTimeout clears
      // any prior timer before arming.
      startTotalTimeout();

      const abortController = new AbortController();
      const signal = abortController.signal;

      try {
        // Step 1: Content
        const contentResult = await fetchSceneContent(
          {
            outline,
            allOutlines: state.outlines,
            stageId: state.stage.id,
            pdfImages: params.pdfImages,
            imageMapping: params.imageMapping,
            stageInfo: params.stageInfo,
            agents: params.agents,
            languageDirective: params.languageDirective,
          },
          signal,
        );

        if (!contentResult.success || !contentResult.content) {
          markOutlineFailed(outline);
          return;
        }

        // Step 2: Actions
        const sortedScenes = [...store.getState().scenes].sort((a, b) => a.order - b.order);
        const lastScene = sortedScenes[sortedScenes.length - 1];
        const previousSpeeches = lastScene
          ? ((lastScene.actions || []) as Action[])
              .filter((a): a is SpeechAction => a.type === 'speech')
              .map((a) => a.text)
          : [];

        const actionsResult = await fetchSceneActions(
          {
            outline: contentResult.effectiveOutline || outline,
            allOutlines: state.outlines,
            content: contentResult.content,
            stageId: state.stage.id,
            agents: params.agents,
            previousSpeeches,
            userProfile: params.userProfile,
            languageDirective: params.languageDirective,
          },
          signal,
        );

        if (!actionsResult.success || !actionsResult.scene) {
          markOutlineFailed(outline);
          return;
        }

        // Step 3: TTS
        const settings = useSettingsStore.getState();
        if (
          settings.ttsEnabled &&
          settings.ttsProviderId !== 'browser-native-tts' &&
          isTTSProviderEnabled(
            settings.ttsProviderId,
            settings.ttsProvidersConfig?.[settings.ttsProviderId],
          )
        ) {
          const ttsResult = await generateTTSForScene(
            actionsResult.scene,
            params.languageDirective || params.stageInfo.language,
            signal,
          );
          if (!ttsResult.success) {
            markOutlineFailed(outline);
            return;
          }
        }

        removeGeneratingOutline();
        store.getState().addScene(actionsResult.scene);

        // Resume remaining generation if there are pending outlines
        if (store.getState().generatingOutlines.length > 0 && lastParamsRef.current) {
          generateRemainingRef.current?.(lastParamsRef.current);
        } else {
          // This retry may have materialized the final outstanding slide. The
          // generateRemaining completion path is not reached on the retry flow,
          // so mark completion here too — otherwise a later delete would treat
          // the orphaned outline as pending and regenerate it.
          store.getState().markGenerationCompleteIfDone();
        }
      } catch (err) {
        if (!isAbortError(err)) {
          markOutlineFailed(outline);
        }
      }
    },
    [store],
  );

  return { generateRemaining, retrySingleOutline, stop, isGenerating };
}
