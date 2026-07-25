# profiles — design notes

Status: **design only, no code yet.** This folder has no `index.ts`, so the
`./agent/extensions/*/index.ts` glob does not pick it up and pi ignores it.

## Goal

Let one pi installation hold several separate configurations and switch between
them. A `study` profile with its own subagents, MCP servers, skills and
`AGENTS.md`; a `code` profile (the default) with the current setup; more later.

## Naming

Called **profile**, not "session". Pi already uses *session* for a single
conversation transcript (`/resume`, forks, `sessions/`), and overloading it would
be confusing. `/profile study`, `/profile code`.

## Architecture: swap at the filesystem layer

The plugin does **not** know what an MCP server or a subagent is. It swaps
symlinks inside `~/.pi/agent` so that other plugins read a different file, then
calls `ctx.reload()`.

```
~/.pi/profiles/
  code/     mcp.json  settings.json  agents/  skills/  AGENTS.md
  study/    mcp.json  settings.json  agents/  skills/  AGENTS.md

~/.pi/agent/mcp.json  ->  ~/.pi/profiles/code/mcp.json   (symlink)
```

Switching = repoint the symlinks + `ctx.reload()` + new session.

### Why this instead of integrating with each plugin

Operating at folder level means we stay in sync with plugins whose config schema
we have never read, including ones installed in the future. No parsing of
`mcp.json`, no knowledge of `subagents.agentOverrides`, nothing to update when a
plugin renames a field.

### Why symlinks instead of moving/renaming the real files

Moving the real config aside loses data:

- A crash or Ctrl-C mid-switch leaves a half-applied state with config under a
  temp name.
- `pi-mcp-adapter` writes config itself (`/mcp disable` persists to project-local
  `.pi/mcp.json`). If it writes while the file is moved aside, one version loses.
- Churn for anything watching those paths.

With symlinks the originals never move, and the swap is one `symlink` + `rename`,
which is atomic on Linux. A crash leaves either the old profile or the new one,
never a hole.

### Rejected: a Go helper binary

Considered a small Go binary to do the file work. Dropped:

- The work is a handful of path operations, microseconds. A process spawn per
  switch costs more than the operations themselves, so it makes switching
  *slower*.
- A cross-platform binary to build, version and keep matched to the TS side.
- It does not replace the extension anyway — only the extension can call
  `ctx.reload()` — so it is a second moving part hanging off the first.

Against the lightness principle in `AGENTS.md`, this is the indirect-cost case: a
"lightweight" component that makes the whole heavier than doing nothing.

### Rejected: per-plugin config overlay

Earlier idea: read each plugin's config and overlay profile values at load time
via `before_agent_start` / `resources_discover`. Works, but needs per-plugin
knowledge and breaks when a plugin changes its schema. The filesystem approach
is strictly better decomposed.

## The manifest

A JSON file lists which paths are profile-scoped and which are shared, so a new
plugin with a new config file is a one-line addition and never a new release of
this plugin.

- **`profile`** — swapped per profile: `mcp.json`, `settings.json`, `agents/`,
  `skills/`, `AGENTS.md`.
- **`shared`** — explicitly never swapped. `auth.json` (do not fork OAuth
  credentials), `npm/` (re-downloading packages per profile would be genuinely
  heavy), `sessions/` (see below).

Shared is listed explicitly rather than being "everything not mentioned", so the
intent is visible.

### Rules to bake in from the start

- **Refuse any path outside the agent dir.** A typo'd `../..` in a config that
  performs renames is a bad afternoon.
- **Migration is explicit.** The first time a path becomes profile-scoped there
  is a real file sitting there. Copy it into the default profile, *then*
  symlink — never silently clobber. If the profile dir already has that path,
  stop and ask.

### Known rough edge: `settings.json`

It mixes profile-ish keys (`subagents.*`) with global ones (`defaultProvider`,
`defaultModel`, `theme`, `packages`). Scoping the whole file means duplicating
provider/model config across profiles and editing it in N places. Start by
scoping the whole file (simple, matches the model) and only add per-key merge
logic if it actually becomes annoying.

## Session semantics

**Switching profiles creates a new session. Mandatory.**

`ctx.newSession({ parentSession, setup, withSession })` exists for exactly this,
so it is cheap: write active profile → swap symlinks → `newSession()`.

Why it cannot be optional: a transcript contains `tool_use` blocks referencing
tools the new profile may not register. Feeding that history back with a changed
tool list invites the model to call tools that no longer exist, and some
providers are stricter than that. Beyond the mechanics, dragging code context
into a study profile defeats the purpose.

### Resume across profiles

Sessions stay **shared**, not profile-scoped — `/resume` should list everything,
with the profile as a label.

- Stamp the profile into session **metadata** (machine-readable), and into the
  description so it is visible in the picker.
- Hook `session_before_switch` (fires on `/resume`): if the session's profile
  differs from the active one, either auto-switch and reload, or prompt. Never
  silently open a study session under the code profile.

## Open problem: concurrent pi instances

Symlinks in `~/.pi/agent` are global to the machine, not scoped to the pi
process. Switching to `study` in one terminal silently yanks config out from
under every already-running pi, including a code session mid-task whose next
`/reload` would pick up the wrong profile.

This is inherent to swapping shared on-disk state, not fixable inside the design.
Options:

- **Accept it** — one pi at a time. Simplest.
- **Guard it** — a lockfile recording which PID holds which profile; refuse to
  switch while another live pi holds a different one. Cheap, no idle cost, and it
  turns silent corruption into a clear error.

**Undecided.** Depends on whether two pi instances ever run at once.

## Idle cost

Target: **none.** A file read at startup, a few path operations per switch.

Specifically ruled out:

- No `fs.watch` on the profile directories. Re-read on `/profile` instead — a
  persistent watcher per profile is exactly the idle-CPU drip this repo exists to
  avoid.
- No eager loading of inactive profiles to make switching feel instant. Only the
  active profile is loaded.

Good news from the existing setup: `pi-mcp-adapter` is **lazy by default** —
servers connect on first tool call, with cached metadata so search/describe work
without a live connection. It also supports per-server `disabled: true` and
`lifecycle: lazy | eager | keep-alive | lazy-keep-alive`. So profile-scoped MCP
config costs nothing at idle as long as nothing is set to `eager`/`keep-alive`.

## Relevant pi API (verified in `docs/extensions.md`)

- `resources_discover` → returns `skillPaths`, `promptPaths`, `themePaths`.
  Useful if we ever want to add paths without symlinking.
- `before_agent_start` → `systemPromptOptions` exposes mutable `contextFiles`
  (AGENTS.md), `selectedTools`, `skills`. A read-only profile could drop
  `edit`/`write` here.
- `ctx.reload()` → same flow as `/reload`; re-emits `session_start` (reason
  `"reload"`) and `resources_discover`. Treat as terminal in the handler
  (`await ctx.reload(); return;`).
- `ctx.newSession()` / `session_before_switch` → see session semantics above.
- Note: pi ships **no built-in MCP or subagents**; both come from installed
  packages (`pi-mcp-adapter`, `pi-subagents`), which is why the filesystem-level
  approach is the right seam.

## Next decisions

1. Concurrent instances: accept, or lockfile?
2. Manifest file location and exact format.
3. Whether `settings.json` needs per-key merging or whole-file scoping is enough.
