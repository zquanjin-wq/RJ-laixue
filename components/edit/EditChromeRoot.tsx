'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CloudUpload, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { EditShell } from '@/components/edit/EditShell';
import { SlideNavRail } from '@/components/edit/SlideNavRail';
import { ActionsBar } from '@/components/edit/ActionsBar/ActionsBar';
import { HeaderControls } from '@/components/stage/header-controls';
import { useAgentRuntime } from '@/lib/agent/client/use-agent-runtime';
import { useStageStore } from '@/lib/store';
import { renameStage } from '@/lib/utils/stage-storage';
import { saveStageToCloud } from '@/lib/utils/cloud-sync';
import { useAuth } from '@/lib/auth/use-auth';
import { isMaicEditorEnabled } from '@/lib/config/feature-flags';
import { preloadEditor } from '@/lib/edit/preload-editor';
import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
import { supportsNarrationTimeline } from './scene-timeline';
import type { Scene } from '@/lib/types/stage';
import { RightRailTabs } from '@/components/edit/RightRailTabs';

interface EditChromeRootProps {
  readonly scene: Scene;
  readonly isEditable: boolean;
  readonly onToggleEditMode?: () => void;
}

/**
 * Edit-mode root — wraps the Pro mode chrome assembly so `stage.tsx`
 * has a single component to mount in the edit branch instead of a
 * 13-line inline JSX with three children.
 *
 * Owned here: `EditShell` (Frame + CommandBar + canvas + overlays),
 * `SlideNavRail` (leftRail slot), the `HeaderControls` trailing
 * (settings pill + Pro Switch) that rides in CommandBar's right slot,
 * and the tabbed `RightRailTabs` (Edit with AI + 角色 roster).
 *
 * NOT owned here:
 * - `MultiTabEditConflictPrompt` — must mount even in playback mode so
 *   the lock-conflict dialog can be shown when entering edit mode is
 *   refused (mode is still 'playback' at that point).
 * - `useEditModeLock` — the lock is acquired by the Pro toggle in
 *   stage.tsx BEFORE the live session is torn down, so it can't live
 *   in a component that only mounts after the switch.
 *
 * `scene` is required (non-null). The parent gates mounting on
 * `mode === 'edit' && currentScene` to satisfy this contract.
 */
export function EditChromeRoot({ scene, isEditable, onToggleEditMode }: EditChromeRootProps) {
  const searchParams = useSearchParams();
  const stage = useStageStore((state) => state.stage);
  const { profile } = useAuth();
  const [savingToCloud, setSavingToCloud] = useState(false);
  const editorAutoOpen = searchParams?.get('editor') === '1';
  const canSaveToCloud =
    Boolean(stage) &&
    (editorAutoOpen || profile?.role === 'admin' || profile?.role === 'teacher');

  // Mark the body while edit mode is mounted, so the editor-scoped CSS
  // rule in globals.css that pins `body.padding-right` to 0 only fires
  // in Pro mode — not on non-editor pages where Radix's
  // react-remove-scroll compensation is still wanted. Lifted from
  // SlideCanvas (which was mounted only for slide scenes) so the
  // attribute now covers read-only scene types in Pro mode too.
  useEffect(() => {
    document.body.dataset.maicEditor = 'true';
    return () => {
      delete document.body.dataset.maicEditor;
    };
  }, []);

  // Safety net: the editor chunk (fonts + slide surface registration) is
  // normally preloaded by the Pro Switch handler in stage.tsx BEFORE mode
  // flips, so by the time we mount the surface is already registered and
  // EditShell resolves it immediately (no NOOP flash). This call is a
  // promise-cached no-op in that path; it only does real work if edit mode
  // is ever entered without going through the handler. Render is NOT gated
  // on it — the preload-before-flip contract keeps the chrome smooth.
  useEffect(() => {
    void preloadEditor();
  }, []);

  // Whether this scene type has a registered canvas editor surface (slide/quiz).
  // Authoring surface is separate from narration timeline availability.
  const authoringEnabled = !!sceneEditorRegistry.resolve(scene.type);
  // The narration timeline (ActionsBar) is decoupled from the canvas editor surface
  // (like agentEnabled below): it applies to registered surfaces (slide/quiz) AND
  // view-only canvases that still carry a spoken script (interactive/pbl).
  const timelineEnabled = supportsNarrationTimeline(scene.type, authoringEnabled);

  // The AI edit panel is decoupled from the canvas surface: it renders wherever
  // the agent has an edit capability — slides (regenerate) AND interactive scenes
  // (edit_interactive_html), even though the interactive canvas itself stays view-only.
  const agentEnabled = authoringEnabled || scene.type === 'interactive';

  // Keep the runtime owned by Pro mode chrome, not by the scene-capability gated
  // panel. Unsupported scene switches can hide/disable the composer without
  // destroying an in-flight run or the messages that still need to settle/save.
  const agentRuntime = useAgentRuntime({
    scene: agentEnabled ? { id: scene.id, title: scene.title } : undefined,
    isSendDisabled: !agentEnabled,
  });

  const headerControls = (
    <>
      {canSaveToCloud && (
        <button
          type="button"
          onClick={async () => {
            if (!stage || savingToCloud) return;
            setSavingToCloud(true);
            try {
              await saveStageToCloud(stage.id);
              toast.success('课程已保存到云端');
            } catch (error) {
              const message = error instanceof Error ? error.message : '未知错误';
              toast.error(`保存到云端失败：${message}`);
            } finally {
              setSavingToCloud(false);
            }
          }}
          disabled={savingToCloud || !stage}
          title={'\u4fdd\u5b58\u5230\u4e91\u7aef'}
          aria-label={'\u4fdd\u5b58\u5230\u4e91\u7aef'}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary px-2.5 text-xs font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:px-3"
        >
          {savingToCloud ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CloudUpload className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">{savingToCloud ? '\u4fdd\u5b58\u4e2d' : '\u4fdd\u5b58\u5230\u4e91\u7aef'}</span>
        </button>
      )}
      <HeaderControls
        mode="edit"
        canEdit={isEditable}
        // Same URL-only gate as components/stage.tsx — the MAIC Editor
        // exit button only appears while ?editor=1 is on the URL.
        onToggleEditMode={editorAutoOpen ? onToggleEditMode : undefined}
      />
    </>
  );

  return (
    <EditShell
      scene={scene}
      courseTitle={stage?.name || '未命名课程'}
      onCourseTitleChange={async (title) => {
        if (!stage) return;
        await renameStage(stage.id, title);
        useStageStore.setState({ stage: { ...stage, name: title, updatedAt: Date.now() } });
      }}
      leftRail={<SlideNavRail />}
      rightRail={
        <RightRailTabs
          scene={{ id: scene.id, title: scene.title, type: scene.type }}
          runtime={agentRuntime.runtime}
          clearThread={agentRuntime.clearThread}
          hasMessages={agentRuntime.hasMessages}
          canSend={agentEnabled}
          agentEnabled={agentEnabled}
          isRunning={agentRuntime.isRunning}
          sessions={agentRuntime.sessions}
          activeSessionId={agentRuntime.activeSessionId}
          switchSession={agentRuntime.switchSession}
          deleteSessionAndRefresh={agentRuntime.deleteSessionAndRefresh}
          refreshSessions={agentRuntime.refreshSessions}
        />
      }
      bottomRail={timelineEnabled ? <ActionsBar sceneId={scene.id} /> : undefined}
      commandTrailing={headerControls}
    />
  );
}
