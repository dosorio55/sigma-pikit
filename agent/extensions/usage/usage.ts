export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type UsageWindow = {
  usedPercent: number;
  windowSeconds: number;
  resetAt: number;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function accountIdFromToken(token: string): string {
  try {
    const payload = object(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")));
    const accountId = object(payload?.["https://api.openai.com/auth"])?.chatgpt_account_id;
    if (typeof accountId === "string" && accountId.trim() && !/[\r\n]/.test(accountId)) {
      return accountId;
    }
  } catch {}
  throw new Error("ChatGPT OAuth authentication is required. Use /login with OpenAI Codex.");
}

export function parseUsage(value: unknown): UsageWindow[] {
  const rateLimit = object(object(value)?.rate_limit);
  const windows: UsageWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const window = object(rateLimit?.[key]);
    if (!window) continue;
    const usedPercent = window.used_percent;
    const windowSeconds = window.limit_window_seconds;
    const resetAt = window.reset_at;
    if (
      typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 ||
      typeof windowSeconds !== "number" || !Number.isSafeInteger(windowSeconds) || windowSeconds <= 0 ||
      typeof resetAt !== "number" || !Number.isSafeInteger(resetAt) || resetAt < 0 || resetAt > 8.64e12
    ) {
      throw new Error("Codex returned an invalid usage window. Its internal API may have changed.");
    }
    windows.push({ usedPercent, windowSeconds, resetAt });
  }
  if (windows.length === 0) throw new Error("Codex did not report any usage windows for this account.");
  return windows.sort((a, b) => a.windowSeconds - b.windowSeconds);
}

export async function fetchUsage(token: string): Promise<UsageWindow[]> {
  const accountId = accountIdFromToken(token);
  let response: Response;
  try {
    response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-Id": accountId,
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Could not reach Codex usage (network error or 10-second timeout).");
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401) throw new Error("Codex authentication expired. Use /login with OpenAI Codex.");
    if (response.status === 403) throw new Error("Codex denied access to usage (HTTP 403).");
    if (response.status === 429) throw new Error("Too many usage requests. Try again later.");
    throw new Error(`Codex usage request failed (HTTP ${response.status}).`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Codex returned an unreadable usage response.");
  }
  return parseUsage(body);
}

export function formatUsage(windows: UsageWindow[], now = Date.now()): string {
  const lines = windows.map((window) => {
    const label = window.windowSeconds === 18000 ? "5 hours"
      : window.windowSeconds === 604800 ? "Weekly"
      : `${Number((window.windowSeconds / 3600).toFixed(2))} hours`;
    const remaining = Number((100 - window.usedPercent).toFixed(1));
    const minutes = Math.max(0, Math.ceil((window.resetAt * 1000 - now) / 60_000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const duration = `${days ? `${days}d ` : ""}${hours}h ${minutes % 60}m`;
    const date = new Date(window.resetAt * 1000).toLocaleString();
    return `${label}: ${remaining}% remaining · resets in ${duration} (${date})`;
  });
  return ["Codex usage", ...lines].join("\n");
}
