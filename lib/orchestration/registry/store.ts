/**
 * Agent Registry Store
 * Manages configurable AI agents using Zustand with localStorage persistence
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AgentConfig } from './types';
import { getActionsForRole } from './types';
import type { TTSProviderId } from '@/lib/audio/types';
import type { VoiceDesign } from '@/lib/audio/voice-design';
import { USER_AVATAR } from '@/lib/types/roundtable';
import type { Participant, ParticipantRole } from '@/lib/types/roundtable';
import { useUserProfileStore } from '@/lib/store/user-profile';
import type { AgentInfo } from '@/lib/generation/pipeline-types';

interface AgentRegistryState {
  agents: Record<string, AgentConfig>; // Map of agentId -> config

  // Actions
  addAgent: (agent: AgentConfig) => void;
  updateAgent: (id: string, updates: Partial<AgentConfig>) => void;
  deleteAgent: (id: string) => void;
  getAgent: (id: string) => AgentConfig | undefined;
  listAgents: () => AgentConfig[];
}

// Action types available to agents
const WHITEBOARD_ACTIONS = [
  'wb_open',
  'wb_close',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_draw_code',
  'wb_edit_code',
  'wb_clear',
  'wb_delete',
];

const SLIDE_ACTIONS = ['spotlight', 'laser', 'play_video'];

// Default agents - always available on both server and client
const DEFAULT_AGENTS: Record<string, AgentConfig> = {
  'default-1': {
    id: 'default-1',
    name: 'AI教师',
    role: 'teacher',
    persona: `你是课堂的主讲教师。你以清晰、温暖、真诚的热情教授知识。

你的教学风格：
- 循序渐进地解释概念，从学生已知的内容出发
- 用生动的比喻、真实的案例和直观的图示让抽象概念变得具体
- 适时停下来检查理解——提问而不是只讲授
- 灵活调整节奏：难点放慢，熟悉的内容快速带过
- 当学生发言时称赞鼓励，温和地纠正错误

你可以使用聚光灯或激光笔指向幻灯片元素，也可以用白板进行手绘讲解。这些动作应自然地融入教学过程，不要宣布你的动作，只管教学。

语气：专业但亲切，耐心，善于鼓励，真诚关心学生是否理解。`,
    avatar: '/avatars/teacher.png',
    color: '#3b82f6',
    allowedActions: [...SLIDE_ACTIONS, ...WHITEBOARD_ACTIONS],
    priority: 10,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-2': {
    id: 'default-2',
    name: 'AI助教',
    role: 'assistant',
    persona: `你是助教。你通过补充说明、解答细节问题来支持主讲教师，确保没有学生掉队。

你的风格：
- 当学生困惑时，用更简单的语言或不同角度重述老师的解释
- 提供具体的例子，尤其是贴近日常生活的实用案例
- 主动补充老师可能略过的背景知识
- 在复杂讲解后总结关键要点
- 可以用白板快速画出辅助说明

你扮演支持性角色——不会抢占课堂，但确保每个人都能跟上。

语气：友好、温暖、接地气。像一个热心的学长学姐，恰好“懂了”的那种。`,
    avatar: '/avatars/assist.png',
    color: '#10b981',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 7,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-3': {
    id: 'default-3',
    name: '显眼包',
    role: 'student',
    persona: `你是班级里的显眼包——所有人都会注意到你。你用幽默的发言、有趣的观察和意想不到的角度为课堂带来活力和笑声。

你的个性：
- 你的笑话和妙语能帮助大家记住知识点
- 当气氛太紧张或大家困惑时，你用幽默缓解
- 把抽象概念和日常生活联系起来，有趣又好记
- 不怕犯错或问“傻问题”——往往大家都在想同样的事
- 喜欢用网络用语和有趣的比喻
- 不会扰乱课堂——幽默让课堂更有趣，大家更放松
- 有时笑话里藏着惊人的洞见

你让课堂保持轻松。当课堂太沉闷时，你来活跃气氛；但你也知道什么时候该收敛。

语气：调皮、有活力、有点调侃。像和朋友聊天一样说话。回答要短——一句话或快速反应，不要长篇大论。`,
    avatar: '/avatars/clown.png',
    color: '#f59e0b',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 4,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-4': {
    id: 'default-4',
    name: '好奇宝宝',
    role: 'student',
    persona: `你是充满好奇心的学生。你总有问题——你的提问常常推动全班更深入地思考。

你的个性：
- 你不断地问“为什么”和“怎么做”——不是为了换乱，而是真心想理解
- 你注意到别人忽略的细节，问边界情况和与其他课题的关联
- 你不怕说“我没听懂”——你的诚实帮助了很多不好意思提问的同学
- 学到新东西时你会很兴奋，并直接表达出来
- 有时你的问题会超前于当前课题，推动讨论向前发展

你代表真诚的好奇心。你的提问让老师的讲解对所有人都更有帮助。

语气：渴望、热情、偶尔困惑。用发现新事物的兴奋说话。提问简洁直接。`,
    avatar: '/avatars/curious.png',
    color: '#ec4899',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-5': {
    id: 'default-5',
    name: '笔记员',
    role: 'student',
    persona: `你是班级里认真的笔记员。你仔细倾听，整理信息，喜欢和大家分享结构化的总结。

你的个性：
- 你自然地将复杂的解释提炼为清晰的要点
- 在关键概念教完后，你会提供快速的总结或回顾
- 你喜欢用白板写下关键公式、定义或结构化提纲
- 你能注意到重要但可能被忽略的内容，并提醒大家
- 偶尔请老师澄清以确保笔记准确

你是考试时所有人都想坐在旁边的同学。你的笔记很传奇。

语气：有条理、乐于助人、略带学究气。说话清晰准确。分享笔记时用结构化格式——编号列表、关键词加粗、清晰的标题。`,
    avatar: '/avatars/note-taker.png',
    color: '#06b6d4',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-6': {
    id: 'default-6',
    name: '思考者',
    role: 'student',
    persona: `你是班级里的深度思考者。当别人专注于理解基础时，你已经在连接想法、质疑假设、探索含义了。

你的个性：
- 你在当前课题和其他领域或概念之间发现意想不到的关联
- 你尊重地挑战观点——“但如果……”和“这难道不是矛盾的吗……”是你的标志性句式
- 你思考更大的图景：哲学意味、现实后果、伦理维度
- 你有时扮演魔鬼代言人，推动讨论走向更深处
- 你的发言常常引发最有趣的课堂讨论

你说话不如别人频繁，但每次发言都会改变对话的方向。你重深度而非广度。

语气：沉思、稳重、求知若渴。发言前会停顿，每句话都经过斟酌、掷地有声。提出发人深省的问题，让所有人停下来思考。`,
    avatar: '/avatars/thinker.png',
    color: '#8b5cf6',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 6,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
};

/**
 * Return the built-in default agents as lightweight AgentInfo objects
 * suitable for the generation pipeline (no UI-only fields like avatar/color).
 */
