import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import type { LedgerEntryRow, LedgerStore, BatchRow } from "../core/ledger";
import { DEFAULT_SETTINGS, type KitRecord, type Settings, type Snapshot } from "../core/types";
import { PLANS, type PlanKey } from "../core/plans";
import { fetchLocations, fetchRecentOrders, fetchVariants, type GraphqlClient } from "./shopify-api";
import { explodeBom, indexKits } from "../core/bom";

export const num = (d: unknown): number => Number(d as never);

export async function ensureShop(domain: string) {
  return prisma.shop.upsert({ where: { domain }, update: { uninstalledAt: null }, create: { domain } });
}

export const settingsOf = (shop: { settings: Prisma.JsonValue }): Settings => ({ ...DEFAULT_SETTINGS, ...((shop.settings as object) ?? {}) });

type KitWithLines = Prisma.KitGetPayload<{ include: { lines: true } }>;

export function toKitRecord(k: KitWithLines, s: Settings, titles: Record<string, string> = {}): KitRecord {
  return {
    id: k.id, title: titles[k.shopifyVariantId] ?? k.shopifyVariantId, variantId: k.shopifyVariantId, mode: k.mode,
    manageAvailability: k.manageAvailability, packagingCostCents: k.packagingCostCents, laborMinutes: num(k.laborMinutes),
    laborRateCents: k.laborRateCents ?? s.laborRateCents, landedUpliftBps: k.landedUpliftBps ?? s.landedUpliftBps,
    lines: k.lines.sort((a, b) => a.sort - b.sort).map((l) => ({
      id: l.id, componentVariantId: l.componentVariantId, componentKitId: l.componentKitId, qtyPerKit: num(l.qtyPerKit),
      wasteBps: l.wasteBps, uom: l.uomLabel, broken: l.broken,
    })),
  };
}

export async function loadKits(shopId: string, s: Settings, titles: Record<string, string> = {}): Promise<KitRecord[]> {
  const rows = await prisma.kit.findMany({ where: { shopId, active: true }, include: { lines: true }, orderBy: { createdAt: "asc" } });
  return rows.map((k) => toKitRecord(k, s, titles));
}

export class PrismaLedgerStore implements LedgerStore {
  constructor(private shopId: string) {}
  async createBatch(b: BatchRow) {
    await prisma.ledgerBatch.create({ data: { id: b.id, shopId: this.shopId, sourceType: b.sourceType, sourceRef: b.sourceRef, status: b.status, note: b.note ?? null } });
  }
  async addEntries(rows: LedgerEntryRow[]) {
    if (!rows.length) return;
    await prisma.ledgerEntry.createMany({
      data: rows.map((r) => ({
        id: r.id, shopId: this.shopId, batchId: r.batchId, sourceType: r.sourceType, sourceRef: r.sourceRef, variantId: r.variantId, sku: r.sku ?? null,
        locationId: r.locationId, delta: r.delta, beforeQty: r.beforeQty, afterQty: r.afterQty, status: r.status, locationAssumed: r.locationAssumed,
        lineKey: r.lineKey ?? null, note: r.note ?? null,
      })),
    });
    const applied = rows.some((r) => r.status === "applied");
    await prisma.ledgerBatch.update({ where: { id: rows[0].batchId }, data: { status: applied ? "applied" : "skipped" } });
  }
  async getBatch(id: string) {
    const b = await prisma.ledgerBatch.findFirst({ where: { id, shopId: this.shopId }, include: { entries: true } });
    if (!b) return null;
    return {
      batch: { id: b.id, sourceType: b.sourceType, sourceRef: b.sourceRef, status: b.status, undoneByBatchId: b.undoneByBatchId, note: b.note },
      entries: b.entries.map((e) => ({ ...e, sourceType: e.sourceType, status: e.status })) as LedgerEntryRow[],
    };
  }
  async markUndone(batchId: string, undoBatchId: string) {
    await prisma.ledgerBatch.update({ where: { id: batchId }, data: { undoneByBatchId: undoBatchId } });
    // Freeze order lines touched by this batch so later webhooks never silently re-apply what the merchant undid.
    const keys = (await prisma.ledgerEntry.findMany({ where: { batchId, lineKey: { not: null } }, select: { lineKey: true } })).map((e) => e.lineKey!);
    for (const k of new Set(keys)) {
      const [orderId, lineId] = k.split("|");
      await prisma.orderLineState.updateMany({ where: { shopId: this.shopId, orderId, lineId }, data: { frozen: true } });
    }
  }
}

