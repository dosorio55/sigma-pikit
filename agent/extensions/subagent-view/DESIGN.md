# subagent-view — design notes

Status: **design only, no code yet.** This folder has no `index.ts`, so the
`./agent/extensions/*/index.ts` glob does not pick it up and pi ignores it.

## Goal

Enter one subagent full screen — its whole conversation, scrollable, updating
live — the way Claude Code lets you step into a child agent. Read-only: no
steering, no prompting, no stopping. Just seeing what it is actually doing.

`pi-subagents` stays installed and unmodified. This extension does not replace
its fleet inspector; it is the zoom that the inspector does not have.

## Why the existing inspector is not enough

`pi-subagents/src/tui/fleet.ts` opens a modal overlay at `width: "95%",
maxHeight: "85%", margin: 1` (`openSubagentFleet`, end of file) and then splits
what is left in two: a roster at ~38% of the inner width and the detail pane in
the rest, with `bodyHeight = min(30, rows * 0.85 - 6)`.

On a 50-row terminal that leaves roughly 30 rows by ~60 columns for the
transcript of a child that has been running for ten minutes. The information is
all there and the pane does scroll — `Shift+J`/`Shift+K` by line, `PgUp`/`PgDn`
by page — but reading a conversation through that slot is not reading it.

## The data is already on disk

Every child writes a transcript while it runs — `pi-subagents/src/shared/child-transcript.ts`:

```
version: 1                  (CHILD_TRANSCRIPT_ARTIFACT_VERSION)
recordType: message | tool_start | tool_end | stdout | stderr | truncated
runId, agent, childIndex, cwd, source: "foreground" | "async", ts, timestamp
```

One JSON object per line, appended as the run progresses, at
`<cwd>/.pi-subagents/artifacts/<runId>_<agent>_<index>_transcript.jsonl` under
the default `artifactDir: "project"` (`getArtifactPaths`, `src/shared/artifacts.ts`).
Foreground and background children write the same format to the same place.

This is the most stable surface the package has that is not code: it is a
declared artifact with a version number. Reading it needs no cooperation from
the running extension, works for children of past sessions, and costs a file
read.

Writing it is on by default and switchable off — `artifactConfig.includeTranscript !== false`
(`src/runs/foreground/execution.ts:1334`). If it is off, this extension has
nothing to show and should say so rather than render an empty screen.

## What we cannot reuse, and what we can call

**Their reader and renderer are out of reach.** `pi-subagents/package.json`
publishes only `.`, `./background-work`, `./delegation`, `./capability-ceiling`
and `./preflight`. `src/tui/fleet-transcript.ts` is not an importable path, so
`readFleetTranscript` and `renderFleetTranscript` are theirs alone. We write our
own parser and our own renderer. For a single child that is much less than their
472 lines: no roster, no two-pane fitting, no per-item detail dispatch.

**Their RPC is explicitly for us.** `subagents:rpc:v1:request`,
`subagents:rpc:v1:reply:<requestId>`, `subagents:rpc:v1:ready` over `pi.events`,
with `ping`, `status`, `spawn`, `steer`, `interrupt`, `stop`, `resume`
(`src/extension/rpc.ts`, documented in
`skills/pi-subagents/references/management-authoring-rpc.md`). `ping` is a
capability handshake, and `status` gives run metadata for async runs.

Worth using for what the filesystem cannot tell us, but not the backbone:
`status` answers about async runs, while live foreground children exist only in
their in-memory `SubagentState`. Scanning the artifacts directory covers both
kinds uniformly, with file mtime as the liveness signal.

## The part that does not exist: a selection hook

There is no way to make Enter inside *their* overlay open *our* view.
`SubagentFleetComponent.handleInput` consumes its keys and exposes no hook, and
the component is constructed inside `openSubagentFleet` with no injection point.

So this is coexistence, not an injection:

- their `/subagents-fleet` keeps doing what it does well — the fleet at a glance,
  states, paths;
- our own command (`/subagent-view`, name to settle) opens the zoom.

Accept the two-step. Trying to graft onto their selection means patching a
component we do not own, which is the maintenance we are explicitly avoiding.

## Shape

**Full screen** is `ctx.ui.custom` with `overlay: true` and
`overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 }` — the same API
they use, with the box opened up. Single column, full height, one child.

**Entry** — a minimal picker, or skip it. Open question below.

**Live tail** — poll on an interval while the view is open: `stat` the
transcript, and re-read the tail only when size/mtime changed. Same shape as the
`transcriptFingerprint` cache they already use (`fleet.ts`), and the same reason:
the file only grows, so an unchanged fingerprint means nothing to re-parse.
Follow the tail by default, and stop following as soon as the user scrolls up.

**Rendering** — assistant text as markdown, tool calls as a collapsed line that
expands, stdout/stderr as dim raw lines. `Markdown` and `wrapTextWithAnsi` from
pi-tui do the work; the transcript records are already shaped as messages and
tool events, so this is a fold over the record stream, not a transcript engine.

## Idle cost

**Nothing.** No child processes, no timers, no `fs.watch`, no connections while
the view is closed.

While it is open: one `setInterval` (theirs is 750 ms; match it), one `stat` per
tick, and a tail read only when the file changed. All cleared in `dispose()`.

Reading the tail rather than the whole file matters for a long run — their reader
caps at 2 MB and the writer at 50 MB.

## Risks

**The transcript format.** It carries `version: 1`, but a bump leaves us blind.
Read defensively: ignore unknown `recordType`s instead of failing, and if the
version is one we do not know, fall back to showing the raw JSONL rather than an
empty screen. That failure mode is ugly and still useful.

**Duplicated rendering.** We reimplement what `renderFleetTranscript` already
does, because their `exports` map keeps it private. This is the cost of not
maintaining a fork, and it is the right trade — but it does mean their
improvements to transcript rendering never reach us.

**Scope creep.** Steering, stopping, replying. All of it is available through
their RPC, and all of it is out of scope: the point is a reader. Their commands
already own mutation, and duplicating that is how this stops being small.

## Open questions

- **Picker or no picker?** A roster of our own is a second thing to build and to
  keep in sync with what a run actually is. The alternative is "open the most
  recently active child" plus `[`/`]` to cycle, which needs no list at all and is
  what you want 90% of the time.
- **Where does the child list come from** if there is a picker: scanning
  `.pi-subagents/artifacts` (works everywhere, but is a directory listing per
  open and shows children of old sessions), or their RPC `status` (authoritative
  for async, blind to live foreground), or both.
- **Non-project `artifactDir`.** With `"session"` or `"temp"` the artifacts are
  elsewhere (`getArtifactsDir`). Resolve the preference from settings, or only
  support the default and say so.
