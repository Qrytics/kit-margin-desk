import { describe, expect, it } from "vitest";
import { deriveAvailability, explodeBom, indexKits, validateNesting, type KitDef } from "../app/core/bom";
import { costChangeImpact, marginFor, rollupCost, weightedAverageCost } from "../app/core/margin";
import { emptyLine, mergeDeltas, planLine, resolveLocation, type LineState } from "../app/core/sync";
import { MemoryGateway, MemoryLedgerStore, applyAdjustments, planUndo, undoBatch } from "../app/core/ledger";

const kit = (id: string, lines: KitDef["lines"], extra: Partial<KitDef> = {}): KitDef => ({
  id, variantId: `v_${id}`, mode: "assemble_on_order", lines,
  packagingCostCents: 0, laborMinutes: 0, laborRateCents: 0, landedUpliftBps: 0, ...extra,
});
const costs: Record<string, number> = { JAR: 200, CANDLE: 500, WAX: 1000, SOAP: 300 };
const unitCost = (v: string) => costs[v] ?? null;

describe("margin math", () => {
  it("rolls up materials, waste, uplift, packaging and labor", () => {
    const k = kit("gift", [
      { componentVariantId: "JAR", qtyPerKit: 2, wasteBps: 0 },
      { componentVariantId: "CANDLE", qtyPerKit: 1, wasteBps: 1000 }, // 10% waste
    ], { packagingCostCents: 150, laborMinutes: 6, laborRateCents: 1800, landedUpliftBps: 800 });
    const c = rollupCost(k, indexKits([k]), unitCost);
    expect(c.materialsCents).toBe(400 + 550);
    expect(c.upliftCents).toBe(76); // 8% of 950
    expect(c.packagingCents).toBe(150);
    expect(c.laborCents).toBe(180);
    expect(c.totalCents).toBe(950 + 76 + 150 + 180);
  });
  it("supports fractional quantities (0.35 of a 1L bottle)", () => {
    const k = kit("oil", [{ componentVariantId: "WAX", qtyPerKit: 0.35, wasteBps: 0 }]);
    expect(rollupCost(k, indexKits([k]), unitCost).materialsCents).toBe(350);
  });
  it("flags missing component costs", () => {
    const k = kit("x", [{ componentVariantId: "NOCOST", qtyPerKit: 1, wasteBps: 0 }]);
    expect(rollupCost(k, indexKits([k]), unitCost).missingCosts).toEqual(["NOCOST"]);
  });
  it("computes margin and health badges", () => {
    const t = { targetPct: 40, alertPct: 20 };
    expect(marginFor(2000, 1000, t)).toMatchObject({ marginCents: 1000, marginPct: 50, health: "green" });
    expect(marginFor(2000, 1400, t).health).toBe("amber");
    expect(marginFor(2000, 1700, t).health).toBe("red");
    expect(marginFor(1000, 1062, t)).toMatchObject({ marginCents: -62, health: "red" });
    expect(marginFor(0, 100, t).health).toBe("unknown");
  });
  it("rolls nested kits into the parent", () => {
    const inner = kit("inner", [{ componentVariantId: "JAR", qtyPerKit: 1, wasteBps: 0 }], { packagingCostCents: 50 });
    const outer = kit("outer", [{ componentKitId: "inner", qtyPerKit: 2, wasteBps: 0 }, { componentVariantId: "SOAP", qtyPerKit: 1, wasteBps: 0 }]);
    const c = rollupCost(outer, indexKits([inner, outer]), unitCost);
    expect(c.materialsCents).toBe(2 * 200 + 300);
    expect(c.packagingCents).toBe(100);
  });
  it("reports which kits a supplier cost change hits", () => {
    const a = kit("a", [{ componentVariantId: "JAR", qtyPerKit: 2, wasteBps: 0 }]);
    const b = kit("b", [{ componentVariantId: "SOAP", qtyPerKit: 1, wasteBps: 0 }]);
    const impact = costChangeImpact([a, b], indexKits([a, b]), () => 1000, unitCost, { variantId: "JAR", oldCents: 200, newCents: 224 });
    expect(impact).toHaveLength(1);
    expect(impact[0]).toMatchObject({ kitId: "a", beforePct: 60, afterPct: 55.2 });
  });
  it("weighted average cost spreads freight", () => {
    expect(weightedAverageCost(100, 200, 100, 300)).toBe(250);
    expect(weightedAverageCost(0, 0, 100, 300, 1000)).toBe(310);
    expect(weightedAverageCost(-5, 200, 10, 300)).toBe(300);
  });
});

