import { readFileSync } from "node:fs";
import { monthlyTotal } from "../src/report.js";

const entries = JSON.parse(readFileSync(new URL("./fixtures/month.json", import.meta.url), "utf8"));

if (monthlyTotal(entries) !== 16) {
  throw new Error("empty customer with an amount should stay in the monthly total");
}
