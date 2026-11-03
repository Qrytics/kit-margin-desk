import { useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { appContext } from "../server/context.server";
import { handleAction } from "../server/route-helpers.server";
import { PLANS, type PlanKey } from "../core/plans";
import { PageHead, Stamp, Toast } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { snapshot: s } = await appContext(request);
  return { plan: s.plan, kits: s.kits.length, demo: s.demo };
};
export const action = ({ request }: ActionFunctionArgs) => handleAction(request);

const ORDER: PlanKey[] = ["kit_desk", "free", "kit_desk_pro", "plus"];

export default function Pricing() {
  const d = useLoaderData<typeof loader>();
  const f = useFetcher<{ ok: boolean; message: string }>();
  return (
    <>
      <PageHead verdict="Pay for the margin desk, not for metering." sub="No usage pricing on sync. Undo and the ledger are never paywalled. 14-day trial on paid plans, billed through Shopify." />
      <div className="plans">
        {ORDER.map((k) => {
          const p = PLANS[k];
          const current = d.plan === k;
          return (
            <section key={k} className="plan" data-current={current} data-lead={k === "kit_desk"} aria-label={p.label}>
              <h2>{p.label}</h2>
              <div className="price">{p.monthlyUsd === 0 ? "Free" : `$${p.monthlyUsd}`}{p.monthlyUsd ? <small> a month, or ${p.annualUsd} a year</small> : null}</div>
              <p>{p.blurb}</p>
              <ul className="list-plain" style={{ marginTop: "auto" }}>
                <li><span>Kits</span><span>{p.maxKits ?? "Unlimited"}</span></li>
                <li><span>Kit orders a month</span><span>{p.kitOrdersPerMonth?.toLocaleString() ?? "Unlimited"}</span></li>
                <li><span>CSV</span><span>{p.csv ? "Yes" : "No"}</span></li>
                <li><span>Purchase orders</span><span>{p.replenishment ? "Yes" : "No"}</span></li>
                <li><span>Build mode</span><span>{p.buildMode ? "Yes" : "No"}</span></li>
              </ul>
              {current ? <Stamp tone="ok">Your plan</Stamp> : k === "free" ? <span className="muted">Cancel a paid plan from your Shopify admin to return here.</span> : (
                <f.Form method="post"><input type="hidden" name="plan" value={p.billingName!} />
                  <button className={`btn ${k === "kit_desk" ? "btn--primary" : ""}`} name="intent" value="subscribe" disabled={f.state !== "idle"}>Start {p.trialDays}-day trial</button></f.Form>
              )}
            </section>
          );
        })}
      </div>
      <Toast result={f.data ?? null} />
    </>
  );
}
