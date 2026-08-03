/**
 * R3.1 playback outbox 门禁测试
 *
 * 验证 playback shadow → outbox 切换、迁移、幂等、无丢失无双发。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  shadowPlaybackProgressViaOutbox, migrateShadowPendingToOutbox, drainPlaybackOutbox,
} from '@/lib/runtime/playback-outbox';
import { cleanupExpiredLeases } from '@/lib/runtime/outbox';
import { db } from '@/lib/utils/database';

function daysAgo(d: number) { return new Date(Date.now() - d * 86400000).toISOString(); }

afterEach(async () => {
  vi.restoreAllMocks();
  await db.runtimeOutbox.clear();
  await db.succeededEntries.clear();
  await db.playbackState.clear();
});

function makePlaybackRow(stageId: string, overrides: Record<string, unknown> = {}) {
  return {
    stageId,
    sceneIndex: 0, actionIndex: 5, consumedDiscussions: [],
    updatedAt: Date.now(), capturedAt: new Date().toISOString(),
    sceneId: 'scene-1', completed: false,
    runtimeShadowEventId: `evt-${stageId}`,
    shadowPending: { eventId: `evt-${stageId}`, capturedAt: new Date().toISOString() },
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════

describe('R3.1 basic enqueue', () => {
  it('shadowPending → outbox entries created, shadowPending cleared', async () => {
    await db.playbackState.put(makePlaybackRow('s1'));
    const result = await shadowPlaybackProgressViaOutbox('s1');
    expect(result).toBe('enqueued');
    // shadowPending cleared
    const row = await db.playbackState.get('s1');
    expect(row!.shadowPending).toBeUndefined();
    // outbox has create + append (no completed)
    const entries = await db.runtimeOutbox.toArray();
    const ops = entries.map((e) => e.op).sort();
    expect(ops).toContain('create_session');
    expect(ops).toContain('append_record');
    expect(ops).not.toContain('set_status');
  });

  it('completed → create + append + set_status enqueued', async () => {
    await db.playbackState.put(makePlaybackRow('s2', { completed: true }));
    await shadowPlaybackProgressViaOutbox('s2');
    const ops = (await db.runtimeOutbox.toArray()).map((e) => e.op).sort();
    expect(ops).toContain('create_session');
    expect(ops).toContain('append_record');
    expect(ops).toContain('set_status');
  });

  it('no shadowPending → skipped (idempotent)', async () => {
    await db.playbackState.put(makePlaybackRow('s3', { shadowPending: undefined }));
    expect(await shadowPlaybackProgressViaOutbox('s3')).toBe('skipped');
    expect(await db.runtimeOutbox.count()).toBe(0);
  });

  it('double call → second call skipped', async () => {
    await db.playbackState.put(makePlaybackRow('s4'));
    expect(await shadowPlaybackProgressViaOutbox('s4')).toBe('enqueued');
    expect(await shadowPlaybackProgressViaOutbox('s4')).toBe('skipped');
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('R3.1 migration', () => {
  it('migrate all rows with shadowPending', async () => {
    await db.playbackState.bulkPut([
      makePlaybackRow('m1'),
      makePlaybackRow('m2', { completed: true }),
      makePlaybackRow('m3', { shadowPending: undefined }), // no pending → skipped
    ]);
    const result = await migrateShadowPendingToOutbox();
    expect(result.migrated).toBe(2);
    expect(result.skipped).toBe(1);
    // all shadowPending cleared
    for (const id of ['m1', 'm2', 'm3']) {
      const r = await db.playbackState.get(id);
      expect(r!.shadowPending).toBeUndefined();
    }
    // outbox has entries for m1 + m2
    const entries = await db.runtimeOutbox.toArray();
    const sessions = new Set(entries.map((e) => e.sessionId));
    expect(sessions.has('pb:m1')).toBe(true);
    expect(sessions.has('pb:m2')).toBe(true);
    expect(sessions.has('pb:m3')).toBe(false);
  });

  it('migration is idempotent', async () => {
    await db.playbackState.put(makePlaybackRow('m4'));
    await migrateShadowPendingToOutbox();
    const count1 = await db.runtimeOutbox.count();
    await migrateShadowPendingToOutbox();
    expect(await db.runtimeOutbox.count()).toBe(count1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('R3.1 dependency chain', () => {
  it('outbox entries form correct dependency chain', async () => {
    await db.playbackState.put(makePlaybackRow('dep1', { completed: true }));
    await shadowPlaybackProgressViaOutbox('dep1');
    const entries = await db.runtimeOutbox.orderBy('sequence').toArray();
    // create (seq=1) → append (seq=2, dependsOn create) → status (seq=3, dependsOn append)
    expect(entries.length).toBe(3);
    expect(entries[0].op).toBe('create_session');
    expect(entries[1].op).toBe('append_record');
    expect(entries[1].dependsOnEntryId).toBe(entries[0].id);
    expect(entries[2].op).toBe('set_status');
    expect(entries[2].dependsOnEntryId).toBe(entries[1].id);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('R3.1 drain + cross-tab safety', () => {
  it('drain sends outbox entries', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await db.playbackState.put(makePlaybackRow('drain1'));
    await shadowPlaybackProgressViaOutbox('drain1');
    await drainPlaybackOutbox('tab-test');
    expect(await db.runtimeOutbox.where('status').equals('pending').count()).toBe(0);
    expect(await db.succeededEntries.count()).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('R3.1 compaction', () => {
  it('multiple enqueue calls → old superseded', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await db.playbackState.put(makePlaybackRow('comp1'));
    // First enqueue creates entries, clears shadowPending
    await shadowPlaybackProgressViaOutbox('comp1');
    // Simulate new snapshot (set shadowPending again)
    await db.playbackState.update('comp1', {
      shadowPending: { eventId: 'evt-comp1-v2', capturedAt: new Date().toISOString() },
      actionIndex: 10,
    });
    await shadowPlaybackProgressViaOutbox('comp1');
    // Old append should be superseded
    const entries = await db.runtimeOutbox.where('semanticKey').equals('playback:comp1:latest-progress').toArray();
    expect(entries.length).toBe(2);
    const statuses = entries.map((e) => e.status).sort();
    expect(statuses).toContain('superseded');
    expect(statuses).toContain('pending');
  });
});
