import {
  buildTaskReport,
  type LearningEventRow,
  type LearnerReportRow,
  type ReportScene,
} from './report';

export type AiBriefReport = ReturnType<typeof buildTaskReport>;

export type AiBriefContent = {
  headline: string;
  summary: string;
  strengths: string[];
  attention: string[];
};

export type AiSuggestion = {
  learnerIds: string[];
  sceneIds: string[];
  reason: string;
};

export type AiBriefResult = {
  classBrief: AiBriefContent;
  learnerBriefs: Array<{ studentId: string; content: AiBriefContent }>;
  suggestions: AiSuggestion[];
};

export function buildAiBriefSnapshot(input: {
  dueAt: string | null;
  learners: LearnerReportRow[];
  events: LearningEventRow[];
  scenes: ReportScene[];
  generatedAt?: Date;
}) {
  const report = buildTaskReport(input);
  const latestEventAt = input.events.length
    ? (input.generatedAt ?? new Date())
    : (input.generatedAt ?? new Date());
  return { report, dataVersion: latestEventAt.toISOString() };
}

export function aiBriefPrompt(snapshot: AiBriefReport): string {
  return `基于下面的确定性学习统计，生成中文 JSON。不得修改或重算任何数字；所有建议必须引用给出的学员 ID 和章节 ID。

返回格式：
{"classBrief":{"headline":"","summary":"","strengths":[""],"attention":[""]},"learnerBriefs":[{"studentId":"","content":{"headline":"","summary":"","strengths":[""],"attention":[""]}}],"suggestions":[{"learnerIds":[""],"sceneIds":[""],"reason":""}]}

只为未开始、逾期、或完成度/掌握度明显需要关注的学员生成个人小结。suggestions 可为空。学习统计：${JSON.stringify(snapshot)}`;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function content(value: unknown): AiBriefContent {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    headline: typeof row.headline === 'string' ? row.headline : '',
    summary: typeof row.summary === 'string' ? row.summary : '',
    strengths: stringArray(row.strengths),
    attention: stringArray(row.attention),
  };
}

/** Parse a model response without inventing an AI result when the response is unusable. */
export function parseAiBrief(text: string): AiBriefResult | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (!parsed.classBrief || typeof parsed.classBrief !== 'object') return null;
    const learnerBriefs = Array.isArray(parsed.learnerBriefs)
      ? parsed.learnerBriefs.flatMap((item) => {
          const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
          return typeof row.studentId === 'string' && row.content
            ? [{ studentId: row.studentId, content: content(row.content) }]
            : [];
        })
      : [];
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.flatMap((item) => {
          const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
          const learnerIds = stringArray(row.learnerIds);
          return learnerIds.length && typeof row.reason === 'string'
            ? [{ learnerIds, sceneIds: stringArray(row.sceneIds), reason: row.reason }]
            : [];
        })
      : [];
    return { classBrief: content(parsed.classBrief), learnerBriefs, suggestions };
  } catch {
    return null;
  }
}
