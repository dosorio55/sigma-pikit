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
      getProviderAuth: () => new Promise<undefined>((resolve) => { resolveAuth = resolve; }),
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
