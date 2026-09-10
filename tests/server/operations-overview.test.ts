import { describe, expect, it } from 'vitest';
import { readOperationsOverview } from '@/lib/server/operations-overview';

describe('operations overview', () => {
  it('keeps the three durable queues and stale leases independently visible', async () => {
    const responses = [
      [{ status: 'ready', count: 3 }],
      [{ status: 'running', count: 1 }, { status: 'queued', count: 2 }],
      [{ status: 'failed', count: 1 }],
      [{ status: 'succeeded', count: 4 }],
      [{ expiredGenerationLeases: 1, expiredVideoLeases: 2, expiredRevoiceLocks: 3 }],
    ];
    const pool = {
      query: async () => ({ rows: responses.shift() ?? [] }),
    };

    await expect(readOperationsOverview(pool as never)).resolves.toMatchObject({
      courses: { ready: 3 },
      queues: {
        classroomGeneration: { running: 1, queued: 2 },
        videoExport: { failed: 1 },
        revoice: { succeeded: 4 },
      },
      stale: { expiredGenerationLeases: 1, expiredVideoLeases: 2, expiredRevoiceLocks: 3 },
    });
  });
});
