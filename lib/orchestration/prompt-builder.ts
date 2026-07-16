/**
 * Prompt Builder for Stateless Generation
 *
 * Builds system prompts and converts messages for the LLM.
 */

import type { StatelessChatRequest } from '@/lib/types/chat';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { WhiteboardActionRecord, AgentTurnSummary } from './types';
import { getActionDescriptions, getEffectiveActions } from './tool-schemas';
import { buildStateContext } from './summarizers/state-context';
import { buildVirtualWhiteboardContext } from './summarizers/whiteboard-ledger';
import { buildPeerContextSection } from './summarizers/peer-context';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';

// ==================== Role Guidelines ====================

const ROLE_GUIDELINES: Record<string, string> = {
  teacher: `Your role in this classroom: LEAD TEACHER.
You are responsible for:
- Controlling the lesson flow, slides, and pacing
- Explaining concepts clearly with examples and analogies
- Asking questions to check understanding
- Using spotlight/laser to direct attention to slide elements
- Using the whiteboard for diagrams and formulas
You can use all available actions. Never announce your actions — just teach naturally.

CRITICAL — When a student asks a question, answer it DIRECTLY. Do NOT re-explain, summarize, or narrate the current slide content first — the student has already seen it. Only reference specific slide elements if the question is specifically about them. Skip any preamble like "Let me explain this slide" or "As shown on this page" — get straight to the answer.`,

  assistant: `Your role in this classroom: TEACHING ASSISTANT.
You are responsible for:
- Supporting the lead teacher by filling gaps and answering side questions
- Rephrasing explanations in simpler terms when students are confused
- Providing concrete examples and background context
- Using the whiteboard sparingly to supplement (not duplicate) the teacher's content
You play a supporting role — don't take over the lesson.`,

  student: `Your role in this classroom: STUDENT.
You are responsible for:
- Participating actively in discussions
- Asking questions, sharing observations, reacting to the lesson
- Keeping responses SHORT (1-2 sentences max)
- Only using the whiteboard when explicitly invited by the teacher
You are NOT a teacher — your responses should be much shorter than the teacher's.`,
};

// ==================== Types ====================

/**
 * Discussion context for agent-initiated discussions
 */
interface DiscussionContext {
  topic: string;
  prompt?: string;
}

// ==================== Per-variant string constants ====================

const FORMAT_EXAMPLE_SLIDE = `[{"type":"action","name":"spotlight","params":{"elementId":"img_1"}},{"type":"text","content":"Your natural speech to students"}]`;
const FORMAT_EXAMPLE_WB = `[{"type":"action","name":"wb_open","params":{}},{"type":"text","content":"Your natural speech to students"}]`;

const ORDERING_SLIDE = `- spotlight/laser actions should appear BEFORE the corresponding text object (point first, then speak)
- whiteboard actions can interleave WITH text objects (draw while speaking)`;
const ORDERING_WB = `- whiteboard actions can interleave WITH text objects (draw while speaking)`;

const SPOTLIGHT_EXAMPLES = `[{"type":"action","name":"spotlight","params":{"elementId":"img_1"}},{"type":"text","content":"Photosynthesis is the process by which plants convert light energy into chemical energy. Take a look at this diagram."},{"type":"text","content":"During this process, plants absorb carbon dioxide and water to produce glucose and oxygen."}]

[{"type":"action","name":"spotlight","params":{"elementId":"eq_1"}},{"type":"action","name":"laser","params":{"elementId":"eq_2"}},{"type":"text","content":"Compare these two equations — notice how the left side is endothermic while the right side is exothermic."}]

`;

const SLIDE_ACTION_GUIDELINES = `- spotlight: Use to focus attention on ONE key element. Don't overuse — max 1-2 per response.
- laser: Use to point at elements. Good for directing attention during explanations.
`;

const MUTUAL_EXCLUSION_NOTE = `- IMPORTANT — Whiteboard / Canvas mutual exclusion: The whiteboard and slide canvas are mutually exclusive. When the whiteboard is OPEN, the slide canvas is hidden — spotlight and laser actions targeting slide elements will have NO visible effect. If you need to use spotlight or laser, call wb_close first to reveal the slide canvas. Conversely, if the whiteboard is CLOSED, wb_draw_* actions still work (they implicitly open the whiteboard), but be aware that doing so hides the slide canvas.
- Prefer variety: mix spotlights, laser, and whiteboard for engaging teaching. Don't use the same action type repeatedly.`;

// ==================== Private helpers ====================

function buildStudentProfileSection(userProfile?: { nickname?: string; bio?: string }): string {
  if (!userProfile?.nickname && !userProfile?.bio) return '';
  return `\n# Student Profile
You are teaching ${userProfile.nickname || 'a student'}.${userProfile.bio ? `\nTheir background: ${userProfile.bio}` : ''}
Personalize your teaching based on their background when relevant. Address them by name naturally.\n`;
}

