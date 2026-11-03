export interface ComponentStock {
  variantId: string;
  onHand: number;
  incoming: number;
  /** units/day consumed (kit sales + direct sales), trailing window */
  burnPerDay: number;
  leadTimeDays: number | null;
  reorderPointOverride: number | null;
  packSize: number | null;
}

export const DEFAULT_COVER_DAYS = 30;

export const daysOfCover = (onHand: number, burnPerDay: number): number | null =>
  burnPerDay > 0 ? Math.max(0, onHand) / burnPerDay : null;

/** reorder point = merchant override, else burn x lead time x 1.5 (spec 7.1). */
export function reorderPoint(c: Pick<ComponentStock, "burnPerDay" | "leadTimeDays" | "reorderPointOverride">): number {
  if (c.reorderPointOverride != null) return c.reorderPointOverride;
  return Math.ceil(c.burnPerDay * (c.leadTimeDays ?? 7) * 1.5);
}

export function suggestQty(c: ComponentStock, coverDays = DEFAULT_COVER_DAYS): number {
  const raw = Math.ceil(c.burnPerDay * coverDays - Math.max(0, c.onHand) - c.incoming);
  if (raw <= 0) return 0;
  const pack = c.packSize && c.packSize > 1 ? c.packSize : 1;
  return Math.ceil(raw / pack) * pack;
}

export const needsReorder = (c: ComponentStock): boolean => c.onHand + c.incoming <= reorderPoint(c) && c.burnPerDay > 0;

export interface Burn { variantId: string; units: number }
/** Sum kit-driven component consumption and direct sales into units/day. */
export function burnRates(consumed: Burn[], windowDays = 30): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of consumed) m.set(c.variantId, (m.get(c.variantId) ?? 0) + c.units);
  for (const [k, v] of m) m.set(k, v / windowDays);
  return m;
}

export function groupBySupplier<T extends { supplierName: string | null }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) {
    const k = i.supplierName?.trim() || "Unassigned supplier";
    m.set(k, [...(m.get(k) ?? []), i]);
  }
  return m;
}

export type PoStatus = "draft" | "sent" | "partially_received" | "received" | "closed";
const NEXT: Record<PoStatus, PoStatus[]> = {
  draft: ["sent", "closed"],
  sent: ["partially_received", "received", "closed"],
  partially_received: ["partially_received", "received", "closed"],
  received: ["closed"],
  closed: [],
};
export const canTransition = (from: PoStatus, to: PoStatus): boolean => NEXT[from].includes(to);

export function statusAfterReceipt(lines: Array<{ qtyOrdered: number; qtyReceived: number }>): PoStatus {
  const done = lines.every((l) => l.qtyReceived >= l.qtyOrdered);
  const any = lines.some((l) => l.qtyReceived > 0);
  return done ? "received" : any ? "partially_received" : "sent";
}

/** Build-N-kits (pre-assembled mode): how many can actually be built, with a partial warning. */
export function planBuild(
  requested: number,
  perKitMicro: Record<string, number>,
  available: (variantId: string) => number,
): { buildable: number; partial: boolean; limitingVariantId: string | null; consume: Array<{ variantId: string; units: number }> } {
  let buildable = requested;
  let limiting: string | null = null;
  for (const [v, micro] of Object.entries(perKitMicro)) {
    const n = Math.floor((Math.max(0, available(v)) * 10_000) / micro);
    if (n < buildable) { buildable = n; limiting = v; }
  }
  const consume = Object.entries(perKitMicro).map(([variantId, micro]) => ({ variantId, units: Math.round((micro * buildable) / 10_000) }));
  return { buildable, partial: buildable < requested, limitingVariantId: limiting, consume };
}
