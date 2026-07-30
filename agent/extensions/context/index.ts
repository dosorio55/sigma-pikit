import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";

import { collect } from "./collect.js";
import { render, renderPlain } from "./render.js";

/**
 * `/context` — where the context window is going, itemised.
 *
 * The footer already shows the running total, so the number is not the point.
 * The breakdown is: "65k" does not tell you an MCP server you never call is
 * eating 15k of it, and that is the fact a `disabled: true` follows from.
 *
 * Idle cost: none. Everything is computed when the command runs — no watcher,
 * no timer, no per-turn bookkeeping to keep a live figure warm.
 */
async function show(pi: ExtensionAPI, ctx: ExtensionCommandContext, expand: boolean) {
  const report = collect(pi, ctx);

  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify(renderPlain(report), "info");
    return;
  }

  await ctx.ui.custom((_tui, theme, _keybindings, done) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));

    container.addChild(border);
    for (const line of render(report, theme, expand)) {
      container.addChild(new Text(line, 1, 0));
    }
    container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 1));
    container.addChild(border);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("context", {
    description: "Show what is filling the context window",
    getArgumentCompletions: (prefix: string) => {
      const items = [{ value: "all", label: "all", description: "Show every tool and file" }];
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      await show(pi, ctx, args.trim() === "all");
    },
  });
}
