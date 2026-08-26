/**
 * Stateless Chat API Endpoint
 *
 * POST /api/chat - Send message, receive SSE stream
 *
 * This endpoint:
 * 1. Receives full state from client (messages + storeState)
 * 2. Runs single-pass generation
 * 3. Streams events as SSE (text deltas + tool calls)
 *
 * Fully stateless: interruption is handled by the client aborting
 * the fetch request, which triggers req.signal on the server side.
 */

import { NextRequest } from 'next/server';
import { statelessGenerate } from '@/lib/orchestration/stateless-generate';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { resolveModel } from '@/lib/server/resolve-model';
import { getServerSupabase } from '@/lib/supabase/server';
import { loadTaskSnapshot } from '@/lib/server/learning-tasks/snapshot-loader';
import type { ThinkingConfig } from '@/lib/types/provider';
const log = createLogger('Chat API');

// Allow streaming responses up to 60 seconds
export const maxDuration = 60;

type TaskCourseAiConfig = {
  modelString?: string;
  providerType?: string;
  thinkingConfig?: ThinkingConfig;
  agentIds?: string[];
  agentConfigs?: StatelessChatRequest['config']['agentConfigs'];
};

async function loadTaskCourseAiConfig(
  taskId: string,
  courseId?: string,
): Promise<TaskCourseAiConfig | null> {
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();
  if (!user) return null;

  const snapshot = await loadTaskSnapshot(user.id, taskId, courseId);
  if (!snapshot.ok) return null;

  const stage = snapshot.data.stage as Record<string, unknown>;
  const authoringModel = stage.teacherModelConfig as
    | {
        modelString?: unknown;
        providerType?: unknown;
        thinkingConfig?: unknown;
      }
    | undefined;
  const configuredAgentIds = Array.isArray(stage.agentIds)
    ? stage.agentIds.filter((id): id is string => typeof id === 'string')
    : [];
  const generatedAgentConfigs = Array.isArray(stage.generatedAgentConfigs)
    ? (stage.generatedAgentConfigs as StatelessChatRequest['config']['agentConfigs'])
    : undefined;
  const agentIds =
    configuredAgentIds.length > 0
      ? configuredAgentIds
      : generatedAgentConfigs?.map((agent) => agent.id).filter(Boolean);

  return {
    ...(typeof authoringModel?.modelString === 'string'
      ? { modelString: authoringModel.modelString }
      : {}),
    ...(typeof authoringModel?.providerType === 'string'
      ? { providerType: authoringModel.providerType }
      : {}),
    ...(authoringModel?.thinkingConfig && typeof authoringModel.thinkingConfig === 'object'
      ? { thinkingConfig: authoringModel.thinkingConfig as ThinkingConfig }
      : {}),
    ...(agentIds?.length ? { agentIds } : {}),
    ...(generatedAgentConfigs?.length ? { agentConfigs: generatedAgentConfigs } : {}),
  };
}

/**
 * POST /api/chat
 * Send a message and receive SSE stream of generation events
 *
 * Request body: StatelessChatRequest
 * {
 *   messages: UIMessage[],
 *   storeState: { stage, scenes, currentSceneId, mode },
 *   config: { agentIds, sessionType? },
 *   apiKey: string,
 *   baseUrl?: string,
 *   model?: string
 * }
 *
 * Response: SSE stream of StatelessEvent
 */
