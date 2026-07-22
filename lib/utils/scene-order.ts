/**
 * scene-order.ts
 *
 * Safe scene ordering utility.
 *
 * Historical courses have unreliable `order` fields:
 *   - Sometimes `order` is missing/non-unique (legacy data)
 *   - Sometimes `order` exists but contradicts the real display sequence
 *     (server-side IndexedDB stores an order field that doesn't match
 *     the actual page order the admin authored)
 *
 * Blindly sorting by `order` can scramble the actual page order
 * (e.g. page 3 becomes page 1, page 7 becomes page 2).
 *
 * **Decision: we never sort by `order` for display purposes.** The raw
 * array order from server / IndexedDB is the source of truth for the
 * display sequence. Any sort-by-order is only allowed in code paths that
 * explicitly manage their own data (e.g. PBL generation, scene creation).
 *
 * This module now only provides diagnostics so the existing call sites
 * can stay the same shape and still log whether order is trustworthy.
 */

/** Diagnostic info describing the order field state of a scene array. */
export interface OrderDiagnostic {
  /** Total scene count. */
  totalScenes: number;
  /** Per-scene orders (parallel to rawScenes). */
  orders: Array<number | null | undefined>;
  /** true iff every scene has a valid, finite order value. */
  allHaveValidOrder: boolean;
  /** true iff all valid orders are unique. */
  hasUniqueOrders: boolean;
  /** true iff every scene has valid, unique orders AND those orders
   *  match the raw array index (i.e. order is sequential starting from 0/1). */
  orderMatchesArrayIndex: boolean;
}

/** Inspect the order field of a scene array without changing it. */
export function inspectOrderField<T extends { order?: number | null }>(
  scenes: T[],
): OrderDiagnostic {
  const orders = scenes.map((s) => s.order);
  const allHaveValidOrder = orders.every(
    (o) => typeof o === 'number' && Number.isFinite(o),
  );
  const hasUniqueOrders = new Set(orders).size === scenes.length;
  const orderMatchesArrayIndex =
    allHaveValidOrder &&
    hasUniqueOrders &&
    orders.every((o, i) => o === i || o === i + 1);

  return {
    totalScenes: scenes.length,
    orders,
    allHaveValidOrder,
    hasUniqueOrders,
    orderMatchesArrayIndex,
  };
}

/**
 * Display-order source strategy.
 *
 * Used by loadStageData, importCourseFromCloud, page.tsx self-heal,
 * and the v14 recovery migration. **Never use `order` field for
 * ordering** — historical data has corrupted order values. `seq` is
 * the trusted insertion sequence, but if `seq` is missing or unreliable,
 * we fall back to creation/updated timestamps + id as a tiebreaker.
 *
 * When migrating from v13, prioritize `seq` only if every record has a
 * valid numeric `seq`. Otherwise fall back to timestamp recovery.
 */
export type DisplayOrderSource = 'seq' | 'createdAt' | 'updatedAt' | 'id';

/**
 * Stable comparator for scene records. Prefers the most-authoritative
 * timestamp available, breaking ties with secondary timestamps and id.
 *
 * Legacy `order` is **explicitly not** consulted here. It has been
 * demonstrated to be untrustworthy across both client (IndexedDB) and
 * server (cloud JSONB) sources.
 */
function sceneRecordComparator<
  T extends {
    seq?: number | null;
    createdAt?: number;
    updatedAt?: number;
    id?: string;
  },
