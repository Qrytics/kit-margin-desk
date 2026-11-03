import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueue } from "../server/jobs.server";

// bulk_operations/finish: verify HMAC, enqueue the download+parse as a job, answer fast.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, webhookId, payload } = await authenticate.webhook(request);
  const p = payload as { admin_graphql_api_id?: string; type?: string };
  if (p.admin_graphql_api_id && (p.type ?? "query") === "query") {
    await enqueue(shop, "bulk_finish", { operationId: p.admin_graphql_api_id }, { dedupeKey: webhookId });
  }
  return new Response();
};