/** Real-mode snapshot: DB state plus live Shopify catalog data for referenced variants. */
export async function loadSnapshot(domain: string, admin: GraphqlClient, opts: { withOrders?: boolean } = {}): Promise<Snapshot> {
  const shop = await ensureShop(domain);
  const settings = settingsOf(shop);
  const kitsRaw = await loadKits(shop.id, settings);
  const ids = new Set<string>();
  for (const k of kitsRaw) { ids.add(k.variantId); k.lines.forEach((l) => l.componentVariantId && ids.add(l.componentVariantId)); }
  const [variants, locations] = await Promise.all([fetchVariants(admin, [...ids]), fetchLocations(admin)]);
  const kits = kitsRaw.map((k) => ({ ...k, title: variants[k.variantId] ? `${variants[k.variantId].productTitle}${variants[k.variantId].variantTitle !== "Default Title" ? " / " + variants[k.variantId].variantTitle : ""}` : "Deleted variant" }));
  // flag broken lines so availability treats them as 0 and the UI can warn
  for (const k of kits) for (const l of k.lines) if (l.componentVariantId && variants[l.componentVariantId] && !variants[l.componentVariantId].exists) l.broken = true;
  const since = new Date(Date.now() - 90 * 86_400_000);
  const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
  const [sales, meta, pos, costs, ledger, kitOrders, recentOrders] = await Promise.all([
    prisma.saleLine.findMany({ where: { shopId: shop.id, soldAt: { gte: since } } }),
    prisma.componentMeta.findMany({ where: { shopId: shop.id } }),
    prisma.purchaseOrder.findMany({ where: { shopId: shop.id }, include: { lines: true }, orderBy: { number: "desc" } }),
    prisma.costChange.findMany({ where: { shopId: shop.id, dismissed: false }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.ledgerBatch.findMany({ where: { shopId: shop.id }, include: { entries: true }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.orderLineState.count({ where: { shopId: shop.id, updatedAt: { gte: month } } }),
    opts.withOrders ? fetchRecentOrders(admin, 50).catch(() => []) : Promise.resolve([]),
  ]);
  return {
    shopDomain: domain, plan: (shop.plan as PlanKey) in PLANS ? (shop.plan as PlanKey) : "free", syncEnabled: shop.syncEnabled, syncPaused: shop.syncPaused, demo: false,
    settings, locations, variants, kits,
    sales: sales.map((s) => ({ variantId: s.variantId, qty: s.qty, refundedQty: s.refundedQty, unitPriceCents: s.unitPriceCents, soldAt: s.soldAt.toISOString() })),
    meta: meta.map((m) => ({ variantId: m.variantId, supplierName: m.supplierName, supplierSku: m.supplierSku, packSize: m.packSize, leadTimeDays: m.leadTimeDays, reorderPointOverride: m.reorderPointOverride, avgCostCents: m.avgCostCents })),
    pos: pos.map((p) => ({ id: p.id, number: p.number, supplierName: p.supplierName, status: p.status, freightCents: p.freightCents, lines: p.lines })),
    costChanges: costs.map((c) => ({ id: c.id, variantId: c.variantId, oldCents: c.oldCents, newCents: c.newCents, at: c.createdAt.toISOString() })),
    ledger: ledger.map((b) => ({
      id: b.id, sourceType: b.sourceType, sourceRef: b.sourceRef, at: b.createdAt.toISOString(), status: b.status, undone: !!b.undoneByBatchId,
      entries: b.entries.map((e) => ({ sku: e.sku, variantId: e.variantId, locationId: e.locationId, delta: e.delta, beforeQty: e.beforeQty, afterQty: e.afterQty, status: e.status, locationAssumed: e.locationAssumed, note: e.note })),
    })),
    recentOrders, kitOrdersThisMonth: kitOrders,
  };
}

export { explodeBom, indexKits };
