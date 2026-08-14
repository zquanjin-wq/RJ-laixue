import { describe, expect, it } from 'vitest';
import { mergeRevoiceResults } from '@/lib/server/course-revoice-jobs';

const voice = { providerId: 'minimax-tts', voiceId: 'male-qn-qingse' };

describe('mergeRevoiceResults', () => {
  it('keeps edits made while a revoice task was running', () => {
    const result = mergeRevoiceResults(
      {
        stage: { id: 'course-1', name: 'Latest title' },
        scenes: [
          {
            id: 'scene-1',
            actions: [
              { id: 'edited', type: 'speech', text: 'teacher changed this line' },
              { id: 'same', type: 'speech', text: 'unchanged line' },
              { id: 'new', type: 'speech', text: 'newly added line' },
            ],
          },
        ],
        outlines: [],
      },
      [
        {
          sceneId: 'scene-1',
          actionId: 'edited',
          text: 'old text',
          status: 'done',
          audioId: 'old-result',
          audioUrl: 'https://cdn.example/old-result.mp3',
        },
        {
          sceneId: 'scene-1',
          actionId: 'same',
          text: 'unchanged line',
          status: 'done',
          audioId: 'new-result',
          audioUrl: 'https://cdn.example/new-result.mp3',
        },
      ],
      voice,
    );

    const actions = result.scenes[0].actions as Array<Record<string, unknown>>;
    expect(actions[0]).not.toHaveProperty('audioUrl');
    expect(actions[1]).toMatchObject({
      audioId: 'new-result',
      audioUrl: 'https://cdn.example/new-result.mp3',
    });
    expect(actions[2]).not.toHaveProperty('audioUrl');
    expect(result.stage).toMatchObject({ teacherVoiceConfig: voice, name: 'Latest title' });
  });
});
