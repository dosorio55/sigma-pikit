# viewport — design notes

Status: **design only, no code yet.** This folder has no `index.ts`, so the
`./agent/extensions/*/index.ts` glob does not pick it up and pi ignores it.

## Goal

Own the screen so that you can **park the view in the middle of the history,
keep typing in the composer, and select text with the mouse** — all at once.

Today those three are mutually exclusive. Getting all of them requires taking
over both the scroll position and the selection, which is what this extension
is for.

## The requirement, stated precisely

1. Composer stays visible and usable while the viewport sits mid-history.
2. Mouse selection sticks to the **text** it was dragged over, not to the screen
   cells it happened to cover.
3. The mouse wheel scrolls, and never leaks into menus as keystrokes.

Requirement 1 is the one that forces every other decision.

## Why the current setup fails

`pi-claude-style-scroll` is installed and pins the composer. It does it by
entering the alternate screen and repainting the history itself:

- `src/tui/terminal-session.ts:31` — `\x1b[?1049h\x1b[H\x1b[2J`
- `src/tui/terminal-session.ts:33` — `\x1b[?1007h`, alternate scroll

Defaults are `alternateScreen: true`, `alternateScroll: true`,
`mouseScroll: false` (`src/config/config.ts:38-51`), and there is no config file
overriding them, so that is what is running.

Two consequences, both structural rather than bugs:

**Selection is useless.** Terminal selection anchors to screen cells. The plugin
repaints those cells on every scroll, so the text slides out from under a
highlight that stays put.

**The wheel types arrow keys.** `?1007` makes the terminal encode wheel events as
cursor keys. The plugin's own comment concedes they are "indistinguishable from
real arrow keys at this layer" (`src/index.ts:243-250`). When an overlay is open,
`shouldHandleStickyTerminalInput` bails out entirely, so the synthetic arrows
reach the subagent selector and move its highlight. Scrolling down picks a
different agent. They special-cased the editor's autocomplete
(`src/index.ts:246-250`) and nothing else.

## The alternative we rejected, and why

There is a way to pin a composer *without* taking over the screen: stay in the
normal buffer and set a scroll margin, `\x1b[1;{H-3}r`, reserving the bottom
rows. Output physically cannot cross the margin, so the composer is pinned, and
because the terminal does the scrolling itself, native selection and native
scrollback both keep working. `fzf --height` works this way.

**It was tested and it passes here.** 200 lines scrolled past a 3-row footer;
all of them reached scrollback, line 001 included, and the footer was never
touched. The xterm rule — lines feed scrollback when the top margin is row 1,
regardless of the bottom margin — holds in this terminal.

**We rejected it anyway**, because the footer is pinned in the *buffer*, not on
the glass. Scroll up and the composer scrolls out of view with everything else.
That satisfies requirement 2 and 3 but breaks requirement 1, which is the one
that matters: you would have to scroll back to the bottom to type, every time.

Recorded here because it is genuinely the cheaper design, and if requirement 1
is ever dropped it is the right answer.

The trade is fundamental: **owning the scroll position requires owning the
paint, and owning the paint destroys native selection.** There is no third
option. Having chosen to own the paint, we owe the user a selection
implementation.

## Architecture

### Two coordinate systems, never confused

The whole design rests on keeping these apart:

- **Screen coords** — row/column of the glass. Where mouse events arrive.
- **Buffer coords** — index into the history line array, plus visible column.
  Where selection lives.

Mouse events convert screen → buffer **once**, on arrival, using the current
viewport offset. Everything downstream is buffer coords. Selection is therefore
immune to scrolling by construction: scrolling changes the viewport offset,
which is not part of a stored selection.

This is also why our selection beats the terminal's. Dragging past the top edge
can auto-scroll and keep extending, and text scrolled off-screen stays selected,
neither of which the terminal can do inside an alternate screen.

### Rendering the highlight

Highlighted lines already contain ANSI colour codes, so a highlight cannot be
spliced in by string index — it has to go in by *visible* column, stepping over
escape sequences and accounting for wide characters.

pi-tui exports the primitives for exactly this:

```
sliceByColumn(line, startCol, length, strict?)      utils.d.ts:68
sliceWithWidth(line, startCol, length, strict?)     utils.d.ts:70
extractSegments(line, beforeEnd, afterStart, ...)   utils.d.ts:79
visibleWidth(str)                                   utils.d.ts:12
```

