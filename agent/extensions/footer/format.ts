/** 80900 -> "80.9k", 249000 -> "249k", 2_000_000 -> "2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

/** Coste en dólares con 2-4 decimales según tamaño: 0.12, 0.0123. */
export function formatCost(cost: number): string {
  if (cost >= 0.1 || cost === 0) return cost.toFixed(2);
  return cost.toFixed(4);
}
