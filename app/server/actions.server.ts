import prisma from "../db.server";
import { applyAdjustments, type InventoryGateway } from "../core/ledger";
import { explodeBom, indexKits, validateNesting, type KitDef } from "../core/bom";
import { canCreateKit, planAllows, PLANS } from "../core/plans";
import { parseBomCsv } from "../core/csv";
import { planBuild, canTransition, statusAfterReceipt, type PoStatus } from "../core/replenish";
import { weightedAverageCost, rollupCost } from "../core/margin";
import { toMicro } from "../lib/units";
import type { AppContext } from "./context.server";
import { PrismaLedgerStore, loadKits, settingsOf } from "./repo.server";
import { ShopifyInventoryGateway, fetchVariants, scanCatalog, updateUnitCost } from "./shopify-api";
import { undoFromUi } from "./sync.server";
import { primaryLocationId, unitCostFn } from "../core/views";
import type { KitRecord } from "../core/types";

export interface ActionResult { ok: boolean; message: string; redirectTo?: string; data?: unknown }
const fail = (message: string): ActionResult => ({ ok: false, message });
const ok = (message: string, extra: Partial<ActionResult> = {}): ActionResult => ({ ok: true, message, ...extra });

interface LineInput { componentVariantId?: string; componentKitId?: string; qty: number; wastePct: number; uom: string }

const parseLines = (raw: string): LineInput[] => {
  const arr = JSON.parse(raw || "[]") as LineInput[];
  return arr.filter((l) => (l.componentVariantId || l.componentKitId) && Number(l.qty) > 0).map((l) => ({
    componentVariantId: l.componentVariantId || undefined, componentKitId: l.componentKitId || undefined,
    qty: Math.round(Number(l.qty) * 1000) / 1000, wastePct: Math.min(100, Math.max(0, Number(l.wastePct) || 0)), uom: (l.uom || "pcs").slice(0, 12),
  }));
};

