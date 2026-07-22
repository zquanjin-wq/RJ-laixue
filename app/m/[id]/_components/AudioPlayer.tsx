'use client';

/**
 * _components/AudioPlayer.tsx
 *
 * Mini audio player for one chapter on mobile. Three playback paths:
 *
 *   1. Pre-rendered audio (audioUrl) — <audio> element with rate
 *      control. Cheapest, no LLM / TTS cost at runtime.
 *
 *   2. No audioUrl — fetch TTS on demand from /api/generate/tts.
 *      Long text is automatically chunked (respecting sentence boundaries)
 *      and each chunk is sent as a separate TTS request. The resulting
 *      audio blobs are concatenated so the learner hears the full chapter.
 *      Uses the course's teacherVoiceConfig for voice selection.
 *
 *   3. Error state — classified into 5 specific errorType values,
 *      each with its own Chinese message, retry button, and
 *      "仅阅读文字" hint.
 *
 * Rate is a single source of truth passed down from MobilePlayer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentModelConfig } from '@/lib/utils/model-config';

// ─── Error classification ───────────────────────────────────────

export type MobileAudioErrorType =
  | 'missing-audio-url'       // scene has no speech action audio
  | 'audio-load-error'        // <audio> element onError fired
  | 'tts-generation-pending'  // TTS is currently generating
  | 'network-error'           // fetch to /api/generate/tts failed
  | 'unsupported-format';     // audio format not playable

/** Human-readable messages for each error type. */
const ERROR_MESSAGES: Record<MobileAudioErrorType, string> = {
  'missing-audio-url': '当前章节暂无语音',
  'audio-load-error': '音频加载失败，请检查网络后重试',
  'tts-generation-pending': '语音正在生成中，请稍候…',
  'network-error': '网络异常，无法连接语音服务',
  'unsupported-format': '音频格式不支持，请尝试其他章节',
};

interface AudioPlayerProps {
  audioUrl?: string;
  audioId?: string;
  /** Full chapter narration text used for fallback TTS. */
  fallbackText: string;
  rate: 1 | 0.75 | 1.25 | 1.5 | 2;
  onRateChange: (r: 1 | 0.75 | 1.25 | 1.5 | 2) => void;
  onTimeUpdate: (seconds: number) => void;
  onEnded: () => void;
  registerAudio: (el: HTMLAudioElement | null) => void;
  /** Teacher voice config from course stage — used for TTS fallback. */
  teacherVoiceConfig?: {
    providerId: string;
    voiceId: string;
    modelId?: string;
  };
  /** Scene ID for dev logging. */
  sceneId?: string;
  /** Stage ID for dev logging. */
  stageId?: string;
}

// ─── TTS chunking ──────────────────────────────────────────────
//
// MiniMax TTS (and most providers) have an effective text length limit
// per request. Rather than sending the entire chapter text in one call
// (which causes the API to silently truncate output), we split into
// sentence-aware chunks and concatenate the resulting audio blobs.

/** Max characters per TTS request — conservative limit for MiniMax. */
const TTS_CHUNK_SIZE = 500;

/**
 * Split text into chunks that respect sentence boundaries (Chinese and
 * Western punctuation). Each chunk is at most TTS_CHUNK_SIZE chars.
 */
function splitTextForTTS(text: string): string[] {
  if (text.length <= TTS_CHUNK_SIZE) return [text];

  // Split on sentence-ending punctuation first
  const sentences = text.split(/(?<=[。！？!？；;：:\n])/u).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const s of sentences) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if ((current + trimmed).length <= TTS_CHUNK_SIZE) {
      current += trimmed;
    } else {
      if (current) chunks.push(current);
      // If a single sentence exceeds the limit, hard-split it
      if (trimmed.length > TTS_CHUNK_SIZE) {
        let remaining = trimmed;
        while (remaining.length > 0) {
          chunks.push(remaining.slice(0, TTS_CHUNK_SIZE));
          remaining = remaining.slice(TTS_CHUNK_SIZE);
        }
        current = '';
      } else {
        current = trimmed;
      }
    }
  }
  if (current) chunks.push(current);

  return chunks.length > 0 ? chunks : [text];
}

// ─── Helpers ────────────────────────────────────────────────────

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

interface TtsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  blobUrl?: string;
  error?: string;
  errorType?: MobileAudioErrorType;
}

