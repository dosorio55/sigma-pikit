import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchUsage, formatUsage } from "./usage.ts";

export default function usage(pi: ExtensionAPI): void {
  let pending = false;

  pi.registerCommand("usage", {
    description: "Show Codex allowance, reset times, credits and available resets",
    handler: async (_args, ctx) => {
      if (pending) {
        ctx.ui.notify("A Codex usage request is already running.", "info");
        return;
      }
      pending = true;
      try {
        let token: string | undefined;
        try {
          token = (await ctx.modelRegistry.getProviderAuth("openai-codex"))?.auth.apiKey;
        } catch {
          throw new Error("Could not resolve Codex authentication. Use /login with OpenAI Codex.");
        }
        if (!token) {
          ctx.ui.notify("Use /login with OpenAI Codex before checking usage.", "warning");
          return;
        }
        ctx.ui.notify(formatUsage(await fetchUsage(token)), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not read Codex usage.", "error");
      } finally {
        pending = false;
      }
    },
  });
}
