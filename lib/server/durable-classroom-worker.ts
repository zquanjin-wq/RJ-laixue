import type { Pool } from 'pg';
import {
  ClassroomGenerationRepository,
  GenerationLeaseLost,
} from './db/classroom-generation-repository';
import { AccessRepository } from './db/access-repository';
import { createGenerationCheckpoints } from './generation-checkpoints';
import { generateClassroom, type ClassroomGenerationProgress } from './classroom-generation';
import {
  generationRequestSchema,
  PPTX_AI_CLASSROOM_PIPELINE_VERSION,
  pptxAiClassroomRequestSchema,
  TEXT_GENERATION_PIPELINE_VERSION,
} from './generation-request';
import { isRetryableGenerationError } from '@/lib/generation/generation-retry';
import type { ThinkingConfig } from '@/lib/types/provider';
import { CourseRepository } from './db/course-repository';
import { PptxSourceRepository } from './db/pptx-source-repository';
import { inspectImportedPptxPages, applyPptxSafeTitleRepairs } from '@/lib/pptx-ai-classroom/inspection';
import {
  applyPptxRoster,
  type PptxPageScript,
} from '@/lib/pptx-ai-classroom/draft';
import { generatePptxPageScript, generatePptxRoster } from '@/lib/pptx-ai-classroom/generation';
import { generatePptxPageActions } from '@/lib/pptx-ai-classroom/actions';
import { validatePptxAiClassroom } from '@/lib/pptx-ai-classroom/quality';
import {
  applyPptxSpeechAudio,
  listPptxSpeechTargets,
  synthesizePptxSpeech,
} from '@/lib/pptx-ai-classroom/tts';
import { callLLM } from '@/lib/ai/llm';
import { resolveModel } from './resolve-model';
import type { Scene, Stage } from '@/lib/types/stage';

export function describeGenerationFailure(error: unknown): { code: string; message: string } {
  const detail = error instanceof Error ? error.message : '';
  if (/\b(tts|voice|speech|audio)\b|配音|音色/i.test(detail)) {
    return {
      code: 'TTS_GENERATION_FAILED',
      message: '课程讲解已生成，但配音未完成。请检查音色服务后重试该课程生成任务。',
    };
  }
  if (/pptx|imported ppt|source/i.test(detail)) {
    return {
      code: 'PPTX_SOURCE_UNAVAILABLE',
      message: '课件来源暂时不可用，未生成不完整课程。请稍后重试。',
    };
  }
  if (/configuration|provider|model|api key|credential|authoring access/i.test(detail)) {
    return {
      code: 'GENERATION_CONFIGURATION_UNAVAILABLE',
      message: '课程生成服务当前不可用，请检查服务配置后重试。',
    };
  }
  return {
    code: 'GENERATION_FAILED',
    message: '课程生成未完成。可以重试任务，课程内容不会被不完整结果覆盖。',
  };
}

