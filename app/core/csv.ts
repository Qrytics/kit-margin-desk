/** BOM CSV import/export. Columns: kit_sku, component_sku, qty_per_kit, waste_pct */
export const BOM_HEADER = ["kit_sku", "component_sku", "qty_per_kit", "waste_pct"] as const;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

export const toCsv = (rows: Array<Array<string | number | null | undefined>>): string =>
  rows
    .map((r) =>
      r
        .map((v) => {
          const s = v == null ? "" : String(v);
          // neutralise spreadsheet formula injection
          const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
          return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
        })
        .join(","),
    )
    .join("\n");

export interface BomRow { kitSku: string; componentSku: string; qty: number; wastePct: number; line: number }
export interface BomImportReport {
  rows: BomRow[];
  errors: Array<{ line: number; message: string }>;
  unmatched: Array<{ line: number; sku: string; role: "kit" | "component" }>;
}

/** Validate against the set of known SKUs; unmatched rows are reported, matched rows still import. */
export function parseBomCsv(text: string, knownSkus: Set<string>): BomImportReport {
  const table = parseCsv(text);
  const report: BomImportReport = { rows: [], errors: [], unmatched: [] };
  if (!table.length) { report.errors.push({ line: 1, message: "File is empty." }); return report; }
  const head = table[0].map((h) => h.trim().toLowerCase());
  const idx = BOM_HEADER.map((h) => head.indexOf(h));
  if (idx.slice(0, 3).some((i) => i < 0)) {
    report.errors.push({ line: 1, message: `Header must include ${BOM_HEADER.join(", ")}.` });
    return report;
  }
  table.slice(1).forEach((r, n) => {
    const line = n + 2;
    const kitSku = (r[idx[0]] ?? "").trim(), componentSku = (r[idx[1]] ?? "").trim();
    const qty = Number((r[idx[2]] ?? "").trim());
    const wastePct = idx[3] >= 0 && (r[idx[3]] ?? "").trim() !== "" ? Number(r[idx[3]]) : 0;
    if (!kitSku || !componentSku) return void report.errors.push({ line, message: "Missing SKU." });
    if (!Number.isFinite(qty) || qty <= 0) return void report.errors.push({ line, message: `Invalid qty_per_kit "${r[idx[2]]}".` });
    if (Math.round(qty * 1000) / 1000 !== qty) return void report.errors.push({ line, message: "qty_per_kit allows up to 3 decimals." });
    if (!Number.isFinite(wastePct) || wastePct < 0 || wastePct > 100) return void report.errors.push({ line, message: "waste_pct must be 0 to 100." });
    let bad = false;
    if (!knownSkus.has(kitSku)) { report.unmatched.push({ line, sku: kitSku, role: "kit" }); bad = true; }
    if (!knownSkus.has(componentSku)) { report.unmatched.push({ line, sku: componentSku, role: "component" }); bad = true; }
    if (!bad) report.rows.push({ kitSku, componentSku, qty, wastePct, line });
  });
  return report;
}
