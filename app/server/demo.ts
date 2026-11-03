import { DEFAULT_SETTINGS, type Snapshot, type VariantInfo, type KitRecord } from "../core/types";

const L1 = "gid://shopify/Location/1";
const L2 = "gid://shopify/Location/2";

/** In-memory fixture used with DEMO_MODE=true so the UI can be exercised without Shopify or a database. */
export function demoSnapshot(now = Date.now()): Snapshot {
  const v = (id: string, product: string, variant: string, sku: string | null, price: number, cost: number | null, stock: number, o: Partial<VariantInfo> = {}): VariantInfo => ({
    id: `gid://shopify/ProductVariant/${id}`, productId: `gid://shopify/Product/${id}`, productTitle: product, variantTitle: variant, sku,
    priceCents: price, compareAtCents: null, costCents: cost, inventoryItemId: `gid://shopify/InventoryItem/${id}`,
    tracked: true, continueSelling: false, exists: true, levels: { [L1]: stock, [L2]: Math.round(stock / 4) }, ...o,
  });
  const vs = [
    v("101", "Amber Jar 250ml", "Default Title", "JAR-250", 600, 224, 34),
    v("102", "Soy Wax Flakes (kg)", "Default Title", "WAX-KG", 1800, 1100, 38),
    v("103", "Cotton Wick Pack", "Default Title", "WICK-10", 400, 90, 420),
    v("104", "Lavender Oil 100ml", "Default Title", "OIL-LAV", 2200, 1400, 61),
    v("105", "Handmade Soap Bar", "Default Title", "SOAP-BAR", 900, 310, 210),
    v("106", "Gift Box", "Kraft", "BOX-KRAFT", 500, 180, 96),
    v("107", "Bath Bomb", "Default Title", "BOMB-1", 700, null, 150),
    v("108", "Ribbon Spool", "Default Title", "RIBBON", 300, 60, 0, { tracked: false }),
    v("109", "Tea Light Pack", "Default Title", "TEA-12", 500, 150, 70, { continueSelling: true }),
    v("110", "Starter Pack Insert", "Default Title", "SOAP-BAR", 100, 20, 80), // duplicate SKU trap
    v("201", "Deluxe Candle Making Kit", "Default Title", "KIT-CANDLE", 4800, null, 0),
    v("202", "Spa Gift Set", "Large", "GIFT-SPA-L", 3600, null, 0),
    v("203", "Spa Gift Set", "Small", "GIFT-SPA-S", 2000, null, 0),
    v("204", "Lavender Pillar Candle", "Default Title", "CANDLE-LAV", 1900, null, 12),
    v("205", "Holiday Bundle", "Default Title", "BUNDLE-XMAS", 2400, null, 0),
  ];
  const variants = Object.fromEntries(vs.map((x) => [x.id, x]));
  const id = (n: string) => `gid://shopify/ProductVariant/${n}`;
  const kit = (kid: string, title: string, vid: string, lines: KitRecord["lines"], x: Partial<KitRecord> = {}): KitRecord => ({
    id: kid, title, variantId: id(vid), mode: "assemble_on_order", lines, packagingCostCents: 0, laborMinutes: 0,
    laborRateCents: 1800, landedUpliftBps: 0, manageAvailability: false, ...x,
  });
  const kits: KitRecord[] = [
    kit("k_candle", "Deluxe Candle Making Kit", "201", [
      { componentVariantId: id("101"), qtyPerKit: 2, wasteBps: 0, uom: "pcs" },
      { componentVariantId: id("102"), qtyPerKit: 0.35, wasteBps: 500, uom: "kg" },
      { componentVariantId: id("103"), qtyPerKit: 1, wasteBps: 0, uom: "pcs" },
      { componentVariantId: id("104"), qtyPerKit: 0.1, wasteBps: 0, uom: "bottle" },
      { componentVariantId: id("106"), qtyPerKit: 1, wasteBps: 0, uom: "pcs" },
    ], { packagingCostCents: 120, laborMinutes: 4, landedUpliftBps: 800 }),
    kit("k_spa_l", "Spa Gift Set (Large)", "202", [
      { componentVariantId: id("105"), qtyPerKit: 3, wasteBps: 0, uom: "pcs" },
      { componentVariantId: id("107"), qtyPerKit: 2, wasteBps: 0, uom: "pcs" },
      { componentKitId: "k_candle_mini", qtyPerKit: 1, wasteBps: 0 },
      { componentVariantId: id("106"), qtyPerKit: 1, wasteBps: 0, uom: "pcs" },
      { componentVariantId: id("108"), qtyPerKit: 1, wasteBps: 0, uom: "pcs" },
    ], { packagingCostCents: 90, laborMinutes: 3, landedUpliftBps: 800 }),
    kit("k_spa_s", "Spa Gift Set (Small)", "203", [
      { componentVariantId: id("105"), qtyPerKit: 2, wasteBps: 0, uom: "pcs" },
      { componentVariantId: id("107"), qtyPerKit: 1, wasteBps: 0, uom: "pcs" },
      { componentVariantId: id("106"), qtyPerKit: 1, wasteBps: 0, uom: "pcs" },
    ], { packagingCostCents: 40, landedUpliftBps: 800 }),
    kit("k_candle_mini", "Lavender Pillar Candle", "204", [
      { componentVariantId: id("101"), qtyPerKit: 1, wasteBps: 0, uom: "pcs" },
      { componentVariantId: id("102"), qtyPerKit: 0.2, wasteBps: 0, uom: "kg" },
      { componentVariantId: id("104"), qtyPerKit: 0.05, wasteBps: 0, uom: "bottle" },
    ], { mode: "pre_assembled" }),
    kit("k_xmas", "Holiday Bundle", "205", [
      { componentKitId: "k_spa_s", qtyPerKit: 2, wasteBps: 0 },
      { componentVariantId: id("109"), qtyPerKit: 1, wasteBps: 0, uom: "pcs" },
      { componentVariantId: id("106"), qtyPerKit: 2, wasteBps: 0, uom: "pcs" },
    ], { packagingCostCents: 250, laborMinutes: 8, landedUpliftBps: 800 }),
  ];
  const sales: Snapshot["sales"] = [];
  const mix: Array<[string, number, number]> = [["201", 4800, 3], ["202", 3600, 2], ["203", 2000, 5], ["205", 2400, 1], ["204", 1900, 4]];
  for (let d = 0; d < 60; d++) for (const [vid, price, perDay] of mix) {
    if ((d + Number(vid)) % 2 === 0) sales.push({ variantId: id(vid), qty: perDay, refundedQty: d % 11 === 0 ? 1 : 0, unitPriceCents: price, soldAt: new Date(now - d * 86_400_000).toISOString() });
  }
  return {
    shopDomain: "demo-candle-co.myshopify.com", plan: "kit_desk_pro", syncEnabled: false, syncPaused: false, demo: true,
    settings: { ...DEFAULT_SETTINGS, defaultLocationId: L1, landedUpliftBps: 800 },
    locations: [{ id: L1, name: "Studio warehouse", primary: true }, { id: L2, name: "Pop-up shop", primary: false }],
    variants, kits, sales,
    meta: [
      { variantId: id("101"), supplierName: "Glassworks Ltd", supplierSku: "AJ-250", packSize: 50, leadTimeDays: 10, reorderPointOverride: null, avgCostCents: 224 },
      { variantId: id("102"), supplierName: "Waxhouse", supplierSku: "SW-1KG", packSize: 5, leadTimeDays: 7, reorderPointOverride: null, avgCostCents: 1100 },
      { variantId: id("104"), supplierName: "Waxhouse", supplierSku: "LAV-100", packSize: null, leadTimeDays: 7, reorderPointOverride: null, avgCostCents: 1400 },
    ],
    pos: [{ id: "po_1", number: 1, supplierName: "Glassworks Ltd", status: "sent", freightCents: 4000, lines: [{ id: "pl1", variantId: id("101"), qtyOrdered: 100, qtyReceived: 0, unitCostCents: 224 }] }],
    costChanges: [{ id: "cc1", variantId: id("101"), oldCents: 200, newCents: 224, at: new Date(now - 3600_000 * 5).toISOString() }],
    ledger: [
      {
        id: "b_1042", sourceType: "order", sourceRef: "#1042", at: new Date(now - 3600_000 * 2).toISOString(), status: "applied", undone: false,
        entries: [
          { sku: "JAR-250", variantId: id("101"), locationId: L1, delta: -2, beforeQty: 36, afterQty: 34, status: "applied", locationAssumed: false, note: null },
          { sku: "WAX-KG", variantId: id("102"), locationId: L1, delta: -1, beforeQty: 39, afterQty: 38, status: "applied", locationAssumed: true, note: null },
        ],
      },
      {
        id: "b_1041", sourceType: "refund", sourceRef: "#1038 refund", at: new Date(now - 3600_000 * 20).toISOString(), status: "applied", undone: false,
        entries: [{ sku: "SOAP-BAR", variantId: id("105"), locationId: L1, delta: 2, beforeQty: 208, afterQty: 210, status: "applied", locationAssumed: false, note: null }],
      },
    ],
    recentOrders: [
      { id: "o1", name: "#1042", lines: [{ lineId: "l1", variantId: id("201"), qty: 1 }] },
      { id: "o2", name: "#1041", lines: [{ lineId: "l2", variantId: id("202"), qty: 2 }, { lineId: "l3", variantId: id("203"), qty: 1 }] },
      { id: "o3", name: "#1040", lines: [{ lineId: "l4", variantId: id("205"), qty: 1 }] },
    ],
    kitOrdersThisMonth: 142,
  };
}
