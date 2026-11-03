import { MICRO, toMicro } from "../lib/units";
import type { KitDef, KitIndex } from "./bom";

export interface CostBreakdown {
  materialsCents: number;
  upliftCents: number;
  packagingCents: number;
  laborCents: number;
  totalCents: number;
  /** variant ids that had no cost entered (counted as 0). */
  missingCosts: string[];
}

/**
 * Landed kit cost = materials (waste included) + uplift% on materials + packaging + labor.
 * Nested kits contribute their own materials/packaging/labor; uplift of the root applies once.
 */
export function rollupCost(
  kit: KitDef,
  kits: KitIndex,
  unitCost: (variantId: string) => number | null,
  opts: { costOverride?: { variantId: string; cents: number } } = {},
): CostBreakdown {
  const missing = new Set<string>();
  const acc = { mat: 0, pack: 0, labor: 0 };

  const walk = (k: KitDef, factor: number, depth: number) => {
    acc.pack += k.packagingCostCents * factor;
    acc.labor += (k.laborMinutes / 60) * k.laborRateCents * factor;
    for (const line of k.lines) {
      const q = ((toMicro(line.qtyPerKit) * (10_000 + line.wasteBps)) / 10_000 / MICRO) * factor;
      if (line.componentKitId) {
        const child = kits.get(line.componentKitId);
        if (child && depth < 4) walk(child, q, depth + 1);
      } else if (line.componentVariantId) {
        const o = opts.costOverride;
        const cost = o && o.variantId === line.componentVariantId ? o.cents : unitCost(line.componentVariantId);
        if (cost == null) missing.add(line.componentVariantId);
        acc.mat += (cost ?? 0) * q;
      }
    }
  };
  walk(kit, 1, 1);

  const materialsCents = Math.round(acc.mat);
  const upliftCents = Math.round((materialsCents * kit.landedUpliftBps) / 10_000);
  const packagingCents = Math.round(acc.pack);
  const laborCents = Math.round(acc.labor);
  return {
    materialsCents,
    upliftCents,
    packagingCents,
    laborCents,
    totalCents: materialsCents + upliftCents + packagingCents + laborCents,
    missingCosts: [...missing],
  };
}

export type Health = "green" | "amber" | "red" | "unknown";

export interface MarginResult {
  marginCents: number;
  /** percent, one decimal e.g. 31.4. null when price is 0. */
  marginPct: number | null;
  health: Health;
}

export interface Thresholds {
  targetPct: number; // green at or above
  alertPct: number; // red below
}

export function marginFor(priceCents: number, costCents: number, t: Thresholds, hasMissingCosts = false): MarginResult {
  const marginCents = priceCents - costCents;
  const marginPct = priceCents > 0 ? Math.round((marginCents / priceCents) * 1000) / 10 : null;
  let health: Health;
  if (marginPct === null) health = "unknown";
  else if (marginCents < 0 || marginPct < t.alertPct) health = "red";
  else if (marginPct >= t.targetPct) health = hasMissingCosts ? "amber" : "green";
  else health = "amber";
  return { marginCents, marginPct, health };
}

export interface CostChangeImpact {
  kitId: string;
  beforePct: number | null;
  afterPct: number | null;
  beforeCents: number;
  afterCents: number;
}

/** Which kits are affected by a component cost change, and how their margin moves. */
export function costChangeImpact(
  kitsList: KitDef[],
  kits: KitIndex,
  priceOf: (kit: KitDef) => number,
  unitCost: (variantId: string) => number | null,
  change: { variantId: string; oldCents: number; newCents: number },
): CostChangeImpact[] {
  const t: Thresholds = { targetPct: 0, alertPct: 0 };
  const out: CostChangeImpact[] = [];
  for (const kit of kitsList) {
    const before = rollupCost(kit, kits, unitCost, { costOverride: { variantId: change.variantId, cents: change.oldCents } });
    const after = rollupCost(kit, kits, unitCost, { costOverride: { variantId: change.variantId, cents: change.newCents } });
    if (before.totalCents === after.totalCents) continue;
    const price = priceOf(kit);
    const b = marginFor(price, before.totalCents, t);
    const a = marginFor(price, after.totalCents, t);
    out.push({ kitId: kit.id, beforePct: b.marginPct, afterPct: a.marginPct, beforeCents: b.marginCents, afterCents: a.marginCents });
  }
  return out;
}

/** Weighted-average unit cost after receiving stock; freight is spread across all units. */
export function weightedAverageCost(
  onHand: number,
  currentAvgCents: number,
  receivedQty: number,
  unitCostCents: number,
  freightCents = 0,
): number {
  const onHandQty = Math.max(0, onHand);
  const totalQty = onHandQty + receivedQty;
  if (totalQty <= 0) return currentAvgCents;
  const value = onHandQty * currentAvgCents + receivedQty * unitCostCents + freightCents;
  return Math.round(value / totalQty);
}
