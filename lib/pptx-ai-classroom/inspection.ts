import type { Scene } from '@/lib/types/stage';

export interface PptxPageRepair {
  field: 'title';
  before: string;
  after: string;
  reason: 'placeholder_title' | 'normalize_whitespace';
  confidence: 'safe';
}

export interface PptxPageInspection {
  sceneId: string;
  page: number;
  title: string;
  visibleText: string[];
  speakerNotes: string | null;
  repairs: PptxPageRepair[];
  warnings: string[];
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  for (const key of ['text', 'content', 'value', 'html']) {
    const found = textValue(item[key]);
    if (found) return found;
  }
  return null;
}

function collectText(value: unknown, output: string[], depth = 0): void {
  if (depth > 5 || value == null) return;
  if (typeof value === 'string') {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized && normalized.length <= 800) output.push(normalized);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, output, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    const item = value as Record<string, unknown>;
    // Text-bearing fields only; walking arbitrary media metadata creates noisy titles.
    for (const key of ['text', 'content', 'richText', 'runs', 'children']) {
      if (key in item) collectText(item[key], output, depth + 1);
    }
  }
}

function normalizedTitle(value: string): string {
  return value.replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function isPlaceholderTitle(title: string, page: number): boolean {
  const normalized = normalizedTitle(title);
  return !normalized || normalized === `第 ${page} 页` || normalized === `Slide ${page}`;
}

/**
 * Inspects imported pages without rewriting their canvas. The result is a
 * checkpointable change-set so AI steps never silently alter the original deck.
 */
export function inspectImportedPptxPages(scenes: Scene[]): PptxPageInspection[] {
  return scenes.map((scene, index) => {
    const page = index + 1;
    const canvas = scene.content.type === 'slide' ? scene.content.canvas : undefined;
    const visibleText: string[] = [];
    if (canvas) collectText(canvas.elements, visibleText);
    const uniqueText = [...new Set(visibleText)];
    const originalTitle = scene.title ?? '';
    const cleanedTitle = normalizedTitle(originalTitle);
    const firstHeading = uniqueText.find((text) => text.length >= 2 && text.length <= 100);
    const repairs: PptxPageRepair[] = [];
    let title = cleanedTitle;
    if (isPlaceholderTitle(originalTitle, page) && firstHeading) {
      title = firstHeading;
      repairs.push({
        field: 'title',
        before: originalTitle,
        after: title,
        reason: 'placeholder_title',
        confidence: 'safe',
      });
    } else if (originalTitle !== cleanedTitle) {
      repairs.push({
        field: 'title',
        before: originalTitle,
        after: cleanedTitle,
        reason: 'normalize_whitespace',
        confidence: 'safe',
      });
    }
    const script = canvas ? textValue((canvas as unknown as Record<string, unknown>).script) : null;
    const warnings: string[] = [];
    if (!canvas) warnings.push('该页面不是可讲授的幻灯片，已跳过页面分析。');
    if (!uniqueText.length && !script) warnings.push('未识别到可讲授文本或讲者备注。');
    return { sceneId: scene.id, page, title, visibleText: uniqueText, speakerNotes: script, repairs, warnings };
  });
}

/** Applies only explicitly approved safe title repairs; canvas content stays untouched. */
export function applyPptxSafeTitleRepairs(
  scenes: Scene[],
  inspections: PptxPageInspection[],
): Scene[] {
  const bySceneId = new Map(inspections.map((inspection) => [inspection.sceneId, inspection]));
  return scenes.map((scene) => {
    const inspection = bySceneId.get(scene.id);
    const repair = inspection?.repairs.find((item) => item.field === 'title');
    return repair ? { ...scene, title: repair.after, updatedAt: Date.now() } : scene;
  });
}
