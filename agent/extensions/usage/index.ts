import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { accountIdFromToken, fetchUsage, formatUsage } from "./usage.ts";

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
        let authFailed = false;
        let unsupportedAuth = false;
        let incompatibleOAuth = false;
        for (const provider of ["openai", "openai-codex"]) {
          let candidate: string | undefined;
          let source: string | undefined;
          try {
            const resolved = await ctx.modelRegistry.getProviderAuth(provider);
            candidate = resolved?.auth.apiKey;
            source = resolved?.source;
          } catch {
            authFailed = true;
            continue;
          }
          if (!candidate) continue;
          try {
            // Subscription tokens carry the account ID required by the usage API.
            accountIdFromToken(candidate);
            token = candidate;
            break;
          } catch {
            if (source === "OAuth") incompatibleOAuth = true;
            else unsupportedAuth = true;
          }
        }
        if (!token) {
          if (authFailed) {
            throw new Error("Could not resolve Codex authentication. Use /login → OpenAI → Sign in with ChatGPT (or OpenAI Codex (legacy)).");
          }
          ctx.ui.notify(
            incompatibleOAuth
              ? "You are signed in with OpenAI OAuth, but this token does not expose the ChatGPT account ID required by /usage. Configure /login → OpenAI Codex (legacy) for usage checks; keep your existing OpenAI login for models."
              : unsupportedAuth
              ? "ChatGPT OAuth authentication is required; API keys are not supported. Use /login → OpenAI → Sign in with ChatGPT (or OpenAI Codex (legacy))."
              : "Use /login → OpenAI → Sign in with ChatGPT (or OpenAI Codex (legacy)) before checking usage.",
            "warning",
          );
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