export function getDefaultAgents(): AgentInfo[] {
  return Object.values(DEFAULT_AGENTS).map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));
}

export const useAgentRegistry = create<AgentRegistryState>()(
  persist(
    (set, get) => ({
      // Initialize with default agents so they're available on server
      agents: { ...DEFAULT_AGENTS },

      addAgent: (agent) =>
        set((state) => ({
          agents: { ...state.agents, [agent.id]: agent },
        })),

      updateAgent: (id, updates) =>
        set((state) => ({
          agents: {
            ...state.agents,
            [id]: { ...state.agents[id], ...updates, updatedAt: new Date() },
          },
        })),

      deleteAgent: (id) =>
        set((state) => {
          const { [id]: _removed, ...rest } = state.agents;
          return { agents: rest };
        }),

      getAgent: (id) => get().agents[id],

      listAgents: () => Object.values(get().agents),
    }),
    {
      name: 'agent-registry-storage',
      version: 11, // Bumped: add voiceOverrides field to AgentConfig
      migrate: (persistedState: unknown) => persistedState,
      // Merge persisted state with default agents
      // Default agents always use code-defined values (not cached)
      // Custom agents use persisted values
      merge: (persistedState: unknown, currentState) => {
        const persisted = persistedState as Record<string, unknown> | undefined;
        const persistedAgents = (persisted?.agents || {}) as Record<string, AgentConfig>;
        const mergedAgents: Record<string, AgentConfig> = { ...DEFAULT_AGENTS };

        // Only preserve non-default, non-generated (custom) agents from cache
        // Generated agents are loaded on-demand from IndexedDB per stage
        for (const [id, agent] of Object.entries(persistedAgents)) {
          const agentConfig = agent as AgentConfig;
          if (!id.startsWith('default-') && !agentConfig.isGenerated) {
            mergedAgents[id] = agentConfig;
          }
        }

        return {
          ...currentState,
          agents: mergedAgents,
        };
      },
    },
  ),
);

/**
 * Convert agents to roundtable participants
 * Maps agent roles to participant roles for the UI
 * @param t - i18n translation function for localized display names
 */
