# profiles — design notes

Status: **v1 implemented.** `index.ts` (command + hooks), `manifest.ts` (load,
validate, blacklist), `swap.ts` (migration + symlinks), `lock.ts` (concurrent
instances). These notes record *why* it works this way; the README documents how
to use it.

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

**One list, by exclusion.** The manifest names the profile-scoped paths and
nothing else:

```json
{ "swap": ["mcp.json", "agents/", "skills/", "prompts/", "AGENTS.md"] }
```

- listed → swapped per profile
- unlisted → untouched

Named `swap`, not `profile`: inside a file that lives in `~/.pi/profiles`,
"profile" says nothing. `swap` names what actually happens to the path. Not
`files` — the list is half directories.

An earlier draft also carried an explicit `shared` list, to make the intent
visible. **Dropped.** Two lists create a third, undefined state — a path in
neither. With one list that state cannot exist: unlisted is itself a defined
answer. The `shared` list was never read by anything anyway; it documented
intent, which a comment does equally well.

### Canonicalise before checking

Every manifest entry is reduced to a path relative to the agent dir *before* any
check runs. Without that, `auth.json`, `./auth.json` and `agents/../auth.json`
are three different strings naming one file, and a blacklist comparing raw
strings only stops the first. Blacklist matching is by prefix, so `git/config` is
caught by the `git` entry.

The agent dir *itself* is refused (`.`, `./`, `agents/..`). It is not "inside the
agent dir" for our purposes: swapping it would move the whole config tree —
credentials and sessions included — into a profile directory and delete the
original.

### Only ever touch links we created

A symlink in the agent dir is only treated as ours if it resolves inside
`~/.pi/profiles`. Anything else is the user's own wiring — `AGENTS.md ->
~/dotfiles/AGENTS.md` is a normal setup — and is adopted on migration or reported
as blocked, never deleted. "Absent means remove the link" applies to our links
only.

### Blacklist

What the `shared` list *did* have worth keeping is protection against a footgun,
so that survives as a check rather than a symmetric list.

**Hardcoded baseline, plus user additions.** The manifest may carry a
`blacklist` key, but the plugin's own list is unioned in and cannot be removed by
editing the manifest — a guard that can be deleted by removing the line
protecting your OAuth tokens is not a guard.

```json
{ "swap": ["mcp.json", "agents/", "skills/", "AGENTS.md"],
  "blacklist": ["some-plugin-creds.json"] }
