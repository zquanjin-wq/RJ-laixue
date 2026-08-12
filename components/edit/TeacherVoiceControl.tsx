'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Volume2 } from 'lucide-react';
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
import { replaceTeacherVoice } from '@/lib/teacher/replace-teacher-voice';

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
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  useEffect(() => {
    if (!open) setSelectedVoice(courseVoice?.voiceId || voices[0]?.id || '');
  }, [courseVoice?.voiceId, open, voices]);

  const currentName =
    voices.find((voice) => voice.id === courseVoice?.voiceId)?.name ||
    courseVoice?.voiceId ||
    '未设置';

  async function handleReplace() {
    if (!stage || !selectedVoice || selectedVoice === courseVoice?.voiceId) return;
    const controller = new AbortController();
    setRunning(true);
    setAbortController(controller);
    setProgress(null);
    try {
      const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
      const voice = {
        providerId,
        voiceId: selectedVoice,
        modelId: providerConfigs[providerId]?.modelId || provider?.defaultModelId || undefined,
      };
      const result = await replaceTeacherVoice({
        stage,
        scenes,
        outlines,
        voice,
        signal: controller.signal,
        onProgress: ({ completed, total }) => setProgress({ completed, total }),
      });
      setScenes(result.scenes);
      updateStage(result.stage);
      setOpen(false);
      toast.success('AI 老师音色已更新，配音已重新生成并保存到云端');
    } catch (error) {
      toast.error(
        controller.signal.aborted
          ? '已停止重新配音，课程继续使用原音色'
          : error instanceof Error
            ? error.message
            : '重新配音失败',
      );
    } finally {
      setRunning(false);
      setAbortController(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !running && setOpen(next)}>
      <DialogTrigger asChild>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          className={
            variant === 'roster'
              ? 'inline-flex w-full items-center justify-between gap-2 rounded-lg border border-violet-200 bg-white px-3 py-2 text-left text-xs font-medium text-violet-700 transition-colors hover:border-violet-400 hover:bg-violet-50 dark:border-violet-700/60 dark:bg-gray-900 dark:text-violet-300'
              : 'shrink-0 inline-flex h-8 max-w-[150px] items-center gap-1.5 rounded-full border border-violet-200/70 bg-white/60 px-3 text-xs text-violet-700 shadow-sm backdrop-blur-md hover:border-violet-400 dark:border-violet-700/60 dark:bg-gray-800/60 dark:text-violet-300'
          }
          title="重新选择 AI 老师音色"
        >
          <Volume2 className="size-3.5" />
          <span className="min-w-0 flex-1 truncate">
            {variant === 'roster' ? `课程音色：${currentName}` : currentName}
          </span>
          {variant === 'roster' && <span className="text-[11px] text-violet-500">更换</span>}
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>更换 AI 老师音色</DialogTitle>
          <DialogDescription>
            确认后会为整门课程重新生成讲解配音并上传云端。完成前将保留当前音色和音频；可随时停止，已上传的临时文件不会影响课程。
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
          <Button
            variant="outline"
            onClick={() => (running ? abortController?.abort() : setOpen(false))}
            disabled={running && !abortController}
          >
            {running ? '停止并保留原音色' : '取消'}
          </Button>
          <Button
            onClick={handleReplace}
            disabled={running || !selectedVoice || selectedVoice === courseVoice?.voiceId}
          >
            {running && <Loader2 className="mr-2 size-4 animate-spin" />}
            {running
              ? progress
                ? `正在生成配音 ${progress.completed}/${progress.total}…`
                : '正在准备重新配音…'
              : '确认更换并重新配音'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
