import { describe, expect, it, vi } from 'vitest';

const { uploadCourseDataUri } = vi.hoisted(() => ({
  uploadCourseDataUri: vi.fn(async (courseId: string, kind: string, value: string) =>
    `https://assets.example/courses/${courseId}/${kind}/${value.slice(5, 10)}`,
  ),
}));

vi.mock('@/lib/course-assets/client', () => ({ uploadCourseDataUri }));

import { externalizeCourseAssets } from '@/lib/course-assets/externalize';
import { prepareCourseForAssetUploads } from '@/lib/course-assets/prepare-course';

describe('externalizeCourseAssets', () => {
  it('replaces all supported data URIs without mutating the local course', async () => {
    const stage = { id: 'course-1', data: { imageMapping: { image: 'data:image/png;base64,AAA' } } };
    const scenes = [{
      id: 'scene-1',
      narrationAudioUrl: 'data:audio/mpeg;base64,BBB',
      actions: [{ audioUrl: 'data:audio/mpeg;base64,CCC' }],
    }];

    const result = await externalizeCourseAssets('course-1', stage, scenes);

    expect(uploadCourseDataUri).toHaveBeenCalledTimes(3);
    expect(result.converted).toEqual({ images: 1, audio: 2 });
    expect(((result.stage.data as { imageMapping: Record<string, string> }).imageMapping.image)).toMatch(/^https:\/\//);
    expect(result.scenes[0].narrationAudioUrl).toMatch(/^https:\/\//);
    expect((result.scenes[0].actions as Array<{ audioUrl: string }>)[0].audioUrl).toMatch(/^https:\/\//);
    expect(stage.data.imageMapping.image).toMatch(/^data:/);
    expect(scenes[0].narrationAudioUrl).toMatch(/^data:/);
  });

  it('does not upload already external URLs', async () => {
    uploadCourseDataUri.mockClear();
    const result = await externalizeCourseAssets('course-2', { data: { imageMapping: { image: 'https://x/image.png' } } }, [{ actions: [{ audioUrl: 'https://x/audio.mp3' }] }]);
    expect(uploadCourseDataUri).not.toHaveBeenCalled();
    expect(result.converted).toEqual({ images: 0, audio: 0 });
  });

  it('removes speech audio copied from another course before it can be republished', async () => {
    const stage = {
      teacherVoiceConfig: { providerId: 'minimax-tts', voiceId: 'male-qingnian' },
    };
    const scenes = [{
      actions: [{
        type: 'speech',
        audioId: 'tts_s1_reused-action',
        audioUrl: 'https://assets.example/storage/v1/object/public/course-assets/courses/other-course/audio/old.mp3',
      }],
    }];

    const result = await externalizeCourseAssets('course-4', stage, scenes);
    const speech = (result.scenes[0].actions as Array<Record<string, unknown>>)[0];

    expect(speech.audioUrl).toBeUndefined();
    expect(speech.audioId).toBeUndefined();
    expect(result.foreignAudioRemoved).toBe(1);
    expect(scenes[0].actions[0].audioUrl).toContain('other-course');
  });

  it('refuses to preserve a foreign audio URL when the course voice is unknown', async () => {
    await expect(
      externalizeCourseAssets('course-5', {}, [{
        actions: [{
          type: 'speech',
          audioUrl: 'https://assets.example/courses/other-course/audio/old.mp3',
        }],
      }]),
    ).rejects.toThrow('课堂阵容');
  });

  it('externalizes nested canvas media and reuses a single upload for duplicate data URIs', async () => {
    uploadCourseDataUri.mockClear();
    const inlineImage = 'data:image/png;base64,NESTED';
    const scene = {
      content: {
        type: 'slide',
        canvas: { elements: [{ id: 'image-1', props: { src: inlineImage } }, { id: 'image-2', src: inlineImage }] },
      },
    };

    const result = await externalizeCourseAssets('course-3', {}, [scene]);

    expect(uploadCourseDataUri).toHaveBeenCalledTimes(1);
    expect(result.converted).toEqual({ images: 1, audio: 0 });
    const elements = ((result.scenes[0].content as { canvas: { elements: Array<{ props?: { src?: string }; src?: string }> } }).canvas.elements);
    expect(elements[0].props?.src).toMatch(/^https:\/\//);
    expect(elements[1].src).toMatch(/^https:\/\//);
    expect((scene.content.canvas.elements[0].props?.src)).toBe(inlineImage);
  });
});

describe('prepareCourseForAssetUploads', () => {
  it('uses the final course namespace for revoice preparation of a new import', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        init?.method === 'POST' ? JSON.stringify({ success: true }) : '',
        { status: init?.method === 'POST' ? 200 : 404 },
      );
    }) as typeof fetch;
    try {
      await prepareCourseForAssetUploads({
        id: 'import-course',
        title: '导入课',
        topic: '',
        stage: { teacherVoiceConfig: { providerId: 'minimax-tts', voiceId: 'male-qingnian' } },
        scenes: [],
        outlines: [],
        forceCourseNamespace: true,
      });
      const post = calls.find((call) => call.init?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(String(post?.init?.body)).id).toBe('import-course');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
