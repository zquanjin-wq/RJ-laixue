import { externalizeCourseAssets, type ExternalizedCourseAssets } from './externalize';

type RecordLike = Record<string, unknown>;

export interface CourseAssetPreparationInput {
  id: string;
  title: string;
  topic: string;
  stage: RecordLike;
  scenes: RecordLike[];
  outlines: unknown;
  /** Revoice preparation already owns the final course id, so avoid a pending namespace. */
  forceCourseNamespace?: boolean;
}

async function readCourseResponse(response: Response): Promise<void> {
  const text = await response.text();
  let body: { success?: boolean; error?: string } | null = null;
  try {
    body = JSON.parse(text) as { success?: boolean; error?: string };
  } catch {
    // Proxies can reject an oversized body before Next.js returns JSON.
  }

  if (!response.ok || !body?.success) {
    const detail = body?.error || text.slice(0, 200) || `HTTP ${response.status}`;
    throw new Error(`Course preparation failed: ${detail}`);
  }
}

function pendingAssetNamespace(): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '')
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `pending-${random.slice(0, 32)}`;
}

/**
 * Makes the snapshot safe to send through the deployment gateway before any
 * asset uploader needs a persistent course row. New courses upload their inline
 * assets to the authenticated pending namespace first, then create a compact
 * recoverable draft. Existing courses can upload directly to their namespace.
 */
export async function prepareCourseForAssetUploads(
  input: CourseAssetPreparationInput,
): Promise<ExternalizedCourseAssets> {
  const probe = await fetch(`/api/courses/${encodeURIComponent(input.id)}`, { method: 'GET' });
  if (!probe.ok && probe.status !== 404) {
    throw new Error(`Course preparation failed: cloud probe returned HTTP ${probe.status}`);
  }

  const assetNamespace = input.forceCourseNamespace || probe.status !== 404
    ? input.id
    : pendingAssetNamespace();

  // A revoice task for an imported course owns the final course id from the
  // outset. Create a minimal row before requesting upload signatures: the
  // sign-upload API deliberately refuses `courses/<id>/...` paths whose
  // course row does not exist. This shell contains no scene payload or inline
  // assets, so it remains comfortably below the deployment request limit.
  if (input.forceCourseNamespace && probe.status === 404) {
    const shell = await fetch('/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: input.id,
        title: input.title,
        topic: input.topic,
        saveState: 'draft',
        data: { stage: input.stage, scenes: [], outlines: [] },
      }),
    });
    await readCourseResponse(shell);
  }
  const externalized = await externalizeCourseAssets(assetNamespace, input.stage, input.scenes);

  const create = await fetch('/api/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: input.id,
      title: input.title,
      topic: input.topic,
      saveState: 'draft',
      data: {
        stage: externalized.stage,
        scenes: externalized.scenes,
        outlines: input.outlines,
      },
    }),
  });
  await readCourseResponse(create);

  return externalized;
}