```

A blacklisted path in `swap` is **skipped with a warning**, not a hard error — a
typo in the manifest should degrade, not brick pi:

```
profiles: ignoring "auth.json" in swap — blacklisted (credentials)
```

Alongside the "no paths outside the agent dir" rule, the mandatory entries are:

- `auth.json` — forking OAuth credentials, and the failure is silent
- `npm/` — re-downloading packages per profile is genuinely heavy
- `sessions/` — shared on purpose, see session semantics
- `settings.json` — global preference only, see below
The profiles directory is deliberately **not** in that list: `~/.pi/profiles` is
a *sibling* of `~/.pi/agent`, so `canonical()` already rejects `../profiles` as
not inside the agent dir. If `profilesDir()` is ever moved inside the agent dir,
that protection disappears silently — add it to the blacklist then.

Error out with the reason. Asymmetric on purpose: the `profile` list stays a
single eyeballable list, the mandatory guards live in code where they cannot be
accidentally un-guarded, and `blacklist` exists only to extend them.

Manifest lives at `~/.pi/profiles/manifest.json`, next to the profiles it
describes.

Location of the manifest, the `active` file and the lockfile is fixed and
**outside** the swapped set — a profile-scoped `active` file would swap itself
out from under the switch.

### Rules to bake in from the start

- **Refuse any path outside the agent dir.** A typo'd `../..` in a config that
  performs renames is a bad afternoon.
- **Migration is explicit.** The first time a path becomes profile-scoped there
  is a real file sitting there. Copy it into the default profile, *then*
  symlink — never silently clobber. If the profile dir already has that path,
  stop and ask.

### Migration runs on demand, per path

**Decided.** Not at startup — on `/profile` invocation. If `~/.pi/profiles` does
not exist the plugin does nothing and costs nothing.

It is not a once-ever step either. The trigger is not plugin *updates* (plugins
should not rewrite user config, though `pi-mcp-adapter` does — see above) but
plugin *installs*: a new plugin writes a new config file, you add one line to the
manifest, and now there is a real file where a symlink should be. So the check is
per manifest entry, every time:

- symlink into the active profile → nothing to do
- real file → migrate (copy into active profile, replace with symlink)
- missing → nothing to do

One `lstat` per entry, ~10 entries, on an explicit user command. This makes
"add a line to the manifest" the complete install procedure for a new plugin —
no separate migrate command to remember.

### `settings.json` is shared

**Decided: shared, not profile-scoped.** Earlier notes flagged it as a rough edge
on the assumption it mixed profile-ish keys (`subagents.*`) with global ones.
Checking the real file, it does not:

```json
theme, packages, defaultProvider, defaultModel,
defaultThinkingLevel, hideThinkingBlock, lastChangelogVersion
```

All global preference. Subagent configuration lives in `agents/`, which *is*
profile-scoped. `packages` shared is consistent with `npm/` shared — profile-
scoped plugin sets would mean npm churn on every switch.

This also removes the per-key merge question entirely: nothing in the file wants
to be per-profile, so there is nothing to merge.

### Creating a profile

An "empty" profile does **not** mean files containing `{}` or `[]`. It means the
files are *absent*, which is a state every plugin already handles correctly —
it is the fresh-install state. So no synthetic empty values are ever written, and
the swap rule is per-path, mirroring the migration rule:

- path exists in the target profile → symlink to it
- path missing → remove the symlink, leave nothing

No dangling symlinks are possible.

- **`/profile new <name>`** — empty directory. The right default: a `study`
  profile exists precisely to not drag `code` config along.
- **`/profile new <name> --from <other>`** — copy an existing profile as a
  starting point, for variants of a working setup.

## UI

`ctx.ui.select(title, options)` is the same SelectList overlay `/resume` uses
(`extensions.md:2438`, `:2451`), so the picker comes for free. Returns
`undefined` on Esc — the cancel path.

- **`/profile`** → picker listing profiles, active one marked. Discoverable path.
- **`/profile study`** → switches directly, no picker. The everyday path.

Notes:

- `select` takes plain strings, not `{label, description}`. Any extra detail
  (agent count, active marker) is formatted into the string.
- Guard on `ctx.hasUI` — `false` in print (`-p`) and JSON mode, where the picker
  cannot work. There, a bare `/profile` should error listing the names rather
  than hang.
- `ctx.ui.addAutocompleteProvider` could complete profile names inline, but it is
  a provider consulted on every autocomplete keystroke. Standing cost for
  something the picker already solves. Skipped for v1.

## Project-local config is out of scope

A project's `.pi/mcp.json` is already scoped by which directory you are in.
Profiles swap global `~/.pi/agent` config, so the two compose: project config
layers on top of whichever profile is active. The "refuse any path outside the
agent dir" rule enforces this for free.

Consequence worth knowing: `pi-mcp-adapter`'s `/mcp disable` persists to the
*project-local* file, so that setting follows the project across every profile
rather than the profile.

## Session semantics

**Switching profiles creates a new session. Mandatory.**

`ctx.newSession({ parentSession, setup, withSession })` exists for exactly this,
so it is cheap: write active profile → swap symlinks → `newSession()`.

Why it cannot be optional: a transcript contains `tool_use` blocks referencing
tools the new profile may not register. Feeding that history back with a changed
tool list invites the model to call tools that no longer exist, and some
providers are stricter than that. Beyond the mechanics, dragging code context
into a study profile defeats the purpose.

A profile switch always lands in a **blank** session. `newSession()` creates an
empty one; it never resumes anything. Resume is a separate, user-initiated path.

### Stamping the profile onto a session

**Correction to an earlier assumption:** there is no general-purpose metadata bag
on a session. `session-format.md:296` shows session metadata is only the
user-facing display name (`/name`, `pi.setSessionName()`).

So the stamp goes in a **custom entry** appended at session start, via
`pi.appendEntry("profiles", { profile })`. On disk:

```json
{"type":"custom","customType":"profiles","data":{"profile":"study"}}
```

Custom entries do not participate in LLM context. Reading it back means parsing
the target session's JSONL, since `session_before_switch` gives
`event.targetSessionFile` — a path, not an object.

Written only when the session has no stamp yet: `session_start` fires with
reason `startup` for `pi -c` / `pi --resume` too, which reopen an *existing*
session. Read the **last** stamp, not the first, so a session that has been
reopened under another profile reports where it was actually last used.

### Resume across profiles

Sessions stay **shared**, not profile-scoped. Resuming a session from another
profile does not violate the new-session rule: you are not continuing the current
conversation, you are leaving it for a different one. Ordering:

```
pick a study session while code is active
  → swap symlinks to study
  → reload
  → open the study session
