import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueue } from "../server/jobs.server";

// Verify HMAC (authenticate.webhook does), enqueue, answer fast. Never process inline.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);
  await enqueue(shop, "order", { topic, body: payload }, { dedupeKey: webhookId });
  return new Response();
};
