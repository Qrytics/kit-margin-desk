import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { planFromBillingName } from "../core/plans";

/** app_subscriptions/update: plan changes and cancellations. Entitlements are re-checked on every request too. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const sub = (payload as { app_subscription: { name: string; status: string } }).app_subscription;
  const active = sub.status === "ACTIVE";
  const cancelled = ["CANCELLED", "DECLINED", "EXPIRED", "FROZEN"].includes(sub.status);
  if (active) await db.shop.updateMany({ where: { domain: shop }, data: { plan: planFromBillingName(sub.name) } });
  else if (cancelled) await db.shop.updateMany({ where: { domain: shop }, data: { plan: "free" } });
  return new Response();
};
