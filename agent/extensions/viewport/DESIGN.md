# viewport — design notes

## Goal

Park the view in the middle of the history and keep typing in the composer at
the same time, without the wheel being emulated as arrow keys.

`pi-claude-style-scroll` already pins the composer, but it does so by taking over
the screen (alternate buffer + its own repaint) and by turning the wheel into
cursor keys via `?1007`. That last part is the concrete daily bug: with an
overlay open, `shouldHandleStickyTerminalInput` bails out and the synthetic
arrows reach the subagent selector, so scrolling picks a different agent.

This extension replaces it with something much smaller.

## How pi paints, and why that is the whole trick

pi never scrolls. It repaints. `TUI.doRender` (`pi-tui/dist/tui.js:980`) asks
every child for its lines and concatenates them (`Container.render`,
`tui.js:96-105`):

```
header · loadedResources · chat · pendingMessages · status
       · widgetsAbove · editor · widgetsBelow · footer
```

Those nine children are added in that exact order in
`pi-coding-agent/dist/modes/interactive/interactive-mode.js:484-493`, and
`Container.children` is public in the typings.

Today the chat hands over all of its lines. The total is far taller than the
terminal, so everything above the last `rows` lines spills into the terminal's
own scrollback. The composer is the last child, so it sits at the bottom of the
screen — but it lives *in the scrollback*, not on the glass. Scroll up with the
wheel and it goes away with everything else. That is the failure we are fixing.

**So: make the scrollable region hand over only the lines that fit.**

```
viewportRows = terminal.rows - (height of every pinned child)
lines        = scrollable.render(width)
return         lines.slice(offset, offset + viewportRows)
```

The total then always equals the terminal height exactly. Nothing spills into
scrollback, and the composer and footer are on the glass by construction,
because they are still the last children of a screen that fits. Scrolling is
`offset += n` followed by `requestRender()`.

The scrollable region is children `0..2` (header, loadedResources, chat), not
just the chat: the startup header and the loaded-resources block scroll away
today, and clipping only the chat would pin them to the top forever.

### Why this costs nothing

The obvious objection is that re-rendering the whole history on every wheel tick
must be expensive. It is not, for two reasons:

1. **pi already does it on every keystroke.** `doRender` calls `render(width)`
   across all children each frame; typing one character re-renders the entire
   history today.
2. **Every component memoises its lines** keyed by `(text, width)` —
   `text.js:38-40`, `markdown.js:55-72`. A render of 5000 old lines is 5000
   array pushes of already-computed strings, not 5000 markdown parses. That is
   what `invalidate()` is for: it is the cache-drop hook, called on theme or
   width changes.

Plus `MIN_RENDER_INTERVAL_MS = 16` (`tui.js:123`) caps repaints at 60fps
regardless of how fast the wheel spins.

Scrolling therefore costs exactly what typing a character costs.

### Measuring the pinned height

`viewportRows` needs the height of the other children, so the wrapper renders
its siblings and sums their line counts. This assumes `render(width)` is
idempotent — safe here, because the differential renderer calls it every frame
by design, and animation (the loader) is driven by a timer plus
`requestRender`, not by side effects inside `render`.

Siblings are rendered twice per frame (once by us, once by `doRender`); the
second call is a cache hit.

## Input

`?1000h` (button tracking) + `?1006h` (SGR encoding). Real mouse events, never
confusable with arrow keys — the subagent-selector bug cannot occur, and when an
overlay is open we swallow the bytes without scrolling.

Mouse capture disables the terminal's own drag-selection, so selecting text
needs **Shift+drag**. Verified as available in the terminals in use here
(Ghostty, Alacritty, Windows Terminal); it is also the standard bypass in kitty
and VTE.

PageUp/PageDown scroll by a screenful, as a mouse-free alternative. Both are
recognised by `keys.js:245-246` but bound to no action anywhere in pi or
pi-tui, so taking them conflicts with nothing.

## What we do not own

We do not enter the alternate screen, do not touch the keyboard protocol stack,
do not reimplement message rendering, do not handle focus, and do not handle
resize. All of that stays pi's. We contribute one `Component` that slices an
array of strings, plus a terminal-input listener.

This is the entire difference from the earlier design in this file, which
proposed owning the paint path: that would have meant an alternate screen, a
private history buffer, a private editor, and permanent exposure to `doRender`
internals. Slicing a child's output gets the same result and leaves the blast
radius at one array index.

## Rejected alternatives

**Scroll region (`\x1b[1;{H-3}r`).** Reserve the bottom rows in the normal
buffer so output cannot cross the margin, the way `fzf --height` does. Tested
and it works here — 200 lines scrolled past a 3-row footer, all reaching
scrollback including line 001. Rejected because the footer is pinned in the
*buffer*, not on the glass: scroll up and the composer leaves with everything
else, which is the exact problem we are solving.

**Owning the paint path.** See above.

## Known limits

**No scrollback.** History is clipped to the viewport, so the terminal has
nothing to scroll or select beyond what is on screen. Selecting text that is
scrolled off requires bringing it on screen first.

**Selection breaks across a scroll.** A drag that crosses a wheel tick loses its
anchor, because the cells move under it. Selecting static text works natively.
Fixing this properly means compositing the highlight ourselves — `sliceWithWidth`
and `extractSegments` (`pi-tui/dist/utils.d.ts:70,79`) and
`applyBackgroundToLine` (`:51`) are exactly the right primitives, but note they
are *not* re-exported from the package index, so it would mean a deep import or
vendoring ~60 lines. Out of scope for now; a copy mode that dumps the transcript
into the normal buffer for native selection is the cheaper answer.

**Conflicts with `pi-claude-style-scroll`.** Both manage terminal screen state;
run one or the other.

## The single point of breakage

Child index `2` being the chat container, and there being nine children. We
validate that shape on install and disable ourselves cleanly if it changes, so a
pi upgrade degrades to "the extension does nothing" rather than a corrupted UI.

## Idle cost

Nothing. No child processes, no timers, no `fs.watch`, no connections. One
terminal-input listener and one zero-height widget, both torn down on
`session_shutdown`.

One `process.on("exit")` listener is registered, purely to restore the mouse
mode. Leaving `?1000h` set after a crash makes the parent shell receive mouse
escape sequences as garbage input, so this one is worth its cost.
