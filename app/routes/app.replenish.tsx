import { useState } from "react";
import { Link, useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { appContext } from "../server/context.server";
import { handleAction } from "../server/route-helpers.server";
import { renderPoPdf } from "../core/po-pdf";
import { componentRows, money, suggestedOrders, variantLabel } from "../core/views";
import { planAllows } from "../core/plans";
import { canTransition } from "../core/replenish";
import { toCsv } from "../core/csv";
import { Empty, IntentButton, PageHead, Stamp, Toast } from "../components/ui";
import { Button, Select, TextField } from "../components/polaris";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await appContext(request);
  const s = ctx.snapshot;
  const allowed = planAllows(s.plan, "replenishment");
  const url = new URL(request.url);
  const poId = url.searchParams.get("po");
  if (poId && url.searchParams.get("format") === "csv") {
    const po = s.pos.find((p) => p.id === poId);
    if (po) throw new Response(toCsv([["supplier_sku", "sku", "item", "qty", "unit_cost"], ...po.lines.map((l) => [s.meta.find((m) => m.variantId === l.variantId)?.supplierSku ?? "", s.variants[l.variantId]?.sku ?? "", s.variants[l.variantId]?.productTitle ?? "", l.qtyOrdered, l.unitCostCents / 100])]), { headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="PO-${po.number}.csv"` } });
  }
  if (poId && url.searchParams.get("format") === "pdf") {
    const po = s.pos.find((p) => p.id === poId);
    if (po) {
      const bytes = await renderPoPdf({
        number: po.number, supplierName: po.supplierName, shopName: s.shopDomain, status: po.status, freightCents: po.freightCents,
        lines: po.lines.map((l) => ({ sku: s.variants[l.variantId]?.sku ?? "", supplierSku: s.meta.find((m) => m.variantId === l.variantId)?.supplierSku ?? "", item: variantLabel(s.variants[l.variantId]), qty: l.qtyOrdered, unitCostCents: l.unitCostCents })),
      });
      throw new Response(new Blob([bytes as BlobPart], { type: "application/pdf" }), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="PO-${po.number}.pdf"` } });
    }
  }
  const rows = componentRows(s);
  const groups = [...suggestedOrders(rows)].map(([supplier, items]) => ({ supplier, items }));
  return { allowed, rows, groups, pos: s.pos.map((p) => ({ ...p, label: (v: string) => v })), variants: Object.fromEntries(Object.values(s.variants).map((v) => [v.id, `${v.productTitle}`])), locations: s.locations, coverDays: s.settings.coverDays };
};
export const action = ({ request }: ActionFunctionArgs) => handleAction(request);

