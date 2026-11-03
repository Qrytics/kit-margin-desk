import { createHash } from "node:crypto";
import prisma from "../db.server";
import { applyAdjustments, undoBatch, type AdjustRequest, type InventoryGateway } from "../core/ledger";
import { explodeBom, indexKits, type KitDef } from "../core/bom";
import { PLANS, withinOrderQuota, type PlanKey } from "../core/plans";
import { emptyLine, mergeDeltas, planLine, resolveLocation, type LineEvent, type LineState } from "../core/sync";
import { PrismaLedgerStore, loadKits, settingsOf } from "./repo.server";
import { ShopifyInventoryGateway, fetchLocations, fetchVariants, type GraphqlClient } from "./shopify-api";

const gid = (type: string, id: string | number) => `gid://shopify/${type}/${id}`;
export const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

/** Claim an idempotency key. Returns false when this exact event was already processed. */
export async function claimEvent(shopId: string, key: string, topic: string, entityId: string, payload?: unknown): Promise<boolean> {
  try {
    await prisma.processedEvent.create({ data: { shopId, idempotencyKey: key, topic, entityId, payloadHash: payload ? hash(payload) : null } });
    return true;
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") return false;
    throw e;
  }
}

interface Ctx {
  shopId: string;
  domain: string;
  admin: GraphqlClient;
  appUrl: string;
}

async function prepare(ctx: Ctx) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: ctx.shopId } });
  const settings = settingsOf(shop);
  const kits = await loadKits(ctx.shopId, settings);
  const idx = indexKits(kits);
  return { shop, settings, kits, idx, store: new PrismaLedgerStore(ctx.shopId) };
}

async function gatewayFor(ctx: Ctx, variantIds: string[]): Promise<{ gateway: InventoryGateway; variants: Awaited<ReturnType<typeof fetchVariants>> }> {
  const variants = await fetchVariants(ctx.admin, variantIds);
  return { variants, gateway: new ShopifyInventoryGateway(ctx.admin, (v) => variants[v]?.inventoryItemId ?? null, ctx.appUrl) };
}

interface OrderPayload {
  id: number | string;
  name?: string;
  updated_at?: string;
  created_at?: string;
  location_id?: number | null;
  line_items: Array<{ id: number | string; variant_id: number | string | null; quantity: number; fulfillable_quantity?: number; price?: string }>;
}

