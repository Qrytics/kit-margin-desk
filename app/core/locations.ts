import { deriveAvailability, indexKits, type KitDef } from "./bom";
import type { VariantInfo } from "./types";

export interface LocationAvailability {
  locationId: string;
  name: string;
  /** null = nothing at this location constrains the kit */
  available: number | null;
  /** variantId of the component that limits the kit here */
  limitingVariantId: string | null;
  /** components that are not stocked at all at this location */
  notStocked: string[];
  warnings: string[];
}

export interface KitLocationReport {
  rows: LocationAvailability[];
  /** sum of per-location availability (a kit is built from parts at one location; stock does not pool) */
  total: number;
  /** location with the most buildable kits, null when nothing is buildable anywhere */
  best: string | null;
}

/**
 * Per-location kit availability. For each location the same min-over-components rule as the single-location
 * view is applied to that location's component levels only. A component with no inventory level at a
 * location counts as 0 there (it can't be sold from that location), and is listed in notStocked.
 * Kits are not pooled across locations: a kit fulfilled from one site needs all parts at that site.
 */
export function kitAvailabilityByLocation(
  kit: KitDef,
  allKits: KitDef[],
  variants: Record<string, VariantInfo>,
  locations: Array<{ id: string; name: string }>,
): KitLocationReport {
  const idx = indexKits(allKits);
  const rows = locations.map((loc): LocationAvailability => {
    const notStocked: string[] = [];
    const av = deriveAvailability(kit, idx, (id) => {
      const v = variants[id];
      if (!v) return undefined;
      const stocked = loc.id in v.levels;
      if (!stocked && v.exists && v.tracked && !v.continueSelling && !notStocked.includes(id)) notStocked.push(id);
      return { variantId: id, exists: v.exists, available: v.levels[loc.id] ?? 0, tracked: v.tracked, continueSelling: v.continueSelling, costCents: v.costCents };
    });
    return { locationId: loc.id, name: loc.name, available: av.available, limitingVariantId: av.limitingVariantId, notStocked, warnings: av.warnings };
  });
  const total = rows.reduce((a, r) => a + (r.available ?? 0), 0);
  let best: string | null = null, bestN = 0;
  for (const r of rows) if ((r.available ?? 0) > bestN) { best = r.locationId; bestN = r.available ?? 0; }
  return { rows, total, best };
}
