import { deriveAvailability, explodeBom, indexKits, type KitDef } from "./bom";
import { costChangeImpact, marginFor, rollupCost, type Health } from "./margin";
import { burnRates, daysOfCover, groupBySupplier, needsReorder, reorderPoint, suggestQty, type ComponentStock } from "./replenish";
import { emptyLine, mergeDeltas, planLine } from "./sync";
import type { KitRecord, Snapshot, VariantInfo } from "./types";

const DAY = 86_400_000;

export const variantLabel = (v: VariantInfo | undefined, fallback = "Deleted variant"): string =>
  v ? `${v.productTitle}${v.variantTitle && v.variantTitle !== "Default Title" ? ` / ${v.variantTitle}` : ""}` : fallback;

export function primaryLocationId(s: Snapshot): string {
  return s.settings.defaultLocationId ?? s.locations.find((l) => l.primary)?.id ?? s.locations[0]?.id ?? "";
}

export const unitCostFn = (s: Snapshot) => {
  const meta = new Map(s.meta.map((m) => [m.variantId, m]));
  // Kit-level cost uses Shopify cost, falling back to app-maintained weighted average (PO receipts).
  return (id: string): number | null => s.variants[id]?.costCents ?? meta.get(id)?.avgCostCents ?? null;
};

export interface KitRow {
  id: string;
  title: string;
  sku: string | null;
  mode: KitRecord["mode"];
  components: number;
  available: number | null;
  limiting: string | null;
  warnings: string[];
  costCents: number;
  priceCents: number;
  marginCents: number;
  marginPct: number | null;
  health: Health;
  units30: number;
  revenue30Cents: number;
  missingCosts: number;
}

export function kitRows(s: Snapshot): KitRow[] {
  const idx = indexKits(s.kits);
  const loc = primaryLocationId(s);
  const cost = unitCostFn(s);
  const since = Date.now() - 30 * DAY;
  return s.kits.filter((k) => k.active !== false).map((k) => {
    const v = s.variants[k.variantId];
    const av = deriveAvailability(k, idx, (id) => {
      const c = s.variants[id];
      return c ? { variantId: id, exists: c.exists, available: c.levels[loc] ?? 0, tracked: c.tracked, continueSelling: c.continueSelling, costCents: c.costCents } : undefined;
    });
    const c = rollupCost(k, idx, cost);
    const price = v?.priceCents ?? 0;
    const m = marginFor(price, c.totalCents, { targetPct: s.settings.targetMarginPct, alertPct: s.settings.alertMarginPct }, c.missingCosts.length > 0);
    const sold = s.sales.filter((x) => x.variantId === k.variantId && new Date(x.soldAt).getTime() >= since);
    const units = sold.reduce((a, x) => a + x.qty - x.refundedQty, 0);
    return {
      id: k.id, title: k.title || variantLabel(v), sku: v?.sku ?? null, mode: k.mode,
      components: k.lines.length, available: av.available, limiting: av.limitingVariantId, warnings: av.warnings,
      costCents: c.totalCents, priceCents: price, marginCents: m.marginCents, marginPct: m.marginPct, health: m.health,
      units30: units, revenue30Cents: sold.reduce((a, x) => a + (x.qty - x.refundedQty) * x.unitPriceCents, 0),
      missingCosts: c.missingCosts.length,
    };
  });
}

export interface HealthReport {
  duplicateSkus: Array<{ sku: string; variants: VariantInfo[] }>;
  untracked: VariantInfo[];
  continueSelling: VariantInfo[];
  noCost: VariantInfo[];
  syncBlocked: boolean;
}

export function healthCheck(variants: VariantInfo[]): HealthReport {
  const bySku = new Map<string, VariantInfo[]>();
  for (const v of variants) {
    const sku = v.sku?.trim();
    if (sku) bySku.set(sku.toLowerCase(), [...(bySku.get(sku.toLowerCase()) ?? []), v]);
  }
  const duplicateSkus = [...bySku.values()].filter((g) => g.length > 1).map((g) => ({ sku: g[0].sku!, variants: g }));
  const live = variants.filter((v) => v.exists);
  return {
    duplicateSkus,
    untracked: live.filter((v) => !v.tracked),
    continueSelling: live.filter((v) => v.tracked && v.continueSelling),
    noCost: live.filter((v) => v.costCents == null),
    syncBlocked: duplicateSkus.length > 0,
  };
}