/** orders/create | orders/updated | orders/cancelled. Convergent: replaying never double-applies. */
export async function processOrderEvent(ctx: Ctx, topic: string, p: OrderPayload): Promise<{ applied: number; skipped: number } | "ignored"> {
  const { shop, settings, kits, idx, store } = await prepare(ctx);
  const orderId = String(p.id);
  const soldAt = new Date(p.created_at ?? Date.now());
  const byVariant = new Map<string, KitDef>(kits.filter((k) => k.mode === "assemble_on_order").map((k) => [k.variantId, k]));
  const allKits = new Map(kits.map((k) => [k.variantId, k]));

  // Sales history (for margin + burn) is always recorded, even with sync off.
  for (const li of p.line_items) {
    if (!li.variant_id) continue;
    const v = gid("ProductVariant", li.variant_id);
    if (!allKits.has(v)) continue;
    await prisma.saleLine.upsert({
      where: { shopId_orderId_lineId: { shopId: ctx.shopId, orderId, lineId: String(li.id) } },
      update: { qty: li.quantity },
      create: { shopId: ctx.shopId, orderId, lineId: String(li.id), variantId: v, qty: li.quantity, unitPriceCents: Math.round(Number(li.price ?? 0) * 100), soldAt },
    });
  }
  if (!shop.syncEnabled || shop.syncPaused) return "ignored";

  const plan = (shop.plan in PLANS ? shop.plan : "free") as PlanKey;
  const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
  const used = await prisma.orderLineState.count({ where: { shopId: ctx.shopId, updatedAt: { gte: month } } });

  const lines: Array<{ li: OrderPayload["line_items"][number]; kit: KitDef; state: LineState }> = [];
  for (const li of p.line_items) {
    if (!li.variant_id) continue;
    const kit = byVariant.get(gid("ProductVariant", li.variant_id));
    if (!kit) continue;
    const row = await prisma.orderLineState.findUnique({ where: { shopId_orderId_lineId: { shopId: ctx.shopId, orderId, lineId: String(li.id) } } });
    lines.push({ li, kit, state: row ? rowToState(row) : emptyLine() });
  }
  if (!lines.length) return "ignored";
  if (!lines.some((l) => l.state.orderedQty !== null) && !withinOrderQuota(plan, used)) {
    await applyAdjustments({ gateway: noopGateway, store, paused: true }, lines.map((l) => ({ variantId: l.kit.variantId, locationId: "n/a", delta: -l.li.quantity, note: `Plan limit of ${PLANS[plan].kitOrdersPerMonth} kit orders/month reached; not decremented` })), { type: "order", ref: p.name ?? orderId, note: "needs_review" });
    return "ignored";
  }

  const leafIds = new Set<string>();
  const planned = lines.map(({ li, kit, state }) => {
    const leaves = Object.fromEntries(explodeBom(kit, idx).leaves);
    Object.keys(leaves).forEach((v) => leafIds.add(v));
    const event: LineEvent = topic === "orders/cancelled"
      ? { type: "cancel", unfulfilledQty: li.fulfillable_quantity ?? li.quantity }
      : { type: "order", orderedQty: li.quantity };
    return { li, kit, state, plan: planLine(state, event, leaves) };
  });
  const { gateway, variants } = await gatewayFor(ctx, [...leafIds]);
  const locs = await fetchLocations(ctx.admin);
  const loc = resolveLocation({
    assignedLocationId: p.location_id ? gid("Location", p.location_id) : null,
    defaultLocationId: settings.defaultLocationId, primaryLocationId: locs.find((l) => l.primary)?.id ?? locs[0]?.id ?? "",
  });

  const reqs: AdjustRequest[] = planned.flatMap(({ li, plan: pl, state }) =>
    pl.deltas.map((d) => ({
      variantId: d.variantId, sku: variants[d.variantId]?.sku ?? null, delta: d.delta,
      locationId: state.netApplied > 0 && state.bomSnapshot ? (locOf(state, loc.locationId)) : loc.locationId,
      locationAssumed: loc.assumed, lineKey: `${orderId}|${li.id}`,
    })),
  );
  const kind = topic === "orders/cancelled" ? "cancel" : "order";
  const merged = mergeRequests(reqs);
  const res = await applyAdjustments({ gateway, store }, merged, { type: kind, ref: p.name ?? `#${orderId}` });
  if (res.entries.some((e) => e.note?.startsWith("error:"))) throw new Error("Shopify API error while adjusting; will retry");

  for (const { li, plan: pl } of planned) {
    await saveLine(ctx.shopId, orderId, String(li.id), gid("ProductVariant", li.variant_id!), pl.nextState, loc.locationId, loc.assumed, p.name);
  }
  return { applied: res.applied, skipped: res.skipped };
}

const noopGateway: InventoryGateway = { adjust: async (c) => c.map(() => ({ ok: false })), getLevel: async () => null };
const locOf = (_s: LineState, fallback: string) => fallback;

function mergeRequests(reqs: AdjustRequest[]): AdjustRequest[] {
  const m = new Map<string, AdjustRequest>();
  for (const r of reqs) {
    const k = `${r.variantId}@${r.locationId}`;
    const cur = m.get(k);
    m.set(k, cur ? { ...cur, delta: cur.delta + r.delta, lineKey: null } : { ...r });
  }
  return [...m.values()].filter((r) => r.delta !== 0);
}

