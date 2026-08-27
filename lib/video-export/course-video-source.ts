import type { QuizContent, Slide } from '@openmaic/dsl';
import type { ClassroomManifest, ManifestAction, ManifestScene } from '@/lib/export/classroom-zip-types';

/** A narration cue preserved from an exported classroom scene. */
export interface VideoNarrationCue {
  text: string;
  audioRef?: string;
}

/** A page that can be handed to the later render-ZIP compiler. */
export type VideoSourcePage =
  | {
      id: string;
      title: string;
      kind: 'slide';
      image: Blob;
      narration: VideoNarrationCue[];
    }
  | {
      id: string;
      title: string;
      kind: 'cover';
      body: string;
      narration: VideoNarrationCue[];
    };

export interface CourseVideoSource {
  stageName: string;
  pages: VideoSourcePage[];
}

/**
 * Browser-side bridge to the existing slide renderer. The production caller
 * will use `slideToPng`; keeping it injected makes this adapter independent of
 * React and directly testable.
 */
export type CaptureSlide = (slide: Slide) => Promise<Blob>;

type ManifestSpeechAction = ManifestAction & {
  type: 'speech';
  text: string;
  audioRef?: string;
};

function speechCues(actions: ManifestAction[] | undefined): VideoNarrationCue[] {
  return (actions ?? []).flatMap((action) => {
    if (action.type !== 'speech') return [];
    const speech = action as ManifestSpeechAction;
    return [{ text: speech.text, ...(speech.audioRef ? { audioRef: speech.audioRef } : {}) }];
  });
}

function coverBody(scene: ManifestScene): string {
  switch (scene.type) {
    case 'quiz':
      return `本节包含 ${(scene.content as QuizContent).questions.length} 道练习题，请在课堂中完成。`;
    case 'interactive':
      return '本节包含互动内容，请在课堂中完成。';
    case 'pbl':
      return '本节包含项目式学习活动，请在课堂中完成。';
    default:
      return '';
  }
}

/**
 * Convert an existing classroom export into video-ready pages.
 *
 * Slides retain their real visual layout by going through the app's existing
 * browser snapshot renderer. Quiz, interactive and PBL scenes deliberately
 * become clear static cover pages in V0 rather than pretending to record their
 * runtime interactions.
 */
export async function prepareCourseVideoSource(
  manifest: ClassroomManifest,
  captureSlide: CaptureSlide,
): Promise<CourseVideoSource> {
  const pages: VideoSourcePage[] = [];
  const scenes = [...manifest.scenes].sort((a, b) => a.order - b.order);

  for (const scene of scenes) {
    const id = `scene-${scene.order}`;
    const narration = speechCues(scene.actions);

    if (scene.type === 'slide') {
      pages.push({
        id,
        title: scene.title,
        kind: 'slide',
        image: await captureSlide((scene.content as { canvas: Slide }).canvas),
        narration,
      });
      continue;
    }

    pages.push({
      id,
      title: scene.title,
      kind: 'cover',
      body: coverBody(scene),
      narration,
    });
  }

  return { stageName: manifest.stage.name, pages };
}
