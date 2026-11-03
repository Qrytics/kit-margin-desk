import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export interface PoPdfLine { sku: string; supplierSku: string; item: string; qty: number; unitCostCents: number }
export interface PoPdfInput {
  number: number; supplierName: string; shopName: string; status: string; freightCents: number; createdAt?: string;
  lines: PoPdfLine[]; currency?: string;
}

const fmt = (cents: number, cur = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(cents / 100);

/** WinAnsi (the standard PDF fonts) cannot encode everything; replace what it can't draw instead of throwing. */
export const pdfSafe = (s: string): string => s.replace(/\s+/g, " ").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

export function truncateToWidth(text: string, font: PDFFont, size: number, max: number): string {
  let t = pdfSafe(text);
  if (font.widthOfTextAtSize(t, size) <= max) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > max) t = t.slice(0, -1);
  return `${t}...`;
}

/** Totals used on the PDF; exported so the arithmetic is unit-tested without parsing the PDF. */
export function poTotals(lines: Array<{ qty: number; unitCostCents: number }>, freightCents: number) {
  const subtotal = lines.reduce((a, l) => a + l.qty * l.unitCostCents, 0);
  return { subtotalCents: subtotal, freightCents, totalCents: subtotal + freightCents };
}

/** Render a one-or-more-page purchase order PDF with pdf-lib (pure JS, no native deps). */
export async function renderPoPdf(po: PoPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Purchase order PO-${po.number}`);
  doc.setProducer("Kit Margin Desk");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const W = 595.28, H = 841.89, M = 48;
  const ink = rgb(0.09, 0.09, 0.1), mute = rgb(0.36, 0.37, 0.38), rule = rgb(0.6, 0.59, 0.55);
  const cols = { sku: M, item: M + 110, qty: W - M - 190, cost: W - M - 110, total: W - M };
  let page!: PDFPage, y = 0;

  const header = () => {
    page = doc.addPage([W, H]);
    y = H - M;
    page.drawText(`Purchase order PO-${po.number}`, { x: M, y: y - 18, size: 20, font: bold, color: ink });
    page.drawText(pdfSafe(`From ${po.shopName}`), { x: M, y: y - 38, size: 10, font, color: mute });
    page.drawText(pdfSafe(`To ${po.supplierName}`), { x: M, y: y - 52, size: 12, font: bold, color: ink });
    const right = pdfSafe(`Status: ${po.status.replace("_", " ")}${po.createdAt ? `   Date: ${po.createdAt.slice(0, 10)}` : ""}`);
    page.drawText(right, { x: W - M - font.widthOfTextAtSize(right, 10), y: y - 18, size: 10, font, color: mute });
    y -= 78;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: ink });
    y -= 16;
    const th = (t: string, x: number, right = false) => page.drawText(t, { x: right ? x - bold.widthOfTextAtSize(t, 9) : x, y, size: 9, font: bold, color: mute });
    th("SKU", cols.sku); th("Item", cols.item); th("Qty", cols.qty, true); th("Unit cost", cols.cost, true); th("Line total", cols.total, true);
    y -= 8;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rule });
    y -= 14;
  };

  header();
  const cur = po.currency ?? "USD";
  for (const l of po.lines) {
    if (y < M + 90) header();
    const sku = pdfSafe(l.sku || l.supplierSku || "-");
    page.drawText(truncateToWidth(sku, mono, 9, 100), { x: cols.sku, y, size: 9, font: mono, color: ink });
    page.drawText(truncateToWidth(l.item + (l.supplierSku && l.sku ? `  (supplier ${l.supplierSku})` : ""), font, 10, cols.qty - cols.item - 40), { x: cols.item, y, size: 10, font, color: ink });
    const right = (t: string, x: number) => page.drawText(t, { x: x - font.widthOfTextAtSize(t, 10), y, size: 10, font, color: ink });
    right(String(l.qty), cols.qty); right(fmt(l.unitCostCents, cur), cols.cost); right(fmt(l.qty * l.unitCostCents, cur), cols.total);
    y -= 18;
  }
  if (po.lines.length === 0) { page.drawText("No lines on this order.", { x: M, y, size: 10, font, color: mute }); y -= 18; }

  if (y < M + 80) header();
  const t = poTotals(po.lines, po.freightCents);
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.5, color: rule });
  y -= 10;
  for (const [label, val, b] of [["Subtotal", t.subtotalCents, false], ["Freight", t.freightCents, false], ["Total", t.totalCents, true]] as const) {
    const f = b ? bold : font;
    page.drawText(label, { x: cols.cost - 60, y, size: 10, font: f, color: ink });
    const s = fmt(val, cur);
    page.drawText(s, { x: cols.total - f.widthOfTextAtSize(s, 10), y, size: 10, font: f, color: ink });
    y -= 16;
  }
  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length}`, { x: W / 2 - 25, y: 24, size: 8, font, color: mute }));
  return doc.save();
}
