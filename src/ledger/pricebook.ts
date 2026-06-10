// Flat integer price book (API-8), pinned in MEMORY.md. Pure, in-memory,
// BigInt arithmetic — no rounding can exist.
export const PRICE_BOOK: Record<string, bigint> = {
  api_call: 1n,
  storage_gb_hour: 5n
}

export function rate(metric: string, quantity: bigint): bigint {
  const unit = PRICE_BOOK[metric]
  if (unit === undefined) throw new Error(`unknown metric: ${metric}`)
  return unit * quantity
}
