import prisma from "../db.server";
import { buildDigest } from "../core/digest";
import { providerFromEnv } from "../core/mailer";
import { planAllows, type PlanKey } from "../core/plans";
import { loadSnapshot, settingsOf } from "./repo.server";
import { enqueue } from "./jobs.server";
import type { GraphqlClient } from "./shopify-api";

/** Job handler: build and send one shop's digest. Skips quietly when disabled, unpaid or empty. */
export async function runDigest(ctx: { shopId: string; domain: string; admin: GraphqlClient }) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: ctx.shopId } });
  const settings = settingsOf(shop);
  if (!settings.digest || !planAllows(shop.plan as PlanKey, "digest")) return { sent: false, reason: "disabled" };
  let to = settings.digestEmail;
  if (!to) {
    // UNVERIFIED: shop.email is on the Shop object in the Admin API; a merchant-set address in Settings wins.
    const res = await ctx.admin.graphql(`query { shop { email } }`);
    to = ((await res.json()) as { data?: { shop?: { email?: string } } }).data?.shop?.email ?? "";
  }
  if (!to) return { sent: false, reason: "no recipient" };
  const snap = await loadSnapshot(ctx.domain, ctx.admin);
  const d = buildDigest(snap, process.env.SHOPIFY_APP_URL);
  if (!d.hasContent && !settings.digestAlways) return { sent: false, reason: "nothing to report" };
  const r = await providerFromEnv().send({ to, subject: d.subject, text: d.text, html: d.html });
  if (!r.ok) throw new Error(r.detail); // job queue retries with backoff
  return { sent: true, reason: r.detail };
}

/** Called by the worker once a day (13:00 UTC); one deduped job per shop per day. */
export async function enqueueDailyDigests() {
  const shops = await prisma.shop.findMany({ where: { uninstalledAt: null, plan: { in: ["kit_desk_pro", "plus"] } } });
  const day = new Date().toISOString().slice(0, 10);
  for (const s of shops) if (settingsOf(s).digest) await enqueue(s.domain, "digest", {}, { dedupeKey: `digest:${day}` });
}
