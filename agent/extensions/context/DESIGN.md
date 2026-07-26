# context — design notes

Status: **design only, no code yet.** This folder has no `index.ts`, so the
`./agent/extensions/*/index.ts` glob does not pick it up and pi ignores it.

## Goal

A `/context` command that shows **where the context window is going** — which
tools, MCP servers, skills and context files are costing tokens, itemised.

Inspired by Claude Code's `/context`, but deliberately not a straight copy: see
[Scope](#scope-static-overhead-only) and [Compaction line](#the-compaction-line).

## Why this is worth building

pi's footer already shows the running total: tokens, cost, cache hit rate, model.
So the *number* is a solved problem, and duplicating it adds nothing.

What does not exist anywhere is the **breakdown**. "65k tokens" does not tell you
that an MCP server you never use is eating 15k of it. The breakdown is what turns
the number into a decision — `disabled: true`, or a `lifecycle` change, or
dropping a skill.

## Scope: static overhead only

**v1 reports the static overhead, not the conversation total.**

- **In:** tools, MCP servers, skills, context files, system prompt.
- **Out:** message/transcript totals — the footer already covers that.

This is the half that exists nowhere else, and it is also the half that is cheap
and stateless to compute (see below). Scoping it this way makes the plugin
smaller *and* more useful than a faithful clone.

## The interesting part: active vs configured

`pi.getActiveTools()` returns active tool **names**; `pi.getAllTools()` returns
metadata for **all configured** tools (`extensions.md:1622`). Those two sets
differ, and the gap is the whole point.

`pi-mcp-adapter` is **lazy by default** — servers connect on first tool call,
with cached metadata so search/describe work without a live connection. So a
configured MCP server may be costing **zero tokens right now**, exactly like
deferred tools in Claude Code (listed at 14.9k, actually contributing 0).

A single "MCP: 14.9k" line would therefore be a lie. The display splits:

```
Active in context          real tokens, per tool, sorted desc
Configured but not loaded  0 tokens, listed so you know it exists
```

That answers the actual question — *what is my setup costing me* — and attaches
a decision to it: a server that is active, expensive and unused is one
`disabled: true` away from free.

Skills are different and worth itemising separately: skill descriptions sit in
the system prompt, so they are an **always-paid** cost, not a lazy one.

## The compaction line

Auto-compaction fires at `contextTokens > contextWindow - reserveTokens`, with
`reserveTokens` defaulting to **16384** and configurable in `settings.json`
(`compaction.md`).

So "free space" is not free — you hit compaction ~16k before the window edge.
Claude Code's `/context` does not show this. Reading `reserveTokens` and drawing
the threshold makes this version genuinely more informative than the thing it
copies:

```
⛁ ⛁ ⛁ ⛀ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛶ ⛶ ⛶ ⛶ ⛶ ┊ ⛶
                                          ↑ compaction at 984k
```

## Token math: use pi's own

`estimateTokens` and `calculateContextTokens` are exported from the package root
(`pi-coding-agent/dist/index.d.ts:5`), alongside `shouldCompact` and
`getLastAssistantUsage`.

**Use them. Do not hand-roll a `chars / 4` heuristic.** A `/context` whose
numbers disagree with the math that actually triggers compaction is worse than
no `/context` at all — it would be confidently wrong about the one thing it
exists to predict.

`ctx.getContextUsage()` (`extensions.md:1036`) gives the headline total: real
usage from the last assistant message, estimated for the trailing tail.

## Statelessness

Restricting v1 to static overhead means **no cached state and no lifecycle
coupling**:

- `pi.getActiveTools()` / `pi.getAllTools()` — callable directly from a command
  handler.
- `estimateTokens` over each tool's serialised `parameters` + `description` —
  pure function.
- `ctx.model.contextWindow`, `reserveTokens` from settings — plain reads.

### The one exception: `systemPromptOptions`

Custom prompt, tool snippets, prompt guidelines, context files and loaded skills
live on `systemPromptOptions`, which pi hands to `before_agent_start` — it is not
sitting on `ctx` for a command to read whenever it likes.

So that slice requires capturing it in a handler and holding it in memory, and
`/context` reports last-known values. On a brand-new session before the first
turn there is no breakdown yet — show the tool/MCP half and say so for the rest.

Docs flag `systemPromptOptions` as **sensitive** — it may include full context
file contents. Local display only: never log it, never expose it through command
lists or autocomplete metadata (`extensions.md:1092`).

## Idle cost

Target: **none**, same rule as `profiles`.

Everything is computed on `/context` invocation. Specifically ruled out:

- No recomputation per turn to keep a live figure warm. The footer is already the
  live indicator; this command is the on-demand X-ray.
- No watcher on skill or MCP config.

The one piece of standing state is a reference to the last
`systemPromptOptions` — a pointer already held by pi, not a copy, and not work.

## Rejected: cloning `/context` faithfully

Reporting the message/transcript total too. Dropped: it duplicates the footer,
and it is the part that needs per-turn state to stay accurate. All cost, no
information gain.

## Relevant pi API (verified in `docs/`)

- `pi.getActiveTools()` → `string[]` of active names.
- `pi.getAllTools()` → `name`, `description`, `parameters`, `promptGuidelines`,
  `sourceInfo` (`{ path, source, scope, origin }`). `sourceInfo.source` is
  `builtin`, `sdk`, or extension source metadata — the grouping key for the
  display (`extensions.md:1622`).
- `ctx.getContextUsage()` → current usage for the active model
  (`extensions.md:1036`).
- `estimateTokens`, `calculateContextTokens`, `shouldCompact` → exported from
  the package root.
- `before_agent_start` → `systemPromptOptions`: custom prompt, active tools, tool
  snippets, prompt guidelines, context files, skills.
- `resources_discover` → `skillPaths`, `promptPaths`, `themePaths`.
- `ctx.ui.custom()` / `setWidget` → rendering. The grid is plain text lines;
  rendering is the easy part.
- Guard terminal-only rendering on `ctx.mode === "tui"` (`extensions.md:942`).

## Prior art

No existing `/context` extension for pi was found (npm, GitHub, the official
`examples/extensions` directory). pi has `/session` — "session file, ID,
messages, tokens, and cost" — which is numbers without breakdown or visual.

## Next decisions

1. Grouping: by `sourceInfo.source`, or by MCP server / skill / builtin?
2. Whether to show per-tool rows by default or only under `/context all`.
3. Whether the compaction line is worth the extra glyph in the grid, or belongs
   in the text summary only.
