import { Link, NavLink, Outlet, useLoaderData, useRouteError, useLocation } from "react-router";
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { appContext } from "../server/context.server";
import { PLANS } from "../core/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await appContext(request);
  const { shopDomain, plan, syncEnabled, syncPaused, demo } = ctx.snapshot;
  return { apiKey: process.env.SHOPIFY_API_KEY || "", demo, shopDomain, plan, syncEnabled, syncPaused };
};

const NAV = [
  { to: "/app", label: "Kits", end: true },
  { to: "/app/setup", label: "Setup" },
  { to: "/app/margin", label: "Margin desk" },
  { to: "/app/replenish", label: "Replenish" },
  { to: "/app/ledger", label: "Ledger" },
  { to: "/app/settings", label: "Settings" },
  { to: "/app/pricing", label: "Plan" },
];

export default function AppLayout() {
  const d = useLoaderData<typeof loader>();
  const loc = useLocation();
  const body = (
    <div className="shell" data-rail={d.demo ? "on" : "off"}>
      {d.demo ? (
        <aside className="rail">
          <div className="wordmark">Kit Margin Desk<small>{d.shopDomain}</small></div>
          <nav aria-label="Main">
            {NAV.map((n, i) => (
              <NavLink key={n.to} to={n.to} end={n.end}
                       {...(loc.pathname === n.to || (!n.end && loc.pathname.startsWith(n.to)) || (n.end && loc.pathname.startsWith("/app/kits")) ? { "aria-current": "page" as const } : {})}>
                <span className="n">{i + 1}</span><span>{n.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="foot">
            <div>{PLANS[d.plan].label} plan</div>
            <div>{d.syncPaused ? "Sync paused" : d.syncEnabled ? "Live sync on" : "Sync off (dry run only)"}</div>
          </div>
        </aside>
      ) : null}
      <div>
        {d.demo ? <div className="demo-bar" role="note"><span>Demo mode: in-memory sample data, no Shopify connection.</span><Link to="/app/pricing">Plan</Link></div> : null}
        <main className="main"><Outlet /></main>
      </div>
    </div>
  );
  if (d.demo) return body;
  return <EmbeddedFrame apiKey={d.apiKey}>{body}</EmbeddedFrame>;
}

// App Bridge + Polaris web components come from the Shopify-provided AppProvider; navigation is Shopify's s-app-nav.
import { AppProvider } from "@shopify/shopify-app-react-router/react";
function EmbeddedFrame({ apiKey, children }: { apiKey: string; children: React.ReactNode }) {
  return (
    <AppProvider apiKey={apiKey}>
      {/* @ts-expect-error web components */}
      <s-app-nav>
        {NAV.map((n) => (
          // @ts-expect-error web components
          <s-link key={n.to} href={n.to}>{n.label}</s-link>
        ))}
        {/* @ts-expect-error web components */}
      </s-app-nav>
      {children}
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const err = useRouteError();
  return (
    <main className="main">
      <div className="callout callout--bad" role="alert">
        <span>Something went wrong loading this page. {err instanceof Error ? err.message : ""}</span>
      </div>
    </main>
  );
}

export const headers: HeadersFunction = () => ({});
