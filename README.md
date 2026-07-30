# sigma

Σ — my collection of plugins for the [pi](https://github.com/earendil-works) agent.
The sum of my pieces, kept separate so I can install and change only what I want.

## Extensions

| Extension | What it does | Idle cost |
|-----------|--------------|-----------|
| `hello`   | The "hello world": draws a one-line footer. A base for learning. | none |
| `footer`  | Two-line footer: project path, model, branch, context bar, tokens, thinking level and cost. | none |
| `wsl-clipboard-image` | Pastes images from the Windows clipboard into the prompt with `Alt+V` (or the `wsl-paste-image` command). Reads the native clipboard via `powershell.exe` and tries several formats (PNG, file, bitmap), so it also works with `Win+V` history. WSL only. | none — `powershell.exe` only runs on demand |
| `context` | `/context`: what is filling the context window, itemised — system prompt, skills, context files and tool schemas grouped by MCP server or extension, with the compaction point marked. | none — computed when you run the command |

### `context`

```bash
/context        # grid, grouped totals
/context all    # every tool and context file, one row each
```

The footer already shows the running total, so the number is not the point. The
breakdown is: *65k tokens* does not tell you that an MCP server you never call is
eating 15k of it, and that is the fact a `disabled: true` follows from.

What it reports:

- **System prompt**, split into the base prompt, skills and context files. Skills
  are measured with pi's own `formatSkillsForPrompt`, so the figure is the block
  that actually ships — skills marked `disable-model-invocation` correctly cost
  nothing, and since pi only includes the skills block while the `read` tool is
  active, the row says so instead of inventing a cost when it is not.
- **Tool schemas**, grouped by the thing you could switch off: an MCP server, an
  extension, the built-ins. Not by `sourceInfo.source` — "extension: 4.9k" names
  nothing you can act on.
- **Configured, not in context.** A tool that is not active has no schema in the
  request, so it costs zero however much it weighs on disk. Same for MCP servers
  in `mcp.json` with no registered tool — in proxy mode that is every one of
  them, and the single `mcp` gateway is listed separately as what you do pay for.
- **The compaction point.** pi compacts at `contextWindow - reserveTokens`
  (16384 by default), so the last ~16k of the window is not yours. A `┊` in the
  grid marks where it fires. The setting is resolved through pi's own
  `SettingsManager`, so an untrusted project's `.pi/settings.json` is ignored
  here exactly as pi ignores it — otherwise the mark would point somewhere pi is
  not going.

Token counts come from pi's exported `estimateTokens`, the same function that
decides when compaction triggers — a `/context` doing its own arithmetic would
be confidently wrong about the one number it exists to predict.

Tools are attributed to an MCP server through the adapter's own metadata cache
(`mcp-cache.json`), which maps servers to the tool and resource names they
registered, and only then by rebuilding the adapter's name prefixes. Cache
matching works even under `toolPrefix: none`, where there is no prefix left to
match on; if two servers claim the same unprefixed name, attribution stays
unknown rather than depending on stale cache order. Server names are discovered from pi's MCP configs, a
`--mcp-config` override, explicit `imports`, and host configs when
`hostConfigDiscovery` is on. JSON sources are parsed as JSONC, comments and
trailing commas included, because that is what the adapter accepts. Codex's
TOML config is not parsed.

Attribution is gated on the tool actually coming from the MCP adapter, so a
server named `web` cannot capture some other extension's `web_search`. Anything
that cannot be traced lands in a **`MCP · server unknown`** row at its real cost,
and while such a row exists no server is listed as idle — one of them may be the
server paying for it.

**Idle cost: none.** No watcher, no timer, no per-turn bookkeeping to keep a live
figure warm — the footer is the live indicator, this is the on-demand X-ray. The
only work is on invocation: a handful of small JSON reads and a walk over the
tool list already in memory.

## How it works

`package.json` declares where the extensions live:

```json
"pi": { "extensions": ["./agent/extensions/*/index.ts"] }
```

pi loads the default exported function from each `index.ts`. Each extension
subscribes to events (`pi.on(...)`) and/or registers UI (`ctx.ui.setFooter(...)`).

## Install / try locally

Try a single extension without installing anything:

```bash
pi -ne -e ./agent/extensions/footer/index.ts
```

Install it permanently from git (once published):

```bash
pi install git:github.com/dosorio55/sigma-pikit
```
