/**
 * The one door every inventory mutation goes through (spec: "apply_adjustments").
 * Ledger completeness is by construction: nothing writes inventory except applyAdjustments.
 */
export type LedgerSource = "order" | "refund" | "cancel" | "fulfillment" | "build" | "po_receipt" | "reconciliation" | "manual" | "undo";
export type EntryStatus = "pending" | "applied" | "skipped" | "failed" | "needs_review";

export interface AdjustRequest {
  variantId: string;
  sku?: string | null;
  locationId: string;
  delta: number;
  locationAssumed?: boolean;
  lineKey?: string | null;
  note?: string | null;
}

export interface GatewayResult {
  ok: boolean;
  before?: number;
  after?: number;
  /** why it was skipped, e.g. "not stocked at location" */
  skipReason?: string;
}

/** Thin boundary over the Shopify Admin API so the logic can be tested without it. */
export interface InventoryGateway {
  /** One call per location in production (inventoryAdjustQuantities supports many items). */
  adjust(changes: AdjustRequest[], ref: { batchId: string; sourceType: LedgerSource; sourceRef: string }): Promise<GatewayResult[]>;
  /** Current on-hand/available for drift detection when undoing. */
  getLevel(variantId: string, locationId: string): Promise<number | null>;
}

export interface LedgerEntryRow {
  id: string;
  batchId: string;
  sourceType: LedgerSource;
  sourceRef: string;
  variantId: string;
  sku?: string | null;
  locationId: string;
  delta: number;
  beforeQty: number | null;
  afterQty: number | null;
  status: EntryStatus;
  locationAssumed: boolean;
  lineKey?: string | null;
  note?: string | null;
}

export interface BatchRow {
  id: string;
  sourceType: LedgerSource;
  sourceRef: string;
  status: EntryStatus;
  undoneByBatchId: string | null;
  note?: string | null;
}

export interface LedgerStore {
  createBatch(b: BatchRow): Promise<void>;
  addEntries(rows: LedgerEntryRow[]): Promise<void>;
  getBatch(id: string): Promise<{ batch: BatchRow; entries: LedgerEntryRow[] } | null>;
  markUndone(batchId: string, undoBatchId: string): Promise<void>;
}

let seq = 0;
export const newId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface ApplyDeps {
  gateway: InventoryGateway;
  store: LedgerStore;
  /** Kill switch: when true, nothing is written to Shopify, entries are recorded as skipped. */
  paused?: boolean;
}

export interface ApplyResult {
  batchId: string;
  entries: LedgerEntryRow[];
  applied: number;
  skipped: number;
}

export async function applyAdjustments(
  deps: ApplyDeps,
  requests: AdjustRequest[],
  source: { type: LedgerSource; ref: string; note?: string },
  batchId = newId("b"),
): Promise<ApplyResult> {
  const reqs = requests.filter((r) => r.delta !== 0);
  await deps.store.createBatch({
    id: batchId,
    sourceType: source.type,
    sourceRef: source.ref,
    status: "pending",
    undoneByBatchId: null,
    note: source.note ?? null,
  });
  let results: GatewayResult[];
  if (deps.paused) {
    results = reqs.map(() => ({ ok: false, skipReason: "Sync is paused" }));
  } else {
    try {
      results = await deps.gateway.adjust(reqs, { batchId, sourceType: source.type, sourceRef: source.ref });
    } catch (e) {
      results = reqs.map(() => ({ ok: false, skipReason: `error: ${(e as Error).message}` }));
    }
  }
  const entries: LedgerEntryRow[] = reqs.map((r, i) => {
    const res = results[i] ?? { ok: false, skipReason: "no result" };
    return {
      id: newId("e"),
      batchId,
      sourceType: source.type,
      sourceRef: source.ref,
      variantId: r.variantId,
      sku: r.sku ?? null,
      locationId: r.locationId,
      delta: r.delta,
      beforeQty: res.before ?? null,
      afterQty: res.after ?? null,
      status: res.ok ? "applied" : "skipped",
      locationAssumed: !!r.locationAssumed,
      lineKey: r.lineKey ?? null,
      note: res.ok ? (r.note ?? null) : (res.skipReason ?? r.note ?? null),
    };
  });
  await deps.store.addEntries(entries);
  return {
    batchId,
    entries,
    applied: entries.filter((e) => e.status === "applied").length,
    skipped: entries.filter((e) => e.status !== "applied").length,
  };
}

/* ---------- undo ---------- */

export interface UndoPlan {
  canUndoCleanly: boolean;
  /** Human explanation when not clean. */
  reason: string | null;
  reversals: AdjustRequest[];
  alreadyUndone: boolean;
}