export async function runDurableClassroomOnce(
  pool: Pool,
  workerId: string,
  baseUrl: string,
): Promise<boolean> {
  const jobs = new ClassroomGenerationRepository(pool);
  const lease = await jobs.claimNext(workerId);
  if (!lease) return false;
  let finished = false;
  let leaseError: unknown;
  let progress: ClassroomGenerationProgress = {
    step: 'initializing',
    progress: 0,
    message: 'Preparing generation',
    scenesGenerated: 0,
  };
  let heartbeatPending = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatPending = heartbeatPending
      .then(async () => {
        if (!finished && !leaseError) await jobs.heartbeat(lease, progress);
      })
      .catch((error) => {
        leaseError = error;
      });
  }, 30_000);
  try {
    const actor = await new AccessRepository(pool).resolveActor(lease.ownerUserId);
    if (!actor || actor.role === 'learner')
      throw new Error('Generation owner no longer has authoring access');
    if (lease.pipelineKind === 'pptx_ai_classroom') {
      await runPptxAiClassroomJob({ pool, jobs, lease, baseUrl, onProgress: async (next) => {
        progress = next;
        await jobs.heartbeat(lease, progress);
        await jobs.appendEvent(lease, {
          kind: next.step === 'completed' ? 'result' : 'thinking',
          phase: next.step,
          summary: next.message,
          details: { progress: next.progress, scenesGenerated: next.scenesGenerated, totalScenes: next.totalScenes },
        });
      } });
      finished = true;
      return true;
    }
    if (lease.operation !== 'create') throw new Error('Enhancement executor is not enabled yet');
    const input = generationRequestSchema.parse(lease.payload);
    const config = lease.configSnapshot as {
      pipelineVersion?: number;
      model?: { modelString: string; thinkingConfig?: ThinkingConfig };
    };
    if (config.pipelineVersion !== TEXT_GENERATION_PIPELINE_VERSION || !config.model?.modelString) {
      throw new Error('Generation configuration version is unavailable');
    }
    await generateClassroom(input, {
      baseUrl,
      execution: {
        courseId: lease.courseId,
        model: config.model,
        checkpoints: createGenerationCheckpoints(jobs, lease, config),
      },
      onProgress: async (next) => {
        if (finished) return;
        if (leaseError) throw leaseError;
        progress = next;
        await jobs.heartbeat(lease, progress);
      },
      persist: async (draft) => {
        if (leaseError) throw leaseError;
        const committed = await jobs.commitCourse(lease, draft);
        finished = true;
        if (committed.status === 'conflict') throw new Error('Generation course revision conflict');
        return {
          ...draft,
          createdAt: new Date().toISOString(),
          url: `${baseUrl}/classroom/${lease.courseId}`,
        };
      },
    });
  } catch (error) {
    console.error('[durable-classroom-worker] generation failed', {
      jobId: lease.id,
      pipelineKind: lease.pipelineKind,
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (!finished && !(error instanceof GenerationLeaseLost)) {
      try {
        const failure = describeGenerationFailure(error);
        await jobs.fail(
          lease,
          failure.code,
          failure.message,
          isRetryableGenerationError(error),
        );
      } catch (failure) {
        if (!(failure instanceof GenerationLeaseLost)) throw failure;
      }
    }
  } finally {
    finished = true;
    clearInterval(heartbeat);
    await heartbeatPending;
  }
  return true;
}

async function runPptxAiClassroomJob(input: {
  pool: Pool;
  jobs: ClassroomGenerationRepository;
  lease: import('./db/classroom-generation-repository').ClaimedGeneration;
  baseUrl: string;
  onProgress: (progress: ClassroomGenerationProgress) => Promise<void>;
}): Promise<void> {
  const request = pptxAiClassroomRequestSchema.parse(input.lease.payload);
  const config = input.lease.configSnapshot as {
    pipelineVersion?: number;
    model?: { modelString: string; thinkingConfig?: ThinkingConfig };
  };
  if (config.pipelineVersion !== PPTX_AI_CLASSROOM_PIPELINE_VERSION || !config.model?.modelString)
    throw new Error('PPTX AI classroom configuration version is unavailable');
  const courses = new CourseRepository(input.pool);
  const source = await new PptxSourceRepository(input.pool).getOwned(request.sourceId, input.lease.ownerUserId);
  const course = await courses.getCourse(request.courseId);
  if (!source || !course || course.ownerUserId !== input.lease.ownerUserId)
    throw new Error('PPTX source or course is no longer available');
  const content = course.content as { stage?: Stage; scenes?: Scene[]; outlines?: unknown[] };
  if (!content.stage || !Array.isArray(content.scenes) || content.stage.id !== input.lease.courseId)
    throw new Error('Imported PPTX course content is incomplete');
  if ((content.stage as Stage & { pptxSource?: { sourceId?: string } }).pptxSource?.sourceId !== request.sourceId)
    throw new Error('PPTX source does not match the requested course');

  const checkpoints = createGenerationCheckpoints(input.jobs, input.lease, config);
  await input.onProgress({ step: 'initializing', progress: 8, message: '正在检查导入课件', scenesGenerated: 0, totalScenes: content.scenes.length });
  const inspections = await checkpoints.run('inspect_import', { courseId: course.id, scenes: content.scenes }, async () =>
    inspectImportedPptxPages(content.scenes!),
  );
  const scenes = request.applySafeRepairs
    ? applyPptxSafeTitleRepairs(content.scenes, inspections)
    : content.scenes;
  const model = await resolveModel({ modelString: config.model.modelString, thinkingConfig: config.model.thinkingConfig });
  const aiCall = async (systemPrompt: string, userPrompt: string) =>
    (await callLLM({ model: model.model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], maxOutputTokens: model.modelInfo?.outputWindow, maxRetries: 0 }, 'generate-classroom', undefined, model.thinkingConfig)).text;
  await input.onProgress({ step: 'generating_outlines', progress: 20, message: '正在配置 AI 教师与伴学', scenesGenerated: 0, totalScenes: scenes.length });
  const roster = await checkpoints.run('roster', { title: content.stage.name, language: request.languageDirective, inspections }, () =>
    generatePptxRoster({
      courseTitle: content.stage!.name,
      teachingRequirement: request.teachingRequirement,
      languageDirective: request.languageDirective,
      pages: inspections,
      aiCall,
      teacherVoice: request.teacherVoice,
      companionCount: request.companionCount,
    }),
  );
  const scripts: PptxPageScript[] = [];
  for (const [index, page] of inspections.entries()) {
    await input.onProgress({ step: 'generating_scenes', progress: 25 + Math.round((index / Math.max(inspections.length, 1)) * 65), message: `正在生成第 ${page.page} 页讲稿`, scenesGenerated: scripts.length, totalScenes: scenes.length });
    const script = await checkpoints.run(`script/${page.page}`, { page, previousTitle: inspections[index - 1]?.title }, () =>
      generatePptxPageScript({
        page,
        previousTitle: inspections[index - 1]?.title,
        courseTitle: content.stage!.name,
        teachingRequirement: request.teachingRequirement,
        languageDirective: request.languageDirective,
        aiCall,
      }),
    );
    if (script) scripts.push(script);
  }
  if (scripts.length === 0) throw new Error('No teachable PPTX pages produced narration');
  const actionsBySceneId = new Map<string, import('@/lib/types/action').Action[]>();
  const allTitles = inspections.map((page) => page.title);
  for (const [index, script] of scripts.entries()) {
    const page = inspections.find((candidate) => candidate.sceneId === script.sceneId);
    const scene = scenes.find((candidate) => candidate.id === script.sceneId);
    if (!page || !scene) continue;
    await input.onProgress({
      step: 'generating_scenes',
      progress: 78 + Math.round((index / Math.max(scripts.length, 1)) * 10),
      message: `正在生成第 ${page.page} 页讲解动作`,
      scenesGenerated: scripts.length,
      totalScenes: scenes.length,
    });
    const actions = await checkpoints.run(
      `actions/${page.page}`,
      { page, script, interactionIntensity: request.interactionIntensity },
      () =>
        generatePptxPageActions({
          scene,
          inspection: page,
          script,
          pageIndex: page.page - 1,
          allTitles,
          previousSpeeches: scripts
            .filter((candidate) => candidate.sceneId !== script.sceneId)
            .slice(Math.max(0, index - 1), index)
            .map((candidate) => candidate.text),
          roster,
          languageDirective: request.languageDirective,
          interactionIntensity: request.interactionIntensity,
          aiCall,
        }),
    );
    actionsBySceneId.set(script.sceneId, actions);
  }
  let voicedScenes = scenes.map((scene) => {
    const actions = actionsBySceneId.get(scene.id);
    return actions ? { ...scene, actions, updatedAt: Date.now() } : scene;
  });
  const assetIds: string[] = [];
  if (request.enableTTS) {
    const teacherVoice = roster.find((agent) => agent.role === 'teacher')?.voiceConfig;
    const audio = new Map<string, { audioId: string; audioUrl: string }>();
    const targets = listPptxSpeechTargets(voicedScenes);
    for (const [index, target] of targets.entries()) {
      await input.onProgress({ step: 'generating_tts', progress: 90 + Math.round((index / Math.max(targets.length, 1)) * 4), message: `正在生成第 ${index + 1}/${targets.length} 段配音`, scenesGenerated: scripts.length, totalScenes: scenes.length });
      const generated = await checkpoints.run(`tts/${target.sceneId}/${target.actionId}`, target, () =>
        synthesizePptxSpeech({
          courseId: input.lease.courseId,
          ownerUserId: input.lease.ownerUserId,
          target,
          courses,
          voiceConfig: teacherVoice,
        }),
      );
      audio.set(`${target.sceneId}:${target.actionId}`, generated);
      assetIds.push(generated.assetId);
    }
    voicedScenes = applyPptxSpeechAudio(voicedScenes, audio);
  }
  const draft = {
    stage: applyPptxRoster({ ...content.stage, languageDirective: request.languageDirective }, roster),
    scenes: voicedScenes,
    outlines: content.outlines ?? [],
    assetIds,
  };
  const quality = validatePptxAiClassroom({
    stage: draft.stage,
    scenes: draft.scenes,
    requireAudio: request.enableTTS,
  });
  const blocking = quality.issues.filter((issue) => issue.severity === 'error');
  if (blocking.length) {
    throw new Error(`PPTX AI classroom quality validation failed: ${blocking.map((issue) => issue.code).join(', ')}`);
  }
  const warnings = [
    ...inspections.flatMap((page) => page.warnings),
    ...quality.issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message),
  ];
  await input.onProgress({
    step: 'persisting',
    progress: 94,
    message: `课堂校验完成：${quality.speechPages} 页讲解，${quality.audioCoverage.ready}/${quality.audioCoverage.required} 段配音就绪`,
    scenesGenerated: scripts.length,
    totalScenes: scenes.length,
  });
  await input.onProgress({ step: 'persisting', progress: 95, message: '正在保存 AI 课堂草稿', scenesGenerated: scripts.length, totalScenes: scenes.length });
  const committed = await input.jobs.commitCourse(input.lease, { ...draft, warnings });
  if (committed.status === 'conflict') throw new Error('PPTX AI classroom revision conflict');
  await input.onProgress({ step: 'completed', progress: 100, message: 'PPTX AI 课堂已生成', scenesGenerated: scripts.length, totalScenes: scenes.length });
  void input.baseUrl;
}
