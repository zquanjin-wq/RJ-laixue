'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';

export type LearnerOption = {
  id: string;
  name: string;
  email: string | null;
  disabled_at?: string | null;
};

type LearnerPickerProps = {
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  initialLearners?: LearnerOption[];
  lockedIds?: string[];
  disabled?: boolean;
};

const PAGE_SIZE = 20;

export function LearnerPicker({
  selectedIds,
  onSelectedIdsChange,
  initialLearners = [],
  lockedIds = [],
  disabled = false,
}: LearnerPickerProps) {
  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [learners, setLearners] = useState<LearnerOption[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [knownLearners, setKnownLearners] = useState<Record<string, LearnerOption>>(() =>
    Object.fromEntries(initialLearners.map((learner) => [learner.id, learner])),
  );

  useEffect(() => {
    setKnownLearners((current) => ({
      ...current,
      ...Object.fromEntries(initialLearners.map((learner) => [learner.id, learner])),
    }));
  }, [initialLearners]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (query) params.set('q', query);
    fetch(`/api/admin/students?${params.toString()}`)
      .then((response) => response.json())
      .then((payload: { success?: boolean; data?: LearnerOption[]; total?: number }) => {
        if (!payload.success) return;
        const nextLearners = payload.data ?? [];
        setLearners(nextLearners);
        setTotal(payload.total ?? 0);
        setKnownLearners((current) => ({
          ...current,
          ...Object.fromEntries(nextLearners.map((learner) => [learner.id, learner])),
        }));
      })
      .finally(() => setLoading(false));
  }, [page, query]);

  const selectedLearners = useMemo(
    () => selectedIds.map((id) => knownLearners[id]).filter(Boolean),
    [knownLearners, selectedIds],
  );
  const lockedSet = useMemo(() => new Set(lockedIds), [lockedIds]);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function toggle(id: string) {
    if (disabled || lockedSet.has(id)) return;
    onSelectedIdsChange(
      selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id],
    );
  }

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(keyword.trim());
  }

  return (
    <div className="space-y-3">
      <form onSubmit={submitSearch} className="flex gap-2">
        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="按姓名或邮箱搜索人员"
          disabled={disabled}
        />
        <Button type="submit" variant="outline" disabled={disabled}>
          搜索
        </Button>
      </form>

      <div className="rounded-md border">
        <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
          <span>
            {query ? `“${query}” 的搜索结果` : '全部人员'} · 共 {total} 人
          </span>
          <span>每页 {PAGE_SIZE} 人</span>
        </div>
        <div className="min-h-40 space-y-1 p-2">
          {learners.map((learner) => (
            <label
              key={learner.id}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted/50"
            >
              <Checkbox
                checked={selectedIds.includes(learner.id)}
                onCheckedChange={() => toggle(learner.id)}
                disabled={disabled || lockedSet.has(learner.id)}
              />
              <span>{learner.name}</span>
              {learner.email && (
                <span className="text-xs text-muted-foreground">{learner.email}</span>
              )}
              {lockedSet.has(learner.id) && (
                <span className="ml-auto text-xs text-muted-foreground">已分配</span>
              )}
            </label>
          ))}
          {!loading && learners.length === 0 && (
            <p className="p-2 text-sm text-muted-foreground">没有匹配的人员。</p>
          )}
          {loading && <p className="p-2 text-sm text-muted-foreground">正在加载人员…</p>}
        </div>
        <div className="flex items-center justify-between border-t px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPage((value) => value - 1)}
            disabled={disabled || page <= 1}
          >
            上一页
          </Button>
          <span className="text-xs text-muted-foreground">
            第 {page} / {pageCount} 页
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPage((value) => value + 1)}
            disabled={disabled || page >= pageCount}
          >
            下一页
          </Button>
        </div>
      </div>

      <div className="rounded-md bg-muted/40 p-3">
        <div className="mb-2 flex items-center gap-2 text-sm">
          已选人员 <Badge variant="secondary">{selectedIds.length}</Badge>
        </div>
        {selectedLearners.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {selectedLearners.map((learner) => (
              <Badge key={learner.id} variant="outline" className="gap-1 py-1">
                {learner.name}
                {!lockedSet.has(learner.id) && !disabled && (
                  <button
                    type="button"
                    onClick={() => toggle(learner.id)}
                    aria-label={`移除 ${learner.name}`}
                  >
                    ×
                  </button>
                )}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">搜索并勾选需要参与本任务的人员。</p>
        )}
      </div>
    </div>
  );
}
