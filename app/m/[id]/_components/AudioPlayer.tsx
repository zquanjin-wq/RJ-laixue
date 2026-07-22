'use client';

/**
 * _components/AudioPlayer.tsx
 *
 * Mini audio player for one chapter on mobile.
 *
 * Primary path: play pre-rendered audio from speechAction.audioUrl
 * (set during course publish via publishSceneAudioAssets).
 *
 * If audioUrl is missing, this means the course was not properly
 * published with audio assets. We show a clear error instead of
 * silently falling back to real-time TTS — TTS generation belongs
 * in the admin publish pipeline, not on the learner's device.
 *
 * Error states are classified into specific types so the learner (and
 * admin debugging via console) knows exactly what went wrong.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Error classification ───────────────────────────────────────

export type MobileAudioErrorType =
  | 'missing-audio-url'       // scene has no speech action audio (publish gap)
  | 'audio-load-error'        // <audio> element onError fired
  | 'network-error'           // network issue loading audioUrl
  | 'unsupported-format';     // audio format not playable by browser

/** Human-readable messages for each error type. */
const ERROR_MESSAGES: Record<MobileAudioErrorType, string> = {
  'missing-audio-url': '该课程语音资源尚未就绪，请联系管理员重新发布',
  'audio-load-error': '音频加载失败，请检查网络后重试',
  'network-error': '网络异常，无法加载语音',
  'unsupported-format': '音频格式不支持，请尝试其他浏览器',
};

interface AudioPlayerProps {
  audioUrl?: string;
  /** Full chapter narration text — kept for display/logging only. */
  fallbackText: string;
  rate: 1 | 0.75 | 1.25 | 1.5 | 2;
  onRateChange: (r: 1 | 0.75 | 1.25 | 1.5 | 2) => void;
  onTimeUpdate: (seconds: number) => void;
  onEnded: () => void;
  registerAudio: (el: HTMLAudioElement | null) => void;
  /** Scene ID for dev logging. */
  sceneId?: string;
  /** Stage ID for dev logging. */
  stageId?: string;
  /** Which field provided the audioUrl — for diagnostics. */
  audioSourceField?: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function AudioPlayer({
  audioUrl,
  fallbackText,
  rate,
  onRateChange,
  onTimeUpdate,
  onEnded,
  registerAudio,
  sceneId,
  stageId,
  audioSourceField,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState<MobileAudioErrorType | null>(null);

  // ─── Dev log: Audio Source diagnostics ──────────────────────
  useEffect(() => {
    console.log('[MOBILE LEARN][Audio Source]', JSON.stringify({
      stageId: stageId ?? '(unknown)',
      sceneId: sceneId ?? '(unknown)',
      sceneTitle: fallbackText.slice(0, 60),
      fallbackTextLength: fallbackText.length,
      hasAudioUrl: !!audioUrl,
      audioUrlLength: audioUrl?.length ?? 0,
      audioSourceField: audioUrl
        ? (audioSourceField ?? 'SpeechAction.audioUrl (published)')
        : '(none — publish gap)',
      errorType: error ?? '(none)',
      timestamp: new Date().toISOString(),
    }));
  }, [stageId, sceneId, audioUrl, fallbackText, error, audioSourceField]);

  // ─── If no audioUrl, set error immediately (no auto-TTS) ─────
  useEffect(() => {
    if (!audioUrl) {
      setError('missing-audio-url');
      console.warn('[MOBILE LEARN][Audio Missing]', JSON.stringify({
        stageId: stageId ?? '(unknown)',
        sceneId: sceneId ?? '(unknown)',
        fallbackTextLength: fallbackText.length,
        timestamp: new Date().toISOString(),
      }));
    } else {
      setError(null);
    }
  }, [audioUrl]);

  // ─── Play / Pause toggle ───────────────────────────────────
  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;

    if (el.paused) {
      console.log('[MOBILE AUDIO][Before Play (user click)]', JSON.stringify({
        sceneId: sceneId ?? '(unknown)',
        audioUrl: el.src?.slice(0, 80),
        audioUrlLength: audioUrl?.length ?? 0,
        hasAudioElement: !!el,
        paused: el.paused,
        readyState: el.readyState,
        networkState: el.networkState,
        currentTime: el.currentTime,
        duration: el.duration,
        timestamp: new Date().toISOString(),
      }));
      el.play().then(() => {
        console.log('[MOBILE AUDIO][Play Success (user click)]', JSON.stringify({
          sceneId: sceneId ?? '(unknown)',
          audioUrl: el.src?.slice(0, 80),
          currentTime: el.currentTime,
          duration: el.duration,
          readyState: el.readyState,
          networkState: el.networkState,
          timestamp: new Date().toISOString(),
        }));
      }).catch((err) => {
        console.warn('[MOBILE AUDIO][Play Failed (user click)]', JSON.stringify({
          sceneId: sceneId ?? '(unknown)',
          audioUrl: el.src?.slice(0, 80),
          errorName: err instanceof Error ? err.name : String(err),
          errorMessage: err instanceof Error ? err.message : String(err),
          readyState: el.readyState,
          networkState: el.networkState,
          timestamp: new Date().toISOString(),
        }));
        const msg = String(err).toLowerCase();
        if (msg.includes('not allowed')) {
          setError('network-error');
        } else if (msg.includes('not supported') || msg.includes('format')) {
          setError('unsupported-format');
        } else {
          setError('audio-load-error');
        }
      });
    } else {
      el.pause();
    }
  }, [sceneId, audioUrl]);