export default function Replenish() {
  const d = useLoaderData<typeof loader>();
  const create = useFetcher<{ ok: boolean; message: string }>();
  const recv = useFetcher<{ ok: boolean; message: string }>();
  const [receiving, setReceiving] = useState<string | null>(null);
  const [received, setReceived] = useState<Record<string, string>>({});
  if (!d.allowed) return (
    <>
      <PageHead verdict="Reorder math in kit units is part of Kit Desk Pro." sub="Days of cover per component, driven by kit sales velocity, plus purchase orders that update your costs when received." />
      <Button variant="primary" href="/app/pricing">See plans</Button>
    </>
  );
  const low = d.rows.filter((r) => r.reorder);
  const worst = d.rows.find((r) => r.cover != null);
  return (
    <>
      <PageHead lead verdict={low.length ? <>{low.length} part{low.length === 1 ? "" : "s"} will run out before the next order lands.</> : "Every part has enough cover."}
        sub={worst?.cover != null ? <>Tightest: {worst.label} has {Math.round(worst.cover)} days of cover at {worst.burnPerDay.toFixed(1)} a day.</> : "Burn rate needs a few days of kit sales."} />
      <div className="stack">
        <section aria-labelledby="cp">
          <h2 id="cp" className="section-title">Components</h2>
          {d.rows.length === 0 ? <Empty title="No components yet">Add parts to a kit and they will appear here.</Empty> : (
            <div className="table-wrap"><table className="ruled">
              <thead><tr><th scope="col">Part</th><th scope="col">Supplier</th><th scope="col" className="num">On hand</th><th scope="col" className="num">Incoming</th><th scope="col" className="num">Burn per day</th><th scope="col" className="num">Days of cover</th><th scope="col" className="num">Reorder at</th><th scope="col" className="num">Last cost</th></tr></thead>
              <tbody>{d.rows.map((r) => (
                <tr key={r.variantId}>
                  <td><span className="name">{r.label}</span><div className="sku">{r.sku}</div></td>
                  <td>{r.supplierName ?? <span className="muted">Not set</span>}{r.supplierSku ? <div className="sku">{r.supplierSku}</div> : null}</td>
                  <td className="num">{r.onHand}</td><td className="num">{r.incoming}</td><td className="num">{r.burnPerDay.toFixed(1)}</td>
                  <td className="num">{r.cover == null ? "n/a" : <><span className="figure" style={{ color: r.cover < 7 ? "var(--correction)" : undefined }}>{Math.round(r.cover)}</span><div className="bar" data-health={r.cover < 7 ? "red" : r.cover < 14 ? "amber" : "green"}><i style={{ width: `${Math.min(100, (r.cover / 45) * 100)}%` }} /></div></>}</td>
                  <td className="num">{r.reorderAt}</td><td className="num">{r.lastCostCents == null ? "n/a" : money(r.lastCostCents)}</td>
                </tr>))}</tbody>
            </table></div>
          )}
        </section>

        <section id="suggested" aria-labelledby="so">
          <h2 id="so" className="section-title">Suggested orders</h2>
          <p className="muted" style={{ marginBottom: 12 }}>Quantity covers {d.coverDays} days, minus what you hold and what is already on order, rounded up to pack size.</p>
          {d.groups.length === 0 ? <Empty title="Nothing to order">No part is below its reorder point.</Empty> : d.groups.map((g) => (
            <div key={g.supplier} className="batch">
              <header><strong>{g.supplier}</strong>
                <create.Form method="post"><input type="hidden" name="intent" value="create-pos" />
                  <input type="hidden" name="items" value={JSON.stringify(g.items.map((i) => ({ variantId: i.variantId, supplierName: g.supplier, qty: i.suggested, costCents: i.lastCostCents ?? 0 })))} />
                  <Button type="submit" variant="primary" small loading={create.state !== "idle"}>Create draft PO</Button></create.Form></header>
              <ul className="list-plain" style={{ padding: "0 16px" }}>{g.items.map((i) => <li key={i.variantId}><span>{i.label} <span className="sku">{i.sku}</span></span><span><strong>{i.suggested}</strong> units{i.packSize ? ` in packs of ${i.packSize}` : ""}</span></li>)}</ul>
            </div>
          ))}
        </section>

        <section id="orders" aria-labelledby="po">
          <h2 id="po" className="section-title">Purchase orders</h2>
          {d.pos.length === 0 ? <Empty title="No purchase orders">Create a draft from a suggested order above.</Empty> : d.pos.map((p) => (
            <div key={p.id} className="batch">
              <header><span><strong>PO #{p.number}</strong>, {p.supplierName}</span>
                <span className="row"><Stamp tone={p.status === "received" || p.status === "closed" ? "ok" : p.status === "draft" ? "quiet" : "warn"}>{p.status.replace("_", " ")}</Stamp>
                  <Button small href={`/app/replenish?po=${p.id}&format=pdf`} download>PDF</Button>
                  <Button small href={`/app/replenish?po=${p.id}&format=csv`} download>CSV</Button>
                  {canTransition(p.status, "sent") && p.status === "draft" ? <IntentButton intent="po-status" fields={{ poId: p.id, to: "sent" }} small variant="primary">Mark sent</IntentButton> : null}
                  {(p.status === "sent" || p.status === "partially_received") ? <Button small onClick={() => setReceiving(receiving === p.id ? null : p.id)}>Receive</Button> : null}
                  {canTransition(p.status, "closed") ? <IntentButton intent="po-status" fields={{ poId: p.id, to: "closed" }} small variant="quiet">Close</IntentButton> : null}
                </span></header>
              <ul className="list-plain" style={{ padding: "0 16px" }}>{p.lines.map((l) => (
                <li key={l.id}><span>{d.variants[l.variantId] ?? l.variantId}</span>
                  <span>{l.qtyReceived} of {l.qtyOrdered} at {money(l.unitCostCents)}
                    {receiving === p.id ? <span style={{ display: "inline-block", width: 112, marginLeft: 12, verticalAlign: "middle" }}><TextField label={`Received quantity for ${d.variants[l.variantId]}`} labelHidden type="number" min="0" max={String(l.qtyOrdered - l.qtyReceived)} value={received[l.id] ?? ""} placeholder={String(l.qtyOrdered - l.qtyReceived)} onValue={(v) => setReceived({ ...received, [l.id]: v })} /></span> : null}</span></li>))}
              </ul>
              {receiving === p.id ? (
                <recv.Form method="post" className="row" style={{ padding: 16 }}>
                  <input type="hidden" name="intent" value="po-receive" /><input type="hidden" name="poId" value={p.id} />
                  <input type="hidden" name="received" value={JSON.stringify(Object.fromEntries(p.lines.map((l) => [l.id, Number(received[l.id] ?? l.qtyOrdered - l.qtyReceived)])))} />
                  {d.locations.length > 1 ? <Select label="Receive at" name="locationId" options={d.locations.map((l) => ({ value: l.id, label: l.name }))} /> : null}
                  <Button type="submit" variant="primary" loading={recv.state !== "idle"}>Receive into Shopify</Button>
                  <span className="hint">Adds stock at the chosen location, updates the weighted average cost, and spreads freight ({money(p.freightCents)}).</span>
                </recv.Form>
              ) : null}
            </div>
          ))}
        </section>
      </div>
      <Toast result={create.data ?? recv.data ?? null} />
    </>
  );
}
