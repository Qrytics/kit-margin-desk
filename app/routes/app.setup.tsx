import { useEffect, useState } from "react";
import { Link, useFetcher, useLoaderData, useRevalidator } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { appContext } from "../server/context.server";
import { handleAction } from "../server/route-helpers.server";
import { dryRun, healthCheck, kitsBlockedByDuplicates, variantLabel } from "../core/views";
import { catalogFor } from "../server/bulk.server";
import { scanCatalog } from "../server/shopify-api";
import { Empty, IntentButton, PageHead, Stamp, Toast, signed } from "../components/ui";
import { VariantPicker } from "../components/VariantPicker";
import { Banner, Button } from "../components/polaris";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await appContext(request, { withOrders: true });
  const s = ctx.snapshot;
  // Install-time catalog scan. Large catalogs: switch to bulkOperationRunQuery (README).
  const scan = ctx.demo
    ? { variants: Object.values(s.variants), truncated: false, source: "demo" as const, scanning: false, finishedAt: null as Date | null }
    : await catalogFor(ctx.admin!, ctx.shopId!, scanCatalog);
  const report = healthCheck(scan.variants);
  const blocked = kitsBlockedByDuplicates({ ...s, variants: Object.fromEntries(scan.variants.map((v) => [v.id, v])) }, report);
  const adminBase = `https://${s.shopDomain}/admin/products`;
  const link = (productId: string) => `${adminBase}/${productId.split("/").pop()}`;
  const slim = (vs: typeof scan.variants) => vs.slice(0, 50).map((v) => ({ id: v.id, label: variantLabel(v), sku: v.sku, href: link(v.productId) }));
  return {
    scanned: scan.variants.length, truncated: scan.truncated, source: scan.source, scanning: scan.scanning, scannedAt: scan.finishedAt ? scan.finishedAt.toISOString() : null, demo: ctx.demo,
    dupes: report.duplicateSkus.map((d) => ({ sku: d.sku, variants: slim(d.variants) })),
    untracked: slim(report.untracked), untrackedCount: report.untracked.length,
    continueSelling: slim(report.continueSelling), continueCount: report.continueSelling.length,
    noCost: slim(report.noCost), noCostCount: report.noCost.length,
    syncBlocked: report.syncBlocked, blockedKits: [...blocked], syncEnabled: s.syncEnabled,
    dry: dryRun(s).slice(0, 20), hasKits: s.kits.length > 0, plan: s.plan,
    kitNames: Object.fromEntries(s.kits.map((k) => [k.id, k.title])),
  };
};
export const action = ({ request }: ActionFunctionArgs) => handleAction(request);

function Issue({ title, count, tone, items, why }: { title: string; count: number; tone: "bad" | "warn" | "ok"; items: Array<{ id: string; label: string; sku: string | null; href: string }>; why: string }) {
  return (
    <section className="panel">
      <div className="row row--between"><h3>{title}</h3><Stamp tone={count === 0 ? "ok" : tone}>{count === 0 ? "Clear" : `${count} found`}</Stamp></div>
      <p className="muted" style={{ marginBottom: 12 }}>{why}</p>
      {items.length ? (
        <ul className="list-plain">
          {items.slice(0, 8).map((i) => <li key={i.id}><span>{i.label} <span className="sku">{i.sku ?? "no SKU"}</span></span><a href={i.href} target="_blank" rel="noreferrer">Fix in Shopify</a></li>)}
          {count > 8 ? <li className="muted">and {count - 8} more</li> : null}
        </ul>
      ) : null}
    </section>
  );
}

