'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, Loader2, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { getTTSVoices, TTS_PROVIDERS } from '@/lib/audio/constants';
import type { TTSProviderId } from '@/lib/audio/types';
import type { StageTeacherVoiceConfig } from '@/lib/teacher/apply-teacher-voice';
import { prepareCourseForAssetUploads } from '@/lib/course-assets/prepare-course';

type Job = {
  id: string;
  status: string;
  total: number;
  completed: number;
  message: string;
  error?: string;
  done: boolean;
  voice: StageTeacherVoiceConfig;
};

export function TeacherVoiceControl({
  variant = 'roster',
}: {
  readonly variant?: 'roster' | 'header';
}) {
  const stage = useStageStore((s) => s.stage);
  const scenes = useStageStore((s) => s.scenes);
  const outlines = useStageStore((s) => s.outlines);
  const setScenes = useStageStore((s) => s.setScenes);
  const updateStage = useStageStore((s) => s.updateStage);
  const settingsProvider = useSettingsStore((s) => s.ttsProviderId);
  const providerConfigs = useSettingsStore((s) => s.ttsProvidersConfig);
  const courseVoice = (
    stage as (typeof stage & { teacherVoiceConfig?: StageTeacherVoiceConfig }) | null
  )?.teacherVoiceConfig;
  const providerId = (courseVoice?.providerId || settingsProvider) as TTSProviderId;
  const voices = useMemo(() => getTTSVoices(providerId), [providerId]);
  const [selectedVoice, setSelectedVoice] = useState(courseVoice?.voiceId || voices[0]?.id || '');
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const jobStatuses = useRef(new Map<string, string>());
  const syncedJobs = useRef(new Set<string>());
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!open) setSelectedVoice(courseVoice?.voiceId || voices[0]?.id || '');
  }, [courseVoice?.voiceId, open, voices]);

  useEffect(() => {
    if (!stage?.id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/courses/${encodeURIComponent(stage.id)}/revoice${job ? `?jobId=${encodeURIComponent(job.id)}` : ''}`,
        );
        const payload = await response.json();
        const next = payload?.job as Job | null;
        if (!next || stopped) return;
        const priorStatus = jobStatuses.current.get(next.id);
        jobStatuses.current.set(next.id, next.status);
        setJob(next);
        if (next.status === 'succeeded' && !syncedJobs.current.has(next.id)) {
          syncedJobs.current.add(next.id);
          const courseResponse = await fetch(`/api/courses/${encodeURIComponent(stage.id)}`);
          const course = await courseResponse.json();
          const data = course?.data?.data;
          if (data?.stage && Array.isArray(data.scenes) && !stopped) {
            setScenes(data.scenes);
            updateStage(data.stage);
          }
          if (priorStatus && priorStatus !== 'succeeded') {
            toast.success('AI 老师音色已更新，配音已保存到云端');
            setOpen(false);
          }
        } else if (
          (next.status === 'failed' || next.status === 'conflict') &&
          priorStatus !== next.status
        ) {
          toast.error(next.message || next.error || '重新配音未完成，课程仍使用原音色');
        }
        if (!next.done && !stopped) {
          timer = setTimeout(poll, payload?.pollIntervalMs || 5000);
        }
      } catch {
        if (!stopped) timer = setTimeout(poll, 8000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [job?.id, open, setScenes, stage?.id, updateStage]);

  const running = starting || (!!job && !job.done);
  const currentName = courseVoice?.voiceId
    ? voices.find((voice) => voice.id === courseVoice.voiceId)?.name || courseVoice.voiceId
    : '未设置';

  async function handleReplace() {
    if (!stage || starting || !selectedVoice) return;
    setStarting(true);
    try {
      const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
      const voice = {
        providerId,
        voiceId: selectedVoice,
        modelId: providerConfigs[providerId]?.modelId || provider?.defaultModelId || undefined,
      };
      const stageWithVoice = { ...stage, teacherVoiceConfig: voice };
      // A course package can contain large inline slide assets. Do not send its
      // complete snapshot through the revoice endpoint (Vercel rejects that as
      // a 413). First externalize those assets and create a compact cloud draft
      // only when this course does not exist yet; then the job request carries
      // only the target voice.
      const courseProbe = await fetch(`/api/courses/${encodeURIComponent(stage.id)}`, {
        cache: 'no-store',
      });
      if (courseProbe.status === 404) {
        const prepared = await prepareCourseForAssetUploads({
          id: stage.id,
          title: stage.name || '',
          topic: '',
          stage: stageWithVoice as unknown as Record<string, unknown>,
          scenes: scenes as unknown as Record<string, unknown>[],
          outlines,
          forceCourseNamespace: true,
        });
        setScenes(prepared.scenes as unknown as typeof scenes);
        updateStage(
          prepared.stage as unknown as Partial<typeof stage> &
            Record<'teacherVoiceConfig', StageTeacherVoiceConfig>,
        );
      } else if (!courseProbe.ok) {
        const detail = await courseProbe.json().catch(() => null);
        throw new Error(detail?.error || '无法验证云端课程');
      }
      const response = await fetch(`/api/courses/${encodeURIComponent(stage.id)}/revoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success || !payload?.job)
        throw new Error(payload?.error || '无法创建重新配音任务');
      jobStatuses.current.set(payload.job.id, payload.job.status);
      setJob(payload.job as Job);
      const acceptedVoice = payload.job.voice || voice;
      updateStage(
        { teacherVoiceConfig: acceptedVoice } as Partial<typeof stage> &
          Record<'teacherVoiceConfig', StageTeacherVoiceConfig>,
      );
      toast.success(
        payload.job.done
          ? '该课程已经使用所选音色'
          : '已加入重新配音队列；离开页面会暂停，返回后自动继续',
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重新配音失败');
    } finally {
      setStarting(false);
    }
  }

  async function cancelJob() {
    if (!stage?.id || !job?.id) return setOpen(false);
    const response = await fetch(
      `/api/courses/${encodeURIComponent(stage.id)}/revoice?jobId=${encodeURIComponent(job.id)}`,
      { method: 'DELETE' },
    );
    if (response.ok) {
      setJob((current) => (current ? { ...current, status: 'cancelled', done: true } : current));
      toast.success('已停止重新配音，课程继续使用原音色');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          className={
            variant === 'roster'
              ? 'inline-flex w-full items-center justify-between gap-2 rounded-lg border border-violet-200 bg-white px-3 py-2 text-left text-xs font-medium text-violet-700 transition-colors hover:border-violet-400 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-75 dark:border-violet-700/60 dark:bg-gray-900 dark:text-violet-300'
              : 'shrink-0 inline-flex h-8 max-w-[150px] items-center gap-1.5 rounded-full border border-violet-200/70 bg-white/60 px-3 text-xs text-violet-700 shadow-sm backdrop-blur-md hover:border-violet-400 dark:border-violet-700/60 dark:bg-gray-800/60 dark:text-violet-300'
          }
          title={running ? '重新配音进行中，点击查看进度' : `当前使用：${currentName}`}
        >
          <Volume2 className="size-3.5" />
          <span className="min-w-0 flex-1 truncate">
            {variant === 'roster' ? `当前使用：${currentName}` : currentName}
          </span>
          {variant === 'roster' && job && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-violet-600">
              {running ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Clock3 className="size-3" />
              )}
              {running ? `重配音 ${job.completed}/${job.total}` : '查看任务'}
            </span>
          )}
          {variant === 'roster' && !running && (
            <span className="text-[11px] text-violet-500">更换</span>
          )}
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>更换 AI 老师音色</DialogTitle>
          <DialogDescription>
            当前部署下，保持页面打开会持续生成；离开后任务会暂停，返回本页将自动继续。完成前课程保持原音色。
            {!courseVoice?.voiceId && ' 此课程尚未固定音色，请先选择一次，之后所有页面会使用同一音色。'}
          </DialogDescription>
        </DialogHeader>
        <Select value={selectedVoice} onValueChange={setSelectedVoice} disabled={running}>
          <SelectTrigger>
            <SelectValue placeholder="选择音色" />
          </SelectTrigger>
          <SelectContent>
            {voices.map((voice) => (
              <SelectItem key={voice.id} value={voice.id}>
                {voice.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" onClick={() => (running ? void cancelJob() : setOpen(false))}>
            {running ? '停止并保留原音色' : '取消'}
          </Button>
          <Button
            onClick={handleReplace}
            disabled={
              running ||
              !selectedVoice
            }
          >
            {running && <Loader2 className="mr-2 size-4 animate-spin" />}
            {running
              ? job
                ? `正在生成配音 ${job.completed}/${job.total}`
                : '正在创建重新配音任务'
              : '确认更换并重新配音'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
