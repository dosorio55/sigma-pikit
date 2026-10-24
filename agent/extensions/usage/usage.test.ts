import assert from "node:assert/strict";
import { test } from "node:test";
import usage from "./index.ts";
import { accountIdFromToken, fetchUsage, formatUsage, parseUsage, USAGE_URL } from "./usage.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const token = `header.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
})).toString("base64url")}.signature`;
const shortWindow = { used_percent: 70, limit_window_seconds: 18000, reset_at: 1700008100 };
const weeklyWindow = { used_percent: 28, limit_window_seconds: 604800, reset_at: 1700259200 };
const payload = { rate_limit: { primary_window: shortWindow, secondary_window: weeklyWindow } };

test("extracts the account from OAuth and rejects API keys and malformed claims", () => {
  assert.equal(accountIdFromToken(token), "test-account");
  for (const invalid of ["sk-test", "a.b.c", "a.e30.c"]) {
    assert.throws(() => accountIdFromToken(invalid), /OAuth/);
  }
});

test("parses two windows and identifies a lone weekly primary by its duration", () => {
  const windows = parseUsage(payload);
  assert.equal(windows.length, 2);
  const text = formatUsage(windows, 1700000000000);
  assert.match(text, /5 hours: 30% remaining · resets in 2h 15m/);
  assert.match(text, /Weekly: 72% remaining · resets in 3d 0h 0m/);
  const weekly = parseUsage({ rate_limit: { primary_window: weeklyWindow, secondary_window: null } });
  assert.equal(weekly.length, 1);
  assert.match(formatUsage(weekly), /Weekly: 72%/);
  assert.doesNotMatch(formatUsage(weekly), /5 hours/);
});

test("handles zero allowance, expired resets, fractional usage and unknown durations", () => {
  const windows = parseUsage({ rate_limit: { secondary_window: {
    ...shortWindow, used_percent: 100, limit_window_seconds: 3600,
  } } });
  assert.match(formatUsage(windows, 1800000000000), /1 hours: 0% remaining · resets in 0h 0m/);
  windows[0].usedPercent = 30.25;
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

test("fetches only the fixed endpoint with OAuth headers, timeout and no redirects", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, USAGE_URL);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.get("chatgpt-account-id"), "test-account");
    return Response.json(payload);
  });
  assert.equal((await fetchUsage(token)).length, 2);
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
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  usage(pi);
  assert.equal(authCalls, 0);
  assert.equal(fetchMock.mock.callCount(), 0);
  await handler("", ctx);
  assert.equal(authCalls, 1);
  assert.match(notifications[0], /5 hours: 30% remaining/);
});
