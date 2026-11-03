import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import usage from "./index.ts";

test("handles missing auth, concurrent requests and auth failures without leaking secrets", async (t) => {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  usage({
    registerCommand(_name: string, command: { handler: typeof handler }) {
      handler = command.handler;
    },
  } as unknown as ExtensionAPI);
  const messages: string[] = [];
  let resolveAuth!: (value: undefined) => void;
  const ctx = {
    modelRegistry: {
      getProviderAuth: (provider: string) => provider === "openai"
        ? new Promise<undefined>((resolve) => { resolveAuth = resolve; })
        : Promise.resolve(undefined),
    },
    ui: { notify(message: string) { messages.push(message); } },
  } as unknown as ExtensionCommandContext;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("No request should be made without credentials");
  });
  const pending = handler("", ctx);
  await handler("", ctx);
  assert.match(messages[0], /already running/);
  resolveAuth(undefined);
  await pending;
  assert.match(messages[1], /Use \/login/);
  assert.equal(fetchMock.mock.callCount(), 0);

  ctx.modelRegistry.getProviderAuth = async () => { throw new Error("secret-auth-detail"); };
  await handler("", ctx);
  assert.match(messages[2], /Could not resolve Codex authentication/);
  assert.doesNotMatch(messages.join("\n"), /secret-auth-detail/);

  ctx.modelRegistry.getProviderAuth = async () => undefined;
  await handler("", ctx);
  assert.match(messages[3], /Use \/login/);
});

function subscriptionToken(account: string): string {
  return `header.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: account },
  })).toString("base64url")}.signature`;
}

test("uses current OpenAI subscription auth and falls back to legacy without sending API keys", async (t) => {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  usage({
    registerCommand(_name: string, command: { handler: typeof handler }) {
      handler = command.handler;
    },
  } as unknown as ExtensionAPI);
  const current = subscriptionToken("current-account");
  const legacy = subscriptionToken("legacy-account");
  const cases = [
    { current, legacy, expected: current, calls: ["openai"] },
    { current: undefined, legacy, expected: legacy, calls: ["openai", "openai-codex"] },
    { current: "sk-secret", legacy, expected: legacy, calls: ["openai", "openai-codex"] },
    { current: "throws", legacy, expected: legacy, calls: ["openai", "openai-codex"] },
    { current: "sk-secret", legacy: undefined, expected: undefined, calls: ["openai", "openai-codex"] },
    { current: "malformed", legacy: "malformed", expected: undefined, calls: ["openai", "openai-codex"] },
  ];
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, options?: RequestInit) => {
    assert.equal(options?.headers && (options.headers as Record<string, string>).Authorization, `Bearer ${expected}`);
    return new Response(JSON.stringify({ credits: { has_credits: false, unlimited: false } }));
  });
  let expected: string | undefined;
  for (const scenario of cases) {
    expected = scenario.expected;
    const calls: string[] = [];
    const messages: string[] = [];
    const ctx = {
      modelRegistry: {
        async getProviderAuth(provider: string) {
          calls.push(provider);
          const token = provider === "openai" ? scenario.current : scenario.legacy;
          if (token === "throws") throw new Error("secret-auth-detail");
          return token ? { auth: { apiKey: token } } : undefined;
        },
      },
      ui: { notify(message: string) { messages.push(message); } },
    } as unknown as ExtensionCommandContext;
    const before = fetchMock.mock.callCount();
    await handler("", ctx);
    assert.deepEqual(calls, scenario.calls);
    assert.equal(fetchMock.mock.callCount() - before, expected ? 1 : 0);
    assert.match(messages[0], expected ? /Codex usage/ : /ChatGPT OAuth authentication is required/);
    assert.doesNotMatch(messages.join("\n"), /sk-secret|secret-auth-detail/);
  }
});
