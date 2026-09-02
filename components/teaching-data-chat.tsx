'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { getCurrentModelConfig } from '@/lib/utils/model-config';

const prompts = [
  '哪些任务尚未开始的人最多？',
  '请概括当前任务完成情况。',
  '我下一步应重点跟进什么？',
];

export function TeachingDataChat() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);

  async function ask(nextQuestion = question) {
    const text = nextQuestion.trim();
    if (!text) return;
    setQuestion(text);
    setLoading(true);
    setAnswer('');
    try {
      const response = await fetch('/api/admin/teaching-data-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: text, ...getCurrentModelConfig() }),
      });
      const body = (await response.json()) as {
        success?: boolean;
        data?: { answer?: string };
        error?: string;
      };
      setAnswer(
        response.ok && body.success
          ? body.data?.answer || '暂无可用回答。'
          : body.error || '暂时无法回答，请稍后重试。',
      );
    } catch {
      setAnswer('网络异常，请稍后重试。');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {prompts.map((prompt) => (
          <Button
            key={prompt}
            variant="outline"
            size="sm"
            onClick={() => void ask(prompt)}
            disabled={loading}
          >
            {prompt}
          </Button>
        ))}
      </div>
      <Textarea
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        placeholder="例如：哪些任务需要我本周重点跟进？"
        rows={3}
      />
      <Button className="w-full" onClick={() => void ask()} disabled={loading || !question.trim()}>
        {loading ? '正在分析…' : '问 AI'}
      </Button>
      {answer && (
        <div className="rounded-lg bg-muted/60 p-3 text-sm leading-6 whitespace-pre-wrap">
          {answer}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        AI 仅解释你权限范围内的任务聚合数据，不会修改任务或课程。
      </p>
    </div>
  );
}
