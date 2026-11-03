import { MICRO, toMicro, withWaste } from "../lib/units";

export type KitMode = "assemble_on_order" | "pre_assembled";

export interface BomLineDef {
  id?: string;
  /** Shopify variant gid of a leaf component. */
  componentVariantId?: string | null;
  /** Another kit (nested BOM). */
  componentKitId?: string | null;
  qtyPerKit: number;
  wasteBps: number;
  uom?: string;
  broken?: boolean;
}

export interface KitDef {
  id: string;
  variantId: string;
  mode: KitMode;
  lines: BomLineDef[];
  packagingCostCents: number;
  laborMinutes: number;
  laborRateCents: number;
  landedUpliftBps: number;
}

export const MAX_DEPTH = 3;

export type KitIndex = Map<string, KitDef>;

export const indexKits = (kits: KitDef[]): KitIndex => new Map(kits.map((k) => [k.id, k]));

export interface ExplodeResult {
  /** leaf variant id -> micro-units consumed per ONE root kit (waste included). */
  leaves: Map<string, number>;
  issues: string[];
}

/**
 * Explode a kit to leaf variants. Handles nesting (depth cap 3), cycles, fractions and waste.
 * A nested kit in pre_assembled mode is consumed as itself (its stock is real), not exploded.
 */
export function explodeBom(root: KitDef, kits: KitIndex): ExplodeResult {
  const leaves = new Map<string, number>();
  const issues: string[] = [];

  const walk = (kit: KitDef, factorMicro: number, depth: number, path: string[]) => {
    for (const line of kit.lines) {
      if (line.broken) {
        issues.push(`broken line in kit ${kit.id}`);
        continue;
      }
      const perUnit = withWaste(toMicro(line.qtyPerKit), line.wasteBps);
      const qty = Math.round((perUnit * factorMicro) / MICRO);
      if (line.componentKitId) {
        const child = kits.get(line.componentKitId);
        if (!child) {
          issues.push(`missing nested kit ${line.componentKitId}`);
          continue;
        }
        if (path.includes(child.id)) {
          issues.push(`cycle at ${child.id}`);
          continue;
        }
        if (child.mode === "pre_assembled") {
          leaves.set(child.variantId, (leaves.get(child.variantId) ?? 0) + qty);
          continue;
        }
        if (depth + 1 > MAX_DEPTH) {
          issues.push(`depth exceeds ${MAX_DEPTH} at ${child.id}`);
          continue;
        }
        walk(child, qty, depth + 1, [...path, child.id]);
      } else if (line.componentVariantId) {
        leaves.set(line.componentVariantId, (leaves.get(line.componentVariantId) ?? 0) + qty);
      }
    }
  };
  walk(root, MICRO, 1, [root.id]);
  return { leaves, issues };
}

/** Would adding componentKitId as a component of kitId create a cycle or exceed the depth cap? */
export function validateNesting(
  kits: KitIndex,
  kitId: string,
  componentKitId: string,
): { ok: true } | { ok: false; reason: string } {
  if (kitId === componentKitId) return { ok: false, reason: "A kit cannot contain itself." };
  const seen = new Set<string>();
  const reaches = (from: string): boolean => {
    if (from === kitId) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const k = kits.get(from);
    return !!k && k.lines.some((l) => l.componentKitId && reaches(l.componentKitId));
  };
  if (reaches(componentKitId)) return { ok: false, reason: "That would create a loop (A contains B contains A)." };
  const height = (id: string, guard = 0): number => {
    const k = kits.get(id);
    if (!k || guard > 10) return 1;
    let h = 1;
    for (const l of k.lines) if (l.componentKitId) h = Math.max(h, 1 + height(l.componentKitId, guard + 1));
    return h;
  };
  const depthAbove = (id: string, guard = 0): number => {
    let best = 1;
    if (guard > 10) return best;
    for (const k of kits.values())
      if (k.lines.some((l) => l.componentKitId === id)) best = Math.max(best, 1 + depthAbove(k.id, guard + 1));
    return best;
  };
  if (depthAbove(kitId) + height(componentKitId) > MAX_DEPTH)
    return { ok: false, reason: `Nesting is limited to ${MAX_DEPTH} levels.` };
  return { ok: true };
}

export interface ComponentInfo {
  variantId: string;
  exists: boolean;
  /** Available quantity at the location being evaluated. */
  available: number;
  tracked: boolean;
  continueSelling: boolean;
  costCents: number | null;
}

export interface Availability {
  /** null = nothing constrains it (all components unconstrained / no lines). */
  available: number | null;
  limitingVariantId: string | null;
  warnings: string[];
}

/** kit_available = min over leaves of floor(component_available / qty_per_kit), clamped at 0. */
export function deriveAvailability(
  root: KitDef,
  kits: KitIndex,
  info: (variantId: string) => ComponentInfo | undefined,
): Availability {
  const { leaves, issues } = explodeBom(root, kits);
  const warnings = [...issues];
  let best: number | null = null;
  let limiting: string | null = null;
  if (root.lines.some((l) => l.broken)) {
    warnings.push("A BOM line points at a deleted component.");
    return { available: 0, limitingVariantId: null, warnings };
  }
  for (const [variantId, micro] of leaves) {
    const c = info(variantId);
    if (!c || !c.exists) {
      warnings.push(`Component ${variantId} is missing in Shopify.`);
      return { available: 0, limitingVariantId: variantId, warnings };
    }
    if (!c.tracked || c.continueSelling) {
      warnings.push(
        !c.tracked
          ? `${variantId}: inventory tracking is off, so it cannot limit this kit.`
          : `${variantId}: continue-selling is on, so it cannot limit this kit.`,
      );
      continue;
    }
    if (micro <= 0) continue;
    const n = Math.max(0, Math.floor((Math.max(0, c.available) * MICRO) / micro));
    if (best === null || n < best) {
      best = n;
      limiting = variantId;
    }
  }
  return { available: best, limitingVariantId: limiting, warnings };
}
