import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { appContext } from "../server/context.server";
import { handleAction } from "../server/route-helpers.server";
import { Empty, PageHead, Stamp, Toast, signed, when } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { snapshot: s } = await appContext(request);
  return { batches: s.ledger, locations: Object.fromEntries(s.locations.map((l) => [l.id, l.name])), paused: s.syncPaused };
};
export const action = ({ request }: ActionFunctionArgs) => handleAction(request);

const LABEL: Record<string, string> = { order: "Order", refund: "Refund", cancel: "Cancellation", fulfillment: "Fulfillment", build: "Build", po_receipt: "PO receipt", reconciliation: "Reconciliation", manual: "Manual", undo: "Undo" };

export default function Ledger() {
  const d = useLoaderData<typeof loader>();
  const f = useFetcher<{ ok: boolean; message: string }>();
  const [open, setOpen] = useState<string | null>(d.batches[0]?.id ?? null);
  const [filter, setFilter] = useState("all");
  const list = d.batches.filter((b) => filter === "all" || b.sourceType === filter);
  const stuck = f.data && !f.data.ok && /compensating/i.test(f.data.message);
  return (
    <>
      <PageHead verdict={d.batches.length ? <>Every stock change the app made, with the receipt.</> : "Nothing has been adjusted yet."} sub="Each row shows before and after. Undo reverses the exact amounts. If something else moved the stock since, the app says so and offers a compensating adjustment instead." />
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="pill-tabs" role="group" aria-label="Filter by source">
          {["all", "order", "refund", "build", "po_receipt", "reconciliation", "undo"].map((k) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{k === "all" ? "All" : LABEL[k]}</button>)}
        </div>
      </div>
      {list.length === 0 ? <Empty title="No entries">When sync is live, each kit order, refund, build and receipt lands here.</Empty> : list.map((b) => {
        const isOpen = open === b.id;
        const skipped = b.entries.filter((e) => e.status !== "applied").length;
        return (
          <article key={b.id} className="batch" data-undone={b.undone}>
            <header>
              <button className="sort" style={{ whiteSpace: "nowrap" }} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : b.id)}><strong>{LABEL[b.sourceType] ?? b.sourceType}</strong> {b.sourceRef}</button>
              <span className="row">
                <span className="muted">{when(b.at)}</span>
                {b.undone ? <Stamp tone="quiet">Undone</Stamp> : b.sourceType === "undo" ? <Stamp tone="quiet">Reversal</Stamp> : <Stamp tone={skipped ? "warn" : "ok"}>{skipped ? `${skipped} skipped` : "Applied"}</Stamp>}
                {!b.undone && b.sourceType !== "undo" ? (
                  <f.Form method="post"><input type="hidden" name="batchId" value={b.id} />
                    <button className="btn btn--small" name="intent" value="undo" disabled={f.state !== "idle"}>Undo batch</button>
                    {stuck ? <button className="btn btn--small btn--danger" name="intent" value="undo-compensate" style={{ whiteSpace: "nowrap", marginLeft: 8 }}>Apply compensating adjustment</button> : null}
                  </f.Form>
                ) : null}
              </span>
            </header>
            {isOpen ? (
              <div className="table-wrap"><table className="ruled">
                <thead><tr><th scope="col">Part</th><th scope="col">Location</th><th scope="col" className="num">Change</th><th scope="col" className="num">Before</th><th scope="col" className="num">After</th><th scope="col">Note</th></tr></thead>
                <tbody>{b.entries.map((e, i) => (
                  <tr key={i}>
                    <td>{e.sku ?? e.variantId.split("/").pop()}</td>
                    <td>{d.locations[e.locationId] ?? e.locationId}{e.locationAssumed ? <> <span className="stamp stamp--warn">Location assumed</span></> : null}</td>
                    <td className={`num ${e.delta < 0 ? "delta-neg" : "delta-pos"}`}>{signed(e.delta)}</td>
                    <td className="num">{e.beforeQty ?? "n/a"}</td><td className="num">{e.afterQty ?? "n/a"}</td>
                    <td>{e.status !== "applied" ? <span className="stamp stamp--warn">{e.note ?? e.status}</span> : <span className="muted">{e.note}</span>}</td>
                  </tr>))}</tbody>
              </table></div>
            ) : null}
          </article>
        );
      })}
      <Toast result={f.data ?? null} />
    </>
  );
}
