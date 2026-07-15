/**
 * lib/mobile/scene-helpers.ts
 *
 * Convert OPENMAIC Scene objects into the flat "podcast-style" structure
 * the mobile app consumes: one (narration_text, audio_url) tuple per
 * chapter. Skips quiz / interactive / pbl scenes' actions, using only
 * their text narration.
 */

import type { Scene } from '@/lib/types/stage';

export interface MobileChapter {
  /** Scene id (stable across visits). */
  sceneId: string;
  /** Scene title (chapter heading). */
  title: string;
  /** Scene order (0-based). */
  order: number;
  /** Scene type — used to flag "interactive skipped" pages. */
  sceneType: 'slide' | 'quiz' | 'interactive' | 'pbl';
  /** Concatenated narration text from all speech actions in order. */
  text: string;
  /** First available TTS audio URL across speech actions. */
  audioUrl?: string;
  /** First available audio id (used as cache key). */
  audioId?: string;
  /** Total seconds of audio (estimated if not pre-computed). */
  durationSec: number;
}

/**
 * Convert OPENMAIC Scene actions into a single narration string.
 * Sorts by `order` if present, otherwise preserves array order.
 */
function extractNarrationText(scene: Scene): string {
  const actions = scene.actions ?? [];
  const sorted = [...actions].sort((a, b) => {
    const ao = (a as { order?: number }).order ?? 0;
    const bo = (b as { order?: number }).order ?? 0;
    return ao - bo;
  });

  const lines: string[] = [];
  for (const a of sorted) {
    if ((a as { type?: string }).type === 'speech') {
      const text = (a as { text?: string }).text;
      if (text) lines.push(text);
    }
  }
  return lines.join(' ').trim();
}

/**
 * Find the first speech action that has an audio URL or audio id.
 */
function extractAudio(scene: Scene): { audioUrl?: string; audioId?: string } {
  const actions = scene.actions ?? [];
  for (const a of actions) {
    if ((a as { type?: string }).type === 'speech') {
      const url = (a as { audioUrl?: string }).audioUrl;
      const id = (a as { audioId?: string }).audioId;
      if (url || id) return { audioUrl: url, audioId: id };
    }
  }
  return {};
}

/**
 * Rough estimate when the scene has no pre-computed duration.
 * Chinese: ~4 characters/sec at 1x speech rate.
 * English: ~2.5 words/sec.
 */
function estimateDurationSec(text: string): number {
  const cn = (text.match(/[一-龥]/g) || []).length;
  const other = text.length - cn;
  return Math.max(3, Math.round(cn / 4 + other / 15));
}

/**
 * Convert an OPENMAIC scenes array (in the shape stored in
 * `public.courses.data.scenes`) into mobile chapters.
 */
export function buildChapters(scenes: Scene[]): MobileChapter[] {
  return scenes
    .map((s) => ({
      sceneId: s.id,
      title: s.title || `第 ${s.order + 1} 章`,
      order: s.order,
      sceneType: (s.type ?? 'slide') as MobileChapter['sceneType'],
      text: extractNarrationText(s),
      ...extractAudio(s),
    }))
    .map((c) => ({
      ...c,
      durationSec: estimateDurationSec(c.text),
    }));
}