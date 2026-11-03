/**
 * Admin GraphQL boundary. Everything that talks to Shopify lives here so the rest of the
 * code stays testable. UNVERIFIED against a live store: queries follow the 2026-04 schema
 * from documentation, see README "What is mocked or unverified".
 */
import type { AdjustRequest, GatewayResult, InventoryGateway, LedgerSource } from "../core/ledger";
import type { VariantInfo } from "../core/types";

export interface GraphqlClient {
  graphql(query: string, opts?: { variables?: Record<string, unknown> }): Promise<Response>;
}

async function gql<T>(admin: GraphqlClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, { variables });
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data as T;
}

const toCents = (v: string | null | undefined): number | null => (v == null ? null : Math.round(Number(v) * 100));

const VARIANT_FIELDS = `
  id sku title price compareAtPrice
  product { id title }
  inventoryItem { id tracked unitCost { amount } inventoryLevels(first: 20) { nodes { location { id } quantities(names: ["available"]) { name quantity } } } }
  inventoryPolicy
`;

interface RawVariant {
  id: string; sku: string | null; title: string; price: string; compareAtPrice: string | null; inventoryPolicy: string;
  product: { id: string; title: string };
  inventoryItem: { id: string; tracked: boolean; unitCost: { amount: string } | null; inventoryLevels: { nodes: Array<{ location: { id: string }; quantities: Array<{ name: string; quantity: number }> }> } } | null;
}

export function mapVariant(r: RawVariant): VariantInfo {
  const levels: Record<string, number> = {};
  for (const n of r.inventoryItem?.inventoryLevels.nodes ?? []) levels[n.location.id] = n.quantities.find((q) => q.name === "available")?.quantity ?? 0;
  return {
    id: r.id, productId: r.product.id, productTitle: r.product.title, variantTitle: r.title, sku: r.sku,
    priceCents: toCents(r.price) ?? 0, compareAtCents: toCents(r.compareAtPrice),
    costCents: toCents(r.inventoryItem?.unitCost?.amount), inventoryItemId: r.inventoryItem?.id ?? null,
    tracked: !!r.inventoryItem?.tracked, continueSelling: r.inventoryPolicy === "CONTINUE", exists: true, levels,
  };
}

/** Fetch specific variants by id (nodes query). Missing/deleted ones come back as exists:false. */
export async function fetchVariants(admin: GraphqlClient, ids: string[]): Promise<Record<string, VariantInfo>> {
  const out: Record<string, VariantInfo> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await gql<{ nodes: Array<RawVariant | null> }>(
      admin,
      `query Variants($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { ${VARIANT_FIELDS} } } }`,
      { ids: chunk },
    );
    chunk.forEach((id, n) => {
      const r = data.nodes[n];
      out[id] = r?.id
        ? mapVariant(r)
        : { id, productId: "", productTitle: "Deleted variant", variantTitle: "", sku: null, priceCents: 0, compareAtCents: null, costCents: null, inventoryItemId: null, tracked: false, continueSelling: false, exists: false, levels: {} };
    });
  }
  return out;
}

/**
 * Catalog scan for the health check. Paginated and capped; for catalogs beyond `maxVariants`
 * use bulkOperationRunQuery (see README) instead of walking pages synchronously.
 */
