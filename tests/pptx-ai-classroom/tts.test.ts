import { describe, expect, it } from 'vitest';
import { TTSRateLimitError } from '@/lib/audio/tts-providers';
import type { Scene } from '@/lib/types/stage';
import {
  applyPptxSpeechAudio,
  listPptxSpeechTargets,
  withPptxTtsRetry,
} from '@/lib/pptx-ai-classroom/tts';

describe('PPTX narration audio mapping', () => {
  it('targets only non-empty speech actions and never attaches audio to a different action', () => {
    const scenes = [
      {
        id: 'scene-1',
        actions: [
          { id: 'focus', type: 'spotlight', elementId: 'e1' },
          { id: 'speech-1', type: 'speech', text: '欢迎学习。' },
          { id: 'empty', type: 'speech', text: '  ' },
        ],
      },
    ] as unknown as Scene[];
    expect(listPptxSpeechTargets(scenes)).toEqual([
      { sceneId: 'scene-1', actionId: 'speech-1', text: '欢迎学习。' },
    ]);
    const applied = applyPptxSpeechAudio(
      scenes,
      new Map([['scene-1:speech-1', { audioId: 'audio-1', audioUrl: '/audio-1' }]]),
    );
    expect(applied[0].actions).toMatchObject([
      { id: 'focus', type: 'spotlight', elementId: 'e1' },
      { id: 'speech-1', type: 'speech', audioId: 'audio-1', audioUrl: '/audio-1' },
      { id: 'empty', type: 'speech' },
    ]);
  });

  it('backs off and retries provider RPM limits without restarting the course job', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withPptxTtsRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new TTSRateLimitError('minimax-tts', 'rate limit exceeded', 5);
        }
        return 'audio-ready';
      },
      { sleep: async (delayMs) => void delays.push(delayMs) },
    );

    expect(result).toBe('audio-ready');
    expect(calls).toBe(3);
    expect(delays).toEqual([10_000, 20_000]);
  });

  it('does not retry permanent TTS failures', async () => {
    let calls = 0;
    await expect(
      withPptxTtsRetry(
        async () => {
          calls += 1;
          throw new Error('invalid voice id');
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow('invalid voice id');
    expect(calls).toBe(1);
  });
});
