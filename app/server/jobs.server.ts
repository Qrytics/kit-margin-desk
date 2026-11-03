import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { applyAdjustments } from "../core/ledger";
import { deriveAvailability, indexKits } from "../core/bom";
import { PLANS, planAllows, type PlanKey } from "../core/plans";
import { eventKey } from "../core/sync";
import { PrismaLedgerStore, loadKits, settingsOf } from "./repo.server";
import { ShopifyInventoryGateway, fetchLocations, fetchVariants, setKitQuantity } from "./shopify-api";
import { handleBulkJob } from "./bulk.server";
import { runDigest } from "./digest.server";
import { hash, processFulfillmentEvent, processOrderEvent, processRefundEvent } from "./sync.server";

export type JobKind = "order" | "refund" | "fulfillment" | "product" | "inventory" | "recompute" | "reconcile" | "digest" | "bulk_finish" | "bulk_poll";

/** Webhook handlers call this and return 200 immediately. dedupeKey = webhook id, so Shopify retries collapse. */
export async function enqueue(shopDomain: string, kind: JobKind, payload: unknown, opts: { dedupeKey?: string; delaySeconds?: number } = {}) {
  const shop = await prisma.shop.upsert({ where: { domain: shopDomain }, update: {}, create: { domain: shopDomain } });
  try {
    await prisma.job.create({
      data: { shopId: shop.id, kind, payload: payload as object, dedupeKey: opts.dedupeKey ?? null, runAt: new Date(Date.now() + (opts.delaySeconds ?? 0) * 1000) },
    });
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e; // duplicate delivery: already queued
  }
}

const MAX_ATTEMPTS = 6;

