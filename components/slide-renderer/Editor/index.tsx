'use client';

import Canvas from './Canvas';
import type { StageMode } from '@/lib/types/stage';
import { ScreenCanvas } from './ScreenCanvas';
import { SceneProvider } from '@/lib/contexts/scene-context';

/**
 * Slide Editor - wraps Canvas with SceneProvider
 */
export function SlideEditor({ mode }: { readonly mode: StageMode }) {
  return (
    // SlideEditor owns the context required by both Canvas and ScreenCanvas.
    // It is also mounted during the playback→editor cross-fade, where relying
    // on a provider supplied by an ancestor made the exiting screen renderer
    // vulnerable to a provider-less render.
    <SceneProvider>
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-hidden">
          {mode === 'autonomous' ? <Canvas /> : <ScreenCanvas />}
        </div>
      </div>
    </SceneProvider>
  );
}