function buildLanguageConstraint(langDirective?: string): string {
  return langDirective ? `\n# Language (CRITICAL)\n${langDirective}\n` : '';
}

function buildDiscussionContextSection(
  discussionContext: DiscussionContext | undefined,
  agentResponses: AgentTurnSummary[] | undefined,
): string {
  if (!discussionContext) return '';
  if (agentResponses && agentResponses.length > 0) {
    return `

# Discussion Context
Topic: "${discussionContext.topic}"
${discussionContext.prompt ? `Guiding prompt: ${discussionContext.prompt}` : ''}

You are JOINING an ongoing discussion — do NOT re-introduce the topic or greet the students. The discussion has already started. Contribute your unique perspective, ask a follow-up question, or challenge an assumption made by a previous speaker.`;
  }
  return `

# Discussion Context
You are initiating a discussion on the following topic: "${discussionContext.topic}"
${discussionContext.prompt ? `Guiding prompt: ${discussionContext.prompt}` : ''}

IMPORTANT: As you are starting this discussion, begin by introducing the topic naturally to the students. Engage them and invite their thoughts. Do not wait for user input - you speak first.`;
}

// ==================== System Prompt ====================

/**
 * Build system prompt for structured output generation
 *
 * @param agentConfig - The agent configuration
 * @param storeState - Current application state
 * @param discussionContext - Optional discussion context for agent-initiated discussions
 * @returns System prompt string
 */
export function buildStructuredPrompt(
  agentConfig: AgentConfig,
  storeState: StatelessChatRequest['storeState'],
  discussionContext?: DiscussionContext,
  whiteboardLedger?: WhiteboardActionRecord[],
  userProfile?: { nickname?: string; bio?: string },
  agentResponses?: AgentTurnSummary[],
  isUserQA = false,
): string {
  // Determine current scene type for action filtering
  const currentScene = storeState.currentSceneId
    ? storeState.scenes.find((s) => s.id === storeState.currentSceneId)
    : undefined;
  const sceneType = currentScene?.type;
  const effectiveActions = getEffectiveActions(agentConfig.allowedActions, sceneType);
  const hasSlideActions =
    effectiveActions.includes('spotlight') || effectiveActions.includes('laser');

  const vars = {
    agentName: agentConfig.name,
    persona: agentConfig.persona,
    roleGuideline: ROLE_GUIDELINES[agentConfig.role] || ROLE_GUIDELINES.student,
    studentProfileSection: buildStudentProfileSection(userProfile),
    peerContext: buildPeerContextSection(agentResponses, agentConfig.name),
    languageConstraint: buildLanguageConstraint(storeState.stage?.languageDirective),
    formatExample: hasSlideActions ? FORMAT_EXAMPLE_SLIDE : FORMAT_EXAMPLE_WB,
    orderingPrinciples: hasSlideActions ? ORDERING_SLIDE : ORDERING_WB,
    spotlightExamples: hasSlideActions ? SPOTLIGHT_EXAMPLES : '',
    actionDescriptions: getActionDescriptions(effectiveActions),
    slideActionGuidelines: hasSlideActions ? SLIDE_ACTION_GUIDELINES : '',
    mutualExclusionNote: hasSlideActions ? MUTUAL_EXCLUSION_NOTE : '',
    stateContext: buildStateContext(storeState, isUserQA),
    virtualWhiteboardContext: buildVirtualWhiteboardContext(storeState, whiteboardLedger),
    lengthGuidelines: buildLengthGuidelines(agentConfig.role),
    whiteboardGuidelines: buildWhiteboardGuidelines(agentConfig.role),
    discussionContextSection: buildDiscussionContextSection(discussionContext, agentResponses),
  };

  // Q&A mode: completely replace the prompt with a focused "answer the
  // question" system prompt. Previous attempts only appended a CRITICAL
  // directive at the end, but LLMs weight the BEGINNING of the system
  // prompt much more heavily than the tail — so a late directive gets
  // drowned out by the rich template-rendered content above it (state
  // context, slide narration hints, discussion guidance). The model
  // ended up saying "同学们好，今天我们进入《制定目标》" because that
  // was the dominant signal in the template body.
  //
  // A lean, purpose-built prompt the model reads top-to-bottom with
  // only the question in front of it is far more reliable than a
  // post-hoc override glued to the end of a 600-line template.
  if (isUserQA) {
    return buildQASystemPrompt({ agentConfig, storeState, agentResponses });
  }

  const prompt = buildPrompt(PROMPT_IDS.AGENT_SYSTEM, vars);
  if (!prompt) {
    throw new Error('agent-system template not found');
  }
  return prompt.system;
}

/**
 * A focused, self-contained system prompt for the Q&A turn.
 *
 * Kept short on purpose. Every line earns its place by either
 * (a) telling the model what NOT to do (anti-lecture), or
 * (b) telling it what TO do (answer the question).
 *
 * No state context dump — we strip slide content because that's
 * exactly what triggers narration. The agent's name + role are
 * the only identity we keep.
 */
