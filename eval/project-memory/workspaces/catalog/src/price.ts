export interface Price {
  sku: string;
  amount: number;
}

export function listAmounts(rows: readonly Price[]): number[] {
  return rows.map((row) => row.amount);
}
