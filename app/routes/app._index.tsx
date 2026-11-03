import { useMemo, useState } from "react";
import { Link, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { appContext } from "../server/context.server";
import { handleAction } from "../server/route-helpers.server";
import { healthCheck, kitRows, marginDesk, money, type KitRow, costAlerts } from "../core/views";
import { explodeBom, indexKits } from "../core/bom";
import { PLANS } from "../core/plans";
import { Ruler } from "../components/Ruler";
import { Empty, HealthStamp, PageHead, pct } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { snapshot: s } = await appContext(request);
  const rows = kitRows(s);
  const h = healthCheck(Object.values(s.variants));
  const desk = marginDesk(s, 30);
  return {
    rows, plan: s.plan, syncEnabled: s.syncEnabled, syncPaused: s.syncPaused, dupes: h.duplicateSkus.length,
    blended: desk.blendedPct, revenue: desk.totalRevenueCents, alerts: costAlerts(s).length, kitCap: PLANS[s.plan].maxKits,
    hasStrip: { scanned: Object.keys(s.variants).length > 0, kits: rows.length > 0, dry: s.recentOrders.length > 0, live: s.syncEnabled },
    usedBy: Object.fromEntries(Object.values(s.variants).map((v) => [v.id, s.kits.filter((k) => explodeBom(k, indexKits(s.kits)).leaves.has(v.id)).map((k) => k.id)])) as Record<string, string[]>,
    components: Object.values(s.variants).filter((v) => rows.length && s.kits.some((k) => k.lines.some((l) => l.componentVariantId === v.id))).map((v) => ({ id: v.id, label: `${v.productTitle} ${v.variantTitle}`, sku: v.sku })),
  };
};
export const action = ({ request }: ActionFunctionArgs) => handleAction(request);

type SortKey = "marginPct" | "revenue30Cents" | "marginCents" | "units30";

