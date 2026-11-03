import { costAlerts, componentRows, kitRows, marginDesk, money, suggestedOrders } from "./views";
import type { Snapshot } from "./types";

export interface Digest {
  subject: string;
  text: string;
  html: string;
  /** false when there is nothing worth emailing (no losing kits, no reorders, no cost changes) */
  hasContent: boolean;
  facts: { losingKits: number; reorderParts: number; costChanges: number; blendedPct: number | null };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Pure: build the daily digest from a snapshot. Same numbers the app shows; no I/O. */
export function buildDigest(s: Snapshot, appUrl = ""): Digest {
  const rows = kitRows(s);
  const losing = rows.filter((r) => r.marginCents < 0).sort((a, b) => a.marginCents - b.marginCents);
  const desk = marginDesk(s, 7);
  const alerts = costAlerts(s);
  const reorder = componentRows(s).filter((r) => r.reorder);
  const orders = [...suggestedOrders(componentRows(s))];
  const heldBack = s.syncPaused ? "Sync is paused: no stock is being written." : null;
  const link = (path: string) => (appUrl ? `${appUrl.replace(/\/$/, "")}${path}` : path);

  const lines: string[] = [];
  const h: string[] = [];
  const section = (title: string, items: string[], path: string) => {
    if (!items.length) return;
    lines.push("", title, ...items.map((i) => `  - ${i}`), `  ${link(path)}`);
    h.push(`<h3 style="margin:20px 0 6px;font-size:15px">${esc(title)}</h3><ul style="margin:0;padding-left:18px">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul><p style="margin:6px 0 0"><a href="${esc(link(path))}">Open in Kit Margin Desk</a></p>`);
  };

  lines.push(`Kit Margin Desk daily digest for ${s.shopDomain}`);
  if (heldBack) lines.push(heldBack);
  lines.push(desk.blendedPct != null ? `Blended kit margin, last 7 days: ${desk.blendedPct}% on ${money(desk.totalRevenueCents)} of kit revenue.` : "Not enough kit sales in the last 7 days to compute a blended margin.");
  section("Kits losing money on every sale", losing.map((r) => `${r.title}: ${money(r.marginCents)} per kit (cost ${money(r.costCents)}, price ${money(r.priceCents)})`), "/app");
  section("Supplier cost changes", alerts.map((a) => `${a.label} ${a.pctChange >= 0 ? "+" : ""}${a.pctChange}% affects ${a.kits.map((k) => k.title).join(", ")}`), "/app/margin#alerts");
  section("Parts that will run out before the next order lands", reorder.map((r) => `${r.label}: ${r.cover == null ? "no burn data" : `${Math.round(r.cover)} days of cover`}, reorder at ${r.reorderAt}`), "/app/replenish");
  section("Suggested purchase orders", orders.map(([supplier, items]) => `${supplier}: ${items.map((i) => `${i.suggested} x ${i.label}`).join(", ")}`), "/app/replenish#suggested");

  const hasContent = losing.length + alerts.length + reorder.length > 0;
  const subject = hasContent
    ? `Kit Margin Desk: ${[losing.length && `${losing.length} losing kit${losing.length === 1 ? "" : "s"}`, reorder.length && `${reorder.length} part${reorder.length === 1 ? "" : "s"} to reorder`, alerts.length && `${alerts.length} cost change${alerts.length === 1 ? "" : "s"}`].filter(Boolean).join(", ")}`
    : "Kit Margin Desk: nothing needs attention today";
  const intro = lines.slice(0, heldBack ? 3 : 2).map((l) => `<p style="margin:0 0 6px">${esc(l)}</p>`).join("");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#17181a;max-width:560px">${intro}${h.join("")}</div>`;
  return {
    subject, text: lines.join("\n"), html, hasContent,
    facts: { losingKits: losing.length, reorderParts: reorder.length, costChanges: alerts.length, blendedPct: desk.blendedPct },
  };
}