export async function performAction(ctx: AppContext, intent: string, f: FormData): Promise<ActionResult> {
  const get = (k: string) => String(f.get(k) ?? "");
  const snap = ctx.snapshot;
  if (ctx.demo) return demoAction(ctx, intent, f);
  const shopId = ctx.shopId!;
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const settings = settingsOf(shop);
  const appUrl = process.env.SHOPIFY_APP_URL ?? "";
  const gatewayFor = async (ids: string[]): Promise<InventoryGateway> => {
    const variants = { ...snap.variants, ...(await fetchVariants(ctx.admin!, ids.filter((i) => !snap.variants[i]))) };
    return new ShopifyInventoryGateway(ctx.admin!, (v) => variants[v]?.inventoryItemId ?? null, appUrl);
  };

  switch (intent) {
    case "enable-sync": {
      const report = (await scanCatalog(ctx.admin!)).variants;
      const bySku = new Map<string, string[]>();
      for (const v of report) if (v.sku) bySku.set(v.sku.toLowerCase(), [...(bySku.get(v.sku.toLowerCase()) ?? []), v.id]);
      const idx = indexKits(snap.kits);
      const used = new Set(snap.kits.flatMap((k) => [k.variantId, ...explodeBom(k, idx).leaves.keys()]));
      const excluded = new Set(settings.excludedVariantIds);
      const conflicts = [...bySku.values()].filter((ids) => ids.length > 1 && ids.some((i) => used.has(i) && !excluded.has(i)));
      if (conflicts.length) return fail("Duplicate SKUs touch your kits. Resolve them in Shopify, or exclude those kits, before enabling sync.");
      await prisma.shop.update({ where: { id: shopId }, data: { syncEnabled: true, syncEnabledAt: new Date() } });
      return ok("Live sync is on. Every adjustment will appear in the ledger.");
    }
    case "disable-sync":
      await prisma.shop.update({ where: { id: shopId }, data: { syncEnabled: false } });
      return ok("Sync turned off. Nothing will be adjusted.");
    case "pause-all":
      await prisma.shop.update({ where: { id: shopId }, data: { syncPaused: true } });
      return ok("All sync paused. Webhooks are still recorded but nothing is written to Shopify.");
    case "resume-all":
      await prisma.shop.update({ where: { id: shopId }, data: { syncPaused: false } });
      return ok("Sync resumed.");
    case "save-settings": {
      const next = {
        ...settings,
        defaultLocationId: get("defaultLocationId") || null,
        laborRateCents: Math.round(Number(get("laborRate")) * 100) || 0,
        landedUpliftBps: Math.round(Number(get("upliftPct")) * 100) || 0,
        targetMarginPct: Number(get("targetPct")) || 40,
        alertMarginPct: Number(get("alertPct")) || 15,
        coverDays: Math.max(1, Number(get("coverDays")) || 30),
        digest: get("digest") === "on" && planAllows(snap.plan, "digest"),
        pushCostToShopify: get("pushCost") === "on",
      };
      await prisma.shop.update({ where: { id: shopId }, data: { settings: next as never } });
      return ok("Settings saved.");
    }
    case "exclude-variant": {
      const next = [...new Set([...settings.excludedVariantIds, get("variantId")])];
      await prisma.shop.update({ where: { id: shopId }, data: { settings: { ...settings, excludedVariantIds: next } as never } });
      return ok("Excluded from sync. Costing still works for it.");
    }
    case "create-kit": {
      const variantId = get("variantId");
      if (!variantId) return fail("Pick a product variant first.");
      const count = await prisma.kit.count({ where: { shopId, active: true } });
      const q = canCreateKit(snap.plan, count);
      if (!q.allowed) return fail(q.reason!);
      const existing = await prisma.kit.findUnique({ where: { shopId_shopifyVariantId: { shopId, shopifyVariantId: variantId } } });
      if (existing) return ok("That variant is already a kit.", { redirectTo: `/app/kits/${existing.id}` });
      const v = (await fetchVariants(ctx.admin!, [variantId]))[variantId];
      if (!v?.exists) return fail("Variant not found in Shopify.");
      const k = await prisma.kit.create({ data: { shopId, shopifyProductId: v.productId, shopifyVariantId: variantId, laborRateCents: null, landedUpliftBps: null } });
      return ok("Kit created. Add its components.", { redirectTo: `/app/kits/${k.id}` });
    }
    case "save-kit": {
      const id = get("kitId");
      const lines = parseLines(get("lines"));
      const kit = await prisma.kit.findFirst({ where: { id, shopId } });
      if (!kit) return fail("Kit not found.");
      // Nesting: validate each nested kit line against a hypothetical index (cycle + depth cap 3).
      const kitsNow = await loadKits(shopId, settings);
      for (const l of lines.filter((x) => x.componentKitId)) {
        const hypo = kitsNow.map((k) => (k.id === id ? { ...k, lines: [] } : k));
        const v = validateNesting(indexKits(hypo), id, l.componentKitId!);
        if (!v.ok) return fail(v.reason);
      }
      const nested = lines.filter((l) => l.componentKitId);
      if (nested.length) {
        const hypo = kitsNow.map((k) => (k.id === id ? { ...k, lines: lines.map((l) => ({ componentKitId: l.componentKitId, componentVariantId: l.componentVariantId, qtyPerKit: l.qty, wasteBps: 0 })) } : k));
        const idx = indexKits(hypo as KitDef[]);
        if (explodeBom(idx.get(id)!, idx).issues.some((i) => /cycle|depth/.test(i))) return fail("Nesting is limited to 3 levels and cannot loop.");
      }
      const invIds = await fetchVariants(ctx.admin!, lines.filter((l) => l.componentVariantId).map((l) => l.componentVariantId!));
      await prisma.$transaction([
        prisma.bomLine.deleteMany({ where: { kitId: id } }),
        prisma.bomLine.createMany({
          data: lines.map((l, i) => ({
            kitId: id, componentVariantId: l.componentVariantId ?? null, componentKitId: l.componentKitId ?? null,
            componentInventoryItemId: l.componentVariantId ? invIds[l.componentVariantId]?.inventoryItemId ?? null : null,
            qtyPerKit: l.qty, wasteBps: Math.round(l.wastePct * 100), uomLabel: l.uom, sort: i,
          })),
        }),
        prisma.kit.update({
          where: { id },
          data: {
            mode: get("mode") === "pre_assembled" ? "pre_assembled" : "assemble_on_order",
            manageAvailability: get("manage") === "on",
            packagingCostCents: Math.round(Number(get("packaging")) * 100) || 0,
            laborMinutes: Number(get("laborMinutes")) || 0,
            landedUpliftBps: get("upliftPct") === "" ? null : Math.round(Number(get("upliftPct")) * 100),
          },
        }),
      ]);
      return ok("Kit saved.");
    }
    case "clone-kit": {
      const src = await prisma.kit.findFirst({ where: { id: get("kitId"), shopId }, include: { lines: true } });
      const target = get("targetVariantId");
      if (!src || !target) return fail("Choose a target variant.");
      const count = await prisma.kit.count({ where: { shopId, active: true } });
      const q = canCreateKit(snap.plan, count);
      if (!q.allowed) return fail(q.reason!);
      if (await prisma.kit.findUnique({ where: { shopId_shopifyVariantId: { shopId, shopifyVariantId: target } } })) return fail("That variant is already a kit.");
      const v = (await fetchVariants(ctx.admin!, [target]))[target];
      const k = await prisma.kit.create({
        data: {
          shopId, shopifyProductId: v.productId, shopifyVariantId: target, mode: src.mode, packagingCostCents: src.packagingCostCents, laborMinutes: src.laborMinutes,
          laborRateCents: src.laborRateCents, landedUpliftBps: src.landedUpliftBps,
          lines: { create: src.lines.map((l) => ({ componentVariantId: l.componentVariantId, componentInventoryItemId: l.componentInventoryItemId, componentKitId: l.componentKitId, qtyPerKit: l.qtyPerKit, wasteBps: l.wasteBps, uomLabel: l.uomLabel, sort: l.sort })) },
        },
      });
      return ok("Kit cloned. Swap any components that differ (scent, size).", { redirectTo: `/app/kits/${k.id}` });
    }
    case "push-cost": {
      const kit = snap.kits.find((k) => k.id === get("kitId"));
      if (!kit) return fail("Kit not found.");
      const cost = rollupCost(kit, indexKits(snap.kits), unitCostFn(snap)).totalCents;
      const item = snap.variants[kit.variantId]?.inventoryItemId;
      if (!item) return fail("Kit variant has no inventory item.");
      await updateUnitCost(ctx.admin!, item, cost);
      return ok(`Shopify cost per item set to ${(cost / 100).toFixed(2)}.`);
    }
    case "import-csv": {
      if (!planAllows(snap.plan, "csv")) return fail("CSV import is part of Kit Desk and above.");
      const catalog = (await scanCatalog(ctx.admin!)).variants;
      const bySku = new Map(catalog.filter((v) => v.sku).map((v) => [v.sku!, v]));
      const report = parseBomCsv(get("csv"), new Set(bySku.keys()));
      if (get("commit") !== "1") return { ok: report.errors.length === 0, message: `${report.rows.length} rows ready, ${report.unmatched.length} unmatched, ${report.errors.length} invalid.`, data: report };
      const grouped = new Map<string, typeof report.rows>();
      for (const r of report.rows) grouped.set(r.kitSku, [...(grouped.get(r.kitSku) ?? []), r]);
      let created = 0;
      for (const [sku, rows] of grouped) {
        const kv = bySku.get(sku)!;
        const count = await prisma.kit.count({ where: { shopId, active: true } });
        let kit = await prisma.kit.findUnique({ where: { shopId_shopifyVariantId: { shopId, shopifyVariantId: kv.id } } });
        if (!kit) {
          if (!canCreateKit(snap.plan, count).allowed) continue;
          kit = await prisma.kit.create({ data: { shopId, shopifyProductId: kv.productId, shopifyVariantId: kv.id } });
          created++;
        }
        await prisma.bomLine.deleteMany({ where: { kitId: kit.id } });
        await prisma.bomLine.createMany({ data: rows.map((r, i) => ({ kitId: kit!.id, componentVariantId: bySku.get(r.componentSku)!.id, componentInventoryItemId: bySku.get(r.componentSku)!.inventoryItemId, qtyPerKit: r.qty, wasteBps: Math.round(r.wastePct * 100), sort: i })) });
      }
      return ok(`Imported ${grouped.size} kits (${created} new). ${report.unmatched.length} unmatched rows were skipped.`, { data: report });
    }
    case "undo":
    case "undo-compensate": {
      const r = await undoFromUi({ shopId, domain: ctx.shop, admin: ctx.admin!, appUrl }, get("batchId"), intent === "undo-compensate");
      return r.ok ? ok(r.message) : fail(r.message);
    }
    case "dismiss-cost-change":
      await prisma.costChange.updateMany({ where: { id: get("id"), shopId }, data: { dismissed: true } });
      return ok("Dismissed.");
    case "resync": {
      const { enqueue } = await import("./jobs.server");
      await enqueue(ctx.shop, "reconcile", {}, { dedupeKey: `manual:${Date.now()}` });
      return ok("Resync queued. Corrections will show in the ledger as reconciliation.");
    }
    case "save-component": {
      const variantId = get("variantId");
      const data = {
        supplierName: get("supplierName") || null, supplierSku: get("supplierSku") || null,
        packSize: Number(get("packSize")) || null, leadTimeDays: Number(get("leadTimeDays")) || null,
        reorderPointOverride: get("reorderPoint") === "" ? null : Number(get("reorderPoint")),
      };
      await prisma.componentMeta.upsert({ where: { shopId_variantId: { shopId, variantId } }, update: data, create: { shopId, variantId, ...data } });
      return ok("Component saved.");
    }
    case "create-pos": {
      if (!planAllows(snap.plan, "replenishment")) return fail("Purchase orders are part of Kit Desk Pro.");
      const items = JSON.parse(get("items") || "[]") as Array<{ variantId: string; supplierName: string; qty: number; costCents: number }>;
      const bySupplier = new Map<string, typeof items>();
      for (const i of items) bySupplier.set(i.supplierName, [...(bySupplier.get(i.supplierName) ?? []), i]);
      let last = (await prisma.purchaseOrder.aggregate({ where: { shopId }, _max: { number: true } }))._max.number ?? 0;
      for (const [supplierName, rows] of bySupplier)
        await prisma.purchaseOrder.create({ data: { shopId, number: ++last, supplierName, lines: { create: rows.map((r) => ({ variantId: r.variantId, qtyOrdered: r.qty, unitCostCents: r.costCents })) } } });
      return ok(`${bySupplier.size} draft purchase order${bySupplier.size === 1 ? "" : "s"} created.`, { redirectTo: "/app/replenish#orders" });
    }
    case "po-status": {
      const po = await prisma.purchaseOrder.findFirst({ where: { id: get("poId"), shopId } });
      const to = get("to") as PoStatus;
      if (!po || !canTransition(po.status, to)) return fail("That status change is not allowed.");
      await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: to } });
      return ok(`PO #${po.number} is now ${to.replace("_", " ")}.`);
    }
    case "po-receive": {
      if (!planAllows(snap.plan, "replenishment")) return fail("Purchase orders are part of Kit Desk Pro.");
      const po = await prisma.purchaseOrder.findFirst({ where: { id: get("poId"), shopId }, include: { lines: true } });
      if (!po || (po.status !== "sent" && po.status !== "partially_received")) return fail("Only sent orders can be received.");
      const locationId = get("locationId") || primaryLocationId(snap);
      const recv = JSON.parse(get("received") || "{}") as Record<string, number>;
      const totalUnits = po.lines.reduce((a, l) => a + Math.max(0, Math.min(l.qtyOrdered - l.qtyReceived, Number(recv[l.id] ?? 0))), 0);
      if (!totalUnits) return fail("Enter a quantity received.");
      const gateway = await gatewayFor(po.lines.map((l) => l.variantId));
      const reqs = po.lines.map((l) => ({ variantId: l.variantId, sku: snap.variants[l.variantId]?.sku ?? null, locationId, delta: Math.max(0, Math.min(l.qtyOrdered - l.qtyReceived, Number(recv[l.id] ?? 0))) }));
      const res = await applyAdjustments({ gateway, store: new PrismaLedgerStore(shopId), paused: shop.syncPaused }, reqs, { type: "po_receipt", ref: `PO #${po.number}` });
      const appliedKeys = new Set(res.entries.filter((e) => e.status === "applied").map((e) => e.variantId));
      for (const l of po.lines) {
        const q = reqs.find((r) => r.variantId === l.variantId)!.delta;
        if (!q || !appliedKeys.has(l.variantId)) continue;
        const meta = await prisma.componentMeta.findUnique({ where: { shopId_variantId: { shopId, variantId: l.variantId } } });
        const onHand = Object.values(snap.variants[l.variantId]?.levels ?? {}).reduce((a, b) => a + b, 0);
        const freightShare = Math.round((po.freightCents * q) / totalUnits);
        const prev = meta?.avgCostCents ?? snap.variants[l.variantId]?.costCents ?? l.unitCostCents;
        const avg = weightedAverageCost(onHand, prev, q, l.unitCostCents, freightShare);
        await prisma.componentMeta.upsert({ where: { shopId_variantId: { shopId, variantId: l.variantId } }, update: { avgCostCents: avg }, create: { shopId, variantId: l.variantId, avgCostCents: avg } });
        if (avg !== prev) await prisma.costChange.create({ data: { shopId, variantId: l.variantId, oldCents: prev, newCents: avg, source: "po_receipt" } });
        if (settings.pushCostToShopify && snap.variants[l.variantId]?.inventoryItemId) await updateUnitCost(ctx.admin!, snap.variants[l.variantId].inventoryItemId!, avg).catch(() => undefined);
        await prisma.poLine.update({ where: { id: l.id }, data: { qtyReceived: { increment: q } } });
      }
      const fresh = await prisma.poLine.findMany({ where: { poId: po.id } });
      await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: statusAfterReceipt(fresh) } });
      return ok(`Received into ${res.applied} component${res.applied === 1 ? "" : "s"}. Cost averages updated.`);
    }
    case "build": {
      if (!planAllows(snap.plan, "buildMode")) return fail("Build mode is part of Kit Desk Pro.");
      const kit = snap.kits.find((k) => k.id === get("kitId"));
      if (!kit || kit.mode !== "pre_assembled") return fail("Only pre-assembled kits can be built.");
      const requested = Math.floor(Number(get("qty")));
      if (!(requested > 0)) return fail("Enter how many kits to build.");
      const locationId = get("locationId") || primaryLocationId(snap);
      const leaves = Object.fromEntries([...explodeBom(kit, indexKits(snap.kits)).leaves].map(([k, v]) => [k, v]));
      const plan = planBuild(requested, leaves, (v) => snap.variants[v]?.levels[locationId] ?? 0);
      if (plan.buildable <= 0) return fail("Components do not cover even one kit at this location.");
      if (plan.partial && get("confirmPartial") !== "1") return { ok: false, message: `Components only cover ${plan.buildable} of ${requested}. Confirm to build ${plan.buildable}.`, data: { partial: plan.buildable } };
      const gateway = await gatewayFor([...Object.keys(leaves), kit.variantId]);
      const reqs = [...plan.consume.map((c) => ({ variantId: c.variantId, sku: snap.variants[c.variantId]?.sku ?? null, locationId, delta: -c.units })), { variantId: kit.variantId, sku: snap.variants[kit.variantId]?.sku ?? null, locationId, delta: plan.buildable }];
      const res = await applyAdjustments({ gateway, store: new PrismaLedgerStore(shopId), paused: shop.syncPaused }, reqs, { type: "build", ref: `Build ${plan.buildable} x ${kit.title}` });
      return res.skipped ? fail("Some rows were skipped, see the ledger. Undo the batch if it was partial.") : ok(`Built ${plan.buildable} kits. You can undo this batch from the ledger.`);
    }
    default:
      return fail(`Unknown action ${intent}`);
  }
}