/** SKUs involved in a BOM that collide with another variant: sync must be blocked for those kits. */
export function kitsBlockedByDuplicates(s: Snapshot, report: HealthReport): Set<string> {
  const dup = new Set(report.duplicateSkus.flatMap((d) => d.variants.map((v) => v.id)));
  const blocked = new Set<string>();
  const idx = indexKits(s.kits);
  for (const k of s.kits) {
    const leaves = [...explodeBom(k, idx).leaves.keys(), k.variantId];
    if (leaves.some((l) => dup.has(l))) blocked.add(k.id);
  }
  return blocked;
}

export interface DryRunRow {
  orderName: string;
  kit: string;
  adjustments: Array<{ sku: string; label: string; delta: number; locationId: string }>;
}

/** Simulate the last 20 kit orders: exactly the component adjustments live sync WOULD have made. */
export function dryRun(s: Snapshot): DryRunRow[] {
  const idx = indexKits(s.kits);
  const byVariant = new Map(s.kits.filter((k) => k.mode === "assemble_on_order").map((k) => [k.variantId, k]));
  const rows: DryRunRow[] = [];
  for (const o of s.recentOrders.slice(0, 20)) {
    const all = [] as ReturnType<typeof mergeDeltas>;
    const kitNames: string[] = [];
    for (const l of o.lines) {
      const k = byVariant.get(l.variantId);
      if (!k) continue;
      kitNames.push(`${k.title} x${l.qty}`);
      const leaves = Object.fromEntries(explodeBom(k, idx).leaves);
      all.push(...planLine(emptyLine(), { type: "order", orderedQty: l.qty }, leaves).deltas);
    }
    if (!kitNames.length) continue;
    rows.push({
      orderName: o.name, kit: kitNames.join(", "),
      adjustments: mergeDeltas(all).map((d) => ({ sku: s.variants[d.variantId]?.sku ?? d.variantId, label: variantLabel(s.variants[d.variantId]), delta: d.delta, locationId: primaryLocationId(s) })),
    });
  }
  return rows;
}

export interface PeriodPnl {
  kitId: string; title: string; units: number; revenueCents: number; materialsCents: number;
  packLaborCents: number; cogsCents: number; marginCents: number; marginPct: number | null; returnedUnits: number; health: Health;
}

export function marginDesk(s: Snapshot, days: 7 | 30 | 90) {
  const idx = indexKits(s.kits);
  const cost = unitCostFn(s);
  const since = Date.now() - days * DAY;
  const pnl: PeriodPnl[] = s.kits.map((k) => {
    const sold = s.sales.filter((x) => x.variantId === k.variantId && new Date(x.soldAt).getTime() >= since);
    const gross = sold.reduce((a, x) => a + x.qty, 0);
    const returned = sold.reduce((a, x) => a + x.refundedQty, 0);
    const net = gross - returned;
    const revenue = sold.reduce((a, x) => a + (x.qty - x.refundedQty) * x.unitPriceCents, 0);
    const c = rollupCost(k, idx, cost);
    const cogs = c.totalCents * net;
    const m = marginFor(revenue, cogs, { targetPct: s.settings.targetMarginPct, alertPct: s.settings.alertMarginPct });
    return {
      kitId: k.id, title: k.title, units: net, revenueCents: revenue, materialsCents: (c.materialsCents + c.upliftCents) * net,
      packLaborCents: (c.packagingCents + c.laborCents) * net, cogsCents: cogs, marginCents: m.marginCents,
      marginPct: revenue > 0 ? m.marginPct : null, returnedUnits: returned, health: revenue > 0 ? m.health : "unknown",
    };
  });
  const active = pnl.filter((p) => p.units > 0);
  const revenue = active.reduce((a, p) => a + p.revenueCents, 0);
  const cogs = active.reduce((a, p) => a + p.cogsCents, 0);
  const ranked = [...active].sort((a, b) => b.marginCents - a.marginCents);
  return {
    pnl, totalRevenueCents: revenue, totalMarginCents: revenue - cogs,
    blendedPct: revenue > 0 ? Math.round(((revenue - cogs) / revenue) * 1000) / 10 : null,
    top: ranked.slice(0, 5), bottom: ranked.slice(-5).reverse().filter((p) => !ranked.slice(0, 5).includes(p) || ranked.length <= 5),
  };
}

