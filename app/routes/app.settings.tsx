import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { appContext } from "../server/context.server";
import { handleAction } from "../server/route-helpers.server";
import { PLANS, planAllows } from "../core/plans";
import { BOM_HEADER, toCsv } from "../core/csv";
import { rollupCost } from "../core/margin";
import { indexKits } from "../core/bom";
import { unitCostFn, variantLabel } from "../core/views";
import { buildDigest } from "../core/digest";
import { PageHead, Stamp, Toast } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await appContext(request);
  const s = ctx.snapshot;
  const url = new URL(request.url);
  const exp = url.searchParams.get("export");
  if (exp) {
    const sku = (id: string | null | undefined) => (id ? s.variants[id]?.sku ?? id : "");
    if (exp === "bom") {
      if (!planAllows(s.plan, "csv")) throw new Response("CSV export is part of Kit Desk and above.", { status: 402 });
      const rows = s.kits.flatMap((k) => k.lines.map((l) => [sku(k.variantId), l.componentKitId ? sku(s.kits.find((x) => x.id === l.componentKitId)?.variantId) : sku(l.componentVariantId), l.qtyPerKit, l.wasteBps / 100]));
      throw new Response(toCsv([[...BOM_HEADER], ...rows]), { headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="boms.csv"' } });
    }
    if (exp === "all") {
      const cost = unitCostFn(s), idx = indexKits(s.kits);
      const body = [
        "# boms", toCsv([[...BOM_HEADER], ...s.kits.flatMap((k) => k.lines.map((l) => [sku(k.variantId), sku(l.componentVariantId), l.qtyPerKit, l.wasteBps / 100]))]),
        "# costs", toCsv([["kit_sku", "landed_cost"], ...s.kits.map((k) => [sku(k.variantId), rollupCost(k, idx, cost).totalCents / 100])]),
        "# ledger", toCsv([["time", "source", "ref", "sku", "location", "delta", "before", "after", "status"], ...s.ledger.flatMap((b) => b.entries.map((e) => [b.at, b.sourceType, b.sourceRef, e.sku, e.locationId, e.delta, e.beforeQty, e.afterQty, e.status]))]),
      ].join("\n\n");
      throw new Response(body, { headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="kit-margin-desk-export.csv"' } });
    }
  }
  const preview = planAllows(s.plan, "digest") ? buildDigest(s) : null;
  return { preview: preview ? { subject: preview.subject, text: preview.text } : null, settings: s.settings, locations: s.locations, paused: s.syncPaused, syncEnabled: s.syncEnabled, plan: s.plan, csv: planAllows(s.plan, "csv"), digest: planAllows(s.plan, "digest"), used: s.kitOrdersThisMonth, cap: PLANS[s.plan].kitOrdersPerMonth, names: Object.fromEntries(Object.values(s.variants).map((v) => [v.id, variantLabel(v)])) };
};
export const action = ({ request }: ActionFunctionArgs) => handleAction(request);

export default function Settings() {
  const d = useLoaderData<typeof loader>();
  const save = useFetcher<{ ok: boolean; message: string }>();
  const kill = useFetcher<{ ok: boolean; message: string }>();
  const csv = useFetcher<{ ok: boolean; message: string; data?: { rows: unknown[]; errors: Array<{ line: number; message: string }>; unmatched: Array<{ line: number; sku: string; role: string }> } }>();
  const [text, setText] = useState("kit_sku,component_sku,qty_per_kit,waste_pct\n");
  const rep = csv.data?.data;
  return (
    <>
      <PageHead verdict="You are in control of every automated change." sub={`${PLANS[d.plan].label} plan. ${d.cap ? `${d.used} of ${d.cap} kit orders used this month.` : `${d.used} kit orders this month, no cap.`}`} />
      <div className="stack">
        <div className="kill" data-paused={d.paused} role="group" aria-label="Pause all sync">
          <div style={{ flex: 1 }}><div className="state">{d.paused ? "All sync is paused" : d.syncEnabled ? "Live sync is running" : "Live sync is off"}</div>
            <p className="muted">{d.paused ? "Webhooks are still recorded so nothing is lost, but no stock is written to Shopify." : "Pause stops every write instantly: orders, refunds, builds, receipts and reconciliation."}</p></div>
          <kill.Form method="post"><button className={`btn ${d.paused ? "btn--primary" : "btn--danger"}`} name="intent" value={d.paused ? "resume-all" : "pause-all"} disabled={kill.state !== "idle"}>{d.paused ? "Resume sync" : "Pause all sync"}</button></kill.Form>
        </div>

        <save.Form method="post" className="panel stack stack--tight" aria-labelledby="def">
          <h2 id="def">Defaults</h2>
          <div className="grid-form">
            <label className="field">Default location
              <select name="defaultLocationId" defaultValue={d.settings.defaultLocationId ?? ""}><option value="">Primary location</option>{d.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
              <span className="hint">Used when an order has no assigned location. Those rows are flagged as assumed.</span></label>
            <label className="field">Labor rate per hour<input name="laborRate" type="number" step="0.01" min="0" defaultValue={(d.settings.laborRateCents / 100).toFixed(2)} /></label>
            <label className="field">Default landed uplift %<input name="upliftPct" type="number" step="0.5" min="0" defaultValue={d.settings.landedUpliftBps / 100} /></label>
            <label className="field">Healthy margin from %<input name="targetPct" type="number" step="1" min="0" max="100" defaultValue={d.settings.targetMarginPct} /></label>
            <label className="field">Alert below %<input name="alertPct" type="number" step="1" min="0" max="100" defaultValue={d.settings.alertMarginPct} /></label>
            <label className="field">Days of cover to order for<input name="coverDays" type="number" min="1" defaultValue={d.settings.coverDays} /></label>
          </div>
          <label className="check"><input type="checkbox" name="pushCost" defaultChecked={d.settings.pushCostToShopify} /><span>When a PO is received, also write the new average cost to Shopify cost per item</span></label>
          <label className="check"><input type="checkbox" name="digest" defaultChecked={d.settings.digest} disabled={!d.digest} /><span>Daily digest email {d.digest ? "" : "(Kit Desk Pro)"}</span></label>
          {d.digest ? (
            <div className="grid-form">
              <label className="field">Send digest to<input name="digestEmail" type="email" defaultValue={d.settings.digestEmail} placeholder="Shop owner email" /><span className="hint">Losing kits, supplier cost changes and parts to reorder. Delivered through the mail relay configured by DIGEST_WEBHOOK_URL.</span></label>
              <label className="check"><input type="checkbox" name="digestAlways" defaultChecked={d.settings.digestAlways} /><span>Also send on quiet days</span></label>
            </div>
          ) : null}
          <div><button className="btn btn--primary" name="intent" value="save-settings" disabled={save.state !== "idle"}>Save settings</button></div>
        </save.Form>

        {d.preview ? (
          <section className="panel stack stack--tight" aria-labelledby="dgp">
            <h2 id="dgp">Digest preview</h2>
            <p className="muted">This is what tomorrow&apos;s email would say right now.</p>
            <p><strong>{d.preview.subject}</strong></p>
            <pre className="preview">{d.preview.text}</pre>
          </section>
        ) : null}

        <section id="csv" className="panel stack stack--tight" aria-labelledby="csvh">
          <div className="row row--between"><h2 id="csvh">Import and export BOMs</h2>{!d.csv ? <Stamp tone="warn">Kit Desk and above</Stamp> : null}</div>
          <csv.Form method="post" className="stack stack--tight">
            <label className="field">Paste CSV (kit_sku, component_sku, qty_per_kit, waste_pct)
              <textarea name="csv" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} disabled={!d.csv} /></label>
            <div className="row">
              <button className="btn" name="intent" value="import-csv" disabled={!d.csv || csv.state !== "idle"}>Check file</button>
              <button className="btn btn--primary" name="intent" value="import-csv" onClick={(e) => { const f = e.currentTarget.form!; let h = f.querySelector<HTMLInputElement>("input[name=commit]"); if (!h) { h = document.createElement("input"); h.type = "hidden"; h.name = "commit"; f.appendChild(h); } h.value = "1"; }} disabled={!d.csv || csv.state !== "idle" || !rep || rep.rows.length === 0}>Import {rep ? rep.rows.length : ""} rows</button>
              <a className="btn" href="/app/settings?export=bom" download aria-disabled={!d.csv}>Export BOMs</a>
            </div>
          </csv.Form>
          {rep ? (
            <div className={`callout ${rep.errors.length || rep.unmatched.length ? "callout--warn" : "callout--ok"}`} role="status">
              <div><strong>{rep.rows.length} rows ready.</strong>
                {rep.unmatched.length ? <ul>{rep.unmatched.map((u, i) => <li key={i}>Line {u.line}: no {u.role} with SKU {u.sku} in your store.</li>)}</ul> : null}
                {rep.errors.length ? <ul>{rep.errors.map((e, i) => <li key={i}>Line {e.line}: {e.message}</li>)}</ul> : null}</div>
            </div>
          ) : null}
        </section>

        <section className="panel stack stack--tight" aria-labelledby="dz">
          <h2 id="dz">Danger zone and data</h2>
          <p className="muted">Take everything with you at any time. Exports include BOMs, costs and the full adjustment ledger.</p>
          <div className="row">
            <a className="btn" href="/app/settings?export=all" download>Export all data (CSV)</a>
            <kill.Form method="post"><button className="btn" name="intent" value="resync" disabled={kill.state !== "idle"}>Resync now</button></kill.Form>
          </div>
        </section>
      </div>
      <Toast result={save.data ?? kill.data ?? (csv.data && !csv.data.data ? csv.data : null)} />
    </>
  );
}
