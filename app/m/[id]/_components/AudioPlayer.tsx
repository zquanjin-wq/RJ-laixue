'use client';

/**
 * _components/AudioPlayer.tsx
 *
 * Mini audio player for one chapter. Three playback paths:
 *
 *   1. Pre-rendered audio (audioUrl) — <audio> element with rate
 *      control. Cheapest, no LLM / TTS cost at runtime.
 *
 *   2. No audio (no audioUrl) — fetch TTS on demand from the existing
 *      /api/generate/tts endpoint. Returns base64 audio, which we
 *      wrap into a Blob URL and feed to the <audio> element.
 *      Loading state shown while TTS is generating.
 *
 *   3. TTS generation failed — show inline error + a retry button.
 *
 * Rate is a single source of truth passed down from MobilePlayer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentModelConfig } from '@/lib/utils/model-config';

interface AudioPlayerProps {
  audioUrl?: string;
  audioId?: string;
  /** Text used for fallback TTS if audioUrl is missing. */
  fallbackText: string;
  rate: 1 | 0.75 | 1.25 | 1.5;
  onRateChange: (r: 1 | 0.75 | 1.25 | 1.5) => void;
  onTimeUpdate: (seconds: number) => void;
  onEnded: () => void;
  registerAudio: (el: HTMLAudioElement | null) => void;
}

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
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tts, setTts] = useState<TtsState>({ status: 'idle' });
  const ttsRequestIdRef = useRef(0);
  const blobUrlRef = useRef<string | null>(null);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) {
      setError('暂无语音');
      return;
    }
    if (el.paused) {
      el.play().catch((e) => setError(`播放失败：${String(e)}`));
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

  // === TTS fallback: if no audioUrl, request /api/generate/tts ===
  useEffect(() => {
    // Skip when audioUrl is provided (cheapest path).
    if (audioUrl) {
      // Tear down any prior TTS state.
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setTts({ status: 'idle' });
      return;
    }

    if (!fallbackText) {
      setTts({ status: 'error', error: '本章节没有文字稿' });
      return;
    }

    const reqId = ++ttsRequestIdRef.current;
    setTts({ status: 'loading' });

    // Build request body from the user's current provider config.
    const mc = getCurrentModelConfig();
    fetch('/api/generate/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: fallbackText.slice(0, 1500), // cap to avoid runaway cost
        audioId: audioId ?? `mobile-${Date.now()}`,
        ttsProviderId: mc.providerId,
        ttsVoice: 'female-yujie', // sensible default; settings store has user override
        ttsModelId: undefined,
        ttsSpeed: 1.0,
        ttsApiKey: mc.apiKey || undefined,
        ttsBaseUrl: mc.baseUrl || undefined,
      }),
    })
      .then(async (res) => {
        if (reqId !== ttsRequestIdRef.current) return; // stale
        if (!res.ok) {
          const errBody = await res.json().catch(() => null);
          throw new Error(errBody?.message || `HTTP ${res.status}`);
        }
        const json = await res.json();
        if (!json.success || !json.data?.base64) {
          throw new Error(json.message || 'TTS 返回数据缺失');
        }
        // Decode base64 → Blob → Blob URL
        const binary = atob(json.data.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const mime = json.data.format === 'mp3' ? 'audio/mpeg' : 'audio/mpeg';
        const blob = new Blob([bytes], { type: mime });
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setTts({ status: 'ready', blobUrl: url });
      })
      .catch((e) => {
        if (reqId !== ttsRequestIdRef.current) return;
        setTts({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      });
  }, [audioUrl, audioId, fallbackText]);

  // === Render TTS-loading state ===
  if (!audioUrl && tts.status === 'loading') {
    return (
      <div className="mx-auto max-w-md w-full px-4 py-4 border-t flex items-center justify-center text-sm text-muted-foreground gap-2">
        <span className="inline-block w-3 h-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
        正在生成语音…
      </div>
    );
  }

  if (!audioUrl && tts.status === 'error') {
    return (
      <div className="mx-auto max-w-md w-full px-4 py-3 border-t text-center">
        <p className="text-xs text-destructive">语音生成失败：{tts.error}</p>
        <button
          onClick={() => {
            // Force a re-fetch by toggling fallbackText identity
            setTts({ status: 'idle' });
          }}
          className="mt-2 text-xs text-primary underline"
        >
          重试
        </button>
      </div>
    );
  }

  // === Resolve the actual URL the audio element should play ===
  const effectiveSrc = audioUrl ?? tts.blobUrl;

  if (!effectiveSrc) {
    return (
      <div className="mx-auto max-w-md w-full px-4 py-4 border-t flex items-center justify-center text-sm text-muted-foreground">
        🎧 暂无语音 — 请阅读文字稿
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md w-full px-4 py-3 border-t bg-background">
      <audio
        key={effectiveSrc /* force remount when src changes — triggers autoplay for new track */}
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
          // Trigger autoplay after metadata loads (browsers won't autoplay
          // a freshly-mounted <audio> on its own).
          el.play().catch((err) => {
            setError(
              `自动播放失败，请按播放按钮（iOS 首次需手动开启）— ${String(err)}`,
            );
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
        onError={() => setError('语音加载失败')}
      />

      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          className="shrink-0 w-12 h-12 rounded-full bg-primary text-primary-foreground text-xl flex items-center justify-center"
          aria-label={playing ? '暂停' : '播放'}
        >
          {playing ? '⏸' : '▶'}
        </button>

        <div className="flex-1">
          <div className="h-1 bg-muted rounded overflow-hidden">
            <div
              className="h-full bg-primary transition-[width] duration-100"
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
            onRateChange(Number(e.target.value) as 1 | 0.75 | 1.25 | 1.5)
          }
          className="shrink-0 bg-muted text-foreground text-xs rounded px-2 py-1"
          aria-label="播放速度"
        >
          <option value="0.75">0.75x</option>
          <option value="1">1x</option>
          <option value="1.25">1.25x</option>
          <option value="1.5">1.5x</option>
        </select>
      </div>

      {error && (
        <p className="mt-2 text-xs text-destructive text-center">{error}</p>
      )}
    </div>
  );
}