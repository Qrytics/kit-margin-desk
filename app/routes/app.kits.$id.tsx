import { useMemo, useState } from "react";
import { Link, useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { appContext } from "../server/context.server";
import { handleAction } from "../server/route-helpers.server";
import { deriveAvailability, indexKits, type KitDef } from "../core/bom";
import { marginFor, rollupCost } from "../core/margin";
import { money, unitCostFn, primaryLocationId, variantLabel } from "../core/views";
import { PLANS, planAllows } from "../core/plans";
import { kitAvailabilityByLocation } from "../core/locations";
import { PageHead, Toast, HealthStamp, pct } from "../components/ui";
import { Ruler } from "../components/Ruler";
import { VariantPicker } from "../components/VariantPicker";
import { Banner, Button, Checkbox, Select, TextField } from "../components/polaris";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const ctx = await appContext(request);
  const s = ctx.snapshot;
  const kit = s.kits.find((k) => k.id === params.id);
  if (!kit) throw new Response("Kit not found", { status: 404 });
  const cost = unitCostFn(s);
  const ids = new Set<string>([kit.variantId]);
  s.kits.forEach((k) => k.lines.forEach((l) => l.componentVariantId && ids.add(l.componentVariantId)));
  const info = Object.fromEntries([...ids].map((id) => {
    const v = s.variants[id];
    return [id, { label: variantLabel(v), sku: v?.sku ?? null, costCents: cost(id), priceCents: v?.priceCents ?? 0, compareAtCents: v?.compareAtCents ?? null, available: v?.levels[primaryLocationId(s)] ?? 0, tracked: v?.tracked ?? false, continueSelling: v?.continueSelling ?? false, exists: v?.exists ?? false }];
  }));
  const byLoc = kitAvailabilityByLocation(kit, s.kits, s.variants, s.locations);
  const nameOf = (id: string | null) => (id ? variantLabel(s.variants[id]) : null);
  const perLocation = {
    multi: planAllows(s.plan, "multiLocation") && s.locations.length > 1, total: byLoc.total, best: byLoc.best,
    rows: byLoc.rows.map((r) => ({ id: r.locationId, name: r.name, available: r.available, limiting: nameOf(r.limitingVariantId), notStocked: r.notStocked.map((v) => nameOf(v)) })),
  };
  return {
    perLocation, kit, kits: s.kits, info, settings: s.settings, plan: s.plan, canBuild: planAllows(s.plan, "buildMode"), locations: s.locations,
    others: s.kits.filter((k) => k.id !== kit.id).map((k) => ({ id: k.id, title: k.title })),
    shopifyCostCents: s.variants[kit.variantId]?.costCents ?? null,
  };
};
export const action = ({ request }: ActionFunctionArgs) => handleAction(request);

interface Line { key: string; componentVariantId?: string; componentKitId?: string; label: string; qty: string; wastePct: string; uom: string }
let k = 0;

