# sigma

Σ — my collection of plugins for the [pi](https://github.com/earendil-works) agent.
The sum of my pieces, kept separate so I can install and change only what I want.

## Extensions

| Extension | What it does | Idle cost |
|-----------|--------------|-----------|
| `hello`   | The "hello world": draws a one-line footer. A base for learning. | none |
| `footer`  | Two-line footer: project path, model, active profile, branch, context bar, tokens, thinking level and cost. | none |
| `wsl-clipboard-image` | Pastes images from the Windows clipboard into the prompt with `Alt+V` (or the `wsl-paste-image` command). Reads the native clipboard via `powershell.exe` and tries several formats (PNG, file, bitmap), so it also works with `Win+V` history. WSL only. | none — `powershell.exe` only runs on demand |
| `context` | `/context`: what is filling the context window, itemised — system prompt, skills, context files and tool schemas grouped by MCP server or extension, with the compaction point marked. | none — computed when you run the command |
| `profiles` | Several pi configurations in one install, switched with `/profile`. Swaps symlinks in `~/.pi/agent` so other plugins read a different `mcp.json`, `agents/`, `skills/`, `prompts/` and `AGENTS.md`, then starts a new session. | none — a few path operations per switch, no watchers |

The `◆ <name>` segment appears only when `profiles` is in use — `footer` reads
`~/.pi/agent/profiles/active` directly rather than importing from `profiles/`, so
the two stay separately installable and neither needs the other.

### `profiles`

```bash
/profile                      # pick from a list
/profile study                # switch directly
/profile new study            # create an empty profile
/profile new study --from code  # create it as a copy
/profile disable              # restore real top-level paths before uninstalling
```

Which paths are profile-scoped is set in `~/.pi/agent/profiles/manifest.json`:

```json
{
  "swap": ["mcp.json", "agents/", "skills/", "prompts/", "AGENTS.md"],
  "blacklist": []
}
```

Anything not listed in `swap` is left alone — that is already the answer for
loose docs and one-off files, so they need no entry anywhere. The blacklist is
narrower: paths where listing them *by mistake* does real damage. Those are
hardcoded, cannot be removed by editing the manifest, and are skipped with a
warning rather than an error:

| Path | Why |
|------|-----|
| `auth.json`, `trust.json` | credentials and project trust — forking them fails silently |
| `git/`, `npm/`, `bin/`, `tmp/` | pi-managed runtime, heavy and machine-specific |
| `package.json`, package-manager lockfiles, `node_modules/`, `.npmrc` | dependency graph for shared extensions; generated modules are heavy and registry config may contain credentials |
| `fff/`, `missions/`, `run-history.jsonl`, `.playwright-mcp/` | extension indexes, durable subagent state, execution history and credential-bearing browser runtime |
| `mcp-cache.json`, `mcp-npx-cache.json`, `mcp-onboarding.json` | caches derived from `mcp.json`; keyed by config hash, so already correct shared |
| `sessions/` | shared across profiles on purpose |
| `settings.json`, `models-store.json` | global preference and provider catalogue |
| `extensions/`, `.git`, `profiles/` | swapping these removes the way back |

`blacklist` in the manifest only *adds* to that list. Entries are canonicalised
first, so `./auth.json` and `git/config` are caught too, and nothing outside
`~/.pi/agent` is ever accepted.

Deliberately **not** blacklisted: `keybindings.json` and plugin configs like
`pi-statusline.json`. Swapping those is a defensible choice and easily undone, so
the option stays open.

The store lives **inside** `~/.pi/agent` so a dotfiles repo tracking that
directory versions the profiles too, and the symlinks it writes are relative
(`mcp.json -> profiles/code/mcp.json`) so they survive being cloned to a
different home directory. Track `manifest.json` and the profile directories;
ignore `profiles/active`, `profiles/lock` and `profiles/disable-lock`, which are
machine-local.

Profile names must match `[A-Za-z0-9][A-Za-z0-9._-]*`; plugin-owned names and
command verbs (`active`, `lock`, `disable-lock`, `manifest.json`, `new`, `disable`) are reserved.
`--from` only accepts an existing profile.

Switching always starts a new session: the old transcript references tools the
new profile may not register. Running `/profile <current>` does not no-op — it
re-checks the symlinks and adopts any newly listed path, which is how you install
a new plugin's config into the profile.

Files already in `~/.pi/agent` are moved into the active profile and symlinked
back, after asking. **Your own symlinks are preserved**: a path like
`AGENTS.md -> ~/dotfiles/AGENTS.md` is adopted as a link, never deleted.

Before uninstalling the extension or deleting `profiles/`, run `/profile disable`.
It materializes the active profile as real paths in `~/.pi/agent`, removes the
active marker, reloads Pi, and leaves every profile directory intact as a backup.
Only links owned by this extension are replaced; real paths and user-owned
symlinks are already independent and remain untouched. It also finds owned links
from older manifest entries, and refuses while any other Pi instance is open.
Once it reports success, the extension and `profiles/` can be removed without
leaving dangling links.

**Idle cost: none.** No watchers, no timers, no eager loading of inactive
profiles. The manifest is read when you run `/profile`, and a switch is a handful
of `symlink`/`rename` calls. A lockfile records which pid holds which profile,
written at session start and on switch, released on quit — so with two pi
instances open, switching in one now **refuses** rather than silently changing
config under the other. Resuming a session from another profile switches to it
first; opening one via `pi -c` warns instead, since config cannot be swapped
mid-startup.

See [`agent/extensions/profiles/DESIGN.md`](agent/extensions/profiles/DESIGN.md)
for why it works this way.

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

Test profiles together with its footer indicator while disabling every installed
extension:

```bash
pi --no-extensions \
  -e /home/alejandro/Projects/Development/Personal/Pi-plugins/sigma/agent/extensions/profiles/index.ts \
  -e /home/alejandro/Projects/Development/Personal/Pi-plugins/sigma/agent/extensions/footer/index.ts
```

Install it permanently from git (once published):

```bash
pi install git:github.com/dosorio55/sigma-pikit
```
