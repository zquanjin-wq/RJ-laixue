import type { Pool } from 'pg';
import {
  ClassroomGenerationRepository,
  GenerationLeaseLost,
} from './db/classroom-generation-repository';
import { AccessRepository } from './db/access-repository';
import { createGenerationCheckpoints } from './generation-checkpoints';
import { generateClassroom, type ClassroomGenerationProgress } from './classroom-generation';
import { generationRequestSchema, TEXT_GENERATION_PIPELINE_VERSION } from './generation-request';
import { isRetryableGenerationError } from '@/lib/generation/generation-retry';
import type { ThinkingConfig } from '@/lib/types/provider';

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
    if (!finished && !(error instanceof GenerationLeaseLost)) {
      try {
        await jobs.fail(
          lease,
          'GENERATION_FAILED',
          'Generation could not complete; retry or inspect worker diagnostics.',
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
