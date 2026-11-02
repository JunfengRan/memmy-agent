import { mkdirSync, writeFileSync } from "node:fs";
import type { Price } from "./price.js";

export function exportPrices(dir: string, rows: readonly Price[]): void {
  mkdirSync(dir, { recursive: true });
  const lines = rows.map((row) => `${row.sku},${row.amount}`);
  writeFileSync(`${dir}/prices.csv`, lines.join("\n"));
}