export function AudioPlayer({
  audioUrl,
  audioId,
  fallbackText,
  rate,
  onRateChange,
  onTimeUpdate,
  onEnded,
  registerAudio,
  teacherVoiceConfig,
  sceneId,
  stageId,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState<MobileAudioErrorType | null>(null);
  const [tts, setTts] = useState<TtsState>({ status: 'idle' });
  const ttsRequestIdRef = useRef(0);
  const blobUrlRef = useRef<string | null>(null);

  // ─── Dev log: Audio Source diagnostics ──────────────────────
  useEffect(() => {
    console.log('[MOBILE LEARN][Audio Source]', JSON.stringify({
      stageId: stageId ?? '(unknown)',
      sceneId: sceneId ?? '(unknown)',
      sceneTitle: fallbackText.slice(0, 60),
      fallbackTextLength: fallbackText.length,
      hasAudioUrl: !!audioUrl,
      audioSourceField: audioUrl ? 'SpeechAction.audioUrl' : '(none)',
      hasTeacherVoiceConfig: !!teacherVoiceConfig,
      teacherVoiceProvider: teacherVoiceConfig?.providerId ?? '(none)',
      teacherVoiceId: teacherVoiceConfig?.voiceId ?? '(none)',
      errorType: error ?? '(none)',
      timestamp: new Date().toISOString(),
    }));
  }, [stageId, sceneId, audioUrl, fallbackText, teacherVoiceConfig, error]);

  // ─── Play / Pause toggle ───────────────────────────────────
  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) {
      setError('missing-audio-url');
      return;
    }
    if (el.paused) {
      el.play().catch((e) => {
        const msg = String(e).toLowerCase();
        if (msg.includes('not supported') || msg.includes('format')) {
          setError('unsupported-format');
        } else if (msg.includes('network') || msg.includes('fetch')) {
          setError('network-error');
        } else {
          setError('audio-load-error');
        }
      });
    } else {
      el.pause();
    }
  }, []);

  // Apply rate to the audio element whenever it changes.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  // Expose audio element ref upward so parent can pause / resume on dialog.
  useEffect(() => {
    registerAudio(audioRef.current);
    return () => registerAudio(null);
  }, [registerAudio]);

  // Revoke any prior blob URL when the chapter changes or we unmount.
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  // === TTS fallback: chunked requests + concatenation ===
  useEffect(() => {
    // Skip when audioUrl is provided (cheapest path).
    if (audioUrl) {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setTts({ status: 'idle' });
      setError(null);
      return;
    }

    if (!fallbackText) {
      setTts({
        status: 'error',
        error: '本章节没有文字稿',
        errorType: 'missing-audio-url',
      });
      setError('missing-audio-url');
      return;
    }

    const reqId = ++ttsRequestIdRef.current;
    setTts({ status: 'loading', errorType: 'tts-generation-pending' });
    setError('tts-generation-pending');

    const mc = getCurrentModelConfig();

    const ttsProviderId = teacherVoiceConfig?.providerId
      ? `${teacherVoiceConfig.providerId}-tts` as const
      : mc.providerId
        ? `${mc.providerId}-tts` as const
        : 'minimax-tts';
    const ttsVoice = teacherVoiceConfig?.voiceId ?? 'female-yujie';
    const ttsModelId = teacherVoiceConfig?.modelId;

    // Split long text into TTS-safe chunks
    const chunks = splitTextForTTS(fallbackText);

    console.info('[MOBILE LEARN][TTS Chunks]', JSON.stringify({
      totalTextLength: fallbackText.length,
      chunkCount: chunks.length,
      chunkLengths: chunks.map(c => c.length),
      sceneId: sceneId ?? '(unknown)',
      timestamp: new Date().toISOString(),
    }));

    // Send TTS requests sequentially (respects rate limits) and collect blobs
    const audioBlobs: Blob[] = [];

    async function processChunks() {
      for (let i = 0; i < chunks.length; i++) {
        // Check if request was superseded by a chapter switch
        if (reqId !== ttsRequestIdRef.current) return;

        const chunk = chunks[i];

        try {
          const res = await fetch('/api/generate/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: chunk,
              audioId: `${audioId ?? 'mobile'}_chunk${i}`,
              ttsProviderId,
              ttsVoice,
              ttsModelId,
              ttsSpeed: 1.0,
              ttsApiKey: mc.apiKey || undefined,
              ttsBaseUrl: mc.baseUrl || undefined,
            }),
          });

          if (!res.ok) {
            const errBody = await res.json().catch(() => null);
            console.warn('[MOBILE LEARN][TTS Chunk Error]', JSON.stringify({
              chunkIndex: i,
              status: res.status,
              statusText: res.statusText,
              responseBody: errBody,
              timestamp: new Date().toISOString(),
            }));
            // Treat non-429 errors as fatal for this chunk
            if (res.status !== 429) {
              throw new Error(errBody?.message || `HTTP ${res.status}`);
            }
            // 429: wait and retry once
            await new Promise(r => setTimeout(r, 2000));
            // Retry (once)
            const retryRes = await fetch('/api/generate/tts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: chunk,
                audioId: `${audioId ?? 'mobile'}_chunk${i}_retry`,
                ttsProviderId,
                ttsVoice,
                ttsModelId,
                ttsSpeed: 1.0,
                ttsApiKey: mc.apiKey || undefined,
                ttsBaseUrl: mc.baseUrl || undefined,
              }),
            });
            if (!retryRes.ok) throw new Error(`TTS chunk ${i} failed after retry`);
            const retryJson = await retryRes.json();
            if (!retryJson.success || !retryJson.data?.base64) throw new Error('TTS 返回数据缺失');

            const b64 = retryJson.data.base64;
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
            const format = retryJson.data.format ?? 'mp3';
            audioBlobs.push(new Blob([bytes], { type: format === 'mp3' ? 'audio/mpeg' : 'audio/mpeg' }));
          } else {
            const json = await res.json();
            if (!json.success || !json.data?.base64) {
              throw new Error(json.message || 'TTS 返回数据缺失');
            }

            const b64 = json.data.base64;
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
            const format = json.data.format ?? 'mp3';
            audioBlobs.push(new Blob([bytes], { type: format === 'mp3' ? 'audio/mpeg' : 'audio/mpeg' }));
          }

          // Small delay between chunks to avoid rate limiting
          if (i < chunks.length - 1) {
            await new Promise(r => setTimeout(r, 500));
          }

        } catch (e) {
          if (reqId !== ttsRequestIdRef.current) return;
          console.warn('[MOBILE LEARN][TTS Catch]', JSON.stringify({
            chunkIndex: i,
            completedChunks: audioBlobs.length,
            totalChunks: chunks.length,
            error: e instanceof Error ? e.message : String(e),
            timestamp: new Date().toISOString(),
          }));

          // If we already have some audio blobs, use what we have
          if (audioBlobs.length > 0) {
            console.info(`[MOBILE LEARN][TTS Partial] Using ${audioBlobs.length}/${chunks.length} chunks`);
            break;
          }
          throw e;
        }
      }

      // All chunks done (or partial) — concatenate blobs
      if (reqId !== ttsRequestIdRef.current) return;

      if (audioBlobs.length === 0) {
        throw new Error('没有成功生成任何音频片段');
      }

      const finalBlob = new Blob(audioBlobs, { type: 'audio/mpeg' });
      const url = URL.createObjectURL(finalBlob);

      console.log('[MOBILE LEARN][TTS Result]', JSON.stringify({
        totalChunks: chunks.length,
        completedChunks: audioBlobs.length,
        totalTextLength: fallbackText.length,
        finalBlobSize: finalBlob.size,
        format: 'mp3',
        timestamp: new Date().toISOString(),
      }));

      blobUrlRef.current = url;
      setTts({ status: 'ready', blobUrl: url });
      setError(null);
    }

    processChunks().catch((e) => {
      if (reqId !== ttsRequestIdRef.current) return;
      const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
      let errType: MobileAudioErrorType = 'network-error';
      if (msg.includes('rate limit') || msg.includes('429')) {
        errType = 'tts-generation-pending';
      } else if (msg.includes('not supported') || msg.includes('format')) {
        errType = 'unsupported-format';
      } else if (msg.includes('network') || msg.includes('fetch') || msg.includes('timeout')) {
        errType = 'network-error';
      }
      setTts({
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
        errorType: errType,
      });
      setError(errType);
    });
  }, [audioUrl, audioId, fallbackText, teacherVoiceConfig]);

  // === Render TTS-loading state ===
  if (!audioUrl && tts.status === 'loading') {
    return (
      <div className="mx-auto max-w-md w-full px-4 py-4 border-t flex items-center justify-center text-sm text-muted-foreground gap-2">
        <span className="inline-block w-3 h-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
        正在生成语音…
      </div>
    );
  }

  // === Render error state with classification ===
  if (!audioUrl && tts.status === 'error') {
    const errType = tts.errorType ?? 'network-error';
    const errMsg = ERROR_MESSAGES[errType] ?? tts.error ?? '语音加载失败';

    return (
      <div className="mx-auto max-w-md w-full px-4 py-3 border-t text-center">
        <p className="text-xs text-destructive font-medium">{errMsg}</p>
        <div className="mt-2 flex items-center justify-center gap-3">
          <button
            onClick={() => {
              setTts({ status: 'idle' });
              setError(null);
            }}
            className="text-xs text-primary underline font-medium"
          >
            重试
          </button>
          <span className="text-xs text-muted-foreground">或</span>
          <span className="text-xs text-muted-foreground">仅阅读下方文字稿</span>
        </div>
        {process.env.NODE_ENV === 'development' && tts.error && (
          <p className="mt-1 text-[10px] text-muted-foreground/50 break-all">
            [{errType}] {tts.error}
          </p>
        )}
      </div>
    );
  }

  // === Resolve the actual URL the audio element should play ===
  const effectiveSrc = audioUrl ?? tts.blobUrl;

  if (!effectiveSrc) {
    return (
      <div className="mx-auto max-w-md w-full px-4 py-4 border-t flex flex-col items-center justify-center text-sm text-muted-foreground gap-2">
        <span>🎧 暂无语音</span>
        <span className="text-xs">请阅读下方文字稿</span>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md w-full px-4 py-3 border-t bg-background pb-safe">
      <audio
        key={effectiveSrc}
        ref={audioRef}
        src={effectiveSrc}
        preload="metadata"
        autoPlay
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          setDuration(el.duration || 0);
          el.playbackRate = rate;
          el.play().catch((err) => {
            const msg = String(err).toLowerCase();
            if (msg.includes('not supported') || msg.includes('format')) {
              setError('unsupported-format');
            } else {
              setError('audio-load-error');
            }
          });
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          setCurrentTime(el.currentTime);
          onTimeUpdate(el.currentTime);
        }}
        onEnded={() => {
          setPlaying(false);
          onEnded();
        }}
        onError={(e) => {
          const el = e.currentTarget;
          console.warn('[MOBILE LEARN][Audio Element Error]', JSON.stringify({
            src: el.src?.slice(0, 80),
            error: el.error ? { code: el.error.code, message: el.error.message } : null,
            networkState: el.networkState,
            readyState: el.readyState,
            currentSrc: el.currentSrc?.slice(0, 80),
            timestamp: new Date().toISOString(),
          }));
          if (!error) setError('audio-load-error');
        }}
      />

      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          className="shrink-0 w-12 h-12 rounded-full bg-primary text-primary-foreground text-xl flex items-center justify-center active:scale-95 transition-transform"
          aria-label={playing ? '暂停' : '播放'}
          style={{ minHeight: '44px', minWidth: '44px' }}
        >
          {playing ? '⏸' : '▶'}
        </button>

        <div className="flex-1 min-w-0">
          <div
            className="h-1.5 bg-muted rounded-full overflow-hidden cursor-pointer active:bg-muted/80"
            role="slider"
            aria-label="播放进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={duration > 0 ? Math.round((currentTime / duration) * 100) : 0}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              if (audioRef.current && duration > 0) {
                audioRef.current.currentTime = frac * duration;
              }
            }}
          >
            <div
              className="h-full bg-primary rounded-full transition-[width] duration-100"
              style={{
                width:
                  duration > 0
                    ? `${Math.min(100, (currentTime / duration) * 100)}%`
                    : '0%',
              }}
            />
          </div>
          <div className="flex justify-between mt-1 text-[11px] text-muted-foreground tabular-nums">
            <span>{fmtTime(currentTime)}</span>
            <span>{fmtTime(duration)}</span>
          </div>
        </div>

        <select
          value={rate}
          onChange={(e) =>
            onRateChange(Number(e.target.value) as 1 | 0.75 | 1.25 | 1.5 | 2)
          }
          className="shrink-0 bg-muted text-foreground text-xs rounded px-2 py-1.5"
          aria-label="播放速度"
          style={{ minHeight: '44px' }}
        >
          <option value="0.75">0.75x</option>
          <option value="1">1x</option>
          <option value="1.25">1.25x</option>
          <option value="1.5">1.5x</option>
          <option value="2">2x</option>
        </select>
      </div>

      {/* Classified error message below player controls */}
      {error && (
        <p className="mt-2 text-xs text-destructive text-center">
          {ERROR_MESSAGES[error]}
          {' '}
          <button
            onClick={() => {
              setError(null);
              if (audioRef.current) {
                audioRef.current.load();
                audioRef.current.play().catch(() => {});
              }
            }}
            className="underline font-medium"
          >
            重试
          </button>
        </p>
      )}
    </div>
  );
}
