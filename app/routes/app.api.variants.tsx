import type { LoaderFunctionArgs } from "react-router";
import { appContext } from "../server/context.server";
import { searchVariants } from "../server/shopify-api";
import { variantLabel } from "../core/views";

/** Variant search for the BOM editor and guided flow. Paginated by `first`; Shopify does the filtering. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await appContext(request);
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  const found = ctx.demo
    ? Object.values(ctx.snapshot.variants).filter((v) => !q || `${v.productTitle} ${v.variantTitle} ${v.sku ?? ""}`.toLowerCase().includes(q.toLowerCase())).slice(0, 20)
    : await searchVariants(ctx.admin!, q, 20);
  return { results: found.map((v) => ({ id: v.id, label: variantLabel(v), sku: v.sku, costCents: v.costCents, priceCents: v.priceCents })) };
};