describe("BOM explode, nesting and availability", () => {
  it("explodes nested kits to leaves", () => {
    const inner = kit("inner", [{ componentVariantId: "JAR", qtyPerKit: 2, wasteBps: 0 }]);
    const outer = kit("outer", [{ componentKitId: "inner", qtyPerKit: 3, wasteBps: 0 }, { componentVariantId: "JAR", qtyPerKit: 1, wasteBps: 0 }]);
    expect(explodeBom(outer, indexKits([inner, outer])).leaves.get("JAR")).toBe(70000);
  });
  it("refuses A->B->A and depth over 3", () => {
    const a = kit("a", [{ componentKitId: "b", qtyPerKit: 1, wasteBps: 0 }]);
    const b = kit("b", []);
    expect(validateNesting(indexKits([a, b]), "b", "a")).toMatchObject({ ok: false });
    expect(validateNesting(indexKits([a, b]), "a", "a")).toMatchObject({ ok: false });
    const d = kit("d", []), c = kit("c", [{ componentKitId: "d", qtyPerKit: 1, wasteBps: 0 }]);
    const b2 = kit("b", [{ componentKitId: "c", qtyPerKit: 1, wasteBps: 0 }]);
    const a2 = kit("a", []);
    expect(validateNesting(indexKits([a2, b2, c, d]), "a", "b")).toMatchObject({ ok: false });
    expect(validateNesting(indexKits([a2, c, d]), "a", "c")).toEqual({ ok: true });
  });
  it("derives availability as min of floors, clamped at 0, per spec", () => {
    const k = kit("k", [
      { componentVariantId: "JAR", qtyPerKit: 2, wasteBps: 0 },
      { componentVariantId: "WAX", qtyPerKit: 0.35, wasteBps: 0 },
    ]);
    const stock: Record<string, number> = { JAR: 7, WAX: 10 };
    const info = (v: string) => ({ variantId: v, exists: true, available: stock[v], tracked: true, continueSelling: false, costCents: null });
    const r = deriveAvailability(k, indexKits([k]), info);
    expect(r.available).toBe(3); // JAR 7/2 = 3, WAX 10/0.35 = 28
    expect(r.limitingVariantId).toBe("JAR");
    stock.JAR = -4;
    expect(deriveAvailability(k, indexKits([k]), info).available).toBe(0);
  });
  it("treats untracked / continue-selling components as unconstrained with a warning", () => {
    const k = kit("k", [{ componentVariantId: "JAR", qtyPerKit: 1, wasteBps: 0 }, { componentVariantId: "WAX", qtyPerKit: 1, wasteBps: 0 }]);
    const info = (v: string) => ({ variantId: v, exists: true, available: v === "JAR" ? 0 : 5, tracked: v !== "JAR", continueSelling: false, costCents: null });
    const r = deriveAvailability(k, indexKits([k]), info);
    expect(r.available).toBe(5);
    expect(r.warnings.length).toBe(1);
  });
  it("a broken line makes availability 0 without throwing", () => {
    const k = kit("k", [{ componentVariantId: "JAR", qtyPerKit: 1, wasteBps: 0, broken: true }]);
    expect(deriveAvailability(k, indexKits([k]), () => undefined).available).toBe(0);
  });
});

// helper: run events through planLine and accumulate stock
const BOM = { JAR: 20000, WAX: 3500 }; // 2 jars, 0.35 wax per kit
function run(events: Array<Parameters<typeof planLine>[1]>, start?: LineState) {
  let state = start ?? emptyLine();
  const stock = new Map<string, number>([["JAR", 1000], ["WAX", 1000]]);
  for (const e of events) {
    const p = planLine(state, e, BOM);
    for (const d of mergeDeltas(p.deltas)) stock.set(d.variantId, stock.get(d.variantId)! + d.delta);
    state = p.nextState;
  }
  return { stock, state };
}
const order = (q: number) => ({ type: "order", orderedQty: q }) as const;
const refund = (id: string, q: number, t = "restock") => ({ type: "refund", refundLineId: id, qty: q, restockType: t }) as const;

