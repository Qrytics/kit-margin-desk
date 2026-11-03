import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

export interface PickResult { id: string; label: string; sku: string | null; costCents: number | null; priceCents: number }

/** Search by title or SKU, debounced. Keyboard: arrows are native via list buttons; Escape closes. */
export function VariantPicker({ onPick, placeholder = "Search products or SKU", label = "Add a component" }: { onPick: (v: PickResult) => void; placeholder?: string; label?: string }) {
  const f = useFetcher<{ results: PickResult[] }>();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open) return;
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => f.load(`/app/api/variants?q=${encodeURIComponent(q)}`), 200);
    return () => { if (t.current) clearTimeout(t.current); };
  }, [q, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const results = f.data?.results ?? [];
  return (
    <div onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <label className="field">{label}
        <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder={placeholder} role="combobox" aria-expanded={open} aria-controls="variant-results" autoComplete="off" />
      </label>
      {open ? (
        <ul id="variant-results" className="search-results" role="listbox" aria-label="Matching variants">
          {f.state === "loading" && !results.length ? <li className="muted" style={{ padding: 12 }}>Searching</li> : null}
          {results.map((r) => (
            <li key={r.id} role="option" aria-selected={false}>
              <button type="button" onClick={() => { onPick(r); setOpen(false); setQ(""); }}>
                <span>{r.label}<span className="sku"> {r.sku ?? "no SKU"}</span></span>
                <span className="muted">{r.costCents == null ? "no cost" : `cost ${(r.costCents / 100).toFixed(2)}`}</span>
              </button>
            </li>
          ))}
          {f.state === "idle" && f.data && !results.length ? <li className="muted" style={{ padding: 12 }}>No variants match.</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