>(a: T, b: T): number {
  // Tier 1: seq (when both numeric and finite)
  const aSeq = typeof a.seq === 'number' && Number.isFinite(a.seq) ? a.seq : null;
  const bSeq = typeof b.seq === 'number' && Number.isFinite(b.seq) ? b.seq : null;
  if (aSeq !== null && bSeq !== null) {
    if (aSeq !== bSeq) return aSeq - bSeq;
  } else if (aSeq !== null) {
    return -1;
  } else if (bSeq !== null) {
    return 1;
  }

  // Tier 2: createdAt (closer to real generation order than updatedAt)
  const aCreated = typeof a.createdAt === 'number' ? a.createdAt : Number.MAX_SAFE_INTEGER;
  const bCreated = typeof b.createdAt === 'number' ? b.createdAt : Number.MAX_SAFE_INTEGER;
  if (aCreated !== bCreated) return aCreated - bCreated;

  // Tier 3: updatedAt
  const aUpdated = typeof a.updatedAt === 'number' ? a.updatedAt : Number.MAX_SAFE_INTEGER;
  const bUpdated = typeof b.updatedAt === 'number' ? b.updatedAt : Number.MAX_SAFE_INTEGER;
  if (aUpdated !== bUpdated) return aUpdated - bUpdated;

  // Tier 4: id (deterministic final tiebreaker)
  return String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

/**
 * Return scenes in display order, dedup by id, and normalize seq/order
 * to match the array position.
 *
 * This is the single source of truth for "what order should scenes be
 * shown in". It replaces every previous ad-hoc ordering attempt.
 *
 * Key invariants:
 *   1. Output is **deduplicated by id** — duplicate-id scenes are dropped
 *      (with a warning log emitted). This kills the "duplicate page"
 *      symptom regardless of how the dup got in.
 *   2. Output's seq[i] === i and order[i] === i after normalization.
 *      Callers can persist directly with no further bookkeeping.
 *   3. The sort key NEVER consults `order` field. It uses seq (if
 *      trustworthy) → createdAt → updatedAt → id.
 *
 * @param logWarning optional callback for diagnostics (duplicate titles etc.)
 */
export interface OrderSceneRecordsOptions {
  /**
   * Sort priority:
   *   - 'auto'      : seq (if all valid+unique) -> createdAt -> updatedAt -> id
   *   - 'createdAt' : force createdAt -> updatedAt -> id, ignore seq entirely
   */
  prefer?: 'auto' | 'createdAt';
  /** When true, the function will also sort by 'order' if it's trustworthy.
   *  Default false (order is untrustworthy in historical data). */
  trustOrder?: boolean;
}

export function orderSceneRecordsForDisplay<
  T extends {
    id: string;
    seq?: number | null;
    order?: number | null;
    createdAt?: number;
    updatedAt?: number;
    title?: string;
  },
>(scenes: T[], options: OrderSceneRecordsOptions = {}): {
  ordered: T[];
  source: DisplayOrderSource;
  duplicateIdsRemoved: string[];
} {
  if (scenes.length === 0) {
    return { ordered: [], source: 'seq', duplicateIdsRemoved: [] };
  }

  // Source determination depends on options.prefer:
  //   - 'createdAt' : force ignore seq, recover from timestamps
  //   - 'auto' (default) : trust seq only if all valid+unique
  const prefer = options.prefer ?? 'auto';
  let source: DisplayOrderSource;

  if (prefer === 'createdAt') {
    if (scenes.every((s) => typeof s.createdAt === 'number')) {
      source = 'createdAt';
    } else if (scenes.every((s) => typeof s.updatedAt === 'number')) {
      source = 'updatedAt';
    } else {
      source = 'id';
    }
  } else {
    // auto mode
    const allHaveValidSeq = scenes.every(
      (s) => typeof s.seq === 'number' && Number.isFinite(s.seq),
    );
    const uniqueSeqs = new Set(scenes.map((s) => s.seq as number)).size;
    if (allHaveValidSeq && uniqueSeqs === scenes.length) {
      source = 'seq';
    } else if (scenes.every((s) => typeof s.createdAt === 'number')) {
      source = 'createdAt';
    } else if (scenes.every((s) => typeof s.updatedAt === 'number')) {
      source = 'updatedAt';
    } else {
      source = 'id';
    }
  }

  // When prefer='createdAt', build a strict comparator that ignores seq entirely.
  const strictCreatedAtComparator = (a: T, b: T): number => {
    const aCreated = typeof a.createdAt === 'number' ? a.createdAt : Number.MAX_SAFE_INTEGER;
    const bCreated = typeof b.createdAt === 'number' ? b.createdAt : Number.MAX_SAFE_INTEGER;
    if (aCreated !== bCreated) return aCreated - bCreated;

    const aUpdated = typeof a.updatedAt === 'number' ? a.updatedAt : Number.MAX_SAFE_INTEGER;
    const bUpdated = typeof b.updatedAt === 'number' ? b.updatedAt : Number.MAX_SAFE_INTEGER;
    if (aUpdated !== bUpdated) return aUpdated - bUpdated;

    return String(a.id).localeCompare(String(b.id));
  };

  // Dedup by id (keep the first occurrence after sort, so duplicates
  // dropped are the later-sorted ones — usually the corrupted ones).
  const sorted =
    prefer === 'createdAt'
      ? [...scenes].sort(strictCreatedAtComparator)
      : [...scenes].sort(sceneRecordComparator);
  const seenIds = new Set<string>();
  const ordered: T[] = [];
  const duplicateIdsRemoved: string[] = [];
  for (const s of sorted) {
    if (seenIds.has(s.id)) {
      duplicateIdsRemoved.push(s.id);
      continue;
    }
    seenIds.add(s.id);
    ordered.push(s);
  }

  // Normalize seq and order to match the new array position.
  for (let i = 0; i < ordered.length; i++) {
    ordered[i] = { ...ordered[i]!, seq: i, order: i } as T;
  }

  return { ordered, source, duplicateIdsRemoved };
}