function buildQASystemPrompt({
  agentConfig,
  storeState,
  agentResponses,
}: {
  agentConfig: AgentConfig;
  storeState: import('@/lib/types/chat').StatelessChatRequest['storeState'];
  agentResponses?: import('./types').AgentTurnSummary[];
}): string {
  const speakerName = agentConfig.name || 'AI 讲师';
  const currentScene = storeState.currentSceneId
    ? storeState.scenes.find((s) => s.id === storeState.currentSceneId)
    : undefined;

  const lines: string[] = [
    '# ROLE',
    `You are "${speakerName}", speaking in a live classroom Q&A.`,
    '',
    '# ABSOLUTE RULES',
    '1. Your ENTIRE response is the answer to the student\'s question.',
    '2. Your FIRST word is the answer. No greeting, no preamble.',
    '3. NEVER say "同学们好", "今天我们", "让我们来看", "我们进入", "这门课". Those are lecture openers. You are not lecturing.',
    '4. NEVER use spotlight, laser, wb_*, or any tool call. Just text.',
    '5. Do NOT narrate slide content. The student has already seen the slide.',
    '6. Answer in the user\'s language. Chinese question → Chinese answer.',
    '',
    '# LENGTH',
    '- 1 sentence for trivial questions.',
    '- 2-4 sentences for typical questions.',
    '- Multi-paragraph only when the question genuinely needs depth.',
    '',
    '# ANCHOR (only if the question is specifically about this slide)',
  ];

  if (currentScene) {
    lines.push(
      `The student is currently looking at the slide titled "${currentScene.title}".`,
    );
    lines.push(
      'If and only if their question is specifically about this slide, you may reference its content briefly.',
    );
    lines.push('Otherwise, IGNORE the slide title entirely.');
  } else {
    lines.push('No active slide. Treat the question as a general question.');
  }

  if (agentResponses && agentResponses.length > 0) {
    lines.push('');
    lines.push('# PRIOR TURNS');
    lines.push(
      'Other agents may have already spoken in this Q&A. Do NOT repeat or paraphrase their points. Add a complementary angle if relevant; otherwise stay silent.',
    );
  }

  return lines.join('\n');
}

// ==================== Length Guidelines ====================

/**
 * Build role-aware length and style guidelines.
 *
 * All agents should be concise and conversational. Student agents must be
 * significantly shorter than teacher to avoid overshadowing the teacher's role.
 */
function buildLengthGuidelines(role: string): string {
  const common = `- Length targets count ONLY your speech text (type:"text" content). Actions (spotlight, whiteboard, etc.) do NOT count toward length. Use as many actions as needed — they don't make your speech "too long."
- Speak conversationally and naturally — this is a live classroom, not a textbook. Use oral language, not written prose.`;

  if (role === 'teacher') {
    return `- Keep your TOTAL speech text around 100 characters (across all text objects combined). Prefer 2-3 short sentences over one long paragraph.
${common}
- Prioritize inspiring students to THINK over explaining everything yourself. Ask questions, pose challenges, give hints — don't just lecture.
- When explaining, give the key insight in one crisp sentence, then pause or ask a question. Avoid exhaustive explanations.`;
  }

  if (role === 'assistant') {
    return `- Keep your TOTAL speech text around 80 characters. You are a supporting role — be brief.
${common}
- One key point per response. Don't repeat the teacher's full explanation — add a quick angle, example, or summary.`;
  }

  // Student roles — must be noticeably shorter than teacher
  return `- Keep your TOTAL speech text around 50 characters. 1-2 sentences max.
${common}
- You are a STUDENT, not a teacher. Your responses should be much shorter than the teacher's. If your response is as long as the teacher's, you are doing it wrong.
- Speak in quick, natural reactions: a question, a joke, a brief insight, a short observation. Not paragraphs.
- Inspire and provoke thought with punchy comments, not lengthy analysis.`;
}

// ==================== Whiteboard Guidelines ====================

/**
 * Build role-aware whiteboard guidelines.
 *
 * Content lives in markdown templates under lib/prompts/templates/agent-system-wb-<role>/
 * with the shared reference at lib/prompts/snippets/whiteboard-reference.md.
 */
function buildWhiteboardGuidelines(role: string): string {
  const templateId =
    role === 'teacher'
      ? PROMPT_IDS.AGENT_SYSTEM_WB_TEACHER
      : role === 'assistant'
        ? PROMPT_IDS.AGENT_SYSTEM_WB_ASSISTANT
        : PROMPT_IDS.AGENT_SYSTEM_WB_STUDENT;

  const prompt = buildPrompt(templateId, {});
  if (!prompt) {
    throw new Error(`${templateId} template not found`);
  }
  return prompt.system;
}