export function agentsToParticipants(
  agentIds: string[],
  t?: (key: string) => string,
): Participant[] {
  const registry = useAgentRegistry.getState();
  const participants: Participant[] = [];
  let hasTeacher = false;

  // Resolve agents and sort: teacher first (by role then priority desc)
  const resolved = agentIds
    .map((id) => registry.getAgent(id))
    .filter((a): a is AgentConfig => a != null);
  resolved.sort((a, b) => {
    if (a.role === 'teacher' && b.role !== 'teacher') return -1;
    if (a.role !== 'teacher' && b.role === 'teacher') return 1;
    return (b.priority ?? 0) - (a.priority ?? 0);
  });

  for (const agent of resolved) {
    // Map agent role to participant role:
    // The first agent with role "teacher" becomes the left-side teacher.
    // If no agent has role "teacher", the highest-priority agent becomes teacher.
    let role: ParticipantRole = 'student';
    if (!hasTeacher) {
      role = 'teacher';
      hasTeacher = true;
    }

    // Use i18n name for default agents, fall back to registry name
    const i18nName = t?.(`settings.agentNames.${agent.id}`);
    const displayName =
      i18nName && i18nName !== `settings.agentNames.${agent.id}` ? i18nName : agent.name;

    participants.push({
      id: agent.id,
      name: displayName,
      role,
      avatar: agent.avatar,
      isOnline: true,
      isSpeaking: false,
    });
  }

  // Always add user participant — use profile store when available
  const userProfile = useUserProfileStore.getState();
  const userName = userProfile.nickname || t?.('common.you') || 'You';
  const userAvatar = userProfile.avatar || USER_AVATAR;

  participants.push({
    id: 'user-1',
    name: userName,
    role: 'user',
    avatar: userAvatar,
    isOnline: true,
    isSpeaking: false,
  });

  return participants;
}

/**
 * Load generated agents for a stage from IndexedDB into the registry.
 * Clears any previously loaded generated agents first.
 * Returns the loaded agent IDs.
 */
export async function loadGeneratedAgentsForStage(stageId: string): Promise<string[]> {
  const { getGeneratedAgentsByStageId } = await import('@/lib/utils/database');
  const records = await getGeneratedAgentsByStageId(stageId);

  const registry = useAgentRegistry.getState();

  // Always clear previously loaded generated agents — even when the new stage
  // has none — to prevent stale agents from a prior auto-classroom leaking
  // into the current preset classroom.
  const currentAgents = registry.listAgents();
  for (const agent of currentAgents) {
    if (agent.isGenerated) {
      registry.deleteAgent(agent.id);
    }
  }

  if (records.length === 0) return [];

  // Add new ones
  const ids: string[] = [];
  for (const record of records) {
    registry.addAgent({
      ...record,
      allowedActions: getActionsForRole(record.role),
      isDefault: false,
      isGenerated: true,
      boundStageId: record.stageId,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.createdAt),
    });
    ids.push(record.id);
  }

  return ids;
}

/**
 * Save generated agents to IndexedDB and registry.
 * Clears old generated agents for this stage first.
 */
export async function saveGeneratedAgents(
  stageId: string,
  agents: Array<{
    id: string;
    name: string;
    role: string;
    persona: string;
    avatar: string;
    color: string;
    priority: number;
    voiceConfig?: { providerId: string; voiceId: string };
    voiceDesign?: VoiceDesign;
  }>,
): Promise<string[]> {
  const { db } = await import('@/lib/utils/database');

  // Clear old generated agents for this stage
  await db.generatedAgents.where('stageId').equals(stageId).delete();

  // Clear from registry
  const registry = useAgentRegistry.getState();
  for (const agent of registry.listAgents()) {
    if (agent.isGenerated) registry.deleteAgent(agent.id);
  }

  // Write to IndexedDB
  const records = agents.map((a) => ({ ...a, stageId, createdAt: Date.now() }));
  await db.generatedAgents.bulkPut(records);

  // Add to registry
  for (const record of records) {
    const { voiceConfig, ...rest } = record;
    registry.addAgent({
      ...rest,
      allowedActions: getActionsForRole(record.role),
      isDefault: false,
      isGenerated: true,
      boundStageId: stageId,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.createdAt),
      ...(voiceConfig
        ? {
            voiceConfig: {
              providerId: voiceConfig.providerId as TTSProviderId,
              voiceId: voiceConfig.voiceId,
            },
          }
        : {}),
    });
  }

  // Eager warm-up: pre-register each generated agent's auto voice so the first
  // spoken line is already stable. Same idempotent ensure as the TTS path;
  // fire-and-forget. Dynamic import keeps this client-only dep out of the
  // server-importable store module.
  void import('@/lib/audio/agent-voice')
    .then((m) => m.warmUpAgentVoices(registry.listAgents().filter((a) => a.isGenerated)))
    .catch(() => undefined);

  return records.map((r) => r.id);
}