export default function KitEditor() {
  const d = useLoaderData<typeof loader>();
  const save = useFetcher<{ ok: boolean; message: string }>();
  const act = useFetcher<{ ok: boolean; message: string; data?: { partial?: number } }>();
  const [lines, setLines] = useState<Line[]>(() => d.kit.lines.map((l) => ({
    key: `l${k++}`, componentVariantId: l.componentVariantId ?? undefined, componentKitId: l.componentKitId ?? undefined,
    label: l.componentKitId ? `Kit: ${d.others.find((o) => o.id === l.componentKitId)?.title ?? "?"}` : d.info[l.componentVariantId!]?.label ?? "Unknown",
    qty: String(l.qtyPerKit), wastePct: String(l.wasteBps / 100), uom: l.uom ?? "pcs",
  })));
  const [mode, setMode] = useState(d.kit.mode);
  const [packaging, setPackaging] = useState((d.kit.packagingCostCents / 100).toFixed(2));
  const [labor, setLabor] = useState(String(d.kit.laborMinutes));
  const [uplift, setUplift] = useState((d.kit.landedUpliftBps / 100).toString());
  const [manage, setManage] = useState(d.kit.manageAvailability);
  const [whatIf, setWhatIf] = useState("");
  const [cloneTo, setCloneTo] = useState<{ id: string; label: string } | null>(null);
  const [qty, setQty] = useState("10");

  const draft: KitDef = useMemo(() => ({
    ...d.kit, mode, packagingCostCents: Math.round(Number(packaging) * 100) || 0, laborMinutes: Number(labor) || 0, landedUpliftBps: Math.round(Number(uplift) * 100) || 0,
    lines: lines.map((l) => ({ componentVariantId: l.componentVariantId, componentKitId: l.componentKitId, qtyPerKit: Number(l.qty) || 0, wasteBps: Math.round((Number(l.wastePct) || 0) * 100) })),
  }), [d.kit, lines, mode, packaging, labor, uplift]);
  const idx = useMemo(() => indexKits(d.kits.map((x) => (x.id === draft.id ? draft : x))), [d.kits, draft]);
  const cost = (id: string) => d.info[id]?.costCents ?? null;
  const c = rollupCost(draft, idx, cost);
  const price = d.info[d.kit.variantId]?.priceCents ?? 0;
  const compare = d.info[d.kit.variantId]?.compareAtCents ?? null;
  const t = { targetPct: d.settings.targetMarginPct, alertPct: d.settings.alertMarginPct };
  const m = marginFor(price, c.totalCents, t, c.missingCosts.length > 0);
  const wi = whatIf !== "" ? marginFor(Math.round(Number(whatIf) * 100), c.totalCents, t) : null;
  const av = deriveAvailability(draft, idx, (id) => { const i = d.info[id]; return i ? { variantId: id, exists: i.exists, available: i.available, tracked: i.tracked, continueSelling: i.continueSelling, costCents: i.costCents } : undefined; });

  const addVariant = (v: { id: string; label: string }) => setLines((ls) => [...ls, { key: `l${k++}`, componentVariantId: v.id, label: v.label, qty: "1", wastePct: "0", uom: "pcs" }]);
  const upd = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const payload = JSON.stringify(lines.map((l) => ({ componentVariantId: l.componentVariantId, componentKitId: l.componentKitId, qty: Number(l.qty), wastePct: Number(l.wastePct), uom: l.uom })));
  const lineCost = (l: Line) => {
    const q = (Number(l.qty) || 0) * (1 + (Number(l.wastePct) || 0) / 100);
    if (l.componentKitId) { const kk = idx.get(l.componentKitId); return kk ? rollupCost(kk, idx, cost).totalCents * q : 0; }
    return (cost(l.componentVariantId!) ?? 0) * q;
  };
  const badLine = (l: Line) => !(Number(l.qty) > 0) || Math.round(Number(l.qty) * 1000) / 1000 !== Number(l.qty);

  return (
    <>
      <PageHead verdict={<>{d.kit.title} {m.marginCents < 0 ? <>loses {money(-m.marginCents)} per kit.</> : <>earns {money(m.marginCents)} per kit.</>}</>}
        sub={<>Landed cost <strong>{money(c.totalCents)}</strong> against a price of {money(price)}. {av.available !== null ? `You can sell ${av.available} right now.` : "No tracked part limits this kit."}</>}>
        <Button href="/app">Back to kits</Button>
      </PageHead>

      <section className="readout" aria-label="Where the price goes" style={{ marginBottom: 24 }}>
        <Ruler size="big" parts={{ materialsCents: c.materialsCents, upliftCents: c.upliftCents, packagingCents: c.packagingCents, laborCents: c.laborCents, priceCents: price }} />
      </section>

      <div className="cols">
        <div className="stack">
          <section aria-labelledby="bom">
            <h2 id="bom" className="section-title">Bill of materials</h2>
            {lines.length === 0 ? <div className="empty"><h3>No parts yet</h3><p className="muted">Search below and add each product or ingredient this kit uses.</p></div> : (
              <div className="table-wrap">
                <table className="ruled bom-table">
                  <thead><tr><th scope="col">Part</th><th scope="col" className="num">Qty per kit</th><th scope="col">Unit</th><th scope="col" className="num">Waste %</th><th scope="col" className="num">Line cost</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
                  <tbody>
                    {lines.map((l) => {
                      const info = l.componentVariantId ? d.info[l.componentVariantId] : null;
                      return (
                        <tr key={l.key} className="bom-line">
                          <td><span className="name">{l.label}</span>
                            <div className="sku">{info?.sku ?? ""}{info && !info.exists ? <> <span className="stamp stamp--bad">Broken: deleted in Shopify</span></> : null}{info && info.exists && (!info.tracked || info.continueSelling) ? <> <span className="stamp stamp--warn">Cannot limit this kit</span></> : null}{info && info.costCents == null ? <> <span className="stamp stamp--warn">No cost</span></> : null}</div></td>
                          <td className="num"><TextField label={`Quantity of ${l.label}`} labelHidden type="number" step="0.001" min="0" value={l.qty} error={badLine(l) ? "Positive, up to 3 decimals" : undefined} onValue={(v) => upd(l.key, { qty: v })} /></td>
                          <td><TextField label={`Unit for ${l.label}`} labelHidden value={l.uom} onValue={(v) => upd(l.key, { uom: v.slice(0, 12) })} /></td>
                          <td className="num"><TextField label={`Waste percent for ${l.label}`} labelHidden type="number" step="0.5" min="0" max="100" value={l.wastePct} onValue={(v) => upd(l.key, { wastePct: v })} /></td>
                          <td className="num">{money(Math.round(lineCost(l)))}</td>
                          <td><Button variant="quiet" small onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} label={`Remove ${l.label}`}>Remove</Button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="grid-form" style={{ marginTop: 16, alignItems: "end" }}>
              <VariantPicker onPick={addVariant} />
              <Select label="Or nest another kit (3 levels max)" value="" onValue={(v) => { const o = d.others.find((x) => x.id === v); if (o) setLines((ls) => [...ls, { key: `l${k++}`, componentKitId: o.id, label: `Kit: ${o.title}`, qty: "1", wastePct: "0", uom: "pcs" }]); }}
                options={[{ value: "", label: "Choose a kit" }, ...d.others.map((o) => ({ value: o.id, label: o.title }))]} />
            </div>
          </section>

          <section className="panel" aria-labelledby="extras">
            <h2 id="extras">Kit settings</h2>
            <div className="grid-form">
              <Select label="Stock mode" value={mode} onValue={(v) => setMode(v as typeof mode)} options={[{ value: "assemble_on_order", label: "Assemble on order (stock is virtual)" }, { value: "pre_assembled", label: "Pre-assembled (kit has real stock)" }]} />
              <TextField label="Packaging cost per kit" type="number" step="0.01" min="0" value={packaging} onValue={setPackaging} />
              <TextField label="Labor minutes per kit" type="number" step="0.5" min="0" value={labor} onValue={setLabor} hint={`At ${money(d.settings.laborRateCents)} an hour.`} />
              <TextField label="Landed uplift %" type="number" step="0.5" min="0" value={uplift} onValue={setUplift} hint="Freight and duty on materials." />
            </div>
            {mode === "assemble_on_order" ? (
              <div style={{ marginTop: 12 }}><Checkbox checked={manage} onChecked={setManage} label="Let the app write this kit's available quantity to Shopify (derived from parts)" /></div>
            ) : null}
            <div className="row" style={{ marginTop: 16 }}>
              <save.Form method="post">
                <input type="hidden" name="intent" value="save-kit" /><input type="hidden" name="kitId" value={d.kit.id} /><input type="hidden" name="lines" value={payload} />
                <input type="hidden" name="mode" value={mode} /><input type="hidden" name="packaging" value={packaging} /><input type="hidden" name="laborMinutes" value={labor} />
                <input type="hidden" name="upliftPct" value={uplift} />{manage ? <input type="hidden" name="manage" value="on" /> : null}
                <Button type="submit" variant="primary" disabled={lines.some(badLine)} loading={save.state !== "idle"}>Save kit</Button>
              </save.Form>
              {lines.some(badLine) ? <span className="hint" role="alert">Fix quantities: positive, up to 3 decimals.</span> : null}
            </div>
          </section>
        </div>

        <aside className="stack" aria-label="Cost rollup">
          {d.perLocation.multi ? (
            <section className="panel" aria-labelledby="loc">
              <h2 id="loc">Can sell by location</h2>
              <table className="ruled">
                <thead><tr><th scope="col">Location</th><th scope="col" className="num">Kits</th><th scope="col">Held back by</th></tr></thead>
                <tbody>{d.perLocation.rows.map((r) => (
                  <tr key={r.id}><td>{r.name}{d.perLocation.best === r.id ? <> <span className="stamp stamp--ok">Most stock</span></> : null}</td>
                    <td className="num figure">{r.available ?? "n/a"}</td>
                    <td>{r.notStocked.length ? <span className="muted">Not stocked here: {r.notStocked.join(", ")}</span> : r.limiting ?? <span className="muted">Nothing</span>}</td></tr>))}</tbody>
              </table>
              <p className="hint" style={{ marginTop: 8 }}>A kit ships from one place, so locations are not added together. Total across sites: {d.perLocation.total}.</p>
            </section>
          ) : null}
          <section className="panel">
            <h2>Landed cost</h2>
            <div className="rollup" role="table" aria-label="Cost breakdown">
              <div><span>Materials (with waste)</span><span>{money(c.materialsCents)}</span></div>
              <div><span>Landed uplift</span><span>{money(c.upliftCents)}</span></div>
              <div><span>Packaging</span><span>{money(c.packagingCents)}</span></div>
              <div><span>Labor</span><span>{money(c.laborCents)}</span></div>
              <div className="total"><span>Total landed cost</span><span className="figure">{money(c.totalCents)}</span></div>
              <div><span>Margin at {money(price)}</span><span><strong>{money(m.marginCents)}</strong> ({pct(m.marginPct)}) <HealthStamp health={m.health} /></span></div>
              {compare ? <div><span>Margin at compare-at {money(compare)}</span><span>{pct(marginFor(compare, c.totalCents, t).marginPct)}</span></div> : null}
            </div>
            {c.missingCosts.length ? <Banner tone="warn" role="status" style={{ marginTop: 12 }}>{c.missingCosts.length} part{c.missingCosts.length === 1 ? " has" : "s have"} no cost, so this margin looks better than it is.</Banner> : null}
          </section>
          <section className="panel">
            <h3>What if the price were</h3>
            <TextField label="Candidate price" labelHidden type="number" step="0.01" min="0" value={whatIf} placeholder={(price / 100).toFixed(2)} onValue={setWhatIf} />
            {wi ? <p style={{ marginTop: 8 }}>Margin would be <strong>{money(wi.marginCents)}</strong>, {pct(wi.marginPct)}.</p> : <p className="muted" style={{ marginTop: 8 }}>Type a price to see margin move.</p>}
          </section>
          <section className="panel stack stack--tight">
            <h3>Actions</h3>
            <act.Form method="post"><input type="hidden" name="intent" value="push-cost" /><input type="hidden" name="kitId" value={d.kit.id} />
              <Button type="submit" loading={act.state !== "idle"}>{`Push ${money(c.totalCents)} to Shopify cost per item`}</Button></act.Form>
            <span className="hint">Shopify currently holds {d.shopifyCostCents == null ? "no cost" : money(d.shopifyCostCents)} for this variant.</span>
            {cloneTo ? (
              <act.Form method="post" className="row"><input type="hidden" name="intent" value="clone-kit" /><input type="hidden" name="kitId" value={d.kit.id} /><input type="hidden" name="targetVariantId" value={cloneTo.id} />
                <span>Clone to <strong>{cloneTo.label}</strong></span><Button type="submit" variant="primary" small>Clone</Button><Button variant="quiet" small onClick={() => setCloneTo(null)}>Cancel</Button></act.Form>
            ) : <VariantPicker label="Clone this kit to another variant" placeholder="Scent or size variant" onPick={(v) => setCloneTo({ id: v.id, label: v.label })} />}
            {mode === "pre_assembled" ? (
              d.canBuild ? (
                <act.Form method="post" className="stack stack--tight"><input type="hidden" name="intent" value="build" /><input type="hidden" name="kitId" value={d.kit.id} />
                  <TextField label="Build how many kits?" name="qty" type="number" min="1" value={qty} onValue={setQty} />
                  {d.locations.length > 1 ? <Select label="Location" name="locationId" options={d.locations.map((l) => ({ value: l.id, label: l.name }))} /> : null}
                  {act.data?.data?.partial ? <Checkbox name="confirmPartial" label={`Build only ${act.data.data.partial} (components run short)`} /> : null}
                  <Button type="submit">Build kits</Button></act.Form>
              ) : <p className="muted">Build mode is part of {PLANS.kit_desk_pro.label}. <Link to="/app/pricing">See plans</Link></p>
            ) : null}
          </section>
        </aside>
      </div>
      <Toast result={save.data ?? act.data ?? null} />
    </>
  );
}
