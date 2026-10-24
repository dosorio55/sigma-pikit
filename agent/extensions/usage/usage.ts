export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

type UsageWindow = {
  usedPercent: number;
  windowSeconds: number;
  resetAt: number;
};

type ResetCredit = {
  title: string;
  status: string;
  grantedAt: number;
  expiresAt?: number;
};

type Usage = {
  windows: UsageWindow[];
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  availableResets?: number;
  resetCredits?: ResetCredit[];
  resetDetailsUnavailable?: boolean;
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

export function parseUsage(value: unknown): Usage {
  const payload = object(value);
  const rateLimit = object(payload?.rate_limit);
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
  const usage: Usage = { windows: windows.sort((a, b) => a.windowSeconds - b.windowSeconds) };
  if (payload?.credits != null) {
    const credits = object(payload.credits);
    const balance = credits?.balance;
    if (
      typeof credits?.has_credits !== "boolean" || typeof credits.unlimited !== "boolean" ||
      (balance != null && (typeof balance !== "string" || !/^\d+(\.\d+)?$/.test(balance)))
    ) {
      throw new Error("Codex returned invalid credit information. Its internal API may have changed.");
    }
    usage.credits = {
      hasCredits: credits.has_credits,
      unlimited: credits.unlimited,
      balance: typeof balance === "string" ? balance : undefined,
    };
  }
  if (payload?.rate_limit_reset_credits != null) {
    const count = object(payload.rate_limit_reset_credits)?.available_count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("Codex returned an invalid available reset count. Its internal API may have changed.");
    }
    usage.availableResets = count;
  }
  if (windows.length === 0 && !usage.credits && usage.availableResets === undefined) {
    throw new Error("Codex did not report any usage windows for this account.");
  }
  return usage;
}

export function parseResetCredits(value: unknown): { availableCount: number; credits: ResetCredit[] } {
  const payload = object(value);
  const count = payload?.available_count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(payload?.credits)) {
    throw new Error("Codex returned invalid reset credit details.");
  }

  const credits = payload.credits.map((value): ResetCredit => {
    const credit = object(value);
    const title = credit?.title ?? credit?.reset_type;
    const status = credit?.status;
    const grantedAt = typeof credit?.granted_at === "string" ? Date.parse(credit.granted_at) : NaN;
    const expiresAt = credit?.expires_at == null ? undefined
      : typeof credit.expires_at === "string" ? Date.parse(credit.expires_at) : NaN;
    if (
      typeof title !== "string" || !title.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(title) ||
      typeof status !== "string" || !status.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(status) ||
      !Number.isFinite(grantedAt) || (expiresAt !== undefined && !Number.isFinite(expiresAt))
    ) {
      throw new Error("Codex returned invalid reset credit details.");
    }
    return { title, status, grantedAt, expiresAt };
  });
  return { availableCount: count, credits };
}

async function fetchJson(url: string, token: string): Promise<unknown> {
  const accountId = accountIdFromToken(token);
  let response: Response;
  try {
    response = await fetch(url, {
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
  return body;
}

export async function fetchUsage(token: string): Promise<Usage> {
  const usage = parseUsage(await fetchJson(USAGE_URL, token));
  if ((usage.availableResets ?? 0) > 0) {
    try {
      const details = parseResetCredits(await fetchJson(RESET_CREDITS_URL, token));
      usage.availableResets = details.availableCount;
      usage.resetCredits = details.credits;
    } catch {
      usage.resetDetailsUnavailable = true;
    }
  }
  return usage;
}

export function formatDuration(milliseconds: number): string {
  let minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  const parts: string[] = [];
  for (const [label, size] of [["mo", 43200], ["w", 10080], ["d", 1440], ["h", 60], ["m", 1]] as const) {
    const count = Math.floor(minutes / size);
    if (count > 0) parts.push(`${count}${label}`);
    minutes %= size;
  }
  return parts.join(" ") || "0m";
}

export function formatUsage(usage: Usage, now = Date.now()): string {
  const lines = usage.windows.map((window) => {
    const label = window.windowSeconds === 18000 ? "5 hours"
      : window.windowSeconds === 604800 ? "Weekly"
      : `${Number((window.windowSeconds / 3600).toFixed(2))} hours`;
    const remaining = Number((100 - window.usedPercent).toFixed(1));
    const duration = formatDuration(window.resetAt * 1000 - now);
    const date = new Date(window.resetAt * 1000).toLocaleString();
    return `${label}: ${remaining}% remaining · resets in ${duration} (${date})`;
  });
  const credits = usage.credits;
  const creditStatus = !credits ? "not reported"
    : credits.unlimited ? "unlimited"
    : credits.balance !== undefined ? credits.balance
    : credits.hasCredits ? "available (balance not reported)" : "none";
  lines.push(`Credits: ${creditStatus}`);
  lines.push(`Available resets: ${usage.availableResets ?? "not reported"}`);

  for (const credit of usage.resetCredits ?? []) {
    const expiry = credit.expiresAt === undefined ? "expiry not reported"
      : credit.expiresAt <= now ? `expired (${new Date(credit.expiresAt).toLocaleString()})`
      : `expires in ${formatDuration(credit.expiresAt - now)} (${new Date(credit.expiresAt).toLocaleString()})`;
    lines.push(`  ${credit.title} · ${credit.status} · ${expiry}`);
    lines.push(`    Granted: ${new Date(credit.grantedAt).toLocaleString()}`);
  }

  if (usage.resetCredits?.length === 0 && (usage.availableResets ?? 0) > 0) {
    lines.push("  Reset details: not reported");
  }

  if (usage.resetDetailsUnavailable) {
    lines.push("  Reset details unavailable; try /usage again later.");
  }
  return ["Codex usage", ...lines].join("\n");
}
