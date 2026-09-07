import { describe, expect, it } from 'vitest';
import { applyPptxSpeechAudio, listPptxSpeechTargets } from '@/lib/pptx-ai-classroom/tts';

describe('PPTX narration audio mapping', () => {
  it('targets only non-empty speech actions and never attaches audio to a different action', () => {
    const scenes: any[] = [
      {
        id: 'scene-1',
        actions: [
          { id: 'focus', type: 'spotlight', elementId: 'e1' },
          { id: 'speech-1', type: 'speech', text: '欢迎学习。' },
          { id: 'empty', type: 'speech', text: '  ' },
        ],
      },
    ];
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
});
