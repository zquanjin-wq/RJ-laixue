import {
  getServerProviders,
  getServerTTSProviders,
  getServerASRProviders,
  getServerPDFProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
  getServerTokenPlan,
  getParallelSceneConcurrency,
} from '@/lib/server/provider-config';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { requireAuthOrTeacher } from '@/lib/server/api-guard';
import { createLogger } from '@/lib/logger';

const log = createLogger('ServerProviders');

export async function GET() {
  const guard = await requireAuthOrTeacher(['learner', 'teacher', 'admin']);
  if (!guard.ok) return guard.response;

  try {
    return apiSuccess({
      providers: getServerProviders(),
      tts: getServerTTSProviders(),
      asr: getServerASRProviders(),
      pdf: getServerPDFProviders(),
      image: getServerImageProviders(),
      video: getServerVideoProviders(),
      webSearch: getServerWebSearchProviders(),
      tokenPlan: getServerTokenPlan(),
      generation: {
        parallelSceneConcurrency: getParallelSceneConcurrency(),
      },
    });
  } catch (error) {
    log.error('Error fetching server providers:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
