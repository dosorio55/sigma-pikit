import assert from "node:assert/strict";
import { test } from "node:test";
import usage from "./index.ts";
import { accountIdFromToken, fetchUsage, formatDuration, formatUsage, parseResetCredits, parseUsage, RESET_CREDITS_URL, USAGE_URL } from "./usage.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const token = `header.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
})).toString("base64url")}.signature`;
const shortWindow = { used_percent: 70, limit_window_seconds: 18000, reset_at: 1700008100 };
const weeklyWindow = { used_percent: 28, limit_window_seconds: 604800, reset_at: 1700259200 };
const payload = {
  rate_limit: { primary_window: shortWindow, secondary_window: weeklyWindow },
  credits: { has_credits: true, unlimited: false, balance: "42.50" },
  rate_limit_reset_credits: { available_count: 2 },
};

const resetPayload = {
  available_count: 2,
  credits: [{
    id: "reset-a",
    reset_type: "usage_reset",
    status: "available",
    title: "Bonus reset",
    granted_at: "2026-01-01T00:00:00Z",
    expires_at: "2026-01-04T00:00:00Z",
  }, {
    id: "reset-b",
    reset_type: "usage_reset",
    status: "available",
    granted_at: "2026-01-01T00:00:00Z",
    expires_at: null,
  }],
};

test("extracts the account from OAuth and rejects API keys and malformed claims", () => {
  assert.equal(accountIdFromToken(token), "test-account");
  for (const invalid of ["sk-test", "a.b.c", "a.e30.c"]) {
    assert.throws(() => accountIdFromToken(invalid), /OAuth/);
  }
});

test("parses two windows and identifies a lone weekly primary by its duration", () => {
  const windows = parseUsage(payload);
  assert.equal(windows.windows.length, 2);
  const text = formatUsage(windows, 1700000000000);
  assert.match(text, /5 hours: 30% remaining · resets in 2h 15m/);
  assert.match(text, /Weekly: 72% remaining · resets in 3d/);
  const weekly = parseUsage({ rate_limit: { primary_window: weeklyWindow, secondary_window: null } });
  assert.equal(weekly.windows.length, 1);
  assert.match(formatUsage(weekly), /Weekly: 72%/);
  assert.doesNotMatch(formatUsage(weekly), /5 hours/);
});

test("handles zero allowance, expired resets, fractional usage and unknown durations", () => {
  const windows = parseUsage({ rate_limit: { secondary_window: {
    ...shortWindow, used_percent: 100, limit_window_seconds: 3600,
  } } });
  assert.match(formatUsage(windows, 1800000000000), /1 hours: 0% remaining · resets in 0m/);
  windows.windows[0].usedPercent = 30.25;
  assert.match(formatUsage(windows), /69.8% remaining/);
});

test("rejects absent and malformed quota rather than inventing an allowance", () => {
  for (const empty of [null, {}, { rate_limit: null }, { rate_limit: { primary_window: null } }]) {
    assert.throws(() => parseUsage(empty), /did not report/);
  }
  for (const invalid of [
    { used_percent: -1 }, { used_percent: 101 }, { used_percent: "30" },
    { used_percent: NaN }, { limit_window_seconds: 0 }, { reset_at: "tomorrow" },
    { reset_at: 9e12 },
  ]) {
    assert.throws(() => parseUsage({ rate_limit: {
      primary_window: { ...shortWindow, ...invalid },
    } }), /invalid usage window/);
  }
});

test("fetches fixed usage and reset endpoints with OAuth headers, timeout and no redirects", async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(url);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.get("chatgpt-account-id"), "test-account");
    return Response.json(url === USAGE_URL ? payload : resetPayload);
  });
  const result = await fetchUsage(token);
  assert.deepEqual(urls, [USAGE_URL, RESET_CREDITS_URL]);
  assert.equal(result.resetCredits?.length, 2);
  assert.equal(result.resetDetailsUnavailable, undefined);
  assert.equal(result.windows.length, 2);
  assert.equal(result.credits?.balance, "42.50");
  assert.equal(result.availableResets, 2);
});

test("reports HTTP, network and JSON errors without exposing response bodies", async (t) => {
  for (const status of [401, 403, 429, 500]) {
    const mocked = t.mock.method(globalThis, "fetch", async () => new Response("secret-body", { status }));
    await assert.rejects(fetchUsage(token), (error: Error) => {
      assert.doesNotMatch(error.message, /secret-body|signature/);
      assert.match(error.message, /authentication expired|denied access|Too many|HTTP 500/);
      return true;
    });
    mocked.mock.restore();
  }
  const malformed = t.mock.method(globalThis, "fetch", async () => new Response("not JSON"));
  await assert.rejects(fetchUsage(token), /unreadable/);
  malformed.mock.restore();
  t.mock.method(globalThis, "fetch", async () => { throw new Error(`private ${token}`); });
  await assert.rejects(fetchUsage(token), /network error or 10-second timeout/);
});

test("command resolves Codex auth on demand even with another active provider", async (t) => {
  let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> = async () => {};
  const notifications: string[] = [];
  const pi = {
    registerCommand(name: string, command: { handler: typeof handler }) {
      assert.equal(name, "usage");
      handler = command.handler;
    },
  } as unknown as ExtensionAPI;
  let authCalls = 0;
  const ctx = {
    modelRegistry: {
      async getProviderAuth(provider: string) {
        authCalls++;
        assert.equal(provider, "openai-codex");
        return { auth: { apiKey: token } };
      },
    },
    ui: { notify(message: string) { notifications.push(message); } },
  } as unknown as ExtensionCommandContext;
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: string) =>
    Response.json(url === USAGE_URL ? payload : resetPayload));
  usage(pi);
  assert.equal(authCalls, 0);
  assert.equal(fetchMock.mock.callCount(), 0);
  await handler("", ctx);
  assert.equal(authCalls, 1);
  assert.match(notifications[0], /5 hours: 30% remaining/);
  assert.match(notifications[0], /Credits: 42\.50/);
  assert.match(notifications[0], /Available resets: 2/);
  assert.match(notifications[0], /Bonus reset · available/);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("shows credit balance and available resets from the same response", () => {
  const text = formatUsage(parseUsage(payload));
  assert.match(text, /Credits: 42\.50/);
  assert.match(text, /Available resets: 2/);
});

test("distinguishes unlimited, zero, missing and undisclosed credit balances", () => {
  for (const [credits, expected] of [
    [{ has_credits: true, unlimited: true, balance: "0" }, "unlimited"],
    [{ has_credits: false, unlimited: false, balance: "0" }, "0"],
    [{ has_credits: false, unlimited: false, balance: null }, "none"],
    [{ has_credits: true, unlimited: false }, "available (balance not reported)"],
    [null, "not reported"],
    [undefined, "not reported"],
  ] as const) {
    const text = formatUsage(parseUsage({ ...payload, credits }));
    assert.ok(text.includes(`Credits: ${expected}\n`));
  }
  const noResets = formatUsage(parseUsage({ ...payload, rate_limit_reset_credits: { available_count: 0 } }));
  assert.match(noResets, /Available resets: 0/);
  for (const missing of [null, undefined]) {
    assert.match(formatUsage(parseUsage({ ...payload, rate_limit_reset_credits: missing })),
      /Available resets: not reported/);
  }
});

test("can show credits or reset counts when no quota windows are reported", () => {
  const creditsOnly = parseUsage({ credits: payload.credits });
  assert.equal(creditsOnly.windows.length, 0);
  assert.match(formatUsage(creditsOnly), /Credits: 42\.50/);
  assert.match(formatUsage(parseUsage({ rate_limit_reset_credits: { available_count: 0 } })),
    /Available resets: 0/);
});

test("rejects malformed credit and reset metadata", () => {
  for (const credits of [
    {}, [], { has_credits: "true", unlimited: false },
    { has_credits: true, unlimited: false, balance: 42 },
    { has_credits: true, unlimited: false, balance: "\u001b[31m42" },
    { has_credits: true, unlimited: false, balance: "-1" },
  ]) {
    assert.throws(() => parseUsage({ ...payload, credits }), /invalid credit information/);
  }
  for (const available_count of [-1, 0.5, "2", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    assert.throws(() => parseUsage({ ...payload, rate_limit_reset_credits: { available_count } }),
      /invalid available reset count/);
  }
});

test("formats reset expiry, missing expiry, status and grant date", () => {
  const details = parseResetCredits(resetPayload);
  const result = parseUsage(payload);
  result.resetCredits = details.credits;
  const text = formatUsage(result, Date.parse("2026-01-02T00:00:00Z"));
  assert.match(text, /Bonus reset · available · expires in 2d/);
  assert.match(text, /usage_reset · available · expiry not reported/);
  assert.ok(text.includes(new Date("2026-01-04T00:00:00Z").toLocaleString()));
  assert.ok(text.includes(`Granted: ${new Date("2026-01-01T00:00:00Z").toLocaleString()}`));
  assert.match(formatUsage(result, Date.parse("2026-01-05T00:00:00Z")), /Bonus reset · available · expired/);
});

test("does not fetch reset details for zero or unreported available counts", async (t) => {
  for (const summary of [{ available_count: 0 }, null, undefined]) {
    const fetchMock = t.mock.method(globalThis, "fetch", async () =>
      Response.json({ ...payload, rate_limit_reset_credits: summary }));
    const result = await fetchUsage(token);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(result.resetCredits, undefined);
    assert.equal(result.resetDetailsUnavailable, undefined);
    fetchMock.mock.restore();
  }
});

test("keeps quotas and credits when reset details fail without leaking secrets", async (t) => {
  for (const failure of [401, 403, 429, 500, "network", "json", "schema"]) {
    const fetchMock = t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url === USAGE_URL) return Response.json(payload);
      if (typeof failure === "number") return new Response(`secret ${token}`, { status: failure });
      if (failure === "network") throw new Error(`secret ${token}`);
      if (failure === "json") return new Response(`secret ${token}`);
      return Response.json({ credits: "secret" });
    });
    const result = await fetchUsage(token);
    assert.equal(result.windows.length, 2);
    assert.equal(result.availableResets, 2);
    assert.equal(result.resetDetailsUnavailable, true);
    const text = formatUsage(result);
    assert.match(text, /Credits: 42\.50/);
    assert.match(text, /Reset details unavailable/);
    assert.doesNotMatch(text, /secret|signature/);
    fetchMock.mock.restore();
  }
});

test("uses the latest available count and tolerates an empty detail list", async (t) => {
  for (const count of [0, 1]) {
    const fetchMock = t.mock.method(globalThis, "fetch", async (url: string) =>
      Response.json(url === USAGE_URL ? payload : { available_count: count, credits: [] }));
    const result = await fetchUsage(token);
    assert.equal(result.availableResets, count);
    assert.deepEqual(result.resetCredits, []);
    if (count > 0) assert.match(formatUsage(result), /Reset details: not reported/);
    fetchMock.mock.restore();
  }
});

test("validates reset detail metadata and rejects unsafe terminal text", () => {
  for (const invalid of [null, {}, { available_count: -1, credits: [] }, { available_count: 1, credits: {} }]) {
    assert.throws(() => parseResetCredits(invalid), /invalid reset credit details/);
  }
  for (const invalid of [
    { title: "\u001b[31mreset" }, { status: "available\nforged" },
    { granted_at: "not a date" }, { expires_at: "not a date" },
    { expires_at: 123 }, { status: null }, { title: null, reset_type: null },
  ]) {
    assert.throws(() => parseResetCredits({
      available_count: 1, credits: [{ ...resetPayload.credits[0], ...invalid }],
    }), /invalid reset credit details/);
  }
  const missingExpiry = { ...resetPayload.credits[0], expires_at: undefined };
  assert.equal(parseResetCredits({ available_count: 1, credits: [missingExpiry] }).credits[0].expiresAt, undefined);
});

test("formats remaining time dynamically as months, weeks, days, hours and minutes", () => {
  const minute = 60_000;
  for (const [minutes, expected] of [
    [-1, "0m"], [0, "0m"], [0.1, "1m"], [59, "59m"], [60, "1h"],
    [61, "1h 1m"], [1440, "1d"], [10080, "1w"], [43200, "1mo"],
    [129 * 60, "5d 9h"], [325 * 60, "1w 6d 13h"],
    [43200 + 10080 + 1440 + 60 + 1, "1mo 1w 1d 1h 1m"],
  ] as const) {
    assert.equal(formatDuration(minutes * minute), expected);
  }
});

test("uses dynamic remaining time for reset-credit expiry", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const result = parseUsage(payload);
  result.resetCredits = parseResetCredits(resetPayload).credits;
  for (const [hours, expected] of [[129, "5d 9h"], [325, "1w 6d 13h"]] as const) {
    result.resetCredits[0].expiresAt = now + hours * 3_600_000;
    assert.ok(formatUsage(result, now).includes(`expires in ${expected} (`));
  }
});