/* ---------- demo mode: in-memory mutations for the flows a reviewer is most likely to click ---------- */
import { MemoryGateway, MemoryLedgerStore, undoBatch, newId } from "../core/ledger";

function demoAction(ctx: AppContext, intent: string, f: FormData): ActionResult {
  const snap = ctx.snapshot;
  const get = (k: string) => String(f.get(k) ?? "");
  switch (intent) {
    case "enable-sync":
      if (snap.variants && Object.values(snap.variants).some((v, i, a) => v.sku && a.findIndex((x) => x.sku === v.sku) !== i && snap.kits.some((k) => k.lines.some((l) => l.componentVariantId === v.id))))
        return fail("Duplicate SKUs touch your kits. Resolve them in Shopify, or exclude those kits, before enabling sync.");
      snap.syncEnabled = true; return ok("Live sync is on (demo). Every adjustment will appear in the ledger.");
    case "disable-sync": snap.syncEnabled = false; return ok("Sync turned off.");
    case "pause-all": snap.syncPaused = true; return ok("All sync paused.");
    case "resume-all": snap.syncPaused = false; return ok("Sync resumed.");
    case "exclude-variant": snap.settings.excludedVariantIds.push(get("variantId")); return ok("Excluded from sync.");
    case "save-settings":
      Object.assign(snap.settings, { targetMarginPct: Number(get("targetPct")) || 40, alertMarginPct: Number(get("alertPct")) || 15, coverDays: Number(get("coverDays")) || 30, laborRateCents: Math.round(Number(get("laborRate")) * 100), landedUpliftBps: Math.round(Number(get("upliftPct")) * 100) });
      return ok("Settings saved (demo memory).");
    case "save-kit": {
      const kit = snap.kits.find((k) => k.id === get("kitId"));
      if (!kit) return fail("Kit not found.");
      const lines = parseLines(get("lines"));
      for (const l of lines.filter((x) => x.componentKitId)) {
        const hypo = snap.kits.map((k) => (k.id === kit.id ? { ...k, lines: [] } : k));
        const v = validateNesting(indexKits(hypo), kit.id, l.componentKitId!);
        if (!v.ok) return fail(v.reason);
      }
      kit.lines = lines.map((l) => ({ componentVariantId: l.componentVariantId, componentKitId: l.componentKitId, qtyPerKit: l.qty, wasteBps: Math.round(l.wastePct * 100), uom: l.uom }));
      kit.mode = get("mode") === "pre_assembled" ? "pre_assembled" : "assemble_on_order";
      kit.packagingCostCents = Math.round(Number(get("packaging")) * 100) || 0;
      kit.laborMinutes = Number(get("laborMinutes")) || 0;
      if (get("upliftPct") !== "") kit.landedUpliftBps = Math.round(Number(get("upliftPct")) * 100);
      return ok("Kit saved (demo memory).");
    }
    case "create-kit": {
      const v = snap.variants[get("variantId")];
      if (!v) return fail("Pick a product variant first.");
      const q = canCreateKit(snap.plan, snap.kits.length); if (!q.allowed) return fail(q.reason!);
      const id = newId("k");
      snap.kits.push({ id, title: `${v.productTitle}${v.variantTitle !== "Default Title" ? " / " + v.variantTitle : ""}`, variantId: v.id, mode: "assemble_on_order", lines: [], packagingCostCents: 0, laborMinutes: 0, laborRateCents: snap.settings.laborRateCents, landedUpliftBps: snap.settings.landedUpliftBps, manageAvailability: false });
      return ok("Kit created.", { redirectTo: `/app/kits/${id}` });
    }
    case "undo":
    case "undo-compensate": {
      const batch = snap.ledger.find((b) => b.id === get("batchId"));
      if (!batch) return fail("Batch not found.");
      if (batch.undone) return fail("This batch was already undone.");
      // Re-run the real undo logic against an in-memory gateway seeded with the batch's afterQty.
      const gateway = new MemoryGateway(); const store = new MemoryLedgerStore();
      for (const e of batch.entries) gateway.set(e.variantId, e.locationId, e.afterQty ?? 0);
      void store.createBatch({ id: batch.id, sourceType: batch.sourceType as never, sourceRef: batch.sourceRef, status: "applied", undoneByBatchId: null });
      void store.addEntries(batch.entries.map((e, i) => ({ id: `e${i}`, batchId: batch.id, sourceType: batch.sourceType as never, sourceRef: batch.sourceRef, variantId: e.variantId, sku: e.sku, locationId: e.locationId, delta: e.delta, beforeQty: e.beforeQty, afterQty: e.afterQty, status: "applied", locationAssumed: e.locationAssumed })));
      void undoBatch({ gateway, store }, batch.id, { allowCompensating: intent === "undo-compensate" });
      batch.undone = true;
      for (const e of batch.entries) { const v = snap.variants[e.variantId]; if (v) v.levels[e.locationId] = (v.levels[e.locationId] ?? 0) - e.delta; }
      snap.ledger.unshift({ id: newId("b"), sourceType: "undo", sourceRef: `Undo of ${batch.sourceRef}`, at: new Date().toISOString(), status: "applied", undone: false, entries: batch.entries.map((e) => ({ ...e, delta: -e.delta, beforeQty: e.afterQty, afterQty: e.beforeQty })) });
      return ok("Batch reversed (demo).");
    }
    case "dismiss-cost-change": snap.costChanges = snap.costChanges.filter((c) => c.id !== get("id")); return ok("Dismissed.");
    default: return fail("This action needs a connected Shopify store. Demo mode covers sync toggles, kit editing, undo and settings.");
  }
}

export { PLANS, toMicro };
