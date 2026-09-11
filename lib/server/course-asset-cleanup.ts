import { CosStorage } from '@/lib/server/cos-storage';
import {
  CourseRepository,
  type CourseAssetRecord,
} from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export interface CourseAssetCleanupRepository {
  claimStaleUnboundPendingAssets(cutoff: Date, limit: number): Promise<CourseAssetRecord[]>;
  completeAssetDeletion(assetId: string): Promise<boolean>;
  failAssetDeletion(assetId: string): Promise<boolean>;
}

export interface CourseAssetObjectStorage {
  deleteObject(objectKey: string): Promise<void>;
}

export interface CourseAssetCleanupResult {
  claimed: number;
  deleted: number;
  failed: number;
  failedAssetIds: string[];
}

/**
 * Removes only abandoned, unbound uploads. Claiming happens in PostgreSQL
 * before COS deletion, so concurrent cleanup runners cannot delete the same
 * source and a late upload confirmation will no longer mark it ready.
 */
export async function cleanupStaleCourseAssets(input: {
  repository: CourseAssetCleanupRepository;
  storage: CourseAssetObjectStorage;
  olderThan: Date;
  limit: number;
}): Promise<CourseAssetCleanupResult> {
  const assets = await input.repository.claimStaleUnboundPendingAssets(input.olderThan, input.limit);
  const result: CourseAssetCleanupResult = {
    claimed: assets.length,
    deleted: 0,
    failed: 0,
    failedAssetIds: [],
  };

  for (const asset of assets) {
    try {
      await input.storage.deleteObject(asset.objectKey);
      if (await input.repository.completeAssetDeletion(asset.id)) result.deleted += 1;
    } catch (error) {
      console.error('[course-asset-cleanup] asset deletion failed', {
        assetId: asset.id,
        objectKey: asset.objectKey,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      await input.repository.failAssetDeletion(asset.id).catch(() => undefined);
      result.failed += 1;
      result.failedAssetIds.push(asset.id);
    }
  }

  return result;
}

export async function runCourseAssetCleanup(input: {
  maxAgeMs: number;
  limit: number;
  now?: Date;
}): Promise<CourseAssetCleanupResult> {
  const now = input.now ?? new Date();
  return cleanupStaleCourseAssets({
    repository: new CourseRepository(getDatabasePool()),
    storage: new CosStorage(),
    olderThan: new Date(now.getTime() - input.maxAgeMs),
    limit: input.limit,
  });
}
