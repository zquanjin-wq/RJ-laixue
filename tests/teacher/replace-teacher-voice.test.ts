import { beforeEach, describe, expect, it, vi } from 'vitest';

const publish = vi.fn();
const validate = vi.fn();
const stagePut = vi.fn();
const scenesPut = vi.fn();

vi.mock('@/lib/audio/audio-publish', () => ({
  publishSceneAudioAssets: publish,
  validatePublishedAudioAssets: validate,
}));
vi.mock('@/lib/course-assets/externalize', () => ({
  externalizeCourseAssets: vi.fn(async (_id, stage, scenes) => ({ stage, scenes })),
}));
vi.mock('@/lib/dsl-extensions/serialize', () => ({ stripRuntimeOnly: (value: unknown) => value }));
vi.mock('@/lib/utils/database', () => ({
  db: {
    stages: { put: stagePut },
    scenes: { bulkPut: scenesPut },
    transaction: vi.fn(async (_mode, _stages, _scenes, work) => work()),
  },
}));

const { replaceTeacherVoice } = await import('@/lib/teacher/replace-teacher-voice');

const stage = {
  id: 'course-1',
  name: '课程',
  teacherVoiceConfig: { providerId: 'minimax-tts', voiceId: 'old' },
};
const scenes = [
  {
    id: 'scene-1',
    stageId: 'course-1',
    type: 'slide',
    title: '第一课',
    order: 1,
    content: { type: 'slide', elements: [] },
    actions: [{ id: 'speech-1', type: 'speech', text: '你好', audioUrl: 'https://old' }],
  },
];
const voice = { providerId: 'minimax-tts', voiceId: 'new', modelId: 'speech-2.8-hd' };

describe('replaceTeacherVoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
    );
    publish.mockResolvedValue({ scenes, failed: [], missing: [] });
    validate.mockReturnValue({ ok: true, issues: [] });
  });

  it('prepares the old snapshot, force-regenerates, then commits the new snapshot', async () => {
    const result = await replaceTeacherVoice({
      stage: stage as never,
      scenes: scenes as never,
      outlines: [],
      voice,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    const finalBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(firstBody.saveState).toBe('draft');
    expect(firstBody.data.stage.teacherVoiceConfig.voiceId).toBe('old');
    expect(publish).toHaveBeenCalledWith('course-1', scenes, voice, { forceRegenerate: true });
    expect(finalBody.saveState).toBe('ready');
    expect(finalBody.data.stage.teacherVoiceConfig.voiceId).toBe('new');
    expect(result.stage).toMatchObject({ teacherVoiceConfig: voice });
  });

  it('does not commit the new course snapshot when audio generation is incomplete', async () => {
    publish.mockResolvedValue({ scenes, failed: [{ audioId: 'x' }], missing: [] });
    await expect(
      replaceTeacherVoice({ stage: stage as never, scenes: scenes as never, outlines: [], voice }),
    ).rejects.toThrow('课程仍保留原音色');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stagePut).not.toHaveBeenCalled();
  });

  it('still returns the cloud-committed snapshot when IndexedDB persistence fails', async () => {
    stagePut.mockRejectedValueOnce(new Error('quota'));
    const result = await replaceTeacherVoice({
      stage: stage as never,
      scenes: scenes as never,
      outlines: [],
      voice,
    });
    expect(result.localPersistenceSucceeded).toBe(false);
    expect(result.stage).toMatchObject({ teacherVoiceConfig: voice });
  });
});