  // Apply rate to the audio element whenever it changes.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  // Expose audio element ref upward so parent can pause / resume on dialog.
  useEffect(() => {
    registerAudio(audioRef.current);
    return () => registerAudio(null);
  }, [registerAudio]);

  // === Render: No audioUrl → clear error state ===
  if (!audioUrl) {
    return (
      <div className="mx-auto max-w-md w-full px-4 py-4 border-t text-center">
        <p className="text-sm text-muted-foreground font-medium">
          🎧 该章节暂无语音
        </p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          课程语音资源未发布到云端，管理员需要重新保存课程以生成语音。
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          您可以阅读下方的文字稿学习本章节内容。
        </p>
        {process.env.NODE_ENV === 'development' && (
          <p className="mt-2 text-[10px] text-muted-foreground/50 break-all">
            [missing-audio-url] scene={sceneId?.slice(0, 12)} stage={stageId?.slice(0, 12)}
          </p>
        )}
      </div>
    );
  }

  // === Render: Normal player with audioUrl ===
  return (
    <div className="mx-auto max-w-md w-full px-4 py-3 border-t bg-background pb-safe">
      <audio
        key={audioUrl}
        ref={audioRef}
        src={audioUrl}
        preload="metadata"
        onLoadStart={(e) => {
          const el = e.currentTarget;
          console.log('[MOBILE AUDIO][loadstart]', JSON.stringify({
            sceneId: sceneId ?? '(unknown)',
            audioUrl: el.src?.slice(0, 80),
            readyState: el.readyState,
            networkState: el.networkState,
            timestamp: new Date().toISOString(),
          }));
        }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          console.log('[MOBILE AUDIO][loadedmetadata]', JSON.stringify({
            sceneId: sceneId ?? '(unknown)',
            audioUrl: el.src?.slice(0, 80),
            duration: el.duration,
            readyState: el.readyState,
            networkState: el.networkState,
            timestamp: new Date().toISOString(),
          }));
          setDuration(el.duration || 0);
          el.playbackRate = rate;
          console.log('[MOBILE AUDIO][Before Play]', JSON.stringify({
            sceneId: sceneId ?? '(unknown)',
            audioUrl: el.src?.slice(0, 80),
            audioUrlLength: audioUrl?.length ?? 0,
            hasAudioElement: !!el,
            paused: el.paused,
            readyState: el.readyState,
            networkState: el.networkState,
            currentTime: el.currentTime,
            duration: el.duration,
            timestamp: new Date().toISOString(),
          }));
          el.play().then(() => {
            console.log('[MOBILE AUDIO][Play Success]', JSON.stringify({
              sceneId: sceneId ?? '(unknown)',
              audioUrl: el.src?.slice(0, 80),
              currentTime: el.currentTime,
              duration: el.duration,
              readyState: el.readyState,
              networkState: el.networkState,
              playbackRate: el.playbackRate,
              timestamp: new Date().toISOString(),
            }));
          }).catch((err) => {
            console.warn('[MOBILE AUDIO][Play Failed]', JSON.stringify({
              sceneId: sceneId ?? '(unknown)',
              audioUrl: el.src?.slice(0, 80),
              errorName: err instanceof Error ? err.name : String(err),
              errorMessage: err instanceof Error ? err.message : String(err),
              readyState: el.readyState,
              networkState: el.networkState,
              timestamp: new Date().toISOString(),
            }));
            const msg = String(err).toLowerCase();
            if (msg.includes('not allowed')) {
              setError('network-error'); // autoplay blocked — treat as needs user interaction
            } else if (msg.includes('not supported') || msg.includes('format')) {
              setError('unsupported-format');
            } else {
              setError('audio-load-error');
            }
          });
        }}
        onCanPlay={(e) => {
          const el = e.currentTarget;
          console.log('[MOBILE AUDIO][canplay]', JSON.stringify({
            sceneId: sceneId ?? '(unknown)',
            audioUrl: el.src?.slice(0, 80),
            duration: el.duration,
            readyState: el.readyState,
            networkState: el.networkState,
            timestamp: new Date().toISOString(),
          }));
        }}
        onPlay={() => {
          setPlaying(true);
          console.log('[MOBILE AUDIO][playing]', JSON.stringify({
            sceneId: sceneId ?? '(unknown)',
            audioUrl: audioRef.current?.src?.slice(0, 80),
            currentTime: audioRef.current?.currentTime,
            duration: audioRef.current?.duration,
            timestamp: new Date().toISOString(),
          }));
        }}
        onPause={() => {
          setPlaying(false);
          console.log('[MOBILE AUDIO][pause]', JSON.stringify({
            sceneId: sceneId ?? '(unknown)',
            currentTime: audioRef.current?.currentTime,
            duration: audioRef.current?.duration,
            timestamp: new Date().toISOString(),
          }));
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          setCurrentTime(el.currentTime);
          onTimeUpdate(el.currentTime);
        }}
        onEnded={() => {
          setPlaying(false);
          console.log('[MOBILE AUDIO][ended]', JSON.stringify({
            sceneId: sceneId ?? '(unknown)',
            currentTime: audioRef.current?.currentTime,
            duration: audioRef.current?.duration,
            timestamp: new Date().toISOString(),
          }));
          onEnded();
        }}
        onError={(e) => {
          const el = e.currentTarget;
          console.warn('[MOBILE AUDIO][error]', JSON.stringify({
            sceneId: sceneId ?? '(unknown)',
            audioUrl: el.src?.slice(0, 80),
            errorCode: el.error?.code,
            errorMessage: el.error?.message,
            readyState: el.readyState,
            networkState: el.networkState,
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
      {error && error !== 'missing-audio-url' && (
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
