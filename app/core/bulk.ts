/**
 * Pure logic for Shopify bulk operations (bulkOperationRunQuery). No I/O: the server layer
 * supplies a BulkGateway (real GraphQL or a fake in tests) and a CatalogStore.
 * Result files are JSONL: one JSON object per line; nested connection children carry `__parentId`.
 */
import type { VariantInfo } from "./types";

export type BulkStatus = "CREATED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED" | "CANCELING" | "EXPIRED";
export const isTerminal = (s: BulkStatus): boolean => s === "COMPLETED" || s === "FAILED" || s === "CANCELED" || s === "EXPIRED";

export interface BulkOperationInfo {
  id: string;
  status: BulkStatus;
  errorCode: string | null;
  objectCount: number;
  url: string | null;
  partialDataUrl: string | null;
}

/** The query is a single string with no variables; bulk operations require that. Catalog health needs no inventory levels. */
export const CATALOG_BULK_QUERY = `{
  productVariants {
    edges { node {
      id sku title price compareAtPrice inventoryPolicy
      product { id title }
      inventoryItem { id tracked unitCost { amount } }
    } }
  }
}`;

interface RawBulkVariant {
  id: string; sku?: string | null; title?: string; price?: string; compareAtPrice?: string | null; inventoryPolicy?: string;
  product?: { id: string; title: string };
  inventoryItem?: { id: string; tracked?: boolean; unitCost?: { amount: string } | null } | null;
}

const toCents = (v: string | null | undefined): number | null => (v == null ? null : Math.round(Number(v) * 100));

/** Parse one JSONL line into a VariantInfo, or null for blank, malformed or non-variant lines. */
export function parseBulkLine(line: string): VariantInfo | null {
  const t = line.trim();
  if (!t) return null;
  let r: RawBulkVariant;
  try { r = JSON.parse(t) as RawBulkVariant; } catch { return null; }
  if (!r || typeof r.id !== "string" || !r.id.includes("/ProductVariant/")) return null;
  return {
    id: r.id, productId: r.product?.id ?? "", productTitle: r.product?.title ?? "", variantTitle: r.title ?? "", sku: r.sku || null,
    priceCents: toCents(r.price) ?? 0, compareAtCents: toCents(r.compareAtPrice), costCents: toCents(r.inventoryItem?.unitCost?.amount),
    inventoryItemId: r.inventoryItem?.id ?? null, tracked: !!r.inventoryItem?.tracked, continueSelling: r.inventoryPolicy === "CONTINUE",
    exists: true, levels: {},
  };
}

/** Parse a whole JSONL text. Returns variants and how many lines were skipped as unreadable. */
export function parseBulkJsonl(text: string): { variants: VariantInfo[]; skipped: number } {
  const variants: VariantInfo[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const v = parseBulkLine(line);
    if (v) variants.push(v); else skipped++;
  }
  return { variants, skipped };
}

/** Incremental line splitter for streamed chunks, so a 500k-variant file never sits in memory as one string. */
export class LineSplitter {
  private tail = "";
  push(chunk: string): string[] {
    const parts = (this.tail + chunk).split("\n");
    this.tail = parts.pop() ?? "";
    return parts;
  }
  flush(): string[] { const t = this.tail; this.tail = ""; return t ? [t] : []; }
}

/** Payload of the bulk_operations/finish webhook. */
export interface BulkFinishPayload { admin_graphql_api_id: string; type?: string; status: string; error_code?: string | null; completed_at?: string }

export interface BulkGateway {
  start(query: string): Promise<{ id: string } | { error: string }>;
  /** Current operation, or a specific one by id. */
  status(id?: string): Promise<BulkOperationInfo | null>;
  /** Yields the result file line by line. */
  lines(url: string): AsyncIterable<string>;
}

export interface CatalogStore {
  /** Latest scan for the shop, if any. */
  latest(): Promise<{ operationId: string; status: "running" | "completed" | "failed"; variantCount: number; finishedAt: Date | null; error: string | null } | null>;
  begin(operationId: string): Promise<void>;
  fail(operationId: string, error: string): Promise<void>;
  /** Replaces the stored catalog atomically-ish and marks the scan complete. */
  complete(operationId: string, variants: VariantInfo[]): Promise<void>;
  load(): Promise<VariantInfo[]>;
}

export type StartResult = { started: true; operationId: string } | { started: false; reason: string };

/** Start a catalog scan unless one is already running (Shopify allows one query bulk op per shop at a time). */
export async function startCatalogScan(gw: BulkGateway, store: CatalogStore): Promise<StartResult> {
  const current = await gw.status();
  if (current && !isTerminal(current.status)) return { started: false, reason: "A bulk operation is already running for this shop." };
  const res = await gw.start(CATALOG_BULK_QUERY);
  if ("error" in res) return { started: false, reason: res.error };
  await store.begin(res.id);
  return { started: true, operationId: res.id };
}

