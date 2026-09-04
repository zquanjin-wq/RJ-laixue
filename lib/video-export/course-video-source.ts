import type { Slide } from '@openmaic/dsl';
import type {
  ClassroomManifest,
  ManifestAction,
  ManifestScene,
} from '@/lib/export/classroom-zip-types';

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

export interface CourseVideoSkippedScene {
  order: number;
  title: string;
  type: ManifestScene['type'];
  reason: string;
}

export interface CourseVideoExportPlan {
  totalScenes: number;
  includedCount: number;
  skippedCount: number;
  skippedScenes: CourseVideoSkippedScene[];
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

function skipReason(scene: ManifestScene): string | null {
  if (scene.type === 'quiz') return 'Quiz 需要学员作答';
  if (scene.type === 'interactive') return '互动内容需要学员操作';
  if (scene.type === 'pbl') return '项目任务需要学员参与';
  if (scene.actions?.some((action) => action.type === 'discussion')) {
    return '讨论环节需要学员参与';
  }
  return null;
}

export function planCourseVideoExport(manifest: ClassroomManifest): CourseVideoExportPlan {
  const scenes = [...manifest.scenes].sort((a, b) => a.order - b.order);
  const skippedScenes = scenes.flatMap((scene) => {
    const reason = skipReason(scene);
    if (!reason) return [];
    return [{ order: scene.order, title: scene.title, type: scene.type, reason }];
  });
  return {
    totalScenes: scenes.length,
    includedCount: scenes.length - skippedScenes.length,
    skippedCount: skippedScenes.length,
    skippedScenes,
  };
}

/**
 * Convert an existing classroom export into video-ready pages.
 *
 * Slides retain their real visual layout by going through the app's existing
 * browser snapshot renderer. Scenes that require learner participation are
 * omitted from both the visual and audio timeline.
 */
export async function prepareCourseVideoSource(
  manifest: ClassroomManifest,
  captureSlide: CaptureSlide,
): Promise<CourseVideoSource> {
  const pages: VideoSourcePage[] = [];
  const scenes = [...manifest.scenes].sort((a, b) => a.order - b.order);

  for (const scene of scenes) {
    if (skipReason(scene)) continue;
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
  }

  return { stageName: manifest.stage.name, pages };
}
