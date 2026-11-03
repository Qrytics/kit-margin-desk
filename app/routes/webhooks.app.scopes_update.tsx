import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session } = await authenticate.webhook(request);
  const current = (payload as { current: string[] }).current;
  if (session) await db.session.update({ where: { id: session.id }, data: { scope: current.toString() } });
  return new Response();
};