/**
 * Reverse the exact deltas of the applied rows. It is "clean" only when every touched
 * (variant, location) still sits at the row's afterQty; otherwise something else moved stock since
 * and we offer a compensating adjustment (same delta reversal, flagged) instead of pretending.
 */
export async function planUndo(
  deps: Pick<ApplyDeps, "gateway" | "store">,
  batchId: string,
): Promise<UndoPlan> {
  const found = await deps.store.getBatch(batchId);
  if (!found) return { canUndoCleanly: false, reason: "Batch not found.", reversals: [], alreadyUndone: false };
  if (found.batch.undoneByBatchId)
    return { canUndoCleanly: false, reason: "This batch was already undone.", reversals: [], alreadyUndone: true };
  const applied = found.entries.filter((e) => e.status === "applied");
  // net per (variant, location), remembering the last afterQty
  const net = new Map<string, { req: AdjustRequest; expectedNow: number | null }>();
  for (const e of applied) {
    const k = `${e.variantId}@${e.locationId}`;
    const cur = net.get(k);
    const req: AdjustRequest = {
      variantId: e.variantId,
      sku: e.sku,
      locationId: e.locationId,
      delta: -(e.delta) + (cur ? cur.req.delta : 0),
      note: `Undo of ${found.batch.sourceType} ${found.batch.sourceRef}`,
    };
    net.set(k, { req, expectedNow: e.afterQty });
  }
  let drift: string | null = null;
  for (const { req, expectedNow } of net.values()) {
    if (expectedNow === null) continue;
    const now = await deps.gateway.getLevel(req.variantId, req.locationId);
    if (now !== null && now !== expectedNow) {
      drift = `${req.sku ?? req.variantId} changed from ${expectedNow} to ${now} since this batch, so an exact reversal is not possible.`;
      break;
    }
  }
  const reversals = [...net.values()].map((n) => n.req).filter((r) => r.delta !== 0);
  return { canUndoCleanly: drift === null, reason: drift, reversals, alreadyUndone: false };
}

export async function undoBatch(
  deps: ApplyDeps,
  batchId: string,
  opts: { allowCompensating?: boolean } = {},
): Promise<{ ok: boolean; message: string; undoBatchId?: string; compensating?: boolean }> {
  const plan = await planUndo(deps, batchId);
  if (plan.alreadyUndone) return { ok: false, message: plan.reason! };
  if (!plan.reversals.length) return { ok: false, message: plan.reason ?? "Nothing to undo." };
  if (!plan.canUndoCleanly && !opts.allowCompensating)
    return { ok: false, message: `${plan.reason} You can apply a compensating adjustment instead.` };
  const res = await applyAdjustments(deps, plan.reversals, {
    type: "undo",
    ref: batchId,
    note: plan.canUndoCleanly ? "Exact reversal" : "Compensating adjustment (stock moved since the original batch)",
  });
  if (res.applied > 0) await deps.store.markUndone(batchId, res.batchId);
  return {
    ok: res.applied > 0,
    undoBatchId: res.batchId,
    compensating: !plan.canUndoCleanly,
    message: res.applied > 0 ? "Batch reversed." : "Nothing could be reversed (see ledger for skipped rows).",
  };
}

/** In-memory implementations used by tests and demo mode. */
export class MemoryLedgerStore implements LedgerStore {
  batches = new Map<string, BatchRow>();
  entries: LedgerEntryRow[] = [];
  async createBatch(b: BatchRow) { this.batches.set(b.id, { ...b }); }
  async addEntries(rows: LedgerEntryRow[]) { this.entries.push(...rows); }
  async getBatch(id: string) {
    const batch = this.batches.get(id);
    return batch ? { batch, entries: this.entries.filter((e) => e.batchId === id) } : null;
  }
  async markUndone(batchId: string, undoBatchId: string) {
    const b = this.batches.get(batchId);
    if (b) b.undoneByBatchId = undoBatchId;
  }
}

export class MemoryGateway implements InventoryGateway {
  levels = new Map<string, number>();
  key = (v: string, l: string) => `${v}@${l}`;
  set(v: string, l: string, q: number) { this.levels.set(this.key(v, l), q); }
  get(v: string, l: string) { return this.levels.get(this.key(v, l)); }
  async getLevel(v: string, l: string) { return this.levels.get(this.key(v, l)) ?? null; }
  async adjust(changes: AdjustRequest[]) {
    return changes.map((c) => {
      const k = this.key(c.variantId, c.locationId);
      const before = this.levels.get(k);
      if (before === undefined) return { ok: false, skipReason: "Component is not stocked at this location" };
      this.levels.set(k, before + c.delta);
      return { ok: true, before, after: before + c.delta };
    });
  }
}
