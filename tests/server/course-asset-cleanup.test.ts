import { describe, expect, it, vi } from 'vitest';
import { cleanupStaleCourseAssets } from '@/lib/server/course-asset-cleanup';

const asset = (id: string, objectKey: string) => ({
  id,
  courseId: null,
  ownerUserId: 'teacher-1',
  kind: 'material' as const,
  objectKey,
  contentType: 'application/octet-stream',
  sizeBytes: 12,
  state: 'deleting' as const,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  boundAt: null,
});

describe('course asset cleanup', () => {
  it('deletes only assets atomically claimed by the repository', async () => {
    const claimed = [asset('asset-1', 'pending/teacher-1/one.pptx')];
    const repository = {
      claimStaleUnboundPendingAssets: vi.fn().mockResolvedValue(claimed),
      completeAssetDeletion: vi.fn().mockResolvedValue(true),
      failAssetDeletion: vi.fn(),
    };
    const storage = { deleteObject: vi.fn().mockResolvedValue(undefined) };

    await expect(cleanupStaleCourseAssets({
      repository,
      storage,
      olderThan: new Date('2026-09-10T00:00:00.000Z'),
      limit: 100,
    })).resolves.toEqual({ claimed: 1, deleted: 1, failed: 0, failedAssetIds: [] });

    expect(repository.claimStaleUnboundPendingAssets).toHaveBeenCalledWith(
      new Date('2026-09-10T00:00:00.000Z'),
      100,
    );
    expect(storage.deleteObject).toHaveBeenCalledWith('pending/teacher-1/one.pptx');
    expect(repository.completeAssetDeletion).toHaveBeenCalledWith('asset-1');
    expect(repository.failAssetDeletion).not.toHaveBeenCalled();
  });

  it('keeps an auditable failed state when COS deletion fails', async () => {
    const repository = {
      claimStaleUnboundPendingAssets: vi.fn().mockResolvedValue([asset('asset-2', 'pending/teacher-1/two.pptx')]),
      completeAssetDeletion: vi.fn(),
      failAssetDeletion: vi.fn().mockResolvedValue(true),
    };
    const storage = { deleteObject: vi.fn().mockRejectedValue(new Error('COS unavailable')) };

    await expect(cleanupStaleCourseAssets({
      repository,
      storage,
      olderThan: new Date(),
      limit: 1,
    })).resolves.toEqual({ claimed: 1, deleted: 0, failed: 1, failedAssetIds: ['asset-2'] });

    expect(repository.completeAssetDeletion).not.toHaveBeenCalled();
    expect(repository.failAssetDeletion).toHaveBeenCalledWith('asset-2');
  });
});