export type FinishResult = { done: true; variants: number; skipped: number } | { done: false; reason: string; terminal: boolean };

/** Called from the bulk_operations/finish job or from polling: when COMPLETED, stream the file into the store. */
export async function finishCatalogScan(gw: BulkGateway, store: CatalogStore, operationId: string): Promise<FinishResult> {
  const op = await gw.status(operationId);
  if (!op) return { done: false, reason: "Operation not found.", terminal: true };
  if (!isTerminal(op.status)) return { done: false, reason: `Still ${op.status.toLowerCase()}.`, terminal: false };
  if (op.status !== "COMPLETED") {
    const reason = `Bulk operation ${op.status.toLowerCase()}${op.errorCode ? ` (${op.errorCode})` : ""}.`;
    await store.fail(operationId, reason);
    return { done: false, reason, terminal: true };
  }
  const variants: VariantInfo[] = [];
  let skipped = 0;
  // Shopify returns url = null for an empty result set.
  if (op.url) for await (const line of gw.lines(op.url)) {
    if (!line.trim()) continue;
    const v = parseBulkLine(line);
    if (v) variants.push(v); else skipped++;
  }
  await store.complete(operationId, variants);
  return { done: true, variants: variants.length, skipped };
}

export interface PollOptions { intervalMs?: number; maxPolls?: number; sleep?: (ms: number) => Promise<void> }

/** Polling fallback for when the webhook is not delivered (dev tunnels, missed events). */
export async function pollCatalogScan(gw: BulkGateway, store: CatalogStore, operationId: string, opts: PollOptions = {}): Promise<FinishResult> {
  const { intervalMs = 3000, maxPolls = 200, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
  let last: FinishResult = { done: false, reason: "Not polled.", terminal: false };
  for (let i = 0; i < maxPolls; i++) {
    last = await finishCatalogScan(gw, store, operationId);
    if (last.done || last.terminal) return last;
    await sleep(intervalMs);
  }
  return last;
}

/** In-memory fakes, used by tests and available to demo tooling. */
export class FakeBulkGateway implements BulkGateway {
  ops = new Map<string, BulkOperationInfo>();
  files = new Map<string, string>();
  startedQueries: string[] = [];
  private seq = 0;
  /** Statuses returned by successive status() calls for the newest op, before it settles. */
  script: BulkStatus[] = ["RUNNING", "COMPLETED"];
  constructor(private resultJsonl = "", private failWith?: string) {}
  async start(query: string) {
    if (this.failWith) return { error: this.failWith };
    this.startedQueries.push(query);
    const id = `gid://shopify/BulkOperation/${++this.seq}`;
    this.ops.set(id, { id, status: "CREATED", errorCode: null, objectCount: 0, url: null, partialDataUrl: null });
    this.files.set(`https://fake/${id}.jsonl`, this.resultJsonl);
    return { id };
  }
  async status(id?: string) {
    const key = id ?? [...this.ops.keys()].pop();
    const op = key ? this.ops.get(key) : undefined;
    if (!op) return null;
    if (!isTerminal(op.status)) {
      const next = this.script.shift() ?? "COMPLETED";
      op.status = next;
      if (next === "COMPLETED") { op.url = this.resultJsonl ? `https://fake/${op.id}.jsonl` : null; op.objectCount = this.resultJsonl.split("\n").filter(Boolean).length; }
      if (next === "FAILED") op.errorCode = "INTERNAL_SERVER_ERROR";
    }
    return { ...op };
  }
  async *lines(url: string) {
    // Emit in odd-sized chunks through the splitter, like a real network stream.
    const text = this.files.get(url) ?? "";
    const sp = new LineSplitter();
    for (let i = 0; i < text.length; i += 7) yield* sp.push(text.slice(i, i + 7));
    yield* sp.flush();
  }
}

export class MemoryCatalogStore implements CatalogStore {
  scan: { operationId: string; status: "running" | "completed" | "failed"; variantCount: number; finishedAt: Date | null; error: string | null } | null = null;
  variants: VariantInfo[] = [];
  async latest() { return this.scan; }
  async begin(operationId: string) { this.scan = { operationId, status: "running", variantCount: 0, finishedAt: null, error: null }; }
  async fail(operationId: string, error: string) { if (this.scan?.operationId === operationId) this.scan = { ...this.scan, status: "failed", error, finishedAt: new Date() }; }
  async complete(operationId: string, variants: VariantInfo[]) {
    this.variants = variants;
    this.scan = { operationId, status: "completed", variantCount: variants.length, finishedAt: new Date(), error: null };
  }
  async load() { return this.variants; }
}
