'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentModelConfig } from '@/lib/utils/model-config';

type Summary = {
  id: string;
  scope: 'class' | 'learner';
  student_id: string | null;
  content: { headline?: string; summary?: string; strengths?: string[]; attention?: string[] };
  created_at: string;
};

type Suggestion = {
  id: string;
  learner_ids: string[];
  scene_ids: string[];
  reason: string;
  status: 'pending' | 'accepted' | 'ignored';
  created_task_id: string | null;
};

export function TaskAiBrief({ taskId }: { taskId: string }) {
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState('');

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/learning-tasks/${taskId}/ai-brief`);
      const json = (await res.json()) as {
        success?: boolean;
        data?: { summaries?: Summary[]; suggestions?: Suggestion[] };
      };
      if (res.ok && json.success) {
        setSummaries(json.data?.summaries ?? []);
        setSuggestions(json.data?.suggestions ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [taskId]);

  async function generate() {
    setGenerating(true);
    setMessage('');
    try {
      const res = await fetch(`/api/admin/learning-tasks/${taskId}/ai-brief`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(getCurrentModelConfig()),
      });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        data?: { summaries?: Summary[]; suggestions?: Suggestion[] };
      };
      if (!res.ok || !json.success) {
        setMessage(json.error ?? 'AI 简报生成失败，请重试');
        return;
      }
      setSummaries(json.data?.summaries ?? []);
      setSuggestions(json.data?.suggestions ?? []);
      setMessage('已生成新的 AI 简报。');
    } catch {
      setMessage('网络异常，请重试。');
    } finally {
      setGenerating(false);
    }
  }

  async function accept(suggestion: Suggestion) {
    setMessage('');
    try {
      const res = await fetch(
        `/api/admin/learning-tasks/${taskId}/ai-suggestions/${suggestion.id}/accept`,
        { method: 'POST' },
      );
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        data?: { taskId?: string };
      };
      if (!res.ok || !json.success) {
        setMessage(json.error ?? '创建补学草稿失败');
        return;
      }
      setSuggestions((current) =>
        current.map((item) =>
          item.id === suggestion.id
            ? { ...item, status: 'accepted', created_task_id: json.data?.taskId ?? null }
            : item,
        ),
      );
      setMessage('已创建补学草稿，尚未发布。');
    } catch {
      setMessage('网络异常，请重试。');
    }
  }

  const classSummary = summaries.find((item) => item.scope === 'class');
  const learnerSummaries = summaries.filter((item) => item.scope === 'learner');
  return (
    <Card className="rounded-lg">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">AI 教学简报</CardTitle>
          <CardDescription>仅解读当前学习统计；补学任务须由老师确认后创建。</CardDescription>
        </div>
        <Button size="sm" onClick={generate} disabled={generating}>
          {generating ? '生成中…' : '生成简报'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {message && <p className="text-muted-foreground">{message}</p>}
        {loading ? (
          <p className="text-muted-foreground">加载中…</p>
        ) : classSummary ? (
          <Brief content={classSummary.content} />
        ) : (
          <p className="text-muted-foreground">尚未生成 AI 简报。</p>
        )}
        {learnerSummaries.length > 0 && (
          <div className="space-y-2 border-t pt-4">
            <p className="font-medium">需要关注的学员</p>
            {learnerSummaries.map((item) => (
              <Brief key={item.id} content={item.content} compact />
            ))}
          </div>
        )}
        {suggestions.length > 0 && (
          <div className="space-y-3 border-t pt-4">
            <p className="font-medium">补学建议</p>
            {suggestions.map((suggestion) => (
              <div key={suggestion.id} className="rounded-md border p-3">
                <p>{suggestion.reason}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  涉及 {suggestion.learner_ids.length} 名学员
                  {suggestion.scene_ids.length ? ` · ${suggestion.scene_ids.length} 个章节` : ''}
                </p>
                {suggestion.status === 'pending' ? (
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="outline"
                    onClick={() => accept(suggestion)}
                  >
                    确认创建补学草稿
                  </Button>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    已创建草稿{suggestion.created_task_id ? `：${suggestion.created_task_id}` : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Brief({ content, compact = false }: { content: Summary['content']; compact?: boolean }) {
  return (
    <div className={compact ? 'rounded-md bg-muted/40 p-3' : 'space-y-2'}>
      {content.headline && <p className="font-medium">{content.headline}</p>}
      {content.summary && <p className="text-muted-foreground">{content.summary}</p>}
      {content.strengths?.length ? <p>亮点：{content.strengths.join('；')}</p> : null}
      {content.attention?.length ? <p>关注：{content.attention.join('；')}</p> : null}
    </div>
  );
}
