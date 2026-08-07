import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { throwIfTtsRateLimited, TTSRateLimitError } from '@/lib/audio/tts-providers';

describe('throwIfTtsRateLimited', () => {
  it('throws a typed TTSRateLimitError on HTTP 429', () => {
    expect(() => throwIfTtsRateLimited('OpenAI', 429)).toThrow(TTSRateLimitError);
    try {
      throwIfTtsRateLimited('OpenAI', 429);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TTSRateLimitError);
      expect((e as TTSRateLimitError).provider).toBe('OpenAI');
    }
  });

  it('does not throw on non-429 statuses', () => {
    expect(() => throwIfTtsRateLimited('OpenAI', 200)).not.toThrow();
    expect(() => throwIfTtsRateLimited('OpenAI', 401)).not.toThrow();
    expect(() => throwIfTtsRateLimited('OpenAI', 500)).not.toThrow();
    expect(() => throwIfTtsRateLimited('OpenAI', 503)).not.toThrow();
  });

  it('TTSRateLimitError carries provider and retryAfterSec', () => {
    const e = new TTSRateLimitError('minimax-tts', 'rate limited', 10);
    expect(e.provider).toBe('minimax-tts');
    expect(e.retryAfterSec).toBe(10);
    expect(e.name).toBe('TTSRateLimitError');
  });

  it('TTSRateLimitError defaults retryAfterSec to 5', () => {
    const e = new TTSRateLimitError('test', 'msg');
    expect(e.retryAfterSec).toBe(5);
  });
});

// ── MiniMax HTTP 200 + body error (Root Cause A) ─────────────────────────────

describe('generateTTS — MiniMax 200 + application-level errors', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', fetchSpy);
    // Mock env vars needed by generateTTS
    vi.stubEnv('TTS_MINIMAX_API_KEY', 'sk-test');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchSpy.mockReset();
  });

  function buildMinimaxConfig() {
    return {
      providerId: 'minimax-tts',
      modelId: 'speech-2.8-hd',
      voice: 'test-voice',
      speed: 1.0,
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimaxi.com',
    };
  }

  it('throws TTSRateLimitError when HTTP 200 + base_resp.status_code 1002', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 1002, status_msg: 'rate limit exceeded(RPM)' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { generateTTS, TTSRateLimitError: TTSRateLimitErr } = await import(
      '@/lib/audio/tts-providers'
    );
    try {
      await generateTTS(buildMinimaxConfig(), 'test text');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TTSRateLimitErr);
      expect((e as Error).message).toContain('rate limit');
    }
  });

  it('throws normal Error when HTTP 200 + base_resp.status_code is non-zero but not rate limit', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 1001, status_msg: 'invalid parameter' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { generateTTS, TTSRateLimitError: Err } = await import('@/lib/audio/tts-providers');
    try {
      await generateTTS(buildMinimaxConfig(), 'test text');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(Err);
      expect((e as Error).message).toContain('1001');
      expect((e as Error).message).toContain('invalid parameter');
    }
  });
});

// ── TTS Queue concurrency tests (Root Cause B) ───────────────────────────────

describe('ttsQueue', () => {
  it('enforces concurrency limit (≤ 3)', { timeout: 10000 }, async () => {
    const { ttsQueue } = await import('@/lib/audio/tts-queue');

    let inFlight = 0;
    let maxInFlight = 0;
    const done = new Set<number>();

    const tasks = Array.from({ length: 9 }, (_, i) => ({
      id: `task-${i}`,
      execute: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Simulate short API call
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        done.add(i);
        return new Response('ok', { status: 200 });
      },
    }));

    const results = await ttsQueue(tasks, { concurrency: 3 });

    // Concurrency never exceeded 3
    expect(maxInFlight).toBe(3);
    // All 9 tasks completed
    expect(done.size).toBe(9);
    expect(results).toHaveLength(9);
    results.forEach((r) => expect(r.status).toBe('ok'));
  });

  it('single task failure does not block other tasks', async () => {
    const { ttsQueue } = await import('@/lib/audio/tts-queue');

    const tasks = [
      {
        id: 'good-1',
        execute: async () => new Response('ok', { status: 200 }),
      },
      {
        id: 'bad',
        execute: async () => {
          throw new Error('network failure');
        },
      },
      {
        id: 'good-2',
        execute: async () => new Response('ok', { status: 200 }),
      },
    ];

    const results = await ttsQueue(tasks, { concurrency: 3, maxAttempts: 2 });

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBe('failed');
    expect(results[2].status).toBe('ok'); // Not blocked by task[1]
  });
});
