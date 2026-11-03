import { redirect } from "react-router";
import { appContext } from "./context.server";
import { performAction } from "./actions.server";

/** Shared action for every app route: one intent-dispatch door, mirrors apply_adjustments for UI writes. */
export async function handleAction(request: Request) {
  const ctx = await appContext(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "subscribe") {
    if (ctx.demo || !ctx.billing) return { ok: false, message: "Billing needs a connected Shopify store (demo mode)." };
    return ctx.billing.request(String(form.get("plan")));
  }
  const result = await performAction(ctx, intent, form);
  if (result.redirectTo && result.ok && !request.headers.get("x-no-redirect")) return redirect(result.redirectTo);
  return result;
}
