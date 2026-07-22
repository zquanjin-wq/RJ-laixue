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