describe("component decrement / restore", () => {
  it("decrements components on order", () => {
    const { stock } = run([order(3)]);
    expect(stock.get("JAR")).toBe(1000 - 6);
    expect(stock.get("WAX")).toBe(1000 - 1); // 1.05 rounds to 1
  });
  it("is idempotent under duplicate delivery", () => {
    const { stock } = run([order(3), order(3), order(3)]);
    expect(stock.get("JAR")).toBe(994);
  });
  it("order edited after payment diffs instead of re-applying", () => {
    const { stock } = run([order(3), order(5)]);
    expect(stock.get("JAR")).toBe(990);
    const down = run([order(5), order(2)]);
    expect(down.stock.get("JAR")).toBe(996);
  });
  it("restores only on restocked refunds, never for NO_RESTOCK", () => {
    expect(run([order(4), refund("r1", 1, "no_restock")]).stock.get("JAR")).toBe(992);
    expect(run([order(4), refund("r1", 1, "return")]).stock.get("JAR")).toBe(994);
    expect(run([order(4), refund("r1", 1), refund("r1", 1)]).stock.get("JAR")).toBe(994); // replayed refund
  });
  it("partial refunds accumulate and fractional rounding does not drift", () => {
    const all = run([order(20), refund("a", 7), refund("b", 13)]);
    expect(all.stock.get("WAX")).toBe(1000);
    expect(all.stock.get("JAR")).toBe(1000);
  });
  it("cancel restores only unfulfilled quantity", () => {
    const r = run([order(5), { type: "cancel", unfulfilledQty: 3 }]);
    expect(r.stock.get("JAR")).toBe(1000 - 4);
  });
  it("out-of-order delivery (refund before create) converges to the same stock", () => {
    const inOrder = run([order(5), refund("r", 2)]);
    const flipped = run([refund("r", 2), order(5)]);
    expect(flipped.stock.get("JAR")).toBe(inOrder.stock.get("JAR"));
    expect(flipped.stock.get("WAX")).toBe(inOrder.stock.get("WAX"));
  });
  it("property: any shuffled event sequence nets to a from-scratch recompute", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let t = 0; t < 200; t++) {
      const ordered = 1 + Math.floor(rnd() * 20);
      const evs: Array<Parameters<typeof planLine>[1]> = [order(ordered)];
      let left = ordered;
      for (let i = 0; i < 3; i++) {
        const q = Math.floor(rnd() * (left + 1));
        left -= q;
        evs.push(refund(`r${i}`, q, rnd() < 0.3 ? "no_restock" : "restock"));
      }
      if (rnd() < 0.3) evs.push({ type: "cancel", unfulfilledQty: Math.floor(rnd() * 3) });
      const shuffled = [...evs].sort(() => rnd() - 0.5);
      const dup = [...shuffled, ...shuffled.slice(0, 2)];
      const a = run(dup), b = run(evs);
      expect(a.state.netApplied).toBe(b.state.netApplied);
      expect(a.stock.get("JAR")).toBe(b.stock.get("JAR"));
      expect(a.stock.get("WAX")).toBe(b.stock.get("WAX"));
      const fresh = run([order(ordered), ...evs.slice(1)].reverse().reverse());
      expect(fresh.stock.get("WAX")).toBe(a.stock.get("WAX"));
    }
  });
  it("frozen lines (undone by the merchant) are not re-applied by later webhooks", () => {
    const first = run([order(3)]);
    const frozen = { ...first.state, frozen: true };
    expect(planLine(frozen, order(3), BOM).deltas).toEqual([]);
  });
  it("resolves location with assumed flag", () => {
    expect(resolveLocation({ assignedLocationId: "L2", primaryLocationId: "L1" })).toEqual({ locationId: "L2", assumed: false });
    expect(resolveLocation({ primaryLocationId: "L1" })).toEqual({ locationId: "L1", assumed: true });
  });
});

describe("ledger apply + undo", () => {
  const setup = () => {
    const gateway = new MemoryGateway();
    gateway.set("JAR", "L1", 100);
    gateway.set("WAX", "L1", 50);
    const store = new MemoryLedgerStore();
    return { gateway, store, deps: { gateway, store } };
  };
  it("writes before/after rows and skips unstocked locations without failing the batch", async () => {
    const { deps, gateway } = setup();
    const r = await applyAdjustments(deps, [
      { variantId: "JAR", locationId: "L1", delta: -6 },
      { variantId: "WAX", locationId: "L9", delta: -1 },
    ], { type: "order", ref: "#1001" });
    expect(r.applied).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.entries[0]).toMatchObject({ beforeQty: 100, afterQty: 94, status: "applied" });
    expect(gateway.get("JAR", "L1")).toBe(94);
  });
  it("pause-all-sync writes nothing to Shopify", async () => {
    const { deps, gateway } = setup();
    const r = await applyAdjustments({ ...deps, paused: true }, [{ variantId: "JAR", locationId: "L1", delta: -6 }], { type: "order", ref: "#1" });
    expect(gateway.get("JAR", "L1")).toBe(100);
    expect(r.entries[0].status).toBe("skipped");
  });
  it("undo reverses exact deltas", async () => {
    const { deps, gateway } = setup();
    const r = await applyAdjustments(deps, [{ variantId: "JAR", locationId: "L1", delta: -6 }, { variantId: "WAX", locationId: "L1", delta: -2 }], { type: "order", ref: "#1" });
    const u = await undoBatch(deps, r.batchId);
    expect(u.ok).toBe(true);
    expect(gateway.get("JAR", "L1")).toBe(100);
    expect(gateway.get("WAX", "L1")).toBe(50);
    expect((await undoBatch(deps, r.batchId)).ok).toBe(false); // cannot undo twice
  });
  it("refuses a clean undo when stock moved, offers compensating adjustment", async () => {
    const { deps, gateway } = setup();
    const r = await applyAdjustments(deps, [{ variantId: "JAR", locationId: "L1", delta: -6 }], { type: "order", ref: "#1" });
    gateway.set("JAR", "L1", 80); // someone else sold/adjusted
    const plan = await planUndo(deps, r.batchId);
    expect(plan.canUndoCleanly).toBe(false);
    expect(plan.reason).toMatch(/changed from 94 to 80/);
    const blocked = await undoBatch(deps, r.batchId);
    expect(blocked.ok).toBe(false);
    const comp = await undoBatch(deps, r.batchId, { allowCompensating: true });
    expect(comp).toMatchObject({ ok: true, compensating: true });
    expect(gateway.get("JAR", "L1")).toBe(86);
  });
  it("undo of a batch that nets the same variant twice reverses the total", async () => {
    const { deps, gateway } = setup();
    const r = await applyAdjustments(deps, [{ variantId: "JAR", locationId: "L1", delta: -4 }, { variantId: "JAR", locationId: "L1", delta: -2 }], { type: "build", ref: "B1" });
    // MemoryGateway applies sequentially so last afterQty is 94
    expect((await undoBatch(deps, r.batchId)).ok).toBe(true);
    expect(gateway.get("JAR", "L1")).toBe(100);
  });
});