`extractSegments` exists specifically for compositing overlays into styled
lines, which is structurally the same problem. This is the part that looked
hardest and is mostly already written.

### Where our code stops and pi's begins

The boundary that decides whether this is maintainable:

- **We own** the alternate screen, the viewport offset, the history line buffer,
  mouse input, selection state, and compositing the highlight.
- **pi owns** producing the rendered lines, the editor component, overlays,
  and the differential renderer underneath.

We take pi's rendered lines as input and composite onto them. We never
reimplement message rendering. If that boundary holds, a pi upgrade changes the
content of the lines we receive and nothing else.

Known friction: `doRender` in pi-tui assumes it owns the full screen and issues
`\x1b[2J\x1b[H\x1b[3J` full redraws on width/height change, plus a
`clearOnShrink` path (`tui.js:1003-1009`). Resize is where the boundary leaks.

### Input

Capture with `?1002h` (drag tracking) + `?1006h` (SGR). Real mouse events,
unambiguous, never confusable with arrow keys — requirement 3 falls out for
free, and the subagent-selector bug cannot occur.

`ctx.ui.onTerminalInput(handler)` is the hook
(`core/extensions/types.d.ts:77`); handlers return `{ consume }` to swallow
input. The existing SGR/X10 parser in `pi-claude-style-scroll` is ~40 lines and
MIT, so it can be adapted rather than rewritten.

Mouse capture disables native terminal selection, but Shift-drag bypasses app
capture in Alacritty, Ghostty, kitty, VTE and Windows Terminal, so the native
path survives as an escape hatch.

### Copy

OSC 52, with `copyToClipboard` (exported from `@earendil-works/pi-coding-agent`)
as the fallback. OSC 52 is worth preferring because it reaches the Windows
clipboard from inside WSL, where the native path is unreliable.

## Staging

Each stage is useful alone. Stop at any point.

**v0 — copy mode.** A key leaves the alternate screen, dumps the transcript into
the normal buffer for native selection, another key returns. Small and ugly,
solves the immediate pain, and is a useful fallback even after v2 exists.

**v1 — our own pinned composer.** Replaces `pi-claude-style-scroll`. Alternate
screen, viewport scrolling, real mouse wheel instead of fake arrow keys. Fixes
the selector hijack. Establishes the buffer model and the renderer boundary that
v2 depends on.

**v2 — selection.** Drag to select, auto-scroll at the edges, copy on release.
The point of the exercise.

Replacing rather than extending is deliberate: v2 needs control of the paint
path, and that path currently belongs to a 1000-line file in a package we do not
own and cannot depend on the internals of. Owning it is also what lets the
composer and the selection be designed together instead of one bolted onto the
other.

## Idle cost

**Nothing.** No child processes, no timers, no `fs.watch`, no connections. Purely
event-driven: terminal input handlers and render hooks, all torn down on
`session_end`. Terminal modes are restored on stop, including the keyboard
protocol stack (the failure mode `pi-claude-style-scroll` patches around in
`installStopPatch` — main and alternate screens keep independent kitty keyboard
stacks, so an unbalanced push leaves the terminal wrong after exit).

The cost of this extension is code and maintenance, not resources.

## Risks

**Depends on pi internals.** Unavoidable — the extension API has no supported
way to take over the paint path. Expect breakage on pi upgrades. The renderer
boundary above is the mitigation: the smaller the surface, the cheaper the fix.

**Portability is fine.** The alternate screen and SGR mouse are universally
supported, ConPTY included, so unlike the rejected scroll-region design this
does not need per-terminal verification. WSL is not a special case here.

**Scope.** v2 invites double-click-to-select-word, line select, search,
selection persistence. All out of scope for a first version.

## Open questions

- Do we hard-conflict with `pi-claude-style-scroll` if both load, or detect and
  disable ourselves? Both drive alternate-screen state through module-level
  globals, so running both would corrupt the terminal.
- Copy on release, or explicit key? Terminal-like behaviour is copy on release,
  but it silently clobbers the clipboard.
- How much history do we keep in the buffer? Theirs caps the viewport at 200
  lines (`historyViewportLineLimit`). Selection across a longer range needs a
  bigger buffer, which costs memory — the one place this design can get heavy.
