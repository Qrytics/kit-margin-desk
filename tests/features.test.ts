import { describe, expect, it } from "vitest";
import {
  CATALOG_BULK_QUERY, FakeBulkGateway, LineSplitter, MemoryCatalogStore, finishCatalogScan, parseBulkJsonl, parseBulkLine, pollCatalogScan, startCatalogScan,
} from "../app/core/bulk";
import { kitAvailabilityByLocation } from "../app/core/locations";
import { buildDigest } from "../app/core/digest";
import { ConsoleMailProvider, WebhookMailProvider, providerFromEnv } from "../app/core/mailer";
import { poTotals, renderPoPdf, truncateToWidth, pdfSafe } from "../app/core/po-pdf";
import { demoSnapshot } from "../app/server/demo";
import type { VariantInfo } from "../app/core/types";
import type { KitDef } from "../app/core/bom";

const row = (n: number, extra: object = {}) => JSON.stringify({
  id: `gid://shopify/ProductVariant/${n}`, sku: `SKU-${n}`, title: "Default Title", price: "12.50", compareAtPrice: null, inventoryPolicy: "DENY",
  product: { id: `gid://shopify/Product/${n}`, title: `P${n}` }, inventoryItem: { id: `gid://shopify/InventoryItem/${n}`, tracked: true, unitCost: { amount: "3.10" } }, ...extra,
});

describe("bulk operations", () => {
  it("parses JSONL, maps money to cents and skips junk lines", () => {
    const text = [row(1), "", "not json", JSON.stringify({ id: "gid://shopify/Product/9" }), row(2, { inventoryPolicy: "CONTINUE", inventoryItem: { id: "i", tracked: false, unitCost: null } })].join("\n");
    const { variants, skipped } = parseBulkJsonl(text);
    expect(skipped).toBe(2);
    expect(variants).toHaveLength(2);
    expect(variants[0]).toMatchObject({ sku: "SKU-1", priceCents: 1250, costCents: 310, tracked: true, continueSelling: false, productTitle: "P1" });
    expect(variants[1]).toMatchObject({ costCents: null, tracked: false, continueSelling: true });
    expect(parseBulkLine("")).toBeNull();
  });
  it("reassembles lines across arbitrary chunk boundaries", () => {
    const sp = new LineSplitter();
    const out = [...sp.push('{"a":1}\n{"b"'), ...sp.push(':2}\n{"c":3'), ...sp.flush()];
    expect(out).toEqual(['{"a":1}', '{"b":2}', '{"c":3']);
  });
  it("query is a single variable-free string (bulk operations require that)", () => {
    expect(CATALOG_BULK_QUERY).not.toContain("$");
    expect(CATALOG_BULK_QUERY).toContain("productVariants");
  });
  it("start, poll while RUNNING, then ingest the file", async () => {
    const gw = new FakeBulkGateway([row(1), row(2), row(3)].join("\n"));
    const store = new MemoryCatalogStore();
    const s = await startCatalogScan(gw, store);
    expect(s).toMatchObject({ started: true });
    expect((await store.latest())?.status).toBe("running");
    let slept = 0;
    const r = await pollCatalogScan(gw, store, (s as { operationId: string }).operationId, { sleep: async () => void slept++ });
    expect(r).toMatchObject({ done: true, variants: 3 });
    expect(slept).toBe(1);
    expect((await store.latest())).toMatchObject({ status: "completed", variantCount: 3 });
    expect(await store.load()).toHaveLength(3);
  });
  it("refuses to start while another bulk operation runs", async () => {
    const gw = new FakeBulkGateway(row(1));
    const store = new MemoryCatalogStore();
    await startCatalogScan(gw, store);
    const again = await startCatalogScan(gw, store);
    expect(again).toMatchObject({ started: false });
    expect(gw.startedQueries).toHaveLength(1);
  });
  it("records a failed operation and keeps the previous catalog", async () => {
    const gw = new FakeBulkGateway(row(1));
    gw.script = ["FAILED"];
    const store = new MemoryCatalogStore();
    store.variants = parseBulkJsonl(row(7)).variants;
    const s = (await startCatalogScan(gw, store)) as { operationId: string };
    const r = await finishCatalogScan(gw, store, s.operationId);
    expect(r).toMatchObject({ done: false, terminal: true });
    expect((await store.latest())?.status).toBe("failed");
    expect(await store.load()).toHaveLength(1);
  });
  it("handles an empty catalog (url is null)", async () => {
    const gw = new FakeBulkGateway("");
    const store = new MemoryCatalogStore();
    const s = (await startCatalogScan(gw, store)) as { operationId: string };
    const r = await pollCatalogScan(gw, store, s.operationId, { sleep: async () => {} });
    expect(r).toMatchObject({ done: true, variants: 0 });
  });
  it("surfaces a userError from bulkOperationRunQuery", async () => {
    const r = await startCatalogScan(new FakeBulkGateway("", "Bulk operation limit reached"), new MemoryCatalogStore());
    expect(r).toEqual({ started: false, reason: "Bulk operation limit reached" });
  });
  it("streams 50,000 variants without trouble", async () => {
    const text = Array.from({ length: 50_000 }, (_, i) => row(i)).join("\n");
    const gw = new FakeBulkGateway(text);
    const store = new MemoryCatalogStore();
    const s = (await startCatalogScan(gw, store)) as { operationId: string };
    const r = await pollCatalogScan(gw, store, s.operationId, { sleep: async () => {} });
    expect(r).toMatchObject({ done: true, variants: 50_000, skipped: 0 });
  }, 30_000);
});