export default function KitsHome() {
  const d = useLoaderData<typeof loader>();
  const [sort, setSort] = useState<SortKey>("marginPct");
  const [losing, setLosing] = useState(false);
  const [q, setQ] = useState("");
  const [comp, setComp] = useState("");
  const rows = useMemo(() => {
    let r = [...d.rows] as KitRow[];
    if (losing) r = r.filter((x) => x.marginCents < 0 || x.health === "red");
    if (q) r = r.filter((x) => (x.title + (x.sku ?? "")).toLowerCase().includes(q.toLowerCase()));
    if (comp) r = r.filter((x) => d.usedBy[comp]?.includes(x.id));
    return r.sort((a, b) => ((a[sort] ?? -1e12) as number) - ((b[sort] ?? -1e12) as number)).reverse().sort((a, b) => (sort === "marginPct" ? (a.marginPct ?? 1e9) - (b.marginPct ?? 1e9) : 0));
  }, [d, sort, losing, q, comp]);
  const losers = d.rows.filter((r) => r.marginCents < 0).length;
  const sortBtn = (k: SortKey, label: string) => <button className="sort" aria-pressed={sort === k} onClick={() => setSort(k)}>{label}</button>;
  const strip = [
    { n: 1, name: "Scan catalog", time: "About 1 minute", state: d.hasStrip.scanned ? "done" : "now", to: "/app/setup" },
    { n: 2, name: "Build first kit", time: "Under 3 minutes", state: d.hasStrip.kits ? "done" : d.hasStrip.scanned ? "now" : "idle", to: "/app/setup" },
    { n: 3, name: "Read the margins", time: "Instant", state: d.hasStrip.kits ? "done" : "idle", to: "/app/margin" },
    { n: 4, name: "Dry run 20 orders", time: "About 10 seconds", state: d.hasStrip.live ? "done" : d.hasStrip.kits ? "now" : "idle", to: "/app/setup#dry-run" },
    { n: 5, name: "Turn on live sync", time: "Your call, one click", state: d.dupes ? "blocked" : d.hasStrip.live ? "done" : "idle", to: "/app/setup#enable" },
  ];

  return (
    <>
      <PageHead
        lead
        verdict={losers > 0 ? <>{losers} {losers === 1 ? "kit is" : "kits are"} losing money on every sale.</> : d.rows.length ? <>Every kit is earning its place.</> : <>Start by naming your first kit.</>}
        sub={d.rows.length ? <>Blended kit margin over 30 days is <strong>{pct(d.blended)}</strong> on {money(d.revenue)} of kit revenue.{d.alerts ? <> <Link to="/app/margin#alerts">{d.alerts} supplier cost {d.alerts === 1 ? "change needs" : "changes need"} a look.</Link></> : null}</> : "A kit is any product made of other products. Pick one and map its parts."}
      >
        <Link className="btn btn--primary" to="/app/setup">{d.rows.length ? "Add a kit" : "Guided first kit"}</Link>
        <Link className="btn" to="/app/margin">Open margin desk</Link>
      </PageHead>

      <ol className="strip" aria-label="Setup progress">
        {strip.map((s) => (
          <li key={s.n} data-state={s.state}>
            <span className="no">{s.n}</span>
            <Link className="name" to={s.to}>{s.name}</Link>
            <span className="time">{s.time}</span>
          </li>
        ))}
      </ol>

      {d.syncPaused ? <div className="callout callout--bad" role="alert" style={{ marginBottom: 24 }}><strong>All sync is paused.</strong> Orders are recorded but no stock is changed.<Link to="/app/settings">Resume in Settings</Link></div> : null}

      {d.rows.length === 0 ? (
        <Empty title="No kits yet" action={<Link className="btn btn--primary" to="/app/setup">Create your first kit</Link>}>
          Kits are existing products. You will keep your listing, SEO and reviews; the app manages the parts behind it.
        </Empty>
      ) : (
        <>
          <div className="row row--between" style={{ marginBottom: 12 }}>
            <div className="row">
              <label className="field" style={{ minWidth: 220 }}><span className="sr-only" style={{ position: "absolute", left: -9999 }}>Search kits</span>
                <input type="search" placeholder="Search kit name or SKU" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search kits" />
              </label>
              <label className="field" style={{ minWidth: 220 }}>
                <select value={comp} onChange={(e) => setComp(e.target.value)} aria-label="Filter by component">
                  <option value="">Any component</option>
                  {d.components.map((c) => <option key={c.id} value={c.id}>{c.sku ?? c.label}</option>)}
                </select>
              </label>
            </div>
            <div className="pill-tabs" role="group" aria-label="Filter">
              <button aria-pressed={!losing} onClick={() => setLosing(false)}>All kits</button>
              <button aria-pressed={losing} onClick={() => setLosing(true)}>Losing money ({losers})</button>
            </div>
          </div>
          <div className="table-wrap">
            <table className="ruled">
              <caption className="sr-only" style={{ position: "absolute", left: -9999 }}>Kits ranked by margin</caption>
              <thead>
                <tr>
                  <th scope="col">Kit</th><th scope="col">Mode</th><th scope="col" className="num">Parts</th><th scope="col" className="num">Can sell</th>
                  <th scope="col" className="num">Landed cost</th><th scope="col" className="num">Price</th><th scope="col" className="num">{sortBtn("marginCents", "Margin")}</th>
                  <th scope="col" className="num">{sortBtn("marginPct", "Margin %")}</th><th scope="col" className="num">{sortBtn("units30", "30d units")}</th><th scope="col" className="num">{sortBtn("revenue30Cents", "30d revenue")}</th><th scope="col">Where the price goes</th><th scope="col">Health</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-loss={r.marginCents < 0}>
                    <td><Link className="name" to={`/app/kits/${r.id}`}>{r.title}</Link><div className="sku">{r.sku ?? "No SKU"}{r.warnings.length ? <> {" "}<span className="stamp stamp--warn" title={r.warnings.join(" ")}>Check parts</span></> : null}</div></td>
                    <td>{r.mode === "pre_assembled" ? "Pre-assembled" : "On order"}</td>
                    <td className="num">{r.components}</td>
                    <td className="num">{r.mode === "pre_assembled" ? <span title="Finished stock lives on the kit itself">can build {r.available ?? "any"}</span> : r.available ?? "n/a"}</td>
                    <td className="num">{money(r.costCents)}{r.missingCosts ? <div className="sku">{r.missingCosts} no cost</div> : null}</td>
                    <td className="num">{money(r.priceCents)}</td>
                    <td className="num figure" style={{ color: r.marginCents < 0 ? "var(--correction)" : undefined }}>{money(r.marginCents)}</td>
                    <td className="num">{pct(r.marginPct)}</td>
                    <td className="num">{r.units30}</td>
                    <td className="num">{money(r.revenue30Cents)}</td>
                    <td style={{ minWidth: 140 }}><Ruler parts={r.parts} size="mini" /></td>
                    <td><HealthStamp health={r.health} pct={r.marginPct} /></td>
                  </tr>
                ))}
                {rows.length === 0 ? <tr><td colSpan={12} className="muted">Nothing matches. {losing ? "No kits are losing money, which is the good outcome." : ""}</td></tr> : null}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 16 }}>
            {d.kitCap ? `${d.rows.length} of ${d.kitCap} kits used on the ${PLANS[d.plan].label} plan. ` : ""}Costs use today&apos;s component prices. Snapshot costing arrives in V2.
          </p>
        </>
      )}
    </>
  );
}
