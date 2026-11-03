import { redirect } from "react-router";
import { demoSnapshot } from "./demo";
import type { Snapshot } from "../core/types";
import { PLANS, planFromBillingName, type PlanKey } from "../core/plans";

export const isDemo = () => process.env.DEMO_MODE === "true";

/** Demo state lives in memory so the UI can be driven without Shopify or a database. */
let demo: Snapshot | null = null;
export const demoState = (): Snapshot => (demo ??= demoSnapshot());
export const resetDemo = () => { demo = null; };

export interface AppContext {
  demo: boolean;
  shop: string;
  snapshot: Snapshot;
  admin: import("./shopify-api").GraphqlClient | null;
  shopId: string | null;
  plan: PlanKey;
  billing: {
    request: (plan: string) => Promise<never>;
    check: () => Promise<{ name: string | null }>;
  } | null;
}

/** Single entry for every route loader/action: authenticates (or serves the demo) and loads a snapshot. */
export async function appContext(request: Request, opts: { withOrders?: boolean } = {}): Promise<AppContext> {
  if (isDemo()) {
    const snapshot = demoState();
    return { demo: true, shop: snapshot.shopDomain, snapshot, admin: null, shopId: null, plan: snapshot.plan, billing: null };
  }
  const [{ authenticate }, repo] = await Promise.all([import("../shopify.server"), import("./repo.server")]);
  const { admin, session, billing } = await authenticate.admin(request);
  const snapshot = await repo.loadSnapshot(session.shop, admin, opts);
  const shopRow = await repo.ensureShop(session.shop);
  // Entitlements are re-derived from Shopify on every request, never trusted from our cache alone.
  let plan: PlanKey = "free";
  try {
    const { BILLING_PLANS } = await import("../shopify.server");
    const status = await billing.check({ plans: Object.keys(BILLING_PLANS) as never, isTest: process.env.BILLING_LIVE !== "true" });
    const name = status.appSubscriptions?.[0]?.name ?? null;
    plan = status.hasActivePayment ? planFromBillingName(name) : "free";
  } catch {
    plan = (shopRow.plan in PLANS ? shopRow.plan : "free") as PlanKey;
  }
  if (plan !== shopRow.plan) {
    const db = (await import("../db.server")).default;
    await db.shop.update({ where: { id: shopRow.id }, data: { plan } });
  }
  snapshot.plan = plan;
  return {
    demo: false, shop: session.shop, snapshot, admin: admin as never, shopId: shopRow.id, plan,
    billing: {
      request: (p) => billing.request({ plan: p as never, isTest: process.env.BILLING_LIVE !== "true" }) as Promise<never>,
      check: async () => ({ name: null }),
    },
  };
}

export const requireFeature = (ctx: AppContext, ok: boolean, redirectTo = "/app/pricing") => {
  if (!ok) throw redirect(redirectTo);
};
