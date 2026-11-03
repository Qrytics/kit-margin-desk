import { MICRO } from "../lib/units";

/**
 * Pure planning for order/refund/cancel sync. No I/O.
 *
 * The invariant: for every order line, netApplied (kit units currently decremented from components)
 * converges on  target = max(0, ordered - restockedRefunds - cancelledUnfulfilled).
 * Because the plan is "target minus netApplied", duplicate deliveries, out-of-order delivery,
 * order edits and partial refunds/cancels all resolve to the same stock as a from-scratch recompute.
 */
export interface LineState {
  /** null until the order itself was seen (a refund may arrive first). */
  orderedQty: number | null;
  /** refundLineItemId -> restocked kit units */
  refunds: Record<string, number>;
  cancelledQty: number;
  netApplied: number;
  /** leaf variant -> micro-units per kit, frozen at first application so restores mirror decrements. */
  bomSnapshot: Record<string, number>;
  frozen: boolean;
}

export const emptyLine = (): LineState => ({
  orderedQty: null,
  refunds: {},
  cancelledQty: 0,
  netApplied: 0,
  bomSnapshot: {},
  frozen: false,
});

export const restockedTotal = (s: LineState): number => Object.values(s.refunds).reduce((a, b) => a + b, 0);

export function targetNet(s: LineState): number {
  if (s.orderedQty === null) return 0;
  return Math.max(0, s.orderedQty - restockedTotal(s) - s.cancelledQty);
}

export type LineEvent =
  | { type: "order"; orderedQty: number }
  | { type: "refund"; refundLineId: string; qty: number; restockType: string }
  | { type: "cancel"; unfulfilledQty: number };

/** Only these restock types put components back on the shelf (spec 4.2). */
export const RESTOCKING_TYPES = new Set(["restock", "return", "RESTOCK", "RETURN", "cancel", "CANCEL"]);

export function applyEvent(s: LineState, e: LineEvent): LineState {
  const next: LineState = { ...s, refunds: { ...s.refunds } };
  if (e.type === "order") {
    next.orderedQty = e.orderedQty;
  } else if (e.type === "refund") {
    // NO_RESTOCK refunds are recorded as 0 restocked units: no phantom components.
    next.refunds[e.refundLineId] = RESTOCKING_TYPES.has(e.restockType) ? e.qty : 0;
  } else if (e.type === "cancel") {
    next.cancelledQty = Math.max(next.cancelledQty, e.unfulfilledQty);
  }
  return next;
}

export interface ComponentDelta {
  variantId: string;
  /** whole units; negative = consume */
  delta: number;
}

/**
 * Convert a kit-unit change into whole-unit component deltas.
 * Fractions: total micro-qty is rounded once per (component, line) so 0.35 x 3 kits = 1.05 -> 1.
 * To avoid cumulative drift, rounding is applied to the cumulative total (see cumulativeComponentUnits)
 * and the delta is the difference between cumulative targets.
 */
export const cumulativeComponentUnits = (microPerKit: number, kitUnits: number): number =>
  Math.round((microPerKit * kitUnits) / MICRO);

export interface LinePlan {
  nextState: LineState;
  /** kit units delta (negative = restore components) for display */
  kitDelta: number;
  deltas: ComponentDelta[];
}

export function planLine(prev: LineState, e: LineEvent, bomMicroPerKit: Record<string, number>): LinePlan {
  const merged = applyEvent(prev, e);
  if (prev.frozen) return { nextState: merged, kitDelta: 0, deltas: [] };
  const snapshot = Object.keys(prev.bomSnapshot).length ? prev.bomSnapshot : bomMicroPerKit;
  const target = targetNet(merged);
  const kitDelta = target - prev.netApplied;
  const deltas: ComponentDelta[] = [];
  if (kitDelta !== 0) {
    for (const [variantId, micro] of Object.entries(snapshot)) {
      const was = cumulativeComponentUnits(micro, prev.netApplied);
      const will = cumulativeComponentUnits(micro, target);
      if (will !== was) deltas.push({ variantId, delta: was - will });
    }
  }
  return {
    nextState: { ...merged, netApplied: target, bomSnapshot: snapshot },
    kitDelta,
    deltas,
  };
}

/** Merge deltas of several lines (same component) into one per variant. */
export function mergeDeltas(all: ComponentDelta[]): ComponentDelta[] {
  const m = new Map<string, number>();
  for (const d of all) m.set(d.variantId, (m.get(d.variantId) ?? 0) + d.delta);
  return [...m].filter(([, v]) => v !== 0).map(([variantId, delta]) => ({ variantId, delta }));
}

/** Idempotency key for a webhook-driven event. */
export const eventKey = (parts: Array<string | number>): string => parts.join(":");

/**
 * Location resolution (spec 4.4): fulfillment-order location, else fulfilling location,
 * else shop primary. Returns the id and whether it was assumed.
 */
export function resolveLocation(args: {
  assignedLocationId?: string | null;
  fulfilledLocationId?: string | null;
  defaultLocationId?: string | null;
  primaryLocationId: string;
}): { locationId: string; assumed: boolean } {
  if (args.assignedLocationId) return { locationId: args.assignedLocationId, assumed: false };
  if (args.fulfilledLocationId) return { locationId: args.fulfilledLocationId, assumed: false };
  return { locationId: args.defaultLocationId || args.primaryLocationId, assumed: true };
}