/** Claim the next due job with SKIP LOCKED semantics so several workers can run. */
async function claim() {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "Job" SET "lockedAt" = now(), "attempts" = "attempts" + 1
    WHERE id = (SELECT id FROM "Job" WHERE "doneAt" IS NULL AND "runAt" <= now() AND ("lockedAt" IS NULL OR "lockedAt" < now() - interval '5 minutes') AND "attempts" < ${MAX_ATTEMPTS}
                ORDER BY "runAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id`;
  return rows[0] ? prisma.job.findUnique({ where: { id: rows[0].id }, include: { shop: true } }) : null;
}

export async function runNextJob(): Promise<boolean> {
  const job = await claim();
  if (!job) return false;
  try {
    await handle(job.shop.domain, job.shopId, job.kind as JobKind, job.payload as never, job.dedupeKey);
    await prisma.job.update({ where: { id: job.id }, data: { doneAt: new Date(), lockedAt: null, lastError: null } });
  } catch (e) {
    const backoff = Math.min(3600, 2 ** job.attempts * 10);
    await prisma.job.update({ where: { id: job.id }, data: { lockedAt: null, lastError: String((e as Error).message).slice(0, 500), runAt: new Date(Date.now() + backoff * 1000) } });
  }
  return true;
}

async function handle(domain: string, shopId: string, kind: JobKind, payload: Record<string, any>, dedupe: string | null) {
  const { admin } = await unauthenticated.admin(domain);
  const ctx = { shopId, domain, admin, appUrl: process.env.SHOPIFY_APP_URL ?? "" };
  switch (kind) {
    case "order": {
      // Spec key: shop + order id + event + updated_at + line ids/qtys. Convergent planner makes replays harmless anyway.
      const key = eventKey([payload.topic, payload.body.id, payload.body.updated_at ?? "", hash(payload.body.line_items?.map((l: any) => [l.id, l.quantity, l.fulfillable_quantity]))]);
      if (await seen(shopId, key)) return;
      await processOrderEvent(ctx, payload.topic, payload.body);
      await mark(shopId, key, payload.topic, String(payload.body.id));
      await scheduleRecompute(domain);
      return;
    }
    case "refund": {
      const key = eventKey(["refunds/create", payload.body.id]);
      if (await seen(shopId, key)) return;
      await processRefundEvent(ctx, payload.body);
      await mark(shopId, key, "refunds/create", String(payload.body.id));
      await scheduleRecompute(domain);
      return;
    }
    case "fulfillment": {
      const key = eventKey(["fulfillments/create", payload.body.id]);
      if (await seen(shopId, key)) return;
      await processFulfillmentEvent(ctx, payload.body);
      await mark(shopId, key, "fulfillments/create", String(payload.body.id));
      return;
    }
    case "product": return handleProduct(ctx, payload.topic, payload.body);
    case "inventory": return scheduleRecompute(domain, 20);
    case "recompute": return recomputeAvailability(ctx);
    case "reconcile": return reconcile(ctx);
    case "digest": return runDigest(ctx);
    case "bulk_finish":
    case "bulk_poll": return handleBulkJob(ctx, kind, payload as never);
  }
  void dedupe;
}

const seen = async (shopId: string, key: string) => !!(await prisma.processedEvent.findUnique({ where: { shopId_idempotencyKey: { shopId, idempotencyKey: key } } }));
const mark = async (shopId: string, key: string, topic: string, entityId: string) => {
  await prisma.processedEvent.upsert({ where: { shopId_idempotencyKey: { shopId, idempotencyKey: key } }, update: {}, create: { shopId, idempotencyKey: key, topic, entityId } });
};

/** Debounced per shop: one recompute job per 20s window regardless of how many inventory events arrive. */
export async function scheduleRecompute(domain: string, delaySeconds = 5) {
  const bucket = Math.floor(Date.now() / (delaySeconds * 1000));
  await enqueue(domain, "recompute", {}, { dedupeKey: `recompute:${bucket}`, delaySeconds });
}

type Ctx = Parameters<typeof processOrderEvent>[0];

/** products/update + products/delete: flag broken BOM lines and detect Shopify cost changes. */
async function handleProduct(ctx: Ctx, topic: string, body: { id: number; variants?: Array<{ id: number; inventory_item_id?: number }> }) {
  const productGid = `gid://shopify/Product/${body.id}`;
  if (topic === "products/delete") {
    const kits = await prisma.kit.findMany({ where: { shopId: ctx.shopId, shopifyProductId: productGid } });
    await prisma.bomLine.updateMany({ where: { kit: { shopId: ctx.shopId }, componentKitId: { in: kits.map((k) => k.id) } }, data: { broken: true } });
    await prisma.kit.updateMany({ where: { shopId: ctx.shopId, shopifyProductId: productGid }, data: { active: false } });
    const lines = await prisma.bomLine.findMany({ where: { kit: { shopId: ctx.shopId }, componentVariantId: { not: null } } });
    const gone = (body.variants ?? []).map((v) => `gid://shopify/ProductVariant/${v.id}`);
    await prisma.bomLine.updateMany({ where: { id: { in: lines.filter((l) => gone.includes(l.componentVariantId!)).map((l) => l.id) } }, data: { broken: true } });
    return scheduleRecompute(ctx.domain);
  }
  const ids = (body.variants ?? []).map((v) => `gid://shopify/ProductVariant/${v.id}`);
  const info = await fetchVariants(ctx.admin, ids);
  for (const id of ids) {
    const cost = info[id]?.costCents;
    if (cost == null) continue;
    const meta = await prisma.componentMeta.findUnique({ where: { shopId_variantId: { shopId: ctx.shopId, variantId: id } } });
    if (meta?.lastKnownCostCents != null && meta.lastKnownCostCents !== cost) {
      await prisma.costChange.create({ data: { shopId: ctx.shopId, variantId: id, oldCents: meta.lastKnownCostCents, newCents: cost, source: "shopify" } });
    }
    await prisma.componentMeta.upsert({
      where: { shopId_variantId: { shopId: ctx.shopId, variantId: id } }, update: { lastKnownCostCents: cost }, create: { shopId: ctx.shopId, variantId: id, lastKnownCostCents: cost },
    });
  }
}

/** Derived availability of app-managed assemble-on-order kits, written with compare-and-swap. */
export async function recomputeAvailability(ctx: Ctx, reason: "recompute" | "reconciliation" = "recompute") {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: ctx.shopId } });
  if (!shop.syncEnabled || shop.syncPaused) return { corrected: 0 };
  const settings = settingsOf(shop);
  const kits = await loadKits(ctx.shopId, settings);
  const managed = kits.filter((k) => k.manageAvailability && k.mode === "assemble_on_order");
  if (!managed.length) return { corrected: 0 };
  const idx = indexKits(managed.concat(kits.filter((k) => !k.manageAvailability)));
  const ids = new Set<string>();
  for (const k of kits) { ids.add(k.variantId); k.lines.forEach((l) => l.componentVariantId && ids.add(l.componentVariantId)); }
  const variants = await fetchVariants(ctx.admin, [...ids]);
  const locs = await fetchLocations(ctx.admin);
  const loc = settings.defaultLocationId ?? locs[0]?.id;
  if (!loc) return { corrected: 0 };
  let corrected = 0;
  const store = new PrismaLedgerStore(ctx.shopId);
  const gateway = new ShopifyInventoryGateway(ctx.admin, (v) => variants[v]?.inventoryItemId ?? null, ctx.appUrl);
  void gateway; void store;
  for (const k of managed) {
    const av = deriveAvailability(k, idx, (id) => { const c = variants[id]; return c ? { variantId: id, exists: c.exists, available: c.levels[loc] ?? 0, tracked: c.tracked, continueSelling: c.continueSelling, costCents: c.costCents } : undefined; });
    const item = variants[k.variantId]?.inventoryItemId;
    if (av.available === null || !item) continue;
    const current = variants[k.variantId].levels[loc] ?? 0;
    if (current === av.available) continue;
    const r = await setKitQuantity(ctx.admin, item, loc, av.available, async () => (await fetchVariants(ctx.admin, [k.variantId]))[k.variantId]?.levels[loc] ?? 0);
    // Derived-quantity writes are ledgered too (completeness by construction), via the same helper in "paused" bookkeeping mode.
    await applyAdjustments(
      { gateway: { adjust: async (c) => c.map(() => ({ ok: r.ok, before: current, after: av.available!, skipReason: r.message })), getLevel: async () => av.available }, store },
      [{ variantId: k.variantId, sku: variants[k.variantId].sku, locationId: loc, delta: av.available - current, note: `Derived availability set to ${av.available}` }],
      { type: reason === "reconciliation" ? "reconciliation" : "manual", ref: reason === "reconciliation" ? "Nightly reconciliation" : "Availability recompute" },
    );
    if (r.ok) corrected++;
  }
  return { corrected };
}

export async function reconcile(ctx: Ctx) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: ctx.shopId } });
  if (!planAllows((shop.plan in PLANS ? shop.plan : "free") as PlanKey, "reconciliation") && shop.plan !== "free") return;
  return recomputeAvailability(ctx, "reconciliation");
}

/** Nightly: enqueue a reconcile for every active shop on a plan that includes it. */
export async function enqueueNightlyReconciliation() {
  const shops = await prisma.shop.findMany({ where: { uninstalledAt: null, syncEnabled: true, syncPaused: false, plan: { in: ["kit_desk_pro", "plus"] } } });
  const day = new Date().toISOString().slice(0, 10);
  for (const s of shops) await enqueue(s.domain, "reconcile", {}, { dedupeKey: `reconcile:${day}` });
}