type LineRow = Awaited<ReturnType<typeof prisma.orderLineState.findUniqueOrThrow>>;
const rowToState = (r: LineRow): LineState => ({
  orderedQty: r.orderedQty, refunds: r.refunds as Record<string, number>, cancelledQty: r.cancelledQty, netApplied: r.netApplied,
  bomSnapshot: r.bomSnapshot as Record<string, number>, frozen: r.frozen,
});

async function saveLine(shopId: string, orderId: string, lineId: string, kitVariantId: string, s: LineState, locationId: string | null, assumed: boolean, orderName?: string) {
  const data = { orderedQty: s.orderedQty, refunds: s.refunds, cancelledQty: s.cancelledQty, netApplied: s.netApplied, bomSnapshot: s.bomSnapshot, frozen: s.frozen };
  await prisma.orderLineState.upsert({
    where: { shopId_orderId_lineId: { shopId, orderId, lineId } },
    update: data,
    create: { shopId, orderId, lineId, kitVariantId, locationId, locationAssumed: assumed, orderName: orderName ?? null, ...data },
  });
}

interface RefundPayload {
  id: number | string;
  order_id: number | string;
  refund_line_items: Array<{ id: number | string; line_item_id: number | string; quantity: number; restock_type: string; line_item?: { variant_id?: number | null } }>;
}

/** refunds/create. Restores only restocked lines; a refund that arrives before its order is parked in line state. */
export async function processRefundEvent(ctx: Ctx, p: RefundPayload): Promise<{ applied: number; skipped: number } | "ignored"> {
  const { shop, settings, kits, idx, store } = await prepare(ctx);
  const orderId = String(p.order_id);
  const byVariant = new Map(kits.map((k) => [k.variantId, k]));
  // sales history: record returned units regardless of restock (revenue is returns-adjusted)
  for (const r of p.refund_line_items) {
    await prisma.saleLine.updateMany({ where: { shopId: ctx.shopId, orderId, lineId: String(r.line_item_id) }, data: { refundedQty: { increment: 0 } } });
  }
  if (!shop.syncEnabled || shop.syncPaused) {
    await bumpRefunds(ctx.shopId, orderId, p);
    return "ignored";
  }
  const planned: Array<{ lineId: string; kitVariantId: string; plan: ReturnType<typeof planLine>; kit: KitDef }> = [];
  for (const r of p.refund_line_items) {
    const variantId = r.line_item?.variant_id ? gid("ProductVariant", r.line_item.variant_id) : null;
    const row = await prisma.orderLineState.findUnique({ where: { shopId_orderId_lineId: { shopId: ctx.shopId, orderId, lineId: String(r.line_item_id) } } });
    const kitVariant = row?.kitVariantId ?? variantId;
    const kit = kitVariant ? byVariant.get(kitVariant) : undefined;
    if (!kit || kit.mode !== "assemble_on_order") continue;
    const leaves = Object.fromEntries(explodeBom(kit, idx).leaves);
    const event: LineEvent = { type: "refund", refundLineId: String(r.id), qty: r.quantity, restockType: r.restock_type };
    planned.push({ lineId: String(r.line_item_id), kitVariantId: kit.variantId, kit, plan: planLine(row ? rowToState(row) : emptyLine(), event, leaves) });
  }
  if (!planned.length) return "ignored";
  const { gateway, variants } = await gatewayFor(ctx, [...new Set(planned.flatMap((x) => Object.keys(x.plan.nextState.bomSnapshot)))]);
  const states = await prisma.orderLineState.findMany({ where: { shopId: ctx.shopId, orderId, lineId: { in: planned.map((x) => x.lineId) } } });
  const locs = await fetchLocations(ctx.admin);
  const fallback = settings.defaultLocationId ?? locs[0]?.id ?? "";
  const reqs = mergeRequests(planned.flatMap((x) => {
    const st = states.find((s) => s.lineId === x.lineId);
    return x.plan.deltas.map((d) => ({
      variantId: d.variantId, sku: variants[d.variantId]?.sku ?? null, delta: d.delta, locationId: st?.locationId ?? fallback,
      locationAssumed: st?.locationAssumed ?? true, lineKey: `${orderId}|${x.lineId}`,
    }));
  }));
  const res = await applyAdjustments({ gateway, store }, reqs, { type: "refund", ref: `Refund ${p.id} on order ${states[0]?.orderName ?? orderId}` });
  if (res.entries.some((e) => e.note?.startsWith("error:"))) throw new Error("Shopify API error while restoring; will retry");
  for (const x of planned) await saveLine(ctx.shopId, orderId, x.lineId, x.kitVariantId, x.plan.nextState, states.find((s) => s.lineId === x.lineId)?.locationId ?? fallback, true);
  return { applied: res.applied, skipped: res.skipped };
}

