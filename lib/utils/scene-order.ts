/**
 * scene-order.ts
 *
 * Safe scene ordering utility.
 *
 * Historical courses may have incomplete / non-unique / missing `order` values
 * that don't match the real display sequence. Blindly sorting by `order` can
 * scramble the actual page order (e.g. page 3 becomes page 1).
 *
 * This function only applies order-sort when ALL scenes have valid, finite,
 * **unique** order values — proving the field is trustworthy. Otherwise it
 * returns the original array unchanged, preserving the real display order.
 */

export interface Orderable {
  order?: number | null;
}

/**
 * Return scenes in display order.
 *
 * - If every scene has a valid, finite, **unique** `order` → sort by order.
 * - Otherwise → return the input array as-is (original array order is truth).
 *
 * This is intentionally conservative: it's better to show pages in the
 * order they arrived from the server / IndexedDB than to guess based on
 * a possibly-stale `order` field.
 */
export function getDisplayOrderedScenes<T extends Orderable>(scenes: T[]): T[] {
  if (scenes.length <= 1) return scenes;

  const orders = scenes.map((s) => s.order);
  const allHaveValidOrder = orders.every(
    (o) => typeof o === 'number' && Number.isFinite(o),
  );
  const hasUniqueOrders = new Set(orders).size === scenes.length;

  if (allHaveValidOrder && hasUniqueOrders) {
    return [...scenes].sort((a, b) => (a.order as number) - (b.order as number));
  }

  // Preserve original array order — this is the real display sequence.
  return scenes;
}

/** Diagnostic info for logging why order-sort was or wasn't applied. */
export function getOrderSortDiagnostic<T extends Orderable>(
  scenes: T[],
  displayScenes: T[],
): {
  orderSortApplied: boolean;
  orderSortSkippedReason:
    | 'order_sort_applied'
    | 'missing_or_invalid_order'
    | 'duplicate_order'
    | 'using_raw_array_order';
} {
  if (scenes.length <= 1) {
    return { orderSortApplied: false, orderSortSkippedReason: 'using_raw_array_order' };
  }

  const orders = scenes.map((s) => s.order);
  const allHaveValidOrder = orders.every(
    (o) => typeof o === 'number' && Number.isFinite(o),
  );
  const hasUniqueOrders = new Set(orders).size === scenes.length;

  if (allHaveValidOrder && hasUniqueOrders) {
    return { orderSortApplied: true, orderSortSkippedReason: 'order_sort_applied' };
  }
  if (!allHaveValidOrder) {
    return { orderSortApplied: false, orderSortSkippedReason: 'missing_or_invalid_order' };
  }
  return { orderSortApplied: false, orderSortSkippedReason: 'duplicate_order' };
}
