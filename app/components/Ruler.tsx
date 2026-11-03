import { money } from "../core/views";

export interface RulerParts { materialsCents: number; upliftCents: number; packagingCents: number; laborCents: number; priceCents: number }

/**
 * Signature element: a 0-to-price ruler. Each segment is where part of the price goes
 * (parts, uplift, packaging, labor); what is left is margin. Over-cost kits overflow in hatching.
 */
export function Ruler({ parts, size = "default" }: { parts: RulerParts; size?: "default" | "mini" | "big" }) {
  const cost = parts.materialsCents + parts.upliftCents + parts.packagingCents + parts.laborCents;
  const price = Math.max(parts.priceCents, 1);
  const scale = Math.max(price, cost);
  const w = (c: number) => `${(Math.max(0, c) / scale) * 100}%`;
  const margin = parts.priceCents - cost;
  const over = cost > parts.priceCents;
  const segs = [
    ["materials", "Parts", parts.materialsCents], ["uplift", "Landed uplift", parts.upliftCents],
    ["packaging", "Packaging", parts.packagingCents], ["labor", "Labor", parts.laborCents],
  ] as const;
  return (
    <div className={`ruler${size === "default" ? "" : ` ruler--${size}`}`} data-over={over} role="img"
         aria-label={`Of a ${money(parts.priceCents)} price: ${segs.map(([, n, v]) => `${n} ${money(v)}`).join(", ")}, ${over ? `loss ${money(-margin)}` : `margin ${money(margin)}`}`}>
      <div className="ruler__track">
        {segs.map(([k, , v]) => v > 0 ? <span key={k} className="ruler__seg" data-k={k} style={{ width: w(v) }} /> : null)}
        {!over && margin > 0 ? <span className="ruler__seg" data-k="margin" style={{ width: w(margin) }} /> : null}
      </div>
      <div className="ruler__ticks" aria-hidden="true"><span>$0</span><span>{over ? `cost ${money(cost)}` : ""}</span><span>{money(parts.priceCents)}</span></div>
      <div className="ruler__legend" aria-hidden="true">
        {segs.map(([k, n]) => <span key={k}><i style={{ background: `var(--${k === "materials" ? "ink" : k === "uplift" ? "ink-3" : k === "packaging" ? "hairline-strong" : "caution"})` }} />{n}</span>)}
        <span><i style={{ background: "var(--gain)" }} />Margin</span>
      </div>
    </div>
  );
}