export async function scanCatalog(admin: GraphqlClient, maxVariants = 2000): Promise<{ variants: VariantInfo[]; truncated: boolean }> {
  const variants: VariantInfo[] = [];
  let after: string | null = null;
  while (variants.length < maxVariants) {
    const data: { productVariants: { nodes: RawVariant[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(
      admin,
      `query Scan($after: String) { productVariants(first: 100, after: $after) { nodes { ${VARIANT_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
      { after },
    );
    variants.push(...data.productVariants.nodes.map(mapVariant));
    if (!data.productVariants.pageInfo.hasNextPage) return { variants, truncated: false };
    after = data.productVariants.pageInfo.endCursor;
  }
  return { variants, truncated: true };
}

export async function searchVariants(admin: GraphqlClient, term: string, first = 20): Promise<VariantInfo[]> {
  const q = term.trim() ? `title:*${term.replace(/[^\w\s-]/g, "")}* OR sku:*${term.replace(/[^\w-]/g, "")}*` : "";
  const data = await gql<{ productVariants: { nodes: RawVariant[] } }>(
    admin,
    `query Search($q: String, $first: Int!) { productVariants(first: $first, query: $q) { nodes { ${VARIANT_FIELDS} } } }`,
    { q, first },
  );
  return data.productVariants.nodes.map(mapVariant);
}

export async function fetchLocations(admin: GraphqlClient): Promise<Array<{ id: string; name: string; primary: boolean }>> {
  const data = await gql<{ locations: { nodes: Array<{ id: string; name: string; isActive: boolean }> } }>(
    admin,
    `query { locations(first: 50) { nodes { id name isActive } } }`,
  );
  const shop = await gql<{ shop: { primaryLocation?: { id: string } | null } }>(admin, `query { shop { id } }`).catch(() => null);
  const active = data.locations.nodes.filter((l) => l.isActive);
  void shop;
  // Shopify does not expose "primary" on Location in all versions; the first active location is the fallback.
  return active.map((l, i) => ({ id: l.id, name: l.name, primary: i === 0 }));
}

/** Orders for the dry run (last N). Requires read_orders. */
export async function fetchRecentOrders(admin: GraphqlClient, first = 50) {
  const data = await gql<{ orders: { nodes: Array<{ id: string; name: string; lineItems: { nodes: Array<{ id: string; quantity: number; variant: { id: string } | null }> } }> } }>(
    admin,
    `query Orders($first: Int!) { orders(first: $first, sortKey: CREATED_AT, reverse: true) { nodes { id name lineItems(first: 50) { nodes { id quantity variant { id } } } } } }`,
    { first },
  );
  return data.orders.nodes.map((o) => ({
    id: o.id, name: o.name,
    lines: o.lineItems.nodes.filter((l) => l.variant).map((l) => ({ lineId: l.id, variantId: l.variant!.id, qty: l.quantity })),
  }));
}

export async function updateUnitCost(admin: GraphqlClient, inventoryItemId: string, cents: number): Promise<void> {
  const data = await gql<{ inventoryItemUpdate: { userErrors: Array<{ message: string }> } }>(
    admin,
    `mutation Cost($id: ID!, $cost: Decimal!) { inventoryItemUpdate(id: $id, input: { cost: $cost }) { userErrors { message } } }`,
    { id: inventoryItemId, cost: (cents / 100).toFixed(2) },
  );
  const err = data.inventoryItemUpdate.userErrors[0];
  if (err) throw new Error(err.message);
}

/** Real gateway: delta adjustments with an app-attributed change name and a reference document. */
export class ShopifyInventoryGateway implements InventoryGateway {
  constructor(private admin: GraphqlClient, private inventoryItemOf: (variantId: string) => string | null, private appUrl: string) {}

  async getLevel(variantId: string, locationId: string): Promise<number | null> {
    const item = this.inventoryItemOf(variantId);
    if (!item) return null;
    const data = await gql<{ inventoryItem: { inventoryLevel: { quantities: Array<{ name: string; quantity: number }> } | null } | null }>(
      this.admin,
      `query Level($id: ID!, $loc: ID!) { inventoryItem(id: $id) { inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } } }`,
      { id: item, loc: locationId },
    );
    return data.inventoryItem?.inventoryLevel?.quantities.find((q) => q.name === "available")?.quantity ?? null;
  }

  async adjust(changes: AdjustRequest[], ref: { batchId: string; sourceType: LedgerSource; sourceRef: string }): Promise<GatewayResult[]> {
    const results: GatewayResult[] = changes.map(() => ({ ok: false, skipReason: "not sent" }));
    const byLoc = new Map<string, number[]>();
    changes.forEach((c, i) => byLoc.set(c.locationId, [...(byLoc.get(c.locationId) ?? []), i]));
    for (const [locationId, idxs] of byLoc) {
      // Never adjust a location where the component is not stocked: skip and flag, do not fail the batch.
      const sendable: number[] = [];
      for (const i of idxs) {
        const lvl = await this.getLevel(changes[i].variantId, locationId).catch(() => null);
        if (lvl === null) results[i] = { ok: false, skipReason: "Component is not stocked at this location" };
        else sendable.push(i);
      }
      if (!sendable.length) continue;
      const input = {
        reason: "correction",
        name: "available",
        referenceDocumentUri: `${this.appUrl}/app/ledger/${ref.batchId}`,
        changes: sendable.map((i) => ({ delta: changes[i].delta, inventoryItemId: this.inventoryItemOf(changes[i].variantId)!, locationId })),
      };
      try {
        const data = await gql<{ inventoryAdjustQuantities: { userErrors: Array<{ message: string }>; inventoryAdjustmentGroup: { changes: Array<{ delta: number; quantityAfterChange: number | null; item: { id: string } }> } | null } }>(
          this.admin,
          `mutation Adj($input: InventoryAdjustQuantitiesInput!) { inventoryAdjustQuantities(input: $input) { userErrors { message } inventoryAdjustmentGroup { changes { name delta quantityAfterChange item { id } } } } }`,
          { input },
        );
        const err = data.inventoryAdjustQuantities.userErrors[0];
        if (err) { sendable.forEach((i) => (results[i] = { ok: false, skipReason: err.message })); continue; }
        const applied = data.inventoryAdjustQuantities.inventoryAdjustmentGroup?.changes ?? [];
        for (const i of sendable) {
          const item = this.inventoryItemOf(changes[i].variantId);
          const hit = applied.find((a) => a.item.id === item);
          const after = hit?.quantityAfterChange ?? undefined;
          results[i] = { ok: true, after, before: after !== undefined ? after - changes[i].delta : undefined };
        }
      } catch (e) {
        sendable.forEach((i) => (results[i] = { ok: false, skipReason: (e as Error).message }));
      }
    }
    return results;
  }
}

/** Write derived kit availability with a compare-and-swap; on conflict re-read and retry once. */
export async function setKitQuantity(admin: GraphqlClient, inventoryItemId: string, locationId: string, quantity: number, readCurrent: () => Promise<number>): Promise<{ ok: boolean; message?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await readCurrent();
    if (current === quantity) return { ok: true };
    const data = await gql<{ inventorySetQuantities: { userErrors: Array<{ message: string; code?: string }> } }>(
      admin,
      `mutation Set($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { message code } } }`,
      { input: { name: "available", reason: "correction", quantities: [{ inventoryItemId, locationId, quantity, changeFromQuantity: current }] } },
    );
    const err = data.inventorySetQuantities.userErrors[0];
    if (!err) return { ok: true };
    if (err.code !== "CHANGE_FROM_QUANTITY_STALE" && !/stale|changeFromQuantity/i.test(err.message)) return { ok: false, message: err.message };
  }
  return { ok: false, message: "Quantity changed during write twice; logged for the next reconciliation." };
}
