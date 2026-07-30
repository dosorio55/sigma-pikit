import { estimateTokens } from "@earendil-works/pi-coding-agent";

/**
 * pi's own token math, not a private copy of it.
 *
 * `estimateTokens` takes an `AgentMessage`, not a string, so anything we want to
 * measure (a tool schema, the system prompt) is wrapped in a throwaway user
 * message. The wrapper contributes no characters of its own: for a user message
 * pi only counts the text of the content blocks.
 *
 * The point is not precision — pi's estimate is `chars / 4` — it is *agreement*.
 * A `/context` that predicts compaction with different arithmetic than the code
 * which triggers compaction would be confidently wrong about the one number it
 * exists to report.
 */
export function tokensOf(text: string): number {
  if (!text) return 0;
  const message = {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: 0,
  };
  return estimateTokens(message as Parameters<typeof estimateTokens>[0]);
}

/** `8.1k`, `1.0M`, `940` — same shape the footer uses. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}
