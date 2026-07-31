import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type TUI } from "@earendil-works/pi-tui";

// ─────────────────────────────────────────────────────────────────────────────
// viewport — pins the composer and the footer to the bottom of the screen while
// letting the history scroll, without emulating arrow keys.
//
// pi never scrolls: it asks every child for its lines, concatenates them and
// repaints. Anything taller than the terminal spills into the terminal's own
// scrollback, which is why scrolling up today takes the composer with it.
//
// So we replace the scrollable children with one wrapper that hands over only
// the lines that fit. The total then always equals the terminal height, nothing
// spills, and the composer stays on the glass because it is still the last
// child of a screen that fits.
//
// See DESIGN.md for why this costs nothing and what it deliberately does not do.
// ─────────────────────────────────────────────────────────────────────────────

/** Children pi adds, in order, in interactive-mode.js:484-493. */
const CHILD_COUNT = 9;

/** header, loadedResources, chat — everything that should scroll away. */
const SCROLLABLE_COUNT = 3;

/** Lines per wheel tick. */
const WHEEL_STEP = 3;

/** Button tracking + SGR encoding. Real mouse events, never confusable with keys. */
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";

/** `ESC [ < button ; col ; row (M|m)` */
const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;

const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

/** Wheel events set bit 6; bit 0 then distinguishes up (0) from down (1). */
function wheelDelta(button: number): number | null {
  if ((button & 64) === 0) return null;
  return (button & 1) === 0 ? -WHEEL_STEP : WHEEL_STEP;
}

/**
 * Renders the scrollable children and returns only the slice that fits in the
 * space the pinned children leave over.
 */
class ScrollViewport implements Component {
  private offset = 0;
  /** Follow new output unless the user has deliberately scrolled up. */
  private stuckToBottom = true;
  private viewportRows = 1;
  private totalRows = 0;
  /**
   * Copy mode hands over every line instead of a slice. The total then exceeds
   * the terminal height again, so pi spills the history into the terminal's own
   * scrollback — which is what gives native wheel and native drag-selection
   * back, across the whole transcript.
   */
  private copyMode = false;

  constructor(
    private readonly sources: Component[],
    private readonly tui: TUI,
  ) {}

  invalidate(): void {
    for (const source of this.sources) source.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const source of this.sources) {
      for (const line of source.render(width)) lines.push(line);
    }

    // Copy mode hands over everything down to the bottom of the view you were
    // on, rather than the whole transcript: the terminal always shows the end of
    // what it is given, so dumping all of it would throw you to the bottom.
    // This way the last rows written are the rows you were already looking at,
    // with the rest above them in native scrollback. `offset` and `viewportRows`
    // are deliberately not recomputed here — they hold the values from the last
    // clipped frame, which is exactly the view being preserved, so leaving copy
    // mode restores it unchanged.
    if (this.copyMode) {
      if (this.totalRows === 0) return lines;
      return lines.slice(0, this.offset + this.viewportRows);
    }

    // Siblings are memoised, so re-rendering them to measure is a cache hit.
    let pinned = 0;
    for (const child of this.tui.children) {
      if (child !== this) pinned += child.render(width).length;
    }

    this.viewportRows = Math.max(1, this.tui.terminal.rows - pinned);
    this.totalRows = lines.length;

    if (this.totalRows <= this.viewportRows) {
      this.offset = 0;
      this.stuckToBottom = true;
      return lines;
    }

    const maxOffset = this.totalRows - this.viewportRows;
    this.offset = this.stuckToBottom ? maxOffset : Math.min(this.offset, maxOffset);
    return lines.slice(this.offset, this.offset + this.viewportRows);
  }

  /** Returns whether the offset actually moved, so callers can skip a repaint. */
  scrollBy(delta: number): boolean {
    const maxOffset = this.totalRows - this.viewportRows;
    if (maxOffset <= 0) return false;

    const next = Math.max(0, Math.min(maxOffset, this.offset + delta));
    if (next === this.offset) return false;

    this.offset = next;
    this.stuckToBottom = next >= maxOffset;
    return true;
  }

  get pageSize(): number {
    return Math.max(1, this.viewportRows - 1);
  }

  get inCopyMode(): boolean {
    return this.copyMode;
  }

  setCopyMode(enabled: boolean): void {
    this.copyMode = enabled;
  }
}