describe("per-location kit availability", () => {
  const v = (id: string, levels: Record<string, number>, o: Partial<VariantInfo> = {}): VariantInfo => ({
    id, productId: "p", productTitle: id, variantTitle: "", sku: id, priceCents: 0, compareAtCents: null, costCents: 100, inventoryItemId: id,
    tracked: true, continueSelling: false, exists: true, levels, ...o,
  });
  const kit: KitDef = { id: "k", variantId: "kv", mode: "assemble_on_order", packagingCostCents: 0, laborMinutes: 0, laborRateCents: 0, landedUpliftBps: 0,
    lines: [{ componentVariantId: "A", qtyPerKit: 2, wasteBps: 0 }, { componentVariantId: "B", qtyPerKit: 1, wasteBps: 0 }] };
  const locs = [{ id: "L1", name: "Warehouse" }, { id: "L2", name: "Shop" }];
  it("computes min over components independently per location", () => {
    const r = kitAvailabilityByLocation(kit, [kit], { A: v("A", { L1: 10, L2: 3 }), B: v("B", { L1: 4, L2: 9 }) }, locs);
    expect(r.rows.map((x) => x.available)).toEqual([4, 1]);
    expect(r.rows[0].limitingVariantId).toBe("B");
    expect(r.rows[1].limitingVariantId).toBe("A");
    expect(r.total).toBe(5);
    expect(r.best).toBe("L1");
  });
  it("treats a component with no level at a location as zero and names it", () => {
    const r = kitAvailabilityByLocation(kit, [kit], { A: v("A", { L1: 10 }), B: v("B", { L1: 4, L2: 9 }) }, locs);
    expect(r.rows[1].available).toBe(0);
    expect(r.rows[1].notStocked).toEqual(["A"]);
    expect(r.rows[0].notStocked).toEqual([]);
  });
  it("ignores untracked components and returns null when nothing constrains", () => {
    const r = kitAvailabilityByLocation(kit, [kit], { A: v("A", {}, { tracked: false }), B: v("B", {}, { continueSelling: true }) }, locs);
    expect(r.rows.every((x) => x.available === null)).toBe(true);
    expect(r.best).toBeNull();
  });
  it("works on the demo fixture and honours nested kits", () => {
    const s = demoSnapshot();
    const spa = s.kits.find((k) => k.id === "k_spa_l")!;
    const r = kitAvailabilityByLocation(spa, s.kits, s.variants, s.locations);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].available!).toBeGreaterThan(r.rows[1].available!);
  });
});