async function bumpRefunds(shopId: string, orderId: string, p: RefundPayload) {
  for (const r of p.refund_line_items) {
    await prisma.saleLine.updateMany({ where: { shopId, orderId, lineId: String(r.line_item_id) }, data: { refundedQty: r.quantity } });
  }
}

interface FulfillmentPayload { order_id: number | string; location_id?: number | null; line_items: Array<{ id: number | string }> }

/** fulfillments/create: if we assumed a location, move the adjustment to where it really shipped from. */
export async function processFulfillmentEvent(ctx: Ctx, p: FulfillmentPayload) {
  if (!p.location_id) return "ignored" as const;
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: ctx.shopId } });
  if (!shop.syncEnabled || shop.syncPaused) return "ignored" as const;
  const actual = gid("Location", p.location_id);
  const orderId = String(p.order_id);
  const rows = await prisma.orderLineState.findMany({ where: { shopId: ctx.shopId, orderId, lineId: { in: p.line_items.map((l) => String(l.id)) }, locationAssumed: true } });
  const moving = rows.filter((r) => r.locationId && r.locationId !== actual && r.netApplied > 0 && !r.frozen);
  if (!moving.length) {
    await prisma.orderLineState.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { locationAssumed: false, locationId: actual } });
    return "ignored" as const;
  }
  const { gateway, variants } = await gatewayFor(ctx, [...new Set(moving.flatMap((r) => Object.keys(r.bomSnapshot as object)))]);
  const reqs: AdjustRequest[] = [];
  for (const r of moving) for (const [v, micro] of Object.entries(r.bomSnapshot as Record<string, number>)) {
    const units = Math.round((micro * r.netApplied) / 10_000);
    if (!units) continue;
    reqs.push({ variantId: v, sku: variants[v]?.sku ?? null, delta: units, locationId: r.locationId!, note: "Location corrected at fulfillment" });
    reqs.push({ variantId: v, sku: variants[v]?.sku ?? null, delta: -units, locationId: actual, note: "Location corrected at fulfillment" });
  }
  const res = await applyAdjustments({ gateway, store: new PrismaLedgerStore(ctx.shopId) }, mergeRequests(reqs), { type: "fulfillment", ref: `Order ${orderId}` });
  await prisma.orderLineState.updateMany({ where: { id: { in: moving.map((r) => r.id) } }, data: { locationId: actual, locationAssumed: false } });
  return { applied: res.applied, skipped: res.skipped };
}

/** Merchant-initiated undo from the ledger screen. */
export async function undoFromUi(ctx: Ctx, batchId: string, allowCompensating: boolean) {
  const store = new PrismaLedgerStore(ctx.shopId);
  const found = await store.getBatch(batchId);
  const { gateway } = await gatewayFor(ctx, [...new Set(found?.entries.map((e) => e.variantId) ?? [])]);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: ctx.shopId } });
  return undoBatch({ gateway, store, paused: shop.syncPaused }, batchId, { allowCompensating });
}
