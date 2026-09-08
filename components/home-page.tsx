'use client';

import { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { TeachingDashboard } from '@/components/teaching-dashboard';
import { AdminGate } from '@/components/auth-gate';
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clock,
  Copy,
  ImagePlus,
  Pencil,
  Trash2,
  Search,
  Settings,
  Sun,
  Moon,
  Monitor,
  ChevronUp,
  Upload,
  Sparkles,
  Atom,
  X,
  Presentation,
  PackageOpen,
  FileText,
  LoaderCircle,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { LanguageSwitcher } from '@/components/language-switcher';
import { createLogger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupInput, InputGroupButton } from '@/components/ui/input-group';
import { Textarea as UITextarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { SettingsDialog } from '@/components/settings';
import { GenerationToolbar } from '@/components/generation/generation-toolbar';
import { AgentBar } from '@/components/agent/agent-bar';
import { useTheme } from '@/lib/hooks/use-theme';
import { nanoid } from 'nanoid';
import { normalizeDocumentMimeType } from '@/lib/document/mime';
import { uploadCourseMaterial, uploadPptxGenerationSource } from '@/lib/course-assets/client';
import { createPptxCourseDraft } from '@/lib/import/pptx-course-draft';
import type { UserRequirements } from '@/lib/types/generation';
import { useSettingsStore } from '@/lib/store/settings';
import { hasUsableLLMProvider } from '@/lib/store/settings-validation';
import { useUserProfileStore, AVATAR_OPTIONS } from '@/lib/store/user-profile';
import {
  StageListItem,
  listStages,
  deleteStageData,
  renameStage,
  getFirstSlideByStages,
  revokeThumbnailSlideMediaUrls,
} from '@/lib/utils/stage-storage';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import type { Slide } from '@openmaic/dsl';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDraftCache } from '@/lib/hooks/use-draft-cache';
import { SpeechButton } from '@/components/audio/speech-button';
import { useImportClassroom } from '@/lib/import/use-import-classroom';
import { shouldShowVocationalTestUi } from '@/lib/config/feature-flags';
import { useImportPptx } from '@/lib/import/use-import-pptx';

const log = createLogger('Home');

const WEB_SEARCH_STORAGE_KEY = 'webSearchEnabled';
const RECENT_OPEN_STORAGE_KEY = 'recentClassroomsOpen';
const INTERACTIVE_MODE_STORAGE_KEY = 'interactiveModeEnabled';

// The durable server-side path is released independently from the legacy browser pipeline.
// It currently accepts text-only drafts; materials and optional enrichment retain their existing flow.
const DURABLE_GENERATION_UI_ENABLED = process.env.NEXT_PUBLIC_ENABLE_DURABLE_GENERATION === 'true';

interface FormState {
  pdfFiles: File[];
  requirement: string;
  webSearch: boolean;
  interactiveMode: boolean;
  vocationalTestMode: boolean;
}

interface PptxGenerationEventView {
  id: number;
  kind: 'thinking' | 'tool' | 'result' | 'warning' | 'error';
  phase: string;
  summary: string;
}
const initialFormState: FormState = {
  pdfFiles: [],
  requirement: '',
  webSearch: false,
  interactiveMode: false,
  vocationalTestMode: false,
};

export function HomePage() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const showVocationalTestUi = shouldShowVocationalTestUi();
  const [form, setForm] = useState<FormState>(initialFormState);
  const [isPreparingGeneration, setIsPreparingGeneration] = useState(false);
  const [createMode, setCreateMode] = useState<'ai' | 'pptx' | 'course'>('ai');
  const [pptxProgress, setPptxProgress] = useState<{
    summary: string;
    events: PptxGenerationEventView[];
  } | null>(null);
  const [dragMode, setDragMode] = useState<'pptx' | 'course' | null>(null);
  const isPreparingGenerationRef = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<
    import('@/lib/types/settings').SettingsSection | undefined
  >(undefined);

  // Draft cache for requirement text
  const { cachedValue: cachedRequirement, updateCache: updateRequirementCache } =
    useDraftCache<string>({ key: 'requirementDraft' });

  // A usable LLM provider exists ⇒ a concrete model is always selected (#580
  // invariant). Gate generation on this single condition (state A vs B)
  // instead of inspecting modelId directly.
  const providersConfig = useSettingsStore((s) => s.providersConfig);
  const selectedAgentIds = useSettingsStore((s) => s.selectedAgentIds);
  const hasUsableProvider = hasUsableLLMProvider(providersConfig);
  const [recentOpen, setRecentOpen] = useState(true);
  const persistRecentOpen = (next: boolean) => {
    setRecentOpen(next);
    try {
      localStorage.setItem(RECENT_OPEN_STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
  };

  // Hydrate client-only state after mount (avoids SSR mismatch)
  /* eslint-disable react-hooks/set-state-in-effect -- Hydration from localStorage must happen in effect */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(RECENT_OPEN_STORAGE_KEY);
      if (saved !== null) setRecentOpen(saved !== 'false');
    } catch {
      /* localStorage unavailable */
    }
    try {
      const savedWebSearch = localStorage.getItem(WEB_SEARCH_STORAGE_KEY);
      const savedInteractiveMode = localStorage.getItem(INTERACTIVE_MODE_STORAGE_KEY);
      const savedCreateMode = localStorage.getItem('laixue-create-mode');
      const updates: Partial<FormState> = {};
      if (savedWebSearch === 'true') updates.webSearch = true;
      if (savedInteractiveMode === 'true') updates.interactiveMode = true;
      if (savedCreateMode === 'pptx' || savedCreateMode === 'course') {
        setCreateMode(savedCreateMode);
      }
      if (Object.keys(updates).length > 0) {
        setForm((prev) => ({ ...prev, ...updates }));
      }
    } catch {
      /* localStorage unavailable */
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Restore requirement draft from localStorage on mount. The previous derived-state
  // pattern initialised `prev` from the cached value itself, so on the first client
  // render the comparison was always equal and the restore never fired. Use an effect
  // so the cache is hydrated into the form once we know the live requirement is empty.
  const draftRestoredRef = useRef(false);
  /* eslint-disable react-hooks/set-state-in-effect -- Hydration from localStorage must happen in effect */
  useEffect(() => {
    if (draftRestoredRef.current) return;
    if (!cachedRequirement) return;
    draftRestoredRef.current = true;
    setForm((prev) => (prev.requirement ? prev : { ...prev, requirement: cachedRequirement }));
  }, [cachedRequirement]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const [themeOpen, setThemeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [classrooms, setClassrooms] = useState<StageListItem[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, Slide>>({});
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const thumbnailsRef = useRef<Record<string, Slide>>({});

  const replaceThumbnails = (slides: Record<string, Slide>) => {
    const previous = thumbnailsRef.current;
    thumbnailsRef.current = slides;
    setThumbnails(slides);
    window.setTimeout(() => revokeThumbnailSlideMediaUrls(previous), 0);
  };

  // Close dropdowns when clicking outside
  useEffect(() => {
    if (!themeOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setThemeOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [themeOpen]);

  const loadClassrooms = async () => {
    try {
      const list = await listStages();
      setClassrooms(list);
      // Load first slide thumbnails
      if (list.length > 0) {
        const slides = await getFirstSlideByStages(list.map((c) => c.id));
        replaceThumbnails(slides);
      } else {
        replaceThumbnails({});
      }
    } catch (err) {
      log.error('Failed to load classrooms:', err);
    }
  };

  const { importing, fileInputRef, triggerFileSelect, handleFileChange } = useImportClassroom(
    (stageId) => {
      loadClassrooms();
      router.push(`/classroom/${encodeURIComponent(stageId)}?editor=1`);
    },
  );

  const {
    importing: pptxImporting,
    fileInputRef: pptxFileInputRef,
    triggerFileSelect: triggerPptxFileSelect,
    handleFileChange: handlePptxFileChange,
  } = useImportPptx({
    onImported: async (slides, file) => {
      setPptxProgress({ summary: '正在登记 PPTX 来源并创建可编辑课程…', events: [] });
      const source = await uploadPptxGenerationSource(file);
      // The durable PPTX pipeline uses the formal UUID course identifier as
      // both its revision anchor and asset namespace; do not create a second
      // course once enrichment begins.
      const courseId = crypto.randomUUID();
      const draft = createPptxCourseDraft({
        courseId,
        fileName: file.name,
        slides,
        sourceId: source.sourceId,
      });
      const response = await fetch('/api/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: courseId, title: draft.title, data: draft, saveState: 'draft' }),
      });
      const saved = await response.json().catch(() => null);
      if (!response.ok || !saved?.success) throw new Error(saved?.error || '导入课程保存失败');
      // PPTX import must always continue through the durable generation path.
      // A client-side release fallback silently created mute, non-interactive
      // courses whenever an older browser bundle evaluated its build-time flag.
      // The server is the authoritative release gate and returns a clear error
      // when this capability is unavailable.
      {
        setPptxProgress({ summary: '正在根据教学需求配置 AI 课堂…', events: [] });
      const audioSettings = useSettingsStore.getState();
      const selectedProvider = audioSettings.ttsProvidersConfig[audioSettings.ttsProviderId];
      const teacherVoice = audioSettings.ttsProviderId && audioSettings.ttsVoice && audioSettings.ttsVoice !== 'default'
        ? { providerId: audioSettings.ttsProviderId, voiceId: audioSettings.ttsVoice, modelId: selectedProvider?.modelId }
        : undefined;
      // AgentBar keeps the teacher selected and lets the creator choose the
      // supporting classroom roles. The durable PPTX pipeline only needs the
      // number of companions; it generates their course-specific personas.
      const companionCount = Math.min(3, Math.max(1, selectedAgentIds.filter((id) => id !== 'default-1').length));
      const submission = await fetch('/api/generation-jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({
            sourceId: source.sourceId,
            courseId,
            sourceRevision: 1,
            teachingRequirement: form.requirement.trim(),
            interactionIntensity: 'standard',
            enableTTS: true,
            ...(teacherVoice ? { teacherVoice } : {}),
            companionCount,
          }),
        });
        const created = await submission.json().catch(() => null);
        if (!submission.ok || !created?.jobId || !created?.pollUrl) {
          throw new Error(created?.error || 'AI 课堂任务创建失败');
        }
        const deadline = Date.now() + 45 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, created.pollIntervalMs ?? 5000));
          const poll = await fetch(created.pollUrl, { cache: 'no-store' });
          const job = await poll.json().catch(() => null);
          if (!poll.ok || !job) throw new Error('AI 课堂生成状态读取失败');
          const events = Array.isArray(job.events)
            ? job.events
                .filter(
                  (event: unknown): event is PptxGenerationEventView =>
                    !!event &&
                    typeof event === 'object' &&
                    typeof (event as PptxGenerationEventView).id === 'number' &&
                    typeof (event as PptxGenerationEventView).summary === 'string',
                )
                .slice(-4)
            : [];
          const latest = events.at(-1);
          if (latest) setPptxProgress({ summary: latest.summary, events });
          if (job.status === 'succeeded') {
            setPptxProgress({ summary: 'AI 课堂已生成，正在进入编辑器…', events });
            router.push(`/classroom/${encodeURIComponent(courseId)}?editor=1`);
            return;
          }
          if (['failed', 'cancelled', 'conflict'].includes(job.status)) {
            throw new Error('AI 课堂生成未完成，请稍后重试。');
          }
        }
        throw new Error('AI 课堂生成等待超时，请稍后在课程列表中查看结果。');
      }
    },
  });

  useEffect(() => {
    // Clear stale media store to prevent cross-course thumbnail contamination.
    // The store may hold tasks from a previously visited classroom whose elementIds
    // (gen_img_1, etc.) collide with other courses' placeholders.
    useMediaGenerationStore.getState().revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    // eslint-disable-next-line react-hooks/set-state-in-effect -- Store hydration on mount
    loadClassrooms();

    return () => {
      revokeThumbnailSlideMediaUrls(thumbnailsRef.current);
      thumbnailsRef.current = {};
    };
  }, []);

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingDeleteId(id);
  };

  const confirmDelete = async (id: string) => {
    setPendingDeleteId(null);
    try {
      await deleteStageData(id);
      await loadClassrooms();
    } catch (err) {
      log.error('Failed to delete classroom:', err);
      toast.error('Failed to delete classroom');
    }
  };

  const handleRename = async (id: string, newName: string) => {
    try {
      await renameStage(id, newName);
      setClassrooms((prev) => prev.map((c) => (c.id === id ? { ...c, name: newName } : c)));
    } catch (err) {
      log.error('Failed to rename classroom:', err);
      toast.error(t('classroom.renameFailed'));
    }
  };

  const deferredSearchQuery = useDeferredValue(searchQuery);
  const filteredClassrooms = useMemo(() => {
    const q = deferredSearchQuery.trim().toLowerCase();
    if (!q) return classrooms;
    return classrooms.filter((c) => {
      const name = c.name?.toLowerCase() ?? '';
      const desc = c.description?.toLowerCase() ?? '';
      return name.includes(q) || desc.includes(q);
    });
  }, [classrooms, deferredSearchQuery]);

  const updateForm = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    try {
      if (field === 'webSearch') localStorage.setItem(WEB_SEARCH_STORAGE_KEY, String(value));
      if (field === 'interactiveMode')
        localStorage.setItem(INTERACTIVE_MODE_STORAGE_KEY, String(value));
      if (field === 'requirement') updateRequirementCache(value as string);
    } catch {
      /* ignore */
    }
  };

  const handleGenerate = async () => {
    // A material upload happens before navigation. Guard synchronously as well
    // as visually: React state alone leaves a small window for double-clicks.
    if (isPreparingGenerationRef.current) return;
    // No model/provider guard here: generation is gated by `canGenerate`
    // (requires a usable provider), and under the #580 invariant a usable
    // provider always has a concrete model. State A (no usable provider)
    // surfaces through the toolbar's single Configure-Provider affordance.
    if (!form.requirement.trim()) {
      setError(t('upload.requirementRequired'));
      return;
    }

    isPreparingGenerationRef.current = true;
    setIsPreparingGeneration(true);
    setError(null);

    try {
      const canUseDurablePath =
        DURABLE_GENERATION_UI_ENABLED &&
        form.pdfFiles.length === 0 &&
        !form.webSearch &&
        !form.interactiveMode &&
        !form.vocationalTestMode;
      if (canUseDurablePath) {
        const submission = await fetch('/api/generation-jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({ requirement: form.requirement, agentMode: 'default' }),
        });
        const created = await submission.json().catch(() => null);
        if (!submission.ok || !created?.jobId || !created?.courseId || !created?.pollUrl) {
          throw new Error(created?.error || '课程生成任务创建失败');
        }
        const deadline = Date.now() + 30 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, created.pollIntervalMs ?? 5000));
          const poll = await fetch(created.pollUrl, { cache: 'no-store' });
          const job = await poll.json().catch(() => null);
          if (!poll.ok || !job) throw new Error('课程生成状态读取失败');
          if (job.status === 'succeeded') {
            router.push(`/classroom/${encodeURIComponent(created.courseId)}?editor=1`);
            return;
          }
          if (['failed', 'cancelled', 'conflict'].includes(job.status)) {
            throw new Error('课程生成未完成，请在稍后重试。');
          }
        }
        throw new Error('课程生成等待超时，请稍后在课程列表中查看结果。');
      }

      const userProfile = useUserProfileStore.getState();
      const requirements: UserRequirements = {
        requirement: form.requirement,
        userNickname: userProfile.nickname || undefined,
        userBio: userProfile.bio || undefined,
        webSearch: form.webSearch || undefined,
        interactiveMode: form.vocationalTestMode ? true : form.interactiveMode,
        ...(form.vocationalTestMode ? { taskEngineMode: true } : {}),
      };

      let materialFiles:
        | Array<{ storageKey: string; fileName: string; documentMimeType: string; size: number }>
        | undefined;

      if (form.pdfFiles.length > 0) {
        // 直传 Supabase Storage,文件不经过 Vercel Serverless Function,
        // 解决 4.5MB 上传硬顶。先临时用一个 nanoid 占位 courseId,
        // 等课程真正创建后路径会自动通过 upsert 关联(courseId 在 sign-upload 路由里只用作目录前缀)。
        try {
          // 上传需要 courseId,这里用一个临时 nanoid 作为目录前缀,
          // 后续会用真实 courseId 重写路径(extract-document 路由会重新拉取)
          const tempCourseId = `pending-${nanoid(12)}`;
          materialFiles = await Promise.all(
            form.pdfFiles.map(async (file) => {
              const uploaded = await uploadCourseMaterial(tempCourseId, file);
              return {
                storageKey: uploaded.path,
                fileName: file.name,
                documentMimeType: normalizeDocumentMimeType({
                  mimeType: file.type,
                  fileName: file.name,
                }),
                size: file.size,
              };
            }),
          );
        } catch (uploadErr) {
          log.error('Course material direct upload failed:', uploadErr);
          setError(
            uploadErr instanceof Error
              ? `课程材料上传失败:${uploadErr.message}`
              : '课程材料上传失败',
          );
          return;
        }
      }

      const sessionState = {
        sessionId: nanoid(),
        requirements,
        pdfText: '',
        pdfImages: [],
        imageStorageIds: [],
        materialFiles,
        sceneOutlines: null,
        currentStep: 'generating' as const,
      };
      sessionStorage.setItem('generationSession', JSON.stringify(sessionState));

      router.push('/generation-preview');
    } catch (err) {
      log.error('Error preparing generation:', err);
      setError(err instanceof Error ? err.message : t('upload.generateFailed'));
    } finally {
      isPreparingGenerationRef.current = false;
      setIsPreparingGeneration(false);
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return t('classroom.today');
    if (diffDays === 1) return t('classroom.yesterday');
    if (diffDays < 7) return `${diffDays} ${t('classroom.daysAgo')}`;
    return date.toLocaleDateString();
  };

  const canGenerate = !!form.requirement.trim() && hasUsableProvider && !isPreparingGeneration;

  const selectCreateMode = (mode: 'ai' | 'pptx' | 'course') => {
    setCreateMode(mode);
    try {
      localStorage.setItem('laixue-create-mode', mode);
    } catch {
      /* localStorage unavailable */
    }
  };

  const openDroppedFile = (mode: 'pptx' | 'course', file: File) => {
    const input = mode === 'pptx' ? pptxFileInputRef.current : fileInputRef.current;
    if (!input) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const handleCreateDrop = (mode: 'pptx' | 'course', event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragMode(null);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    const extension = file.name.toLowerCase();
    if (mode === 'pptx' && !extension.endsWith('.pptx')) {
      toast.error('请选择 PPTX 文件');
      return;
    }
    if (mode === 'course' && !extension.endsWith('.zip')) {
      toast.error('请选择 ZIP 课程包');
      return;
    }
    openDroppedFile(mode, file);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (canGenerate) handleGenerate();
    }
  };

  return (
    <div className="relative min-h-[100dvh] w-full overflow-x-hidden bg-[#f4f8f6] px-4 pb-16 pt-20 text-slate-800 dark:bg-slate-950 dark:text-slate-100 md:px-8 md:pt-24">
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        onChange={handleFileChange}
        className="hidden"
      />
      <input
        ref={pptxFileInputRef}
        type="file"
        accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        onChange={handlePptxFileChange}
        className="hidden"
      />
      {/* ═══ Top-right pill (unchanged) ═══ */}
      <div
        ref={toolbarRef}
        className="fixed top-4 right-4 z-50 flex items-center gap-1 bg-white/60 dark:bg-gray-800/60 backdrop-blur-md px-2 py-1.5 rounded-full border border-gray-100/50 dark:border-gray-700/50 shadow-sm"
      >
        {/* Language Selector */}
        <LanguageSwitcher onOpen={() => setThemeOpen(false)} />

        <div className="w-[1px] h-4 bg-gray-200 dark:bg-gray-700" />

        {/* Theme Selector */}
        <div className="relative">
          <button
            onClick={() => {
              setThemeOpen(!themeOpen);
            }}
            className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all"
          >
            {theme === 'light' && <Sun className="w-4 h-4" />}
            {theme === 'dark' && <Moon className="w-4 h-4" />}
            {theme === 'system' && <Monitor className="w-4 h-4" />}
          </button>
          {themeOpen && (
            <div className="absolute top-full mt-2 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden z-50 min-w-[140px]">
              <button
                onClick={() => {
                  setTheme('light');
                  setThemeOpen(false);
                }}
                className={cn(
                  'w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2',
                  theme === 'light' &&
                    'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
                )}
              >
                <Sun className="w-4 h-4" />
                {t('settings.themeOptions.light')}
              </button>
              <button
                onClick={() => {
                  setTheme('dark');
                  setThemeOpen(false);
                }}
                className={cn(
                  'w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2',
                  theme === 'dark' &&
                    'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
                )}
              >
                <Moon className="w-4 h-4" />
                {t('settings.themeOptions.dark')}
              </button>
              <button
                onClick={() => {
                  setTheme('system');
                  setThemeOpen(false);
                }}
                className={cn(
                  'w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2',
                  theme === 'system' &&
                    'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
                )}
              >
                <Monitor className="w-4 h-4" />
                {t('settings.themeOptions.system')}
              </button>
            </div>
          )}
        </div>

        <div className="w-[1px] h-4 bg-gray-200 dark:bg-gray-700" />

        {/* Settings Button */}
        <div className="relative">
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all group"
          >
            <Settings className="w-4 h-4 group-hover:rotate-90 transition-transform duration-500" />
          </button>
        </div>
      </div>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setSettingsSection(undefined);
        }}
        initialSection={settingsSection}
      />

      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -left-48 -top-44 size-[560px] rounded-full bg-sky-300/35 blur-[90px] dark:bg-sky-700/10" />
        <div className="absolute -right-52 -top-24 size-[660px] rounded-full bg-emerald-300/30 blur-[100px] dark:bg-emerald-700/10" />
        <div className="absolute -bottom-72 left-1/3 size-[560px] rounded-full bg-violet-300/25 blur-[95px] dark:bg-violet-700/10" />
      </div>

      <motion.main
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className="relative z-10 mx-auto w-full max-w-[1080px]"
      >
        <header className="mb-5">
          <h1 className="text-[28px] font-semibold tracking-tight text-slate-800 dark:text-white md:text-[32px]">
            创建一门课程
          </h1>
          <p className="mt-2 text-sm leading-7 text-slate-600 dark:text-slate-300 md:text-[15px]">
            从教学需求开始生成，或基于已有 PPT、交互课程继续创作。
          </p>
        </header>

        <section className="relative">
          <div
            role="tablist"
            aria-label="课程创建方式"
            className="mb-3 flex snap-x gap-3 overflow-x-auto rounded-xl border border-white/80 bg-white/35 p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,.8),0_18px_38px_-28px_rgba(15,70,55,.35)] backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/40 md:grid md:grid-cols-3"
          >
            {(
              [
                {
                  id: 'ai',
                  title: 'AI 创建课程',
                  desc: '描述教学目标，从零生成',
                  icon: Sparkles,
                  tone: 'emerald',
                },
                {
                  id: 'pptx',
                  title: '通过 PPT 创建',
                  desc: '上传课件，转换为可编辑课程',
                  icon: Presentation,
                  tone: 'orange',
                },
                {
                  id: 'course',
                  title: '导入已有交互课程',
                  desc: '迁移完整课程与互动配置',
                  icon: PackageOpen,
                  tone: 'cyan',
                },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              const selected = createMode === item.id;
              return (
                <button
                  key={item.id}
                  data-create-mode={item.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => selectCreateMode(item.id)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                    event.preventDefault();
                    const modes = ['ai', 'pptx', 'course'] as const;
                    const current = modes.indexOf(item.id);
                    const direction = event.key === 'ArrowRight' ? 1 : -1;
                    const next = modes[(current + direction + modes.length) % modes.length];
                    selectCreateMode(next);
                    requestAnimationFrame(() => {
                      document
                        .querySelector<HTMLButtonElement>(`[data-create-mode="${next}"]`)
                        ?.focus();
                    });
                  }}
                  className={cn(
                    'flex min-w-[265px] snap-center items-start gap-3 rounded-lg border p-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 md:min-w-0',
                    selected
                      ? 'translate-y-[-1px] border-white bg-white/90 shadow-[0_14px_30px_-18px_rgba(23,110,72,.6),0_0_0_1px_rgba(20,132,78,.55)] dark:border-white/20 dark:bg-slate-900/90'
                      : 'border-white/60 bg-white/25 hover:-translate-y-px hover:bg-white/55 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10',
                  )}
                >
                  <span
                    className={cn(
                      'grid size-9 shrink-0 place-items-center rounded-lg border shadow-[inset_0_1px_0_rgba(255,255,255,.8)]',
                      item.tone === 'emerald' &&
                        'border-emerald-200 bg-gradient-to-br from-emerald-50 to-violet-50 text-emerald-700',
                      item.tone === 'orange' &&
                        'border-orange-200 bg-gradient-to-br from-amber-50 to-orange-100 text-orange-700',
                      item.tone === 'cyan' &&
                        'border-cyan-200 bg-gradient-to-br from-cyan-50 to-emerald-100 text-cyan-700',
                    )}
                  >
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0">
                    <span
                      className={cn(
                        'block text-sm font-semibold md:text-[15px]',
                        selected && 'text-emerald-800 dark:text-emerald-300',
                      )}
                    >
                      {item.title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-600 dark:text-slate-300 md:text-[13px]">
                      {item.desc}
                    </span>
                  </span>
                  {selected && <Check className="ml-auto size-4 shrink-0 text-emerald-700" />}
                </button>
              );
            })}
          </div>

          <div className="relative overflow-hidden rounded-2xl border border-white/90 bg-white/60 shadow-[inset_0_1px_0_rgba(255,255,255,.9),0_28px_64px_-30px_rgba(23,75,60,.42)] backdrop-blur-2xl dark:border-white/10 dark:bg-slate-900/65">
            <div
              className={cn(
                'absolute inset-x-6 top-0 h-0.5 bg-gradient-to-r from-transparent via-emerald-500 to-transparent',
                createMode === 'pptx' && 'via-orange-500',
                createMode === 'course' && 'via-cyan-600',
              )}
            />
            <AnimatePresence mode="wait">
              {createMode === 'ai' ? (
                <motion.div
                  key="ai"
                  role="tabpanel"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="flex min-h-[344px] flex-col p-5 md:p-7"
                >
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <GreetingBar />
                    <div className="flex w-full min-w-0 items-center gap-2 md:w-auto">
                      <span className="hidden text-xs font-medium text-slate-500 lg:inline">
                        课堂角色与音色
                      </span>
                      <AgentBar />
                    </div>
                  </div>
                  <label
                    className="mb-2 flex items-center justify-between text-sm font-semibold"
                    htmlFor="course-requirement"
                  >
                    <span>课程主题 / 教学需求</span>
                    <span className="font-mono text-xs font-medium text-slate-500">
                      {form.requirement.length}/300
                    </span>
                  </label>
                  <textarea
                    id="course-requirement"
                    ref={textareaRef}
                    maxLength={300}
                    placeholder={t('upload.requirementPlaceholder')}
                    className="min-h-[138px] w-full resize-y rounded-lg border border-slate-300 bg-white/80 px-4 py-3.5 text-[15px] leading-7 text-slate-800 shadow-inner outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/15 dark:border-slate-700 dark:bg-slate-950/50 dark:text-white"
                    value={form.requirement}
                    onChange={(e) => updateForm('requirement', e.target.value)}
                    onKeyDown={handleKeyDown}
                    rows={4}
                  />
                  <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <GenerationToolbar
                        webSearch={form.webSearch}
                        onWebSearchChange={(v) => updateForm('webSearch', v)}
                        onSettingsOpen={(section) => {
                          setSettingsSection(section);
                          setSettingsOpen(true);
                        }}
                        pdfFiles={form.pdfFiles}
                        onPdfFilesChange={(files) => updateForm('pdfFiles', files)}
                        onPdfError={setError}
                      />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={form.interactiveMode}
                            onClick={() => updateForm('interactiveMode', !form.interactiveMode)}
                            className={cn(
                              'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
                              form.interactiveMode
                                ? 'border-cyan-500 bg-cyan-100 text-cyan-800'
                                : 'border-cyan-300 bg-white/55 text-cyan-700 hover:bg-cyan-50',
                            )}
                          >
                            <Atom className="size-3.5" />
                            {t('toolbar.interactiveModeLabel')}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t('toolbar.interactiveModeHint')}</TooltipContent>
                      </Tooltip>
                      <SpeechButton
                        size="md"
                        onTranscription={(text) => {
                          setForm((prev) => {
                            const next = `${prev.requirement}${prev.requirement ? ' ' : ''}${text}`;
                            updateRequirementCache(next);
                            return { ...prev, requirement: next };
                          });
                        }}
                      />
                      {showVocationalTestUi && (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={form.vocationalTestMode}
                          onClick={() => updateForm('vocationalTestMode', !form.vocationalTestMode)}
                          className={cn(
                            'h-8 rounded-full border px-3 text-xs font-medium',
                            form.vocationalTestMode
                              ? 'border-violet-500 bg-violet-100 text-violet-800'
                              : 'border-slate-300 bg-white/55 text-slate-600',
                          )}
                        >
                          职教任务
                        </button>
                      )}
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={isPreparingGeneration ? '正在创建课程' : '生成课程'}
                          onClick={handleGenerate}
                          disabled={!canGenerate}
                          className={cn(
                            'grid size-11 shrink-0 place-items-center rounded-xl border transition',
                            canGenerate
                              ? 'border-emerald-600/50 bg-gradient-to-b from-emerald-300 to-emerald-500 text-emerald-950 shadow-[inset_0_1px_0_rgba(255,255,255,.75),0_10px_22px_-12px_rgba(16,120,72,.85)] hover:-translate-y-px hover:brightness-105'
                              : 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400',
                          )}
                        >
                          {isPreparingGeneration ? (
                            <LoaderCircle className="size-5 animate-spin" />
                          ) : (
                            <ArrowUp className="size-5" />
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {isPreparingGeneration ? '正在创建课程…' : '生成课程'}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key={createMode}
                  role="tabpanel"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="min-h-[344px] p-5 md:p-7"
                >
                  {(createMode === 'pptx' && pptxImporting) ||
                  (createMode === 'course' && importing) ? (
                    <div className="flex min-h-[290px] flex-col justify-center rounded-xl border border-white/90 bg-white/55 p-6 shadow-inner dark:border-white/10 dark:bg-slate-950/30">
                      <div className="flex items-center gap-3">
                        <span
                          className={cn(
                            'grid size-12 place-items-center rounded-lg',
                            createMode === 'pptx'
                              ? 'bg-orange-100 text-orange-700'
                              : 'bg-cyan-100 text-cyan-700',
                          )}
                        >
                          {createMode === 'pptx' ? (
                            <FileText className="size-6" />
                          ) : (
                            <PackageOpen className="size-6" />
                          )}
                        </span>
                        <div>
                          <p className="font-semibold">正在处理所选文件</p>
                          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                            {createMode === 'pptx'
                              ? pptxProgress?.summary || '正在解析页面与讲师备注…'
                              : '正在解析课程内容与互动配置…'}
                          </p>
                        </div>
                        <LoaderCircle className="ml-auto size-5 animate-spin text-emerald-700" />
                      </div>
                      <div className="mt-6 h-2 overflow-hidden rounded-full bg-slate-200/80">
                        <div className="h-full w-2/3 animate-pulse rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600" />
                      </div>
                      <p className="mt-2 text-right font-mono text-xs text-slate-500">处理中</p>
                      {createMode === 'pptx' && pptxProgress?.events.length ? (
                        <div className="mt-4 space-y-1.5 rounded-lg border border-slate-200 bg-white/55 p-3 text-left text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-950/30 dark:text-slate-300">
                          {pptxProgress.events.map((event) => (
                            <p key={event.id} className="truncate">
                              <span className="mr-2 text-emerald-700">{event.kind === 'warning' ? '提示' : '进行中'}</span>
                              {event.summary}
                            </p>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div
                      onDragEnter={(e) => {
                        e.preventDefault();
                        setDragMode(createMode);
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragMode(null);
                      }}
                      onDrop={(e) => handleCreateDrop(createMode, e)}
                      className={cn(
                        'flex min-h-[290px] flex-col items-center justify-center rounded-xl border-2 border-dashed px-5 py-7 text-center transition',
                        dragMode === createMode
                          ? 'border-emerald-500 bg-emerald-50/75 shadow-[0_0_0_6px_rgba(16,185,129,.1)]'
                          : 'border-slate-300 bg-white/30 hover:border-emerald-500/70 hover:bg-white/50 dark:border-slate-700 dark:bg-slate-950/20',
                      )}
                    >
                      {createMode === 'pptx' && (
                        <div className="mb-5 w-full max-w-xl text-left">
                          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">课堂角色与音色</p>
                              <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">设置 AI 讲师、伴学角色和讲师音色后再导入。</p>
                            </div>
                            <div className="w-full sm:w-72"><AgentBar /></div>
                          </div>
                          <label
                            htmlFor="pptx-teaching-requirement"
                            className="mb-2 flex items-center justify-between text-sm font-semibold text-slate-800 dark:text-slate-100"
                          >
                            <span>教学需求</span>
                            <span className="font-mono text-xs font-medium text-slate-500">
                              {form.requirement.length}/300
                            </span>
                          </label>
                          <textarea
                            id="pptx-teaching-requirement"
                            maxLength={300}
                            rows={3}
                            value={form.requirement}
                            onChange={(event) => updateForm('requirement', event.target.value)}
                            placeholder="例如：面向新员工讲解本课件，突出业务价值，每 3 页安排一次轻量理解检查。"
                            className="w-full resize-y rounded-lg border border-slate-300 bg-white/80 px-3 py-2.5 text-sm leading-6 text-slate-800 shadow-inner outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/15 dark:border-slate-700 dark:bg-slate-950/50 dark:text-white"
                          />
                          <p className="mt-1.5 text-xs leading-5 text-slate-600 dark:text-slate-300">
                            PPT 保留原有内容和版式；教学需求将决定讲解、角色和互动方式。
                          </p>
                        </div>
                      )}
                      <span
                        className={cn(
                          'grid h-16 w-20 place-items-center rounded-xl shadow-[inset_0_1px_0_rgba(255,255,255,.85),0_10px_24px_-14px_rgba(15,70,55,.5)]',
                          createMode === 'pptx'
                            ? 'bg-gradient-to-br from-amber-50 to-orange-100 text-orange-700'
                            : 'bg-gradient-to-br from-cyan-50 to-emerald-100 text-cyan-700',
                        )}
                      >
                        {createMode === 'pptx' ? (
                          <Presentation className="size-8" />
                        ) : (
                          <PackageOpen className="size-8" />
                        )}
                      </span>
                      <h2
                        className={cn(
                          'mt-4 text-base font-semibold',
                          dragMode === createMode && 'text-emerald-800',
                        )}
                      >
                        {dragMode === createMode
                          ? createMode === 'pptx'
                            ? '松开以上传 PPTX'
                            : '松开以上传课程包'
                          : createMode === 'pptx'
                            ? '将 PPTX 拖到此处，或选择文件'
                            : '将课程包拖到此处，或选择文件'}
                      </h2>
                      <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600 dark:text-slate-300">
                        {createMode === 'pptx'
                          ? '保留页面顺序与讲师备注，转换后可编辑。'
                          : '导入已完成的交互课程，保留内容、结构与互动配置。'}
                      </p>
                      <button
                        type="button"
                        onClick={createMode === 'pptx' ? triggerPptxFileSelect : triggerFileSelect}
                        className="mt-4 inline-flex h-11 items-center gap-2 rounded-lg border border-emerald-600/50 bg-gradient-to-b from-emerald-300 to-emerald-500 px-5 text-sm font-semibold text-emerald-950 shadow-[inset_0_1px_0_rgba(255,255,255,.75),0_10px_24px_-14px_rgba(16,120,72,.75)] hover:-translate-y-px hover:brightness-105"
                      >
                        <Upload className="size-4" />
                        {createMode === 'pptx' ? '选择 PPTX 文件' : '选择课程包文件'}
                      </button>
                      <p className="mt-3 font-mono text-xs text-slate-500">
                        {createMode === 'pptx'
                          ? '.pptx · 单个文件最大 100MB'
                          : '.zip 压缩课程包 · 单个文件最大 200MB'}
                      </p>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-3 rounded-lg border border-red-300 bg-red-50/80 p-3 text-sm text-red-700"
              >
                {error}
              </motion.div>
            )}
          </AnimatePresence>
        </section>

        {/* ═══ Recent classrooms — collapsible ═══ */}
        {classrooms.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className="relative z-10 mt-10 w-full max-w-6xl flex flex-col items-center"
          >
            {/* Trigger — divider-line with centered text */}
            <div className="group w-full flex items-center gap-4 py-2">
              <div className="flex-1 h-px bg-border/40 group-hover:bg-border/70 transition-colors" />
              <div className="shrink-0 flex items-center gap-3 text-[13px] text-muted-foreground/60 select-none">
                <button
                  onClick={() => persistRecentOpen(!recentOpen)}
                  className="flex items-center gap-2 hover:text-foreground/70 transition-colors cursor-pointer"
                >
                  <Clock className="size-3.5" />
                  {t('classroom.recentClassrooms')}
                  <span className="text-[11px] tabular-nums opacity-60">{classrooms.length}</span>
                  <motion.div
                    animate={{ rotate: recentOpen ? 180 : 0 }}
                    transition={{ duration: 0.3, ease: 'easeInOut' }}
                  >
                    <ChevronDown className="size-3.5" />
                  </motion.div>
                </button>

                {/* Search toggle — icon that expands into an input in place */}
                <AnimatePresence initial={false}>
                  {!searchOpen ? (
                    <motion.button
                      key="search-icon"
                      ref={searchButtonRef}
                      type="button"
                      aria-label={t('classroom.searchAriaLabel')}
                      onClick={() => {
                        setSearchOpen(true);
                        if (!recentOpen) persistRecentOpen(true);
                        requestAnimationFrame(() => searchInputRef.current?.focus());
                      }}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.12, ease: 'easeOut' }}
                      className="flex items-center justify-center size-6 rounded-full text-muted-foreground/50 hover:text-foreground/70 hover:bg-muted/50 transition-colors cursor-pointer"
                    >
                      <Search className="size-3.5" />
                    </motion.button>
                  ) : (
                    <motion.div
                      key="search-input"
                      initial={{ opacity: 0, width: 0 }}
                      animate={{ opacity: 1, width: 200 }}
                      exit={{ opacity: 0, width: 0 }}
                      transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
                      className="overflow-hidden"
                    >
                      <InputGroup
                        className={cn(
                          'h-7 text-[12px] rounded-full bg-muted/40 border-transparent shadow-none',
                          'transition-colors',
                          'hover:bg-muted/60',
                          'has-[[data-slot=input-group-control]:focus-visible]:bg-muted/60',
                          'has-[[data-slot=input-group-control]:focus-visible]:border-transparent',
                          'has-[[data-slot=input-group-control]:focus-visible]:ring-0',
                        )}
                      >
                        <InputGroupInput
                          ref={searchInputRef}
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              if (searchQuery) {
                                setSearchQuery('');
                              } else {
                                setSearchOpen(false);
                                requestAnimationFrame(() => searchButtonRef.current?.focus());
                              }
                            }
                          }}
                          onBlur={() => {
                            if (!searchQuery) {
                              setSearchOpen(false);
                            }
                          }}
                          placeholder={t('classroom.searchPlaceholder')}
                          aria-label={t('classroom.searchAriaLabel')}
                          className="h-7 pl-3 placeholder:text-muted-foreground/50"
                        />
                        {searchQuery && (
                          <InputGroupButton
                            size="icon-xs"
                            aria-label={t('classroom.clearSearch')}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setSearchQuery('');
                              searchInputRef.current?.focus();
                            }}
                          >
                            <X />
                          </InputGroupButton>
                        )}
                      </InputGroup>
                    </motion.div>
                  )}
                </AnimatePresence>

                <button
                  onClick={triggerFileSelect}
                  disabled={importing}
                  className="group/import grid grid-cols-[auto_0fr] hover:grid-cols-[auto_1fr] items-center gap-1 rounded-full px-1.5 py-0.5 text-[12px] text-muted-foreground/35 hover:text-muted-foreground/70 hover:bg-muted/50 transition-all duration-200 cursor-pointer"
                >
                  <Upload className="size-3" />
                  <span className="overflow-hidden opacity-0 group-hover/import:opacity-100 transition-opacity duration-200 whitespace-nowrap">
                    {t('import.classroom')}
                  </span>
                </button>
                <button
                  onClick={triggerPptxFileSelect}
                  disabled={pptxImporting}
                  className="group/import-pptx grid grid-cols-[auto_0fr] hover:grid-cols-[auto_1fr] items-center gap-1 rounded-full px-1.5 py-0.5 text-[12px] text-muted-foreground/35 hover:text-muted-foreground/70 hover:bg-muted/50 transition-all duration-200 cursor-pointer"
                >
                  <Presentation className="size-3" />
                  <span className="overflow-hidden opacity-0 group-hover/import-pptx:opacity-100 transition-opacity duration-200 whitespace-nowrap">
                    {t('import.pptx')}
                  </span>
                </button>
              </div>
              <div className="flex-1 h-px bg-border/40 group-hover:bg-border/70 transition-colors" />
            </div>

            {/* Expandable content */}
            <AnimatePresence>
              {recentOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                  className="w-full overflow-hidden"
                >
                  {searchQuery.trim() && filteredClassrooms.length === 0 ? (
                    <div className="pt-8 pb-2 text-center text-[13px] text-muted-foreground/60">
                      {t('classroom.searchEmpty')}
                    </div>
                  ) : (
                    <div className="pt-8 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-8">
                      {filteredClassrooms.map((classroom, i) => (
                        <motion.div
                          key={classroom.id}
                          initial={{ opacity: 0, y: 16 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{
                            delay: i * 0.04,
                            duration: 0.35,
                            ease: 'easeOut',
                          }}
                        >
                          <ClassroomCard
                            classroom={classroom}
                            slide={thumbnails[classroom.id]}
                            formatDate={formatDate}
                            onDelete={handleDelete}
                            onRename={handleRename}
                            confirmingDelete={pendingDeleteId === classroom.id}
                            onConfirmDelete={() => confirmDelete(classroom.id)}
                            onCancelDelete={() => setPendingDeleteId(null)}
                            onClick={() => router.push(`/classroom/${classroom.id}`)}
                          />
                        </motion.div>
                      ))}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </motion.main>
    </div>
  );
}

// ─── Greeting Bar — avatar + "Hi, Name", click to edit in-place ────
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;

function isCustomAvatar(src: string) {
  return src.startsWith('data:');
}

function GreetingBar() {
  const { t } = useI18n();
  const avatar = useUserProfileStore((s) => s.avatar);
  const nickname = useUserProfileStore((s) => s.nickname);
  const bio = useUserProfileStore((s) => s.bio);
  const setAvatar = useUserProfileStore((s) => s.setAvatar);
  const setNickname = useUserProfileStore((s) => s.setNickname);
  const setBio = useUserProfileStore((s) => s.setBio);

  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const displayName = nickname || t('profile.defaultNickname');

  // Click-outside to collapse
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditingName(false);
        setAvatarPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const startEditName = () => {
    setNameDraft(nickname);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const commitName = () => {
    setNickname(nameDraft.trim());
    setEditingName(false);
  };

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_AVATAR_SIZE) {
      toast.error(t('profile.fileTooLarge'));
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast.error(t('profile.invalidFileType'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d')!;
        const scale = Math.max(128 / img.width, 128 / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (128 - w) / 2, (128 - h) / 2, w, h);
        setAvatar(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div ref={containerRef} className="relative pl-4 pr-2 pt-3.5 pb-1 w-auto">
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleAvatarUpload}
      />

      {/* ── Collapsed pill (always in flow) ── */}
      {!open && (
        <div
          className="flex items-center gap-2.5 cursor-pointer transition-all duration-200 group rounded-full px-2.5 py-1.5 border border-border/50 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 active:scale-[0.97]"
          onClick={() => setOpen(true)}
        >
          <div className="shrink-0 relative">
            <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-border/30 group-hover:ring-violet-400/60 dark:group-hover:ring-violet-400/40 transition-all duration-300">
              <img src={avatar} alt="" className="size-full object-cover" />
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-white dark:bg-slate-800 border border-border/40 flex items-center justify-center opacity-60 group-hover:opacity-100 transition-opacity">
              <Pencil className="size-[7px] text-muted-foreground/70" />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="leading-none select-none flex items-center gap-1">
                  <span className="text-[13px] font-semibold text-foreground/85 group-hover:text-foreground transition-colors">
                    {t('home.greetingWithName', { name: displayName })}
                  </span>
                  <ChevronDown className="size-3 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors shrink-0" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                {t('profile.editTooltip')}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}

      {/* ── Expanded panel (absolute, floating) ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="absolute left-4 top-3.5 z-50 w-64"
          >
            <div className="rounded-2xl bg-white/95 dark:bg-slate-800/95 backdrop-blur-sm ring-1 ring-black/[0.04] dark:ring-white/[0.06] shadow-[0_1px_8px_-2px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_8px_-2px_rgba(0,0,0,0.3)] px-2.5 py-2">
              {/* ── Row: avatar + name ── */}
              <div
                className="flex items-center gap-2.5 cursor-pointer transition-all duration-200"
                onClick={() => {
                  setOpen(false);
                  setEditingName(false);
                  setAvatarPickerOpen(false);
                }}
              >
                {/* Avatar */}
                <div
                  className="shrink-0 relative cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAvatarPickerOpen(!avatarPickerOpen);
                  }}
                >
                  <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-violet-300/70 dark:ring-violet-500/40 transition-all duration-300">
                    <img src={avatar} alt="" className="size-full object-cover" />
                  </div>
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-white dark:bg-slate-800 border border-border/60 flex items-center justify-center"
                  >
                    <ChevronDown
                      className={cn(
                        'size-2 text-muted-foreground/70 transition-transform duration-200',
                        avatarPickerOpen && 'rotate-180',
                      )}
                    />
                  </motion.div>
                </div>

                {/* Text */}
                <div className="flex-1 min-w-0">
                  {editingName ? (
                    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        ref={nameInputRef}
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitName();
                          if (e.key === 'Escape') {
                            setEditingName(false);
                          }
                        }}
                        onBlur={commitName}
                        maxLength={20}
                        placeholder={t('profile.defaultNickname')}
                        className="flex-1 min-w-0 h-6 bg-transparent border-b border-border/80 text-[13px] font-semibold text-foreground outline-none placeholder:text-muted-foreground/40"
                      />
                      <button
                        onClick={commitName}
                        className="shrink-0 size-5 rounded flex items-center justify-center text-violet-500 hover:bg-violet-100 dark:hover:bg-violet-900/30"
                      >
                        <Check className="size-3" />
                      </button>
                    </div>
                  ) : (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        startEditName();
                      }}
                      className="group/name inline-flex items-center gap-1 cursor-pointer"
                    >
                      <span className="text-[13px] font-semibold text-foreground/85 group-hover/name:text-foreground transition-colors">
                        {displayName}
                      </span>
                      <Pencil className="size-2.5 text-muted-foreground/30 opacity-0 group-hover/name:opacity-100 transition-opacity" />
                    </span>
                  )}
                </div>

                {/* Collapse arrow */}
                <motion.div
                  initial={{ opacity: 0, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="shrink-0 size-6 rounded-full flex items-center justify-center hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                >
                  <ChevronUp className="size-3.5 text-muted-foreground/50" />
                </motion.div>
              </div>

              {/* ── Expandable content ── */}
              <div className="pt-2" onClick={(e) => e.stopPropagation()}>
                {/* Avatar picker */}
                <AnimatePresence>
                  {avatarPickerOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      <div className="p-1 pb-2.5 flex items-center gap-1.5 flex-wrap">
                        {AVATAR_OPTIONS.map((url) => (
                          <button
                            key={url}
                            onClick={() => setAvatar(url)}
                            className={cn(
                              'size-7 rounded-full overflow-hidden bg-gray-50 dark:bg-gray-800 cursor-pointer transition-all duration-150',
                              'hover:scale-110 active:scale-95',
                              avatar === url
                                ? 'ring-2 ring-violet-400 dark:ring-violet-500 ring-offset-0'
                                : 'hover:ring-1 hover:ring-muted-foreground/30',
                            )}
                          >
                            <img src={url} alt="" className="size-full" />
                          </button>
                        ))}
                        <label
                          className={cn(
                            'size-7 rounded-full flex items-center justify-center cursor-pointer transition-all duration-150 border border-dashed',
                            'hover:scale-110 active:scale-95',
                            isCustomAvatar(avatar)
                              ? 'ring-2 ring-violet-400 dark:ring-violet-500 ring-offset-0 border-violet-300 dark:border-violet-600 bg-violet-50 dark:bg-violet-900/30'
                              : 'border-muted-foreground/30 text-muted-foreground/50 hover:border-muted-foreground/50',
                          )}
                          onClick={() => avatarInputRef.current?.click()}
                          title={t('profile.uploadAvatar')}
                        >
                          <ImagePlus className="size-3" />
                        </label>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Bio */}
                <UITextarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder={t('profile.bioPlaceholder')}
                  maxLength={200}
                  rows={2}
                  className="resize-none border-border/40 bg-transparent min-h-[72px] !text-[13px] !leading-relaxed placeholder:!text-[11px] placeholder:!leading-relaxed focus-visible:ring-1 focus-visible:ring-border/60"
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Classroom Card — clean, minimal style ──────────────────────
function ClassroomCard({
  classroom,
  slide,
  formatDate,
  onDelete,
  onRename,
  confirmingDelete,
  onConfirmDelete,
  onCancelDelete,
  onClick,
}: {
  classroom: StageListItem;
  slide?: Slide;
  formatDate: (ts: number) => string;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onRename: (id: string, newName: string) => void;
  confirmingDelete: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const thumbRef = useRef<HTMLDivElement>(null);
  const [thumbWidth, setThumbWidth] = useState(0);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = thumbRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setThumbWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (editing) nameInputRef.current?.focus();
  }, [editing]);

  const isTaskEngineMode = classroom.taskEngineMode === true;
  const showModeBadge = classroom.interactiveMode || isTaskEngineMode;
  const ModeBadgeIcon = isTaskEngineMode ? Sparkles : Atom;
  const modeBadgeLabel = isTaskEngineMode ? 'Vocational Mode' : t('toolbar.interactiveModeLabel');

  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setNameDraft(classroom.name);
    setEditing(true);
  };

  const commitRename = () => {
    if (!editing) return;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== classroom.name) {
      onRename(classroom.id, trimmed);
    }
    setEditing(false);
  };

  return (
    <div className="group cursor-pointer" onClick={confirmingDelete ? undefined : onClick}>
      {/* Thumbnail — large radius, no border, subtle bg */}
      <div
        ref={thumbRef}
        className="relative w-full aspect-[16/9] rounded-2xl bg-slate-100 dark:bg-slate-800/80 overflow-hidden transition-transform duration-200 group-hover:scale-[1.02]"
      >
        {slide && thumbWidth > 0 ? (
          <SlideThumbnail
            slide={slide}
            size={thumbWidth}
            viewportSize={slide.viewportSize ?? 1000}
            viewportRatio={slide.viewportRatio ?? 0.5625}
          />
        ) : !slide ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="size-12 rounded-2xl bg-gradient-to-br from-violet-100 to-blue-100 dark:from-violet-900/30 dark:to-blue-900/30 flex items-center justify-center">
              <span className="text-xl opacity-50">📄</span>
            </div>
          </div>
        ) : null}

        {showModeBadge && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={modeBadgeLabel}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  'absolute bottom-2 left-2 inline-flex items-center justify-center size-5 rounded-full bg-white/70 dark:bg-slate-900/60 backdrop-blur-sm shadow-sm z-10',
                  isTaskEngineMode
                    ? 'text-amber-600 dark:text-amber-300 ring-1 ring-amber-500/35'
                    : 'text-cyan-600 dark:text-cyan-300 ring-1 ring-cyan-500/30',
                )}
              >
                <ModeBadgeIcon className="size-3" />
              </span>
            </TooltipTrigger>
            {/* Negative sideOffset compensates for the global Tooltip Arrow's
                rotate-45 bounding box, which Radix reserves as spacing. */}
            <TooltipContent
              side="top"
              align="start"
              sideOffset={-4}
              collisionPadding={0}
              className="text-xs"
            >
              {modeBadgeLabel}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Delete — top-right, only on hover */}
        <AnimatePresence>
          {!confirmingDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <Button
                size="icon"
                variant="ghost"
                className="absolute top-2 right-2 size-7 opacity-0 group-hover:opacity-100 transition-opacity bg-black/30 hover:bg-destructive/80 text-white hover:text-white backdrop-blur-sm rounded-full"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(classroom.id, e);
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="absolute top-2 right-11 size-7 opacity-0 group-hover:opacity-100 transition-opacity bg-black/30 hover:bg-black/50 text-white hover:text-white backdrop-blur-sm rounded-full"
                onClick={(e) => {
                  e.stopPropagation();
                  // Open the saved course in the classroom so the admin
                  // (or teacher) can preview it, and toggle on the
                  // MAIC Editor (Pro mode) once NEXT_PUBLIC_MAIC_EDITOR_ENABLED
                  // is set. The `?editor=1` query string is a convention
                  // we propagate to the EditChromeRoot — it auto-enables
                  // the edit-mode toggle when the MAIC Editor flag is on.
                  window.open(`/classroom/${classroom.id}?editor=1`, '_blank');
                }}
              >
                <Pencil className="size-3.5" />
              </Button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Inline delete confirmation overlay */}
        <AnimatePresence>
          {confirmingDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/50 backdrop-blur-[6px]"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-[13px] font-medium text-white/90">
                {t('classroom.deleteConfirmTitle')}?
              </span>
              <div className="flex gap-2">
                <button
                  className="px-3.5 py-1 rounded-lg text-[12px] font-medium bg-white/15 text-white/80 hover:bg-white/25 backdrop-blur-sm transition-colors"
                  onClick={onCancelDelete}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="px-3.5 py-1 rounded-lg text-[12px] font-medium bg-red-500/90 text-white hover:bg-red-500 transition-colors"
                  onClick={onConfirmDelete}
                >
                  {t('classroom.delete')}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Info — outside the thumbnail */}
      <div className="mt-2.5 px-1 flex items-center gap-2">
        <span className="shrink-0 inline-flex items-center rounded-full bg-violet-100 dark:bg-violet-900/30 px-2 py-0.5 text-[11px] font-medium text-violet-600 dark:text-violet-400">
          {classroom.sceneCount} {t('classroom.slides')} · {formatDate(classroom.updatedAt)}
        </span>
        {editing ? (
          <div className="flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
            <input
              ref={nameInputRef}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setEditing(false);
              }}
              onBlur={commitRename}
              maxLength={100}
              placeholder={t('classroom.renamePlaceholder')}
              className="w-full bg-transparent border-b border-violet-400/60 text-[15px] font-medium text-foreground/90 outline-none placeholder:text-muted-foreground/40"
            />
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <p
                className="font-medium text-[15px] truncate text-foreground/90 min-w-0 cursor-text"
                onDoubleClick={startRename}
              >
                {classroom.name}
              </p>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              sideOffset={4}
              className="!max-w-[min(90vw,32rem)] break-words whitespace-normal"
            >
              <div className="flex items-center gap-1.5">
                <span className="break-all">{classroom.name}</span>
                <button
                  className="shrink-0 p-0.5 rounded hover:bg-foreground/10 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(classroom.name);
                    toast.success(t('classroom.nameCopied'));
                  }}
                >
                  <Copy className="size-3 opacity-60" />
                </button>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
