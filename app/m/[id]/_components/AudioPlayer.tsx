'use client';

/**
 * _components/AudioPlayer.tsx
 *
 * Mini audio player for one chapter. Two playback paths:
 *
 *   1. Pre-rendered audio (audioUrl) — <audio> element with rate
 *      control. Cheapest, no LLM / TTS cost at runtime.
 *
 *   2. No audio (no audioUrl) — fetch TTS on demand from the
 *      /api/tts/mobile endpoint. The endpoint is intentionally
 *      not implemented yet (Phase 1.5); for now we show "暂无语音"
 *      and let the user read the text.
 *
 *  Rate is a single source of truth passed down from MobilePlayer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

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

export function AudioPlayer({
  audioUrl,
  audioId: _audioId,
  fallbackText: _fallbackText,
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

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) {
      setError('暂无预录语音，请联系管理员');
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

  if (!audioUrl) {
    return (
      <div className="mx-auto max-w-md w-full px-4 py-4 border-t flex items-center justify-center text-sm text-muted-foreground">
        🎧 暂无语音 — 请阅读文字稿
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md w-full px-4 py-3 border-t bg-background">
      <audio
        key={audioUrl /* force remount on src change so the browser loads + autoplays the new track */}
        ref={audioRef}
        src={audioUrl}
        preload="metadata"
        autoPlay
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          setDuration(el.duration || 0);
          el.playbackRate = rate;
          // Some browsers (iOS Safari) silently swallow autoPlay when no
          // user gesture has fired yet. We surface that to the user
          // rather than letting the UI lie about playback state.
          el.play().catch((err) => {
            setError(
              `自动播放失败，请按播放按钮（iOS 首次需要手动开启）— ${String(err)}`,
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