```

By the time the transcript loads, the study profile's tools are registered.
Transcript and tools match — nothing stale, no "at your own risk".

**Correction to an earlier draft.** It claimed `/resume` would list the active
profile only, with a `--all` flag. That is **not implementable**: `/resume` is
pi's built-in command and extensions cannot filter, relabel or reorder its
picker. No API exists for it. What does exist:

- `SessionManager.list(cwd)` / `listAll()` (`extensions.md:1205`) — read the
  session list and build *our own* picker.
- `session_before_switch` — fires on `/resume`, carries `targetSessionFile`, can
  cancel.

So the split is:

- **Built-in `/resume` stays unfiltered and unlabelled** — untouchable. But it is
  made *safe*: the hook reads the target session's stamp, sees a profile
  mismatch, and swaps + reloads before the session opens.
- **Filtering and labelling need our own command** (`/profile resume`), built on
  `SessionManager.list()` + `ctx.ui.select`. Additive, not a modification of
  `/resume`.

The safety half is v1. The nicer picker is v2.

Auto-switch is not extra machinery: it is the same primitive `/profile` uses,
minus the final `newSession()` — the session being opened *is* the new session.

- `/profile study` = swap + reload + newSession
- resume a study session = swap + reload + (resume opens it)

Hooked on `session_before_switch`, which fires on `/resume`.

## Concurrent pi instances: lockfile

Symlinks in `~/.pi/agent` are global to the machine, not scoped to the pi
process. Switching to `study` in one terminal silently yanks config out from
under every already-running pi, including a code session mid-task whose next
`/reload` would pick up the wrong profile.

This is inherent to swapping shared on-disk state and is **not fixable** — you
cannot reach into another running pi and change its profile. A per-instance
config dir via env var was considered and **rejected**: one mechanism, symlinks.

**Decided: a lockfile.** It does not coordinate anything; it refuses, and it
makes the situation discoverable. Both checks are event-driven — no watcher, no
poll, zero idle cost.

**On switch** (in the instance switching):

```
read lockfile → another live pid holding a different profile?
  yes → refuse: "pi (pid 4821) is using profile 'code'"
  no  → write my entry, swap, reload
```

**On session start** (in every instance, switching or not): record this pid's
profile. An instance that never runs `/profile` still needs an entry — otherwise
a second pi reads an empty lock, sees no conflict, and swaps config out from
under it. That is the failure the lock exists to prevent, and claiming only on
switch would have missed the common case entirely.

**Drift detection uses the session's own stamp**, compared against `active` at
`session_start`. Two mechanisms were tried and are wrong:

- *Lockfile vs `active`* — both are written in lockstep by the same code path,
  so they can never disagree. Dead branch.
- *An in-memory snapshot* — pi calls the extension factory afresh on **every**
  runtime construction (`loader.js:373`), so module and closure state reset on
  reload, `/new`, `/resume` and `/fork` alike. Also a dead branch, and a worse
  one because it looks live.

The stamp is the only state that survives, and it doubles as the fix for
`pi -c` / `pi --resume`, which never emit `session_before_switch` and so bypass
the resume hook entirely. Warn-only: swapping config mid-startup is worse than
telling the user.

The entry is released on quit, so a recycled pid cannot inherit a phantom
conflict that blocks every future switch.

```json
{ "4821": "code", "5102": "study" }
```

Dead PIDs pruned on read via `process.kill(pid, 0)` — an existence check, no
signal sent.

**Honest limit:** this does not protect the other instance. It finds out the next
time it reloads, not instantly. What the lockfile buys is turning the common case
(you try to switch, get told no) into an error instead of silent corruption.

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

## v1 scope

All open questions are resolved. Layout:

```
~/.pi/profiles/
  manifest.json      one list: the profile-scoped paths
  active             one line: name of the active profile
  lock               { "<pid>": "<profile>" }
  code/              mcp.json  agents/  skills/  AGENTS.md
  study/             (whatever subset exists)
```

**In v1:**

1. Manifest read + path validation (outside-the-agent-dir check, refuse-list).
2. Migration on demand, per path, on `/profile` invocation.
3. Swap: `symlink` to temp name + `rename` (atomic); remove the symlink where the
   target profile lacks the path.
4. `/profile` picker, `/profile <name>` direct, `/profile new <name> [--from X]`.
5. `ctx.reload()` + `ctx.newSession()`.
6. Lockfile: refuse on conflict, warn on drift at session start.
7. Profile stamped onto each session as a hidden custom entry.

8. `session_before_switch`: on `/resume` into a foreign profile, swap + reload
   before the session opens.

**Deferred, consciously:**

- `/profile resume` — our own filtered, labelled session picker. Built-in
  `/resume` cannot be filtered, so this is a separate command, and it only earns
  its keep once stamped sessions have accumulated.
- Autocomplete provider for profile names.

**Not in v1:** a `profile_changed` event for other plugins to react to. Nothing
needs it today, so building it would be speculative. Revisit in v2 if something
actually wants to listen.
