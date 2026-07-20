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

// ==================== Q&A Mode Preamble ====================

/**
 * Prepended at the TOP of the agent system prompt when isUserQA=true.
 *
 * The Q&A mode question/answer works as follows:
 * - The user typed a question in the Q&A side panel.
 * - We prepend this block (highest-attention region of the context window)
 *   so the anti-lecture directive is the first thing the model reads.
 * - Below it, the FULL template-rendered system prompt still runs — role,
 *   persona, action guidelines, slide context, history — so the model has
 *   all the context it needs to answer concretely.
 *
 * What this block does NOT do:
 * - It does NOT strip slide content or history. The model needs that
 *   context to give a real answer.
 * - It does NOT lock the model to 1-2 sentences. Real questions deserve
 *   real answers; truncating produced "我们先来看面试官的四级量表——"
 *   single-sentence non-answers.
 * - It does NOT ban spotlight/laser categorically. If pointing at a
 *   specific slide element genuinely helps the answer, the model may
 *   use it. It just may NOT use those actions as a lecture substitute.
 */
const QA_MODE_PREAMBLE = `# Q&A MODE (User Has Asked a Direct Question — OVERRIDES)
The user typed a DIRECT QUESTION in the Q&A side panel. Treat answering this question as your ONLY job for this turn.

Hard rules (these override anything in the rest of this prompt):
1. Your FIRST sentence MUST directly answer the user's question — no exception. BANNED openers: any variation of "好的，这页讲的是…" / "这一页的内容是…" / "我们先来看看…" / "这张幻灯片展示了…" — these are slide narration, not answers. Also banned: "同学们好", "Welcome", "今天我们", "让我们进入", "这门课". If your first sentence could appear at the start of a normal lecture turn, you are doing it wrong.
2. Do NOT continue narrating the current slide. The "Current slide elements" block in this prompt is BACKGROUND CONTEXT for understanding the user's question — not a script to deliver.
3. You MAY reference slide content if it genuinely helps the answer (e.g. the question is about the current slide's topic). Do NOT force a connection — if the question is unrelated to the slide, ignore the slide entirely.
4. You MAY use spotlight/laser if pointing at a specific element genuinely helps your answer. Do NOT use them as a lecture substitute.
5. Match the question's depth with the answer's depth. "怎么做" deserves 2-5 sentences with concrete examples, not a one-sentence deflection.
6. If you genuinely cannot answer, say so plainly ("我不确定" / "I'm not sure"). Do NOT deflect to slide content as a substitute for an answer.
7. VAGUE QUESTIONS — when the student says "这是什么" / "我不懂" / "没看懂" / "能讲一下吗" / "再解释一下", they are asking for help understanding the CURRENT topic. DO NOT ask "你具体想问什么" or "你能再具体描述一下吗" or deflect. Instead: look at the slide title and core content in the state context, then explain the MAIN CONCEPT of this page in clear, simple terms (2-5 sentences with at least one concrete example). The student is confused — your job is to un-confuse them, not to demand a more precise question.

After answering, stop. Do not tee up the next slide, do not summarize the page, do not say "我们继续". Optionally, if the student's question is clearly resolved, you may end with ONE short nudge like "如果问题解决了，可以结束讨论继续上课" to remind the student they can click "End Discussion" — but ONLY as a brief coda, not a new topic.`;

/**
 * Q&A-mode length rules — REPLACE the role length guidelines.
 *
 * The role guidelines cap the teacher at ~100 characters per response.
 * That cap exists for lecture pacing, but in Q&A it amputates real
 * answers: the model stops after one short paragraph even when the
 * question needs depth (observed 2026-07-18: the answer to the SMART
 * "measurable" question ended right after ~130 chars, mid-thought).
 */
const QA_LENGTH_GUIDELINES = `- This is a Q&A ANSWER, not a lecture segment. The ~100-character speech cap from the role guidelines does NOT apply here — it exists for lecture pacing and would amputate a real answer.
- Match the answer's depth to the question: trivial clarification = 1 sentence; a typical "怎么办 / 为什么 / 怎么写" = 2-5 sentences PLUS at least one concrete example or actionable suggestion; genuinely deep topics = multiple short paragraphs.
- COMPLETENESS RULE: finish the whole answer before ending your turn. Never stop at the first paragraph of what should be a multi-part answer. If you promised structure ("有两个办法"), deliver all of it.`;

/**
 * Closing reminder APPENDED at the very END of the system prompt in Q&A
 * mode. The template's own final line ("Remember: Speak naturally as a
 * teacher") owns the recency slot — the highest-attention tail position.
 * In Q&A mode this block takes that slot back, so the last thing the
 * model reads is "answer the question", not "teach the slide".
 */
const QA_MODE_CLOSING = `# Q&A MODE — FINAL REMINDER
Re-read the student's latest message: it is a DIRECT QUESTION, and your entire response is the answer to it.
- FIRST sentence = the answer itself. No greeting, no slide recap, no "我们先来看".
- The slide elements above are BACKGROUND for understanding the question, NOT a script to deliver.
- Give the COMPLETE answer (see the Length rules above) — do not stop early, do not launch into new slide content.
- After the complete answer, optionally end with ONE brief handoff — e.g. "如果问题解决了，可以结束讨论继续上课" — to nudge the student toward clicking "End Discussion". This is a reminder, NOT new teaching: do not start explaining the next slide, do not add more content after it.
- Answer in the student's language.`;