export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  let chatModel: string | undefined;
  let chatMessageCount: number | undefined;

  try {
    const body: StatelessChatRequest = await req.json();
    chatModel = body.model;
    chatMessageCount = body.messages?.length;

    // Validate required fields
    if (!body.messages || !Array.isArray(body.messages)) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: messages');
    }

    if (!body.storeState) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: storeState');
    }

    if (!body.config || !body.config.agentIds || body.config.agentIds.length === 0) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: config.agentIds');
    }

    if (body.useServerModel && !body.taskContext?.taskId) {
      return apiError('TASK_CONTEXT_REQUIRED', 400, '学习任务缺少课程上下文');
    }
    const taskAiConfig = body.useServerModel
      ? await loadTaskCourseAiConfig(body.taskContext!.taskId, body.taskContext!.courseId)
      : null;
    if (body.useServerModel && !taskAiConfig) {
      return apiError('TASK_CONTEXT_UNAVAILABLE', 403, '无法读取任务的课程配置');
    }
    const chatConfig = taskAiConfig
      ? {
          ...body.config,
          ...(taskAiConfig.agentIds ? { agentIds: taskAiConfig.agentIds } : {}),
          ...(taskAiConfig.agentConfigs ? { agentConfigs: taskAiConfig.agentConfigs } : {}),
        }
      : body.config;

    const {
      model: languageModel,
      apiKey: resolvedApiKey,
      providerId,
      thinkingConfig: resolvedThinking,
    } = await resolveModel({
      // In a learner task, the course snapshot is the source of truth. This
      // keeps the author-selected AI teacher/model intact and ignores whatever
      // model the learner's browser happened to use previously.
      modelString: taskAiConfig?.modelString ?? (body.useServerModel ? undefined : body.model),
      stage: 'chat-adapter',
      apiKey: body.useServerModel ? undefined : body.apiKey,
      baseUrl: body.useServerModel ? undefined : body.baseUrl,
      providerType:
        taskAiConfig?.providerType ?? (body.useServerModel ? undefined : body.providerType),
      // Let resolveModel arbitrate thinking too: a routed chat-adapter's thinking
      // wins, an unrouted one honors this client thinking (see resolve-model.ts).
      thinkingConfig:
        taskAiConfig?.thinkingConfig ??
        (body.useServerModel ? undefined : (body.thinkingConfig ?? body.thinking)),
    });

    if (isProviderKeyRequired(providerId) && !resolvedApiKey) {
      return apiError('MISSING_API_KEY', 401, 'API Key is required');
    }

    log.info('Processing request');
    log.info(
      `Agents: ${chatConfig.agentIds.join(', ')}, Messages: ${body.messages.length}, Turn: ${body.directorState?.turnCount ?? 0}`,
    );

    // Use the native request signal for abort propagation
    const signal = req.signal;

    // Create SSE stream
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // Stream generation in background with heartbeat to prevent connection timeout
    const HEARTBEAT_INTERVAL_MS = 15_000;
    (async () => {
      // Heartbeat: periodically send SSE comments to keep the connection alive.
      // Proxies / browsers may close idle SSE connections after 30-120s of silence.
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      const startHeartbeat = () => {
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
          try {
            writer.write(encoder.encode(`:heartbeat\n\n`)).catch(() => stopHeartbeat());
          } catch {
            stopHeartbeat();
          }
        }, HEARTBEAT_INTERVAL_MS);
      };
      const stopHeartbeat = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      try {
        startHeartbeat();

        // Use the resolved thinking (route-pinned for a routed chat-adapter,
        // else the client's). Default to disabled for low-latency chat.
        const thinkingConfig: ThinkingConfig = resolvedThinking ?? {
          mode: 'disabled',
          enabled: false,
        };

        const generator = statelessGenerate(
          {
            ...body,
            config: chatConfig,
            apiKey: resolvedApiKey,
          },
          signal,
          languageModel,
          thinkingConfig,
        );

        for await (const event of generator) {
          if (signal.aborted) {
            log.info('Request was aborted');
            break;
          }

          const data = `data: ${JSON.stringify(event)}\n\n`;
          await writer.write(encoder.encode(data));
        }

        stopHeartbeat();
        await writer.close();
      } catch (error) {
        stopHeartbeat();

        // If aborted, just close the writer silently
        if (signal.aborted) {
          log.info('Request aborted during streaming');
          try {
            await writer.close();
          } catch {
            /* already closed */
          }
          return;
        }

        log.error(
          `Chat stream error [model=${body.model ?? 'unknown'}, agents=${body.config?.agentIds?.length ?? 0}, messages=${body.messages?.length ?? 0}]:`,
          error,
        );

        // Try to send error event
        try {
          const errorEvent: StatelessEvent = {
            type: 'error',
            data: {
              message: error instanceof Error ? error.message : String(error),
            },
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
          await writer.close();
        } catch {
          // Writer may already be closed
        }
      }
    })();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    log.error(
      `Chat request failed [model=${chatModel ?? 'unknown'}, messages=${chatMessageCount ?? 0}]:`,
      error,
    );
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to process request',
    );
  }
}