import { canCreateKit, planAllows, planFromBillingName, withinOrderQuota } from "../app/core/plans";
import { parseBomCsv, toCsv } from "../app/core/csv";
import { daysOfCover, needsReorder, planBuild, reorderPoint, statusAfterReceipt, suggestQty, canTransition } from "../app/core/replenish";

describe("plans", () => {
  it("gates features and quotas", () => {
    expect(canCreateKit("free", 3).allowed).toBe(false);
    expect(canCreateKit("kit_desk", 500).allowed).toBe(true);
    expect(planAllows("kit_desk", "replenishment")).toBe(false);
    expect(planAllows("kit_desk_pro", "replenishment")).toBe(true);
    expect(withinOrderQuota("free", 20)).toBe(false);
    expect(withinOrderQuota("plus", 1e6)).toBe(true);
    expect(planFromBillingName("Kit Desk Pro")).toBe("kit_desk_pro");
    expect(planFromBillingName("whatever")).toBe("free");
  });
});

describe("csv", () => {
  it("imports valid rows and reports unmatched / invalid ones", () => {
    const skus = new Set(["GIFT", "JAR", "WAX"]);
    const r = parseBomCsv("kit_sku,component_sku,qty_per_kit,waste_pct\nGIFT,JAR,2,0\nGIFT,WAX,0.35,5\nGIFT,NOPE,1,0\nGIFT,JAR,abc,0\nGIFT,JAR,1.2345,0", skus);
    expect(r.rows).toHaveLength(2);
    expect(r.unmatched).toEqual([{ line: 4, sku: "NOPE", role: "component" }]);
    expect(r.errors.map((e) => e.line)).toEqual([5, 6]);
  });
  it("escapes quotes and neutralises formula injection on export", () => {
    expect(toCsv([["a,b", '=cmd|"x"', 5]])).toBe(`"a,b","'=cmd|""x""",5`);
  });
});

describe("replenishment", () => {
  const c = { variantId: "JAR", onHand: 34, incoming: 0, burnPerDay: 6.2, leadTimeDays: 10, reorderPointOverride: null, packSize: 50 };
  it("computes days of cover, reorder point and pack-rounded suggestion", () => {
    expect(Math.round(daysOfCover(34, 6.2)!)).toBe(5);
    expect(reorderPoint(c)).toBe(93);
    expect(needsReorder(c)).toBe(true);
    expect(suggestQty(c)).toBe(200); // 186 - 34 = 152 -> 4 packs of 50
    expect(suggestQty({ ...c, onHand: 500 })).toBe(0);
    expect(suggestQty({ ...c, incoming: 200 })).toBe(0);
  });
  it("PO state machine and receipt status", () => {
    expect(canTransition("draft", "received")).toBe(false);
    expect(canTransition("sent", "partially_received")).toBe(true);
    expect(statusAfterReceipt([{ qtyOrdered: 10, qtyReceived: 4 }, { qtyOrdered: 5, qtyReceived: 5 }])).toBe("partially_received");
    expect(statusAfterReceipt([{ qtyOrdered: 10, qtyReceived: 10 }])).toBe("received");
  });
  it("partial build warns when components cover fewer kits", () => {
    const p = planBuild(10, { JAR: 20000, WAX: 3500 }, (v) => (v === "JAR" ? 7 : 100));
    expect(p).toMatchObject({ buildable: 3, partial: true, limitingVariantId: "JAR" });
    expect(p.consume).toEqual([{ variantId: "JAR", units: 6 }, { variantId: "WAX", units: 1 }]);
  });
});
