/**
 * Shopify bulk operation boundary + Prisma catalog store. UNVERIFIED against a live store:
 * mutation and field names follow the 2026-04 docs (bulkOperationRunQuery, currentBulkOperation, node(id) on BulkOperation).
 */
import prisma from "../db.server";
import type { GraphqlClient } from "./shopify-api";
import type { BulkGateway, BulkOperationInfo, BulkStatus, CatalogStore } from "../core/bulk";
import { LineSplitter, finishCatalogScan, startCatalogScan } from "../core/bulk";
import type { VariantInfo } from "../core/types";

async function gql<T>(admin: GraphqlClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, { variables });
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data as T;
}

const OP_FIELDS = "id status errorCode objectCount url partialDataUrl";
type RawOp = { id: string; status: BulkStatus; errorCode: string | null; objectCount: string | number; url: string | null; partialDataUrl: string | null };
const mapOp = (o: RawOp): BulkOperationInfo => ({ ...o, objectCount: Number(o.objectCount) });

export class ShopifyBulkGateway implements BulkGateway {
  constructor(private admin: GraphqlClient) {}

  async start(query: string) {
    const data = await gql<{ bulkOperationRunQuery: { bulkOperation: { id: string } | null; userErrors: Array<{ message: string }> } }>(
      this.admin,
      `mutation Run($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { field message } } }`,
      { q: query },
    );
    const r = data.bulkOperationRunQuery;
    if (r.userErrors.length || !r.bulkOperation) return { error: r.userErrors[0]?.message ?? "Shopify did not start the bulk operation." };
    return { id: r.bulkOperation.id };
  }

  async status(id?: string) {
    if (id) {
      const d = await gql<{ node: RawOp | null }>(this.admin, `query Op($id: ID!) { node(id: $id) { ... on BulkOperation { ${OP_FIELDS} } } }`, { id });
      return d.node?.id ? mapOp(d.node) : null;
    }
    const d = await gql<{ currentBulkOperation: RawOp | null }>(this.admin, `query { currentBulkOperation(type: QUERY) { ${OP_FIELDS} } }`);
    return d.currentBulkOperation ? mapOp(d.currentBulkOperation) : null;
  }

  /** The result URL is a signed download link: no auth header, streamed and split into lines. */
  async *lines(url: string) {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Bulk result download failed (${res.status}).`);
    const sp = new LineSplitter();
    const dec = new TextDecoder();
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* sp.push(dec.decode(value, { stream: true }));
    }
    yield* sp.flush();
  }
}

export class PrismaCatalogStore implements CatalogStore {
  constructor(private shopId: string) {}
  async latest() {
    const s = await prisma.catalogScan.findFirst({ where: { shopId: this.shopId }, orderBy: { startedAt: "desc" } });
    return s ? { operationId: s.operationId, status: s.status as "running" | "completed" | "failed", variantCount: s.variantCount, finishedAt: s.finishedAt, error: s.error } : null;
  }
  async begin(operationId: string) {
    await prisma.catalogScan.upsert({ where: { operationId }, update: {}, create: { shopId: this.shopId, operationId } });
  }
  async fail(operationId: string, error: string) {
    await prisma.catalogScan.updateMany({ where: { shopId: this.shopId, operationId }, data: { status: "failed", error: error.slice(0, 300), finishedAt: new Date() } });
  }
  async complete(operationId: string, variants: VariantInfo[]) {
    await prisma.$transaction(async (tx) => {
      await tx.catalogVariant.deleteMany({ where: { shopId: this.shopId } });
      for (let i = 0; i < variants.length; i += 1000) {
        await tx.catalogVariant.createMany({
          data: variants.slice(i, i + 1000).map((v) => ({ shopId: this.shopId, variantId: v.id, sku: v.sku, data: v as unknown as object })),
        });
      }
      await tx.catalogScan.updateMany({ where: { shopId: this.shopId, operationId }, data: { status: "completed", variantCount: variants.length, error: null, finishedAt: new Date() } });
    }, { timeout: 120_000, maxWait: 10_000 });
  }
  async load() {
    const rows = await prisma.catalogVariant.findMany({ where: { shopId: this.shopId }, select: { data: true } });
    return rows.map((r) => r.data as unknown as VariantInfo);
  }
}

/** Start a scan and schedule the polling fallback; the bulk_operations/finish webhook normally lands first. */
export async function requestCatalogScan(admin: GraphqlClient, shopId: string, domain: string) {
  const { enqueue } = await import("./jobs.server");
  const r = await startCatalogScan(new ShopifyBulkGateway(admin), new PrismaCatalogStore(shopId));
  if (r.started) await enqueue(domain, "bulk_poll", { operationId: r.operationId, n: 0 }, { dedupeKey: `bulk_poll:${r.operationId}:0`, delaySeconds: 15 });
  return r;
}

/** Job handler for both bulk_finish (webhook) and bulk_poll (fallback). Re-enqueues itself while the operation runs. */
export async function handleBulkJob(ctx: { shopId: string; domain: string; admin: GraphqlClient }, kind: "bulk_finish" | "bulk_poll", payload: { operationId: string; n?: number }) {
  const r = await finishCatalogScan(new ShopifyBulkGateway(ctx.admin), new PrismaCatalogStore(ctx.shopId), payload.operationId);
  if (r.done || r.terminal || kind === "bulk_finish") return;
  const n = (payload.n ?? 0) + 1;
  if (n > 240) return new PrismaCatalogStore(ctx.shopId).fail(payload.operationId, "Gave up polling after an hour.");
  const { enqueue } = await import("./jobs.server");
  await enqueue(ctx.domain, "bulk_poll", { operationId: payload.operationId, n }, { dedupeKey: `bulk_poll:${payload.operationId}:${n}`, delaySeconds: Math.min(60, 15 + n * 5) });
}

/**
 * Catalog for the health check, enable-sync and CSV import. Prefers the last completed bulk scan;
 * otherwise falls back to the capped synchronous walk and says whether the result is partial.
 */
export async function catalogFor(admin: GraphqlClient, shopId: string, sync: (admin: GraphqlClient) => Promise<{ variants: VariantInfo[]; truncated: boolean }>) {
  const store = new PrismaCatalogStore(shopId);
  const latest = await store.latest();
  const completed = latest?.status === "completed" ? latest : null;
  if (completed) return { variants: await store.load(), truncated: false, source: "bulk" as const, scanning: latest?.status === "running", finishedAt: completed.finishedAt };
  const quick = await sync(admin);
  return { ...quick, source: "quick" as const, scanning: latest?.status === "running", finishedAt: null as Date | null };
}