/**
 * Swaps the scrollable children for the wrapper. Returns a teardown function,
 * or null if the layout is not the shape we expect — in which case we do
 * nothing at all rather than corrupt the UI.
 */
function install(tui: TUI): { viewport: ScrollViewport; restore: () => void } | null {
  const children = tui.children;
  if (children.length !== CHILD_COUNT) return null;

  const sources = children.slice(0, SCROLLABLE_COUNT);
  if (!sources.every((child) => child instanceof Container)) return null;

  const viewport = new ScrollViewport(sources, tui);
  children.splice(0, SCROLLABLE_COUNT, viewport);

  return {
    viewport,
    restore: () => {
      const index = tui.children.indexOf(viewport);
      if (index !== -1) tui.children.splice(index, 1, ...sources);
    },
  };
}

const COPY_MODE_KEY = "alt+c";

export default function viewport(pi: ExtensionAPI) {
  let installed = false;
  let teardown: (() => void) | null = null;
  let toggleCopyMode: (() => void) | null = null;

  pi.registerShortcut(COPY_MODE_KEY, {
    description: "viewport: copy mode (release the history for native selection)",
    handler: () => toggleCopyMode?.(),
  });

  pi.registerCommand("copy-mode", {
    description: "Release the history into the terminal scrollback so you can select and copy natively",
    handler: async () => toggleCopyMode?.(),
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    // A zero-height widget is the least invasive way to get the TUI instance.
    ctx.ui.setWidget("viewport", (tui: TUI) => {
      if (!installed) {
        installed = true;
        // Deferred: the factory may run inside doRender, and splicing children
        // mid-iteration would skip elements for that frame.
        queueMicrotask(() => setup(tui));
      }
      return { invalidate() {}, render: () => [] };
    });

    function setup(tui: TUI): void {
      const result = install(tui);
      if (!result) {
        ctx.ui.notify(
          "viewport: unexpected pi layout, extension disabled",
          "warning",
        );
        return;
      }

      const { viewport: view, restore } = result;
      tui.terminal.write(MOUSE_ON);

      const scroll = (delta: number): void => {
        if (view.scrollBy(delta)) tui.requestRender();
      };

      toggleCopyMode = () => {
        const entering = !view.inCopyMode;
        view.setCopyMode(entering);
        // Mouse capture is exactly what blocks native selection, so drop it.
        tui.terminal.write(entering ? MOUSE_OFF : MOUSE_ON);
        ctx.ui.setStatus(
          "viewport",
          entering ? `copy mode · ${COPY_MODE_KEY} to exit` : undefined,
        );
        tui.requestRender(true);
      };

      const unsubscribe = ctx.ui.onTerminalInput((data: string) => {
        // In copy mode the history belongs to the terminal, not to us.
        if (view.inCopyMode) return undefined;

        if (data === PAGE_UP) {
          scroll(-view.pageSize);
          return { consume: true };
        }
        if (data === PAGE_DOWN) {
          scroll(view.pageSize);
          return { consume: true };
        }

        if (!data.includes("\x1b[<")) return undefined;

        // Swallow every mouse event, but only scroll when no overlay is up —
        // this is what keeps the wheel out of the subagent selector.
        let delta = 0;
        const rest = data.replace(SGR_MOUSE, (_match, button: string) => {
          const step = wheelDelta(Number(button));
          if (step !== null && !tui.hasOverlay()) delta += step;
          return "";
        });

        if (delta !== 0) scroll(delta);
        return rest.length === 0 ? { consume: true } : { data: rest };
      });

      const restoreMouse = () => tui.terminal.write(MOUSE_OFF);
      // Leaving ?1000h set after a crash feeds mouse escapes to the parent
      // shell as garbage, so this one listener earns its keep.
      process.on("exit", restoreMouse);

      teardown = () => {
        unsubscribe();
        restoreMouse();
        process.off("exit", restoreMouse);
        restore();
        toggleCopyMode = null;
      };
    }
  });

  pi.on("session_shutdown", async () => {
    teardown?.();
    teardown = null;
    installed = false;
  });
}