/**
 * Self-contained system prompt for a PEER (role 'student') speaking in Q&A
 * mode. The peer is NOT answering the question — the teacher just did that.
 * The peer reacts as a fellow student: a brief resonance, a relatable "me
 * too", or one short follow-up question. One or two sentences, student voice.
 *
 * This is intentionally separate from the teacher's Q&A sandwich: if the peer
 * received the teacher's "answer the question completely" prompt, it would
 * re-answer the question at length and the two agents would talk past each
 * other. The peer's job is classroom texture, not a second answer.
 */
function buildPeerQASystemPrompt(agentName: string): string {
  return `You are "${agentName}", a fellow STUDENT in this classroom (not the teacher, not an assistant).

A classmate just asked the teacher a question, and the teacher has already answered it. You are now chiming in briefly, as one student to another.

Hard rules:
1. You are NOT answering the question — the teacher already did. Do not re-explain, do not add a second full answer.
2. Say ONE or TWO short sentences, in a natural student voice. Either:
   - react / resonate ("我也有这个疑问…" / "原来如此,那个例子挺有用的"), OR
   - ask ONE short follow-up question a real classmate might ask.
3. Never lecture, never summarize the slide, never use spotlight/laser/whiteboard.
4. Match the language the classmate used (Chinese question → Chinese).
5. Stop after your one or two sentences. Do not say "我们继续" or tee up the next slide.`;
}

/**
 * Plain-text format example for Q&A mode. Keeps the JSON-array output
 * contract intact without priming the "spotlight first, then narrate"
 * pattern that FORMAT_EXAMPLE_SLIDE demonstrates.
 */
const FORMAT_EXAMPLE_QA = `[{"type":"text","content":"Your direct, complete answer to the student's question — in their language, with a concrete example if useful."}]`;

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
  // Q&A mode, PEER (student) agent: return a self-contained "react as a
  // classmate" prompt instead of the teacher's Q&A sandwich. Without this
  // branch the peer would inherit the teacher's "answer the question
  // completely" instructions and produce a second full-length answer,
  // talking past the teacher. The peer's job is classroom texture (a brief
  // resonance or one follow-up question), not another answer.
  if (isUserQA && agentConfig.role === 'student') {
    return buildPeerQASystemPrompt(agentConfig.name);
  }

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
    // Q&A mode de-primes lecture behavior: plain-text format example, no
    // spotlight few-shot, no slide-action guidelines — those taught the
    // model to open with spotlight + slide narration even under Q&A rules.
    formatExample: isUserQA
      ? FORMAT_EXAMPLE_QA
      : hasSlideActions
        ? FORMAT_EXAMPLE_SLIDE
        : FORMAT_EXAMPLE_WB,
    orderingPrinciples: hasSlideActions ? ORDERING_SLIDE : ORDERING_WB,
    spotlightExamples: isUserQA ? '' : hasSlideActions ? SPOTLIGHT_EXAMPLES : '',
    actionDescriptions: getActionDescriptions(effectiveActions),
    slideActionGuidelines: isUserQA ? '' : hasSlideActions ? SLIDE_ACTION_GUIDELINES : '',
    mutualExclusionNote: hasSlideActions ? MUTUAL_EXCLUSION_NOTE : '',
    stateContext: buildStateContext(storeState, isUserQA),
    virtualWhiteboardContext: buildVirtualWhiteboardContext(storeState, whiteboardLedger),
    // Q&A mode swaps the lecture length cap for "complete answer" rules —
    // the ~100-char cap amputated real answers mid-thought.
    lengthGuidelines: isUserQA ? QA_LENGTH_GUIDELINES : buildLengthGuidelines(agentConfig.role),
    whiteboardGuidelines: buildWhiteboardGuidelines(agentConfig.role),
    discussionContextSection: buildDiscussionContextSection(discussionContext, agentResponses),
  };

  // Q&A mode: keep the full template-rendered system prompt (role,
  // persona, slide context, history — the model needs these to answer
  // concretely) and SANDWICH it:
  //   - TOP: QA_MODE_PREAMBLE hard rules (attention)
  //   - BOTTOM: QA_MODE_CLOSING final reminder (recency — the template's
  //     own last line is "Speak naturally as a teacher", which otherwise
  //     owns the tail slot and pulls the model back into narration)
  // Lecture-priming vars (spotlight few-shot, slide-action guidelines,
  // spotlight-first format example, ~100-char length cap) are swapped
  // out in `vars` above when isUserQA is true.
  //
  // The previous design (commit 77b6b20, completely replacing the system
  // prompt with buildQASystemPrompt) put the model in an information
  // vacuum: it saw the slide TITLE and a 6-rule prompt with no slide
  // content, no action guidelines, no prior context. When the user's
  // question was loosely related to the slide, the model latched onto
  // the slide title and produced a one-sentence non-answer like
  // "我们先来看面试官的四级量表——左边这部分". Keeping the full prompt
  // below the preamble lets the model still reference slide content
  // when it's actually relevant.
  const prompt = buildPrompt(PROMPT_IDS.AGENT_SYSTEM, vars);
  if (!prompt) {
    throw new Error('agent-system template not found');
  }
  if (isUserQA) {
    return `${QA_MODE_PREAMBLE}\n\n${prompt.system}\n\n${QA_MODE_CLOSING}`;
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
