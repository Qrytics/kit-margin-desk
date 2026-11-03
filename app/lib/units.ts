/** Quantities are tracked in micro-units (1 unit = 10_000) so fractional BOM math is exact. */
export const MICRO = 10_000;

export const toMicro = (qty: number): number => Math.round(qty * MICRO);
export const fromMicro = (micro: number): number => micro / MICRO;

/** Floor division that rounds toward -infinity (JS % and / do not). */
export const floorDiv = (a: number, b: number): number => Math.floor(a / b);

/** (1 + bps/10000) applied to a micro-quantity, rounded. */
export const withWaste = (micro: number, wasteBps: number): number =>
  Math.round((micro * (10_000 + wasteBps)) / 10_000);

export const centsToDollars = (c: number): number => c / 100;
export const dollarsToCents = (d: number | string): number => Math.round(Number(d) * 100 * 1000) / 1000;
