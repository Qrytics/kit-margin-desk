import type { KitDef } from "./bom";
import type { PlanKey } from "./plans";

export interface VariantInfo {
  id: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  priceCents: number;
  compareAtCents: number | null;
  costCents: number | null;
  inventoryItemId: string | null;
  tracked: boolean;
  continueSelling: boolean;
  exists: boolean;
  /** locationId -> available */
  levels: Record<string, number>;
}

export interface Settings {
  defaultLocationId: string | null;
  laborRateCents: number;
  landedUpliftBps: number;
  targetMarginPct: number;
  alertMarginPct: number;
  coverDays: number;
  digest: boolean;
  pushCostToShopify: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultLocationId: null,
  laborRateCents: 1800,
  landedUpliftBps: 0,
  targetMarginPct: 40,
  alertMarginPct: 15,
  coverDays: 30,
  digest: false,
  pushCostToShopify: false,
};

export interface KitRecord extends KitDef {
  title: string;
  manageAvailability: boolean;
}

export interface SaleRow {
  variantId: string;
  qty: number;
  refundedQty: number;
  unitPriceCents: number;
  soldAt: string;
}

export interface MetaRow {
  variantId: string;
  supplierName: string | null;
  supplierSku: string | null;
  packSize: number | null;
  leadTimeDays: number | null;
  reorderPointOverride: number | null;
  avgCostCents: number | null;
}

export interface PoRow {
  id: string;
  number: number;
  supplierName: string;
  status: "draft" | "sent" | "partially_received" | "received" | "closed";
  freightCents: number;
  lines: Array<{ id: string; variantId: string; qtyOrdered: number; qtyReceived: number; unitCostCents: number }>;
}

export interface CostChangeRow { id: string; variantId: string; oldCents: number; newCents: number; at: string }

export interface LedgerBatchView {
  id: string;
  sourceType: string;
  sourceRef: string;
  at: string;
  status: string;
  undone: boolean;
  entries: Array<{ sku: string | null; variantId: string; locationId: string; delta: number; beforeQty: number | null; afterQty: number | null; status: string; locationAssumed: boolean; note: string | null }>;
}

export interface OrderSample {
  id: string;
  name: string;
  lines: Array<{ lineId: string; variantId: string; qty: number }>;
}

export interface Snapshot {
  shopDomain: string;
  plan: PlanKey;
  syncEnabled: boolean;
  syncPaused: boolean;
  demo: boolean;
  settings: Settings;
  locations: Array<{ id: string; name: string; primary: boolean }>;
  variants: Record<string, VariantInfo>;
  kits: KitRecord[];
  sales: SaleRow[];
  meta: MetaRow[];
  pos: PoRow[];
  costChanges: CostChangeRow[];
  ledger: LedgerBatchView[];
  recentOrders: OrderSample[];
  kitOrdersThisMonth: number;
}
