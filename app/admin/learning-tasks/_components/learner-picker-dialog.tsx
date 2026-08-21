'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { LearnerPicker, type LearnerOption } from './learner-picker';

type LearnerPickerDialogProps = {
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  initialLearners?: LearnerOption[];
  lockedIds?: string[];
  disabled?: boolean;
  actionLabel?: string;
};

export function LearnerPickerDialog({
  selectedIds,
  onSelectedIdsChange,
  initialLearners,
  lockedIds,
  disabled = false,
  actionLabel = '添加学员',
}: LearnerPickerDialogProps) {
  const [open, setOpen] = useState(false);
  const [draftIds, setDraftIds] = useState<string[]>(selectedIds);

  function setDialogOpen(nextOpen: boolean) {
    if (nextOpen) setDraftIds(selectedIds);
    setOpen(nextOpen);
  }

  function confirmSelection() {
    onSelectedIdsChange(draftIds);
    setOpen(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="outline"
        onClick={() => setDialogOpen(true)}
        disabled={disabled}
      >
        {actionLabel}
      </Button>
      <span className="text-sm text-muted-foreground">
        已选人员 <Badge variant="secondary">{selectedIds.length}</Badge>
      </span>

      <Dialog open={open} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{actionLabel}</DialogTitle>
            <DialogDescription>按姓名或邮箱搜索，逐页勾选参与本任务的人员。</DialogDescription>
          </DialogHeader>
          <LearnerPicker
            selectedIds={draftIds}
            onSelectedIdsChange={setDraftIds}
            initialLearners={initialLearners}
            lockedIds={lockedIds}
            disabled={disabled}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={confirmSelection} disabled={disabled}>
              确认选择
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
