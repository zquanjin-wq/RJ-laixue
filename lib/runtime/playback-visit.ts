/**
 * lib/runtime/playback-visit.ts
 *
 * R3.1a: Playback visit-session lifecycle — "new session per completed playback cycle".
 *
 * visitId = generateHexId(16), sessionId = "pb:<stageId>:<visitId>"
 * Completed cycle → next play cycle gets new visit → new server session.
 * Eliminates the "append after completed → 409 INACTIVE_SESSION" main path.
 */

import { db } from '@/lib/utils/database';
import type { RuntimeOutboxEntry, PlaybackVisit, PlaybackVisitState } from '@/lib/utils/database';
import { generateHexId, claimTabOwnerId } from '@/lib/runtime/tab-owner';

// ─── Errors ────────────────────────────────────────────────────────────────────

export class SnapshotEventMismatchError extends Error {
  constructor(visitId: string, eventId: string) {
    super(`Snapshot event mismatch for visit ${visitId}: ${eventId}`);
    this.name = 'SnapshotEventMismatchError';
  }
}

export class VisitCycleCompletedError extends Error {
  constructor(visitId: string) {
    super(`Visit cycle already completed: ${visitId}`);
    this.name = 'VisitCycleCompletedError';
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const now = () => new Date().toISOString();

/** In-tx enqueue helper — no independent tx, no network. Must be called inside an existing rw transaction. */
async function _enqueueInTx(
  params: { sessionId: string; op: RuntimeOutboxEntry['op']; semanticKey: string; body: unknown },
  dependsOnEntryId?: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const nowStr = now();
  const existing = await db.runtimeOutbox
    .where('semanticKey').equals(params.semanticKey)
    .filter((e) => e.status === 'pending' && !e.leaseOwner && e.id !== id)
    .toArray();
  for (const e of existing) {
    await db.runtimeOutbox.update(e.id, { status: 'superseded' });
    await _supersedeDepsInTx(e.id);
  }
  const rows = await db.runtimeOutbox.where('sessionId').equals(params.sessionId).toArray();
  const lastSeq = rows.length > 0 ? Math.max(...rows.map((e) => e.sequence ?? 0)) : 0;
  const entry: RuntimeOutboxEntry = {
    id, kind: 'playback', op: params.op,
    sessionId: params.sessionId, semanticKey: params.semanticKey,
    body: params.body, createdAt: nowStr, attempts: 0, nextAttemptAt: nowStr,
    status: 'pending', sequence: lastSeq + 1, dependsOnEntryId,
  };
  await db.runtimeOutbox.put(entry);
  return id;
}

async function _supersedeDepsInTx(entryId: string): Promise<void> {
  const deps = await db.runtimeOutbox.where('dependsOnEntryId').equals(entryId)
    .filter((e) => e.status === 'pending' && !e.leaseOwner).toArray();
  for (const d of deps) {
    await db.runtimeOutbox.update(d.id, { status: 'superseded' });
    await _supersedeDepsInTx(d.id);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════

// ─── M4: claimOrReuseVisitInTx ─────────────────────────────────────────────────

async function claimOrReuseVisitInTx(
  stageId: string, tabOwnerId: string,
): Promise<PlaybackVisit> {
  // Step 0: legacy adoption (adopted visit has isLegacyAdopted=true, sessionId="pb:<stageId>")
  const legacy = await db.playbackVisits
    .where('[stageId+status]').equals([stageId, 'active'])
    .filter((v) => v.visitId === `legacy-${stageId}` && !!v.isLegacyAdopted)
    .first();
  if (legacy) {
    await db.playbackVisits.update(legacy.visitId, {
      tabOwnerId,
      isLegacyAdopted: undefined,
    });
    return (await db.playbackVisits.get(legacy.visitId))!;
  }

  // Step 1: check for existing active visit for this (stageId, tabOwnerId)
  const mine = await db.playbackVisits
    .where('[tabOwnerId+stageId]').equals([tabOwnerId, stageId])
    .filter((v) => v.status === 'active')
    .first();
  if (mine) return mine;

  // Step 2: create new visit
  const visitId = generateHexId(16);
  const sessionId = `pb:${stageId}:${visitId}`;
  const ts = now();
  const visit: PlaybackVisit = {
    visitId, stageId, tabOwnerId, sessionId,
    status: 'active', createdAt: ts,
  };
  await db.playbackVisits.add(visit);
  return visit;
}

// ─── M4: completePreflightInTx ─────────────────────────────────────────────────

async function completePreflightInTx(
  visit: PlaybackVisit,
  snapshot: { eventId: string; completed?: boolean },
): Promise<
  | { action: 'idempotent'; appendId: string; statusId: string }
  | { action: 'cycle_completed' }
  | { action: 'proceed' }
> {
  // Axiom: completed credential exists → must not append
  if (visit.completedStatusEntryId) {
    const cred = await db.succeededEntries.get(visit.completedStatusEntryId);
    if (cred) {
      // §1.9: checkVisitCompleted would have flipped visit.status by now
      // If not (race), force cycle switch
      return { action: 'cycle_completed' };
    }
  }

  // Snapshot not completed → normal enqueue
  if (!snapshot.completed || !visit.completedStatusEntryId) {
    return { action: 'proceed' };
  }

  // Status enqueued but not yet sent → compare eventId
  const statusEntry = await db.runtimeOutbox.get(visit.completedStatusEntryId);
  if (!statusEntry) {
    // Not in outbox, not in succeeded → re-enqueue
    return { action: 'proceed' };
  }

  const appendEntry = statusEntry.dependsOnEntryId
    ? await db.runtimeOutbox.get(statusEntry.dependsOnEntryId)
    : null;

  if (!appendEntry) {
    // Append already sent, status still in outbox → idempotent (don't create new append)
    return { action: 'idempotent', appendId: statusEntry.dependsOnEntryId!, statusId: visit.completedStatusEntryId };
  }

  const appendEventId = (appendEntry.body as any)?.id?.split(':').pop();
  if (appendEventId === snapshot.eventId) {
    return { action: 'idempotent', appendId: appendEntry.id, statusId: visit.completedStatusEntryId };
  }

  throw new SnapshotEventMismatchError(visit.visitId, snapshot.eventId);
}

// ─── M4: enqueueCompleteWithCASInTx ────────────────────────────────────────────

async function enqueueCompleteWithCASInTx(
  visit: PlaybackVisit, appendId: string,
): Promise<string> {
  if (visit.completedStatusEntryId) {
    // CAS: already has a completed entry — idempotent return
    return visit.completedStatusEntryId;
  }
  const statusId = await _enqueueInTx({
    sessionId: visit.sessionId, op: 'set_status',
    semanticKey: `pb:completed:${visit.visitId}`,
    body: { status: 'completed', updatedAt: now() },
  }, appendId);
  await db.playbackVisits.update(visit.visitId, { completedStatusEntryId: statusId });
  return statusId;
}

// ─── M4: checkVisitCompleted ───────────────────────────────────────────────────

export async function checkVisitCompleted(visitId: string): Promise<boolean> {
  return db.transaction('rw', db.playbackVisits, db.succeededEntries, async () => {
    const visit = await db.playbackVisits.get(visitId);
    if (!visit?.completedStatusEntryId) return false;
    const cred = await db.succeededEntries.get(visit.completedStatusEntryId);
    if (!cred) return false;
    // Flip visit.status and record credential time in same tx (§1.9 invariant)
    await db.playbackVisits.update(visitId, {
      status: 'completed',
      completedCredentialAt: cred.deletedAt,
    });
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════

// ─── M5: persistSnapshotWithComplete ───────────────────────────────────────────

export async function persistSnapshotWithComplete(
  stageId: string,
  snapshot: {
    eventId: string;
    capturedAt: string;
    sceneId?: string;
    sceneIndex: number;
    actionIndex: number;
    consumedDiscussions?: string[];
    completed?: boolean;
  },
): Promise<{ visitId: string; appendId: string; statusId?: string }> {
  const ownerId = await claimTabOwnerId(); // M3: async claim

  return db.transaction(
    'rw',
    [db.playbackVisits, db.playbackVisitStates, db.runtimeOutbox, db.runtimeChainHeads, db.succeededEntries],
    async () => {
      const visit = await claimOrReuseVisitInTx(stageId, ownerId);

      // ★ Preflight (M4 §1.8: unconditional when completedStatusEntryId exists)
      // Covers all three edge cases: credential exists, append-sent-status-pending, eventId match/mismatch
      if (visit.completedStatusEntryId) {
        const pre = await completePreflightInTx(visit, snapshot);
        if (pre.action === 'idempotent') {
          return { visitId: visit.visitId, appendId: pre.appendId, statusId: pre.statusId };
        }
        if (pre.action === 'cycle_completed') {
          throw new VisitCycleCompletedError(visit.visitId);
        }
        // pre.action === 'proceed'
      }

      // 1. Write visit-specific state
      await db.playbackVisitStates.put({
        visitId: visit.visitId,
        stageId,
        sceneIndex: snapshot.sceneIndex,
        actionIndex: snapshot.actionIndex,
        consumedDiscussions: snapshot.consumedDiscussions ?? [],
        sceneId: snapshot.sceneId,
        capturedAt: snapshot.capturedAt,
        updatedAt: Date.now(),
        completed: snapshot.completed,
        runtimeShadowEventId: snapshot.eventId,
        shadowPending: { eventId: snapshot.eventId, capturedAt: snapshot.capturedAt },
      } satisfies PlaybackVisitState);

      // 2. Ensure create entry (only if visit.createEntryId not already set)
      let prevId: string | undefined = visit.createEntryId;
      if (!prevId) {
        prevId = await _enqueueInTx({
          sessionId: visit.sessionId, op: 'create_session',
          semanticKey: `pb:create:${visit.sessionId}`,
          body: { id: visit.sessionId, kind: 'playback', stageId,
                  status: 'active', createdAt: snapshot.capturedAt,
                  updatedAt: snapshot.capturedAt },
        });
        await db.playbackVisits.update(visit.visitId, { createEntryId: prevId });
      }

      // 3. Append
      const appendId = await _enqueueInTx({
        sessionId: visit.sessionId, op: 'append_record',
        semanticKey: `pb:append:${visit.sessionId}:${snapshot.eventId}`,
        body: {
          id: `${visit.sessionId}:${snapshot.eventId}`,
          createdAt: snapshot.capturedAt,
          sceneId: snapshot.sceneId,
          payload: {
            v: 1,
            sceneIndex: snapshot.sceneIndex,
            actionIndex: snapshot.actionIndex,
            consumedDiscussions: snapshot.consumedDiscussions ?? [],
            capturedAt: snapshot.capturedAt,
          },
        },
      }, prevId);

      // 4. Completed set_status (CAS by enqueueCompleteWithCASInTx)
      let statusId: string | undefined;
      if (snapshot.completed) {
        statusId = await enqueueCompleteWithCASInTx(visit, appendId);
      }

      return { visitId: visit.visitId, appendId, statusId };
    },
  );
}