describe("daily digest", () => {
  it("summarises losing kits, reorders and cost changes from the demo shop", () => {
    const d = buildDigest(demoSnapshot(), "https://app.example.com/");
    expect(d.hasContent).toBe(true);
    expect(d.facts.losingKits).toBeGreaterThan(0);
    expect(d.subject).toMatch(/losing kit/);
    expect(d.text).toContain("https://app.example.com/app/replenish");
    expect(d.html).toContain("<ul");
  });
  it("is quiet when nothing needs attention", () => {
    const s = demoSnapshot();
    s.kits = []; s.costChanges = []; s.sales = [];
    const d = buildDigest(s);
    expect(d.hasContent).toBe(false);
    expect(d.subject).toMatch(/nothing needs attention/);
  });
  it("escapes HTML in names", () => {
    const s = demoSnapshot();
    Object.values(s.variants)[0].productTitle = "<script>x</script>";
    s.kits[0].title = "<b>Kit</b>";
    expect(buildDigest(s).html).not.toContain("<script>");
  });
});

describe("mail providers", () => {
  const mail = { to: "a@b.co", subject: "S", text: "T", html: "<p>T</p>" };
  it("console provider logs and succeeds", async () => {
    const lines: string[] = [];
    const r = await new ConsoleMailProvider((l) => lines.push(l)).send(mail);
    expect(r.ok).toBe(true);
    expect(lines[0]).toContain("subject=S");
  });
  it("webhook provider posts JSON with an optional bearer secret and reports failures", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const ok = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response("", { status: 202 }); }) as unknown as typeof fetch;
    expect((await new WebhookMailProvider("https://hook.test/x", ok, "sek").send(mail)).ok).toBe(true);
    expect(JSON.parse(seen!.init.body as string)).toMatchObject({ kind: "kit-margin-desk.digest", to: "a@b.co" });
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer sek");
    const bad = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await new WebhookMailProvider("https://hook.test/x", bad).send(mail)).toMatchObject({ ok: false });
    const boom = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect((await new WebhookMailProvider("https://hook.test/x", boom).send(mail)).detail).toContain("down");
  });
  it("chooses the provider from env", () => {
    expect(providerFromEnv({}).name).toBe("console");
    expect(providerFromEnv({ DIGEST_WEBHOOK_URL: "https://x.test" }).name).toBe("webhook");
    expect(providerFromEnv({ DIGEST_PROVIDER: "webhook" }).name).toBe("console");
    expect(providerFromEnv({ DIGEST_PROVIDER: "console", DIGEST_WEBHOOK_URL: "https://x.test" }).name).toBe("console");
  });
});

describe("purchase order PDF", () => {
  it("sums lines and freight", () => {
    expect(poTotals([{ qty: 100, unitCostCents: 224 }, { qty: 5, unitCostCents: 1100 }], 4000)).toEqual({ subtotalCents: 27900, freightCents: 4000, totalCents: 31900 });
  });
  it("renders a valid PDF, and paginates long orders", async () => {
    const line = (i: number) => ({ sku: `S${i}`, supplierSku: "X", item: `Item ${i} ☃ snowman`, qty: i + 1, unitCostCents: 199 });
    const one = await renderPoPdf({ number: 7, supplierName: "Glassworks Ltd", shopName: "demo.myshopify.com", status: "sent", freightCents: 4000, lines: [line(1), line(2)] });
    expect(Buffer.from(one.slice(0, 5)).toString()).toBe("%PDF-");
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(one)).getPageCount()).toBe(1);
    const many = await renderPoPdf({ number: 8, supplierName: "S", shopName: "d", status: "draft", freightCents: 0, lines: Array.from({ length: 80 }, (_, i) => line(i)) });
    expect((await PDFDocument.load(many)).getPageCount()).toBeGreaterThan(1);
    const empty = await renderPoPdf({ number: 9, supplierName: "S", shopName: "d", status: "draft", freightCents: 0, lines: [] });
    expect((await PDFDocument.load(empty)).getPageCount()).toBe(1);
  });
  it("makes text safe for standard fonts and truncates to width", async () => {
    expect(pdfSafe("a☃b\nc")).toBe("a?b c");
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const f = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const t = truncateToWidth("A very long product name that cannot possibly fit", f, 10, 80);
    expect(t.endsWith("...")).toBe(true);
    expect(f.widthOfTextAtSize(t, 10)).toBeLessThanOrEqual(80);
  });
});
