import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session } = await authenticate.webhook(request);
  if (session) await db.session.deleteMany({ where: { shop } });
  // Keep BOMs and the ledger for the reinstall window; stop all sync immediately.
  await db.shop.updateMany({ where: { domain: shop }, data: { uninstalledAt: new Date(), syncEnabled: false, plan: "free" } });
  return new Response();
};