export interface CostAlert {
  id: string; variantId: string; label: string; sku: string | null; pctChange: number;
  kits: Array<{ kitId: string; title: string; beforePct: number | null; afterPct: number | null }>;
}

export function costAlerts(s: Snapshot): CostAlert[] {
  const idx = indexKits(s.kits);
  const cost = unitCostFn(s);
  const priceOf = (k: KitDef) => s.variants[k.variantId]?.priceCents ?? 0;
  return s.costChanges.map((c) => {
    const impact = costChangeImpact(s.kits, idx, priceOf, cost, { variantId: c.variantId, oldCents: c.oldCents, newCents: c.newCents });
    return {
      id: c.id, variantId: c.variantId, label: variantLabel(s.variants[c.variantId]), sku: s.variants[c.variantId]?.sku ?? null,
      pctChange: c.oldCents > 0 ? Math.round(((c.newCents - c.oldCents) / c.oldCents) * 1000) / 10 : 0,
      kits: impact.map((i) => ({ kitId: i.kitId, title: s.kits.find((k) => k.id === i.kitId)?.title ?? i.kitId, beforePct: i.beforePct, afterPct: i.afterPct })),
    };
  }).filter((a) => a.kits.length > 0);
}

export interface ComponentRow extends ComponentStock {
  label: string; sku: string | null; supplierName: string | null; supplierSku: string | null;
  cover: number | null; reorderAt: number; suggested: number; reorder: boolean; lastCostCents: number | null;
}

export function componentRows(s: Snapshot): ComponentRow[] {
  const idx = indexKits(s.kits);
  const loc = primaryLocationId(s);
  const meta = new Map(s.meta.map((m) => [m.variantId, m]));
  const since = Date.now() - 30 * DAY;
  const consumed: Array<{ variantId: string; units: number }> = [];
  const kitByVariant = new Map(s.kits.map((k) => [k.variantId, k]));
  for (const sale of s.sales) {
    if (new Date(sale.soldAt).getTime() < since) continue;
    const net = sale.qty - sale.refundedQty;
    const k = kitByVariant.get(sale.variantId);
    if (k && k.mode === "assemble_on_order") {
      for (const [v, micro] of explodeBom(k, idx).leaves) consumed.push({ variantId: v, units: (micro * net) / 10_000 });
    } else consumed.push({ variantId: sale.variantId, units: net });
  }
  const burn = burnRates(consumed, 30);
  const ids = new Set<string>();
  for (const k of s.kits) for (const v of explodeBom(k, idx).leaves.keys()) ids.add(v);
  const incoming = new Map<string, number>();
  for (const po of s.pos) if (po.status === "sent" || po.status === "partially_received")
    for (const l of po.lines) incoming.set(l.variantId, (incoming.get(l.variantId) ?? 0) + Math.max(0, l.qtyOrdered - l.qtyReceived));
  return [...ids].map((id) => {
    const v = s.variants[id], m = meta.get(id);
    const stock: ComponentStock = {
      variantId: id, onHand: v?.levels[loc] ?? 0, incoming: incoming.get(id) ?? 0, burnPerDay: burn.get(id) ?? 0,
      leadTimeDays: m?.leadTimeDays ?? null, reorderPointOverride: m?.reorderPointOverride ?? null, packSize: m?.packSize ?? null,
    };
    return {
      ...stock, label: variantLabel(v), sku: v?.sku ?? null, supplierName: m?.supplierName ?? null, supplierSku: m?.supplierSku ?? null,
      cover: daysOfCover(stock.onHand, stock.burnPerDay), reorderAt: reorderPoint(stock),
      suggested: suggestQty(stock, s.settings.coverDays), reorder: needsReorder(stock), lastCostCents: m?.avgCostCents ?? v?.costCents ?? null,
    };
  }).sort((a, b) => (a.cover ?? 1e9) - (b.cover ?? 1e9));
}

export const suggestedOrders = (rows: ComponentRow[]) => groupBySupplier(rows.filter((r) => r.reorder && r.suggested > 0));

export const money = (cents: number, currency = "USD"): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
