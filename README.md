# sigma

Σ — my collection of plugins for the [pi](https://github.com/earendil-works) agent.
The sum of my pieces, kept separate so I can install and change only what I want.

## Extensions

| Extension | What it does | Idle cost |
|-----------|--------------|-----------|
| `hello`   | The "hello world": draws a one-line footer. A base for learning. | none |
| `footer`  | Two-line footer: project path, model, branch, context bar, tokens, thinking level and cost. | none |
| `wsl-clipboard-image` | Pastes images from the Windows clipboard into the prompt with `Alt+V` (or the `wsl-paste-image` command). Reads the native clipboard via `powershell.exe` and tries several formats (PNG, file, bitmap), so it also works with `Win+V` history. WSL only. | none — `powershell.exe` only runs on demand |
| `profiles` | Several pi configurations in one install, switched with `/profile`. Swaps symlinks in `~/.pi/agent` so other plugins read a different `mcp.json`, `agents/`, `skills/`, `prompts/` and `AGENTS.md`, then starts a new session. | none — a few path operations per switch, no watchers |

### `profiles`

```bash
/profile                      # pick from a list
/profile study                # switch directly
/profile new study            # create an empty profile
/profile new study --from code  # create it as a copy
```

Which paths are profile-scoped is set in `~/.pi/profiles/manifest.json`:

```json
{
  "swap": ["mcp.json", "agents/", "skills/", "prompts/", "AGENTS.md"],
  "blacklist": []
}
```

Anything not listed in `swap` is left alone. Credentials (`auth.json`, `git/`),
`sessions/`, `npm/` and global preferences (`settings.json`,
`models-store.json`) are blacklisted in code and cannot be swapped even if
listed — they are skipped with a warning. `blacklist` only *adds* to that.
Entries are canonicalised first, so `./auth.json` and `git/config` are caught
too, and nothing outside `~/.pi/agent` is ever accepted.

Profile names must match `[A-Za-z0-9][A-Za-z0-9._-]*`, and `--from` only accepts
an existing profile.

Switching always starts a new session: the old transcript references tools the
new profile may not register. Running `/profile <current>` does not no-op — it
re-checks the symlinks and adopts any newly listed path, which is how you install
a new plugin's config into the profile.

Files already in `~/.pi/agent` are moved into the active profile and symlinked
back, after asking. **Your own symlinks are preserved**: a path like
`AGENTS.md -> ~/dotfiles/AGENTS.md` is adopted as a link, never deleted.

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
