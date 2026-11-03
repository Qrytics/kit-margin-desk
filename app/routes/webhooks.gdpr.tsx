import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Mandatory compliance webhooks. The app stores no customer PII (only order and line ids, quantities
 * and prices), so data_request and customers/redact have nothing to return or remove.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  if (topic === "SHOP_REDACT") {
    await db.session.deleteMany({ where: { shop } });
    await db.shop.deleteMany({ where: { domain: shop } }); // cascades to every table
  }
  return new Response();
};