export default function Setup() {
  const d = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!d.scanning) return;
    const t = setInterval(() => revalidator.revalidate(), 8000);
    return () => clearInterval(t);
  }, [d.scanning, revalidator]);
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null);
  const create = useFetcher<{ ok: boolean; message: string }>();
  return (
    <>
      <PageHead verdict={d.syncBlocked ? "Fix duplicate SKUs before sync can go live." : d.hasKits ? "Your catalog is ready for kit sync." : "Your catalog scan is in. Now map your first kit."} sub={`${d.scanned} variants scanned${d.source === "bulk" ? " (full catalog)" : d.truncated ? " (first 2,000 only; run the full scan below)" : ""}. Nothing has been changed in your store.`} />

      {!d.demo ? (
        <section className="panel" aria-labelledby="fs" style={{ marginBottom: 24 }}>
          <div className="row row--between">
            <div>
              <h2 id="fs">Full catalog scan</h2>
              <p className="muted">{d.scanning ? "Shopify is reading your whole catalog. This page refreshes when it finishes." : d.source === "bulk" ? `Last full scan ${d.scannedAt ? new Date(d.scannedAt).toLocaleString("en-US") : ""}: ${d.scanned} variants.` : "Large catalogs are read in the background by Shopify, so nothing is capped or slow."}</p>
            </div>
            <IntentButton intent="scan-catalog" variant={d.source === "bulk" ? "default" : "primary"} disabled={d.scanning}>{d.scanning ? "Scanning" : d.source === "bulk" ? "Scan again" : "Run full scan"}</IntentButton>
          </div>
        </section>
      ) : null}

      <div className="stack">
        <section id="first-kit" className="panel" aria-labelledby="fk">
          <h2 id="fk">Guided first kit</h2>
          <p className="muted" style={{ marginBottom: 12 }}>Pick the product that is a kit. Then add the parts it is made of. Most people finish in under three minutes.</p>
          {!picked ? <VariantPicker label="Which product is a kit?" placeholder="Search by product name or SKU" onPick={(v) => setPicked({ id: v.id, label: v.label })} /> : (
            <create.Form method="post" className="row">
              <input type="hidden" name="intent" value="create-kit" /><input type="hidden" name="variantId" value={picked.id} />
              <span><strong>{picked.label}</strong> is a kit.</span>
              <Button type="submit" variant="primary" loading={create.state !== "idle"}>Add components</Button>
              <Button variant="quiet" onClick={() => setPicked(null)}>Pick another</Button>
            </create.Form>
          )}
          {create.data && !create.data.ok ? <Banner tone="bad" role="alert" style={{ marginTop: 12 }}>{create.data.message}</Banner> : null}
          <p className="muted" style={{ marginTop: 12 }}>Have a spreadsheet? <Link to="/app/settings#csv">Import BOMs from CSV</Link>.</p>
        </section>

        <section aria-labelledby="hc">
          <h2 id="hc" className="section-title">Kit readiness</h2>
          <div className="stack stack--tight">
            <Issue title="Duplicate SKUs" count={d.dupes.length} tone="bad" why="Sync works by variant, but duplicated SKUs are how other apps corrupted stores. Kits that touch these are held back from sync until you fix them or exclude them. Costing still works." items={d.dupes.flatMap((x) => x.variants)} />
            {d.dupes.length ? (
              <Banner tone="bad" role="alert" heading="Blocker">
                {d.blockedKits.length ? `${d.blockedKits.length} of your kits touch a duplicated SKU: ${d.blockedKits.map((k) => d.kitNames[k]).join(", ")}.` : "No kit uses these yet, but sync will refuse them if you add one."}
              </Banner>
            ) : null}
            <Issue title="Inventory tracking is off" count={d.untrackedCount} tone="warn" why="An untracked component can never limit a kit. Native bundles oversell this way. Kits using it get a warning badge." items={d.untracked} />
            <Issue title="Continue selling when out of stock" count={d.continueCount} tone="warn" why="Same hole: the component looks unlimited, so availability math ignores it." items={d.continueSelling} />
            <Issue title="No cost entered" count={d.noCostCount} tone="warn" why="Margin counts a missing cost as zero, which flatters the kit. Enter costs in Shopify or via a purchase order." items={d.noCost} />
          </div>
        </section>

        <section id="dry-run" className="panel" aria-labelledby="dr">
          <h2 id="dr">Dry run: your last 20 kit orders</h2>
          <p className="muted" style={{ marginBottom: 12 }}>This is exactly what live sync would have changed. Nothing here was written.</p>
          {d.dry.length === 0 ? <Empty title="No kit orders to simulate yet">Create a kit, and any recent orders containing it will appear here.</Empty> : (
            <div className="table-wrap">
              <table className="ruled">
                <thead><tr><th scope="col">Order</th><th scope="col">Kit</th><th scope="col">Component</th><th scope="col" className="num">Change</th></tr></thead>
                <tbody>
                  {d.dry.flatMap((r) => r.adjustments.map((a, i) => (
                    <tr key={`${r.orderName}-${a.sku}`}>
                      <td>{i === 0 ? r.orderName : ""}</td><td>{i === 0 ? r.kit : ""}</td><td>{a.label} <span className="sku">{a.sku}</span></td><td className="num delta-neg">{signed(a.delta)}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section id="enable" className="panel" aria-labelledby="en">
          <h2 id="en">Live sync</h2>
          <p className="muted" style={{ marginBottom: 12 }}>Off by default. When on, kit orders decrement components, refunds with restock put them back, and every change is logged and reversible.</p>
          {d.syncEnabled ? <div className="row"><Stamp tone="ok">Live sync is on</Stamp><IntentButton intent="disable-sync" variant="danger">Turn off</IntentButton></div> : <IntentButton intent="enable-sync" variant="primary" disabled={!d.hasKits}>I have read the dry run. Turn on live sync</IntentButton>}
          {d.dupes.length ? <div style={{ marginTop: 12 }} className="row">{d.dupes.slice(0, 3).flatMap((x) => x.variants).slice(1, 4).map((v) => <IntentButton key={v.id} intent="exclude-variant" fields={{ variantId: v.id }} small>Exclude {v.sku}</IntentButton>)}</div> : null}
        </section>
      </div>
      <Toast result={create.data && create.data.ok ? create.data : null} />
    </>
  );
}
