import { Link, useLoaderData, useSearchParams } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { appContext } from "../server/context.server";
import { handleAction } from "../server/route-helpers.server";
import { costAlerts, marginDesk, money } from "../core/views";
import { toCsv } from "../core/csv";
import { Empty, HealthStamp, IntentButton, PageHead, pct } from "../components/ui";
import { Button } from "../components/polaris";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await appContext(request);
  const url = new URL(request.url);
  const days = ([7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30) as 7 | 30 | 90;
  const desk = marginDesk(ctx.snapshot, days);
  if (url.searchParams.get("format") === "csv") {
    const csv = toCsv([
      ["kit", "units", "revenue", "materials_cogs", "packaging_labor", "total_cogs", "margin", "margin_pct", "returned_units"],
      ...desk.pnl.filter((p) => p.units > 0).map((p) => [p.title, p.units, p.revenueCents / 100, p.materialsCents / 100, p.packLaborCents / 100, p.cogsCents / 100, p.marginCents / 100, p.marginPct ?? "", p.returnedUnits]),
    ]);
    throw new Response(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="kit-margin-${days}d.csv"` } });
  }
  return { days, desk, alerts: costAlerts(ctx.snapshot), csvOk: true };
};
export const action = ({ request }: ActionFunctionArgs) => handleAction(request);

export default function MarginDesk() {
  const d = useLoaderData<typeof loader>();
  const [, setParams] = useSearchParams();
  const active = d.desk.pnl.filter((p) => p.units > 0).sort((a, b) => b.marginCents - a.marginCents);
  const worst = [...active].sort((a, b) => a.marginCents - b.marginCents)[0];
  return (
    <>
      <PageHead lead verdict={d.desk.blendedPct == null ? "No kit sales in this period yet." : <>Kits kept {pct(d.desk.blendedPct)} of every dollar sold.</>}
        sub={worst && worst.marginCents < 0 ? <><strong>{worst.title}</strong> cost you {money(-worst.marginCents)} more than it earned in the last {d.days} days.</> : "Margins use current component costs. Snapshot costing, which freezes cost at the moment of sale, arrives in V2."}>
        <div className="pill-tabs" role="group" aria-label="Period">
          {[7, 30, 90].map((n) => <button key={n} aria-pressed={d.days === n} onClick={() => setParams({ days: String(n) })}>{n} days</button>)}
        </div>
        <Button href={`/app/margin?days=${d.days}&format=csv`} download>Export CSV</Button>
      </PageHead>

      <div className="hero-figure">
        <div><div className="big">{money(d.desk.totalMarginCents)}</div><div className="cap">gross margin on kits, last {d.days} days, returns-adjusted</div></div>
        <div><div className="mid">{money(d.desk.totalRevenueCents)}</div><div className="cap">kit revenue</div></div>
        <div><div className="mid">{pct(d.desk.blendedPct)}</div><div className="cap">blended margin</div></div>
      </div>

      {d.alerts.length > 0 ? (
        <section id="alerts" aria-labelledby="al" style={{ marginBottom: 32 }}>
          <h2 id="al" className="section-title">Supplier cost changes</h2>
          <ul className="list-plain" style={{ borderTop: "1px solid var(--ink)" }}>
            {d.alerts.map((a) => (
              <li key={a.id}>
                <div>
                  <strong>{a.label}</strong> <span className="sku">{a.sku}</span>: {a.pctChange > 0 ? "+" : ""}{a.pctChange}%. {a.kits.length} kit{a.kits.length === 1 ? "" : "s"} affected.
                  <div className="muted">
                    {a.kits.map((k, i) => <span key={k.kitId}>{i ? "; " : ""}<Link to={`/app/kits/${k.kitId}`}>{k.title}</Link> margin {pct(k.beforePct)} to {pct(k.afterPct)}</span>)}
                  </div>
                </div>
                <IntentButton intent="dismiss-cost-change" fields={{ id: a.id }} small>Dismiss</IntentButton>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="cols">
        <section aria-labelledby="pl">
          <h2 id="pl" className="section-title">Profit and loss per kit</h2>
          {active.length === 0 ? <Empty title="Nothing sold in this window">Try 90 days, or wait for the first kit order.</Empty> : (
            <div className="table-wrap">
              <table className="ruled">
                <thead><tr><th scope="col">Kit</th><th scope="col" className="num">Units</th><th scope="col" className="num">Revenue</th><th scope="col" className="num">Materials</th><th scope="col" className="num">Pack and labor</th><th scope="col" className="num">Margin</th><th scope="col" className="num">%</th><th scope="col">Health</th></tr></thead>
                <tbody>
                  {active.map((p) => (
                    <tr key={p.kitId} data-loss={p.marginCents < 0}>
                      <td><Link className="name" to={`/app/kits/${p.kitId}`}>{p.title}</Link>{p.returnedUnits ? <div className="sku">{p.returnedUnits} returned</div> : null}</td>
                      <td className="num">{p.units}</td><td className="num">{money(p.revenueCents)}</td><td className="num">{money(p.materialsCents)}</td><td className="num">{money(p.packLaborCents)}</td>
                      <td className="num figure" style={{ color: p.marginCents < 0 ? "var(--correction)" : undefined }}>{money(p.marginCents)}</td><td className="num">{pct(p.marginPct)}</td><td><HealthStamp health={p.health} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <aside className="stack" aria-label="Top and bottom">
          <section className="panel"><h3>Top five by margin dollars</h3>
            <ol className="list-plain">{d.desk.top.map((p) => <li key={p.kitId}><span>{p.title}</span><strong>{money(p.marginCents)}</strong></li>)}</ol></section>
          <section className="panel"><h3>Bottom five</h3>
            <ol className="list-plain">{d.desk.bottom.length ? d.desk.bottom.map((p) => <li key={p.kitId}><span>{p.title}</span><strong style={{ color: p.marginCents < 0 ? "var(--correction)" : undefined }}>{money(p.marginCents)}</strong></li>) : <li className="muted">All kits already appear in the top five.</li>}</ol></section>
        </aside>
      </div>
    </>
  );
}
