import { nanoid } from 'nanoid';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';
import type { PptxPageInspection } from './inspection';
import type { PptxClassroomRosterMember, PptxPageScript } from './draft';

function parseJson(value: string): unknown {
  return JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}

function fallbackRoster(languageDirective: string): PptxClassroomRosterMember[] {
  const chinese = languageDirective.toLowerCase().startsWith('zh');
  return [
    {
      id: 'pptx-teacher',
      name: chinese ? 'AI 老师' : 'AI Instructor',
      role: 'teacher',
      persona: chinese ? '表达清晰，善于联系页面内容循序讲解。' : 'Clear, structured, and attentive to the source material.',
      avatar: AGENT_DEFAULT_AVATARS[0], color: AGENT_COLOR_PALETTE[0], priority: 10,
      voiceDesign: chinese
        ? { identity: '成年教师', texture: '温暖清晰', delivery: '从容鼓励' }
        : { identity: 'adult instructor', texture: 'warm and clear', delivery: 'calm and encouraging' },
    },
    {
      id: 'pptx-companion',
      name: chinese ? '伴学同学' : 'Learning Companion',
      role: 'student',
      persona: chinese ? '主动提问，帮助学习者梳理重点。' : 'Asks useful questions and helps learners connect key ideas.',
      avatar: AGENT_DEFAULT_AVATARS[1], color: AGENT_COLOR_PALETTE[1], priority: 5,
      voiceDesign: chinese
        ? { identity: '青年学习伙伴', texture: '明亮自然', delivery: '积极自然' }
        : { identity: 'young learning companion', texture: 'bright and natural', delivery: 'engaged and natural' },
    },
  ];
}

export async function generatePptxRoster(input: {
  courseTitle: string;
  teachingRequirement: string;
  languageDirective: string;
  pages: PptxPageInspection[];
  aiCall: AICallFn;
  teacherVoice?: { providerId: string; modelId?: string; voiceId: string };
  companionCount?: number;
}): Promise<PptxClassroomRosterMember[]> {
  const pageSummary = input.pages.slice(0, 12).map((page) => `${page.page}. ${page.title}`).join('\n');
  try {
    const raw = await input.aiCall(
      'You design a small, practical roster for an interactive course. Return only JSON.',
      `Course: ${input.courseTitle}\nTeaching requirement: ${input.teachingRequirement}\nLanguage: ${input.languageDirective}\nPages:\n${pageSummary}\n\nReturn exactly one teacher and one student companion as {"agents":[{"name":"","role":"teacher|student","persona":"","voiceDesign":{"identity":"","texture":"","delivery":""}}]}.`,
    );
    const parsed = parseJson(raw) as { agents?: Array<Record<string, unknown>> };
    const agents = parsed.agents ?? [];
    if (agents.filter((agent) => agent.role === 'teacher').length !== 1 || agents.length < 2)
      return fallbackRoster(input.languageDirective);
    const roster: PptxClassroomRosterMember[] = agents.slice(0, Math.max(2, 1 + (input.companionCount ?? 1))).map((agent, index): PptxClassroomRosterMember => ({
      id: `pptx-agent-${nanoid(8)}`,
      name: typeof agent.name === 'string' && agent.name.trim() ? agent.name.trim() : `Agent ${index + 1}`,
      role: agent.role === 'teacher' ? 'teacher' : agent.role === 'assistant' ? 'assistant' : 'student',
      persona: typeof agent.persona === 'string' ? agent.persona.trim() : '',
      avatar: AGENT_DEFAULT_AVATARS[index % AGENT_DEFAULT_AVATARS.length],
      color: AGENT_COLOR_PALETTE[index % AGENT_COLOR_PALETTE.length],
      priority: agent.role === 'teacher' ? 10 : agent.role === 'assistant' ? 7 : 5,
      ...(agent.voiceDesign && typeof agent.voiceDesign === 'object'
        ? { voiceDesign: agent.voiceDesign as PptxClassroomRosterMember['voiceDesign'] }
        : {}),
    }));
    const teacher = roster.find((agent) => agent.role === 'teacher');
    if (teacher && input.teacherVoice) teacher.voiceConfig = input.teacherVoice;
    return roster;
  } catch {
    const roster = fallbackRoster(input.languageDirective);
    if (input.teacherVoice) roster[0].voiceConfig = input.teacherVoice;
    return roster;
  }
}

export async function generatePptxPageScript(input: {
  page: PptxPageInspection;
  previousTitle?: string;
  courseTitle: string;
  teachingRequirement: string;
  languageDirective: string;
  aiCall: AICallFn;
}): Promise<PptxPageScript | null> {
  const speakerNotes = input.page.speakerNotes?.trim();
  if (!speakerNotes && !input.page.visibleText.length) return null;
  const raw = await input.aiCall(
    'You write concise spoken classroom narration. Return plain text only. Never invent facts beyond the slide or its speaker notes. Speaker notes are a draft, not text to recite: preserve their intent while rewriting them into a natural explanation with a transition. Do not mention that you are reading slides or notes.',
    `Course: ${input.courseTitle}\nTeaching requirement: ${input.teachingRequirement}\nLanguage: ${input.languageDirective}\nPrevious page: ${input.previousTitle ?? 'none'}\nCurrent page title: ${input.page.title}\nVisible slide text:\n${input.page.visibleText.join('\n') || '(none)'}\nSpeaker notes draft:\n${speakerNotes ?? '(none)'}\n\nWrite a 45-90 second spoken explanation with a natural transition.`,
  );
  const text = raw.trim();
  return text
    ? {
        sceneId: input.page.sceneId,
        text,
        sourceKind: speakerNotes ? 'speaker_notes_rewritten' : 'ai_generated',
      }
    : null;
}
