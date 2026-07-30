import type { Theme } from "@earendil-works/pi-coding-agent";

import type { Report } from "./collect.js";
import { formatPercent, formatTokens } from "./tokens.js";

type Token = Parameters<Theme["fg"]>[0];

const COLS = 20;
const ROWS = 10;
const CELLS = COLS * ROWS;

const USED = "⛁";
const FREE = "⛶";
const MARK = "┊";

const LABEL_WIDTH = 26;
const VALUE_WIDTH = 7;

interface Segment {
  cells: number;
  color: Token;
}

/**
 * The grid is the part the eye lands on, so it carries the compaction mark.
 *
 * pi compacts at `contextWindow - reserveTokens`, which on a 1M window is ~16k
 * short of the end. A bar drawn all the way to the edge quietly claims space
 * that will never be yours; one glyph fixes that, and it is the one thing this
 * view can say that Claude Code's cannot.
 */
function grid(report: Report, theme: Theme): string[] {
  if (report.contextWindow <= 0) return [];

  const perCell = report.contextWindow / CELLS;
  const messages = Math.max(0, (report.sessionTokens ?? report.staticTokens) - report.staticTokens);

  const segments: Segment[] = [
    { cells: Math.round(report.systemPrompt.total / perCell), color: "accent" },
    { cells: Math.round(report.activeTokens / perCell), color: "success" },
    { cells: Math.round(messages / perCell), color: "warning" },
  ];

  const painted: string[] = [];
  for (const segment of segments) {
    for (let i = 0; i < segment.cells && painted.length < CELLS; i += 1) {
      painted.push(theme.fg(segment.color, USED));
    }
  }

  const markAt = report.compactionEnabled
    ? Math.min(CELLS - 1, Math.floor(report.compactionAt / perCell))
    : -1;

  while (painted.length < CELLS) {
    const index = painted.length;
    painted.push(index === markAt ? theme.fg("error", MARK) : theme.fg("dim", FREE));
  }
  // The mark falls inside used space only when the session is already past the
  // compaction point, which the summary line reports in words anyway.
  if (markAt >= 0 && !painted[markAt]?.includes(MARK)) {
    painted[markAt] = theme.fg("error", MARK);
  }

  const lines: string[] = [];
  for (let row = 0; row < ROWS; row += 1) {
    lines.push(painted.slice(row * COLS, (row + 1) * COLS).join(" "));
  }
  return lines;
}

function legend(theme: Theme, withMark: boolean): string {
  const item = (color: Token, glyph: string, text: string) =>
    `${theme.fg(color, glyph)} ${theme.fg("muted", text)}`;
  const items = [
    item("accent", USED, "system prompt"),
    item("success", USED, "tools"),
    item("warning", USED, "messages"),
    item("dim", FREE, "free"),
  ];
  if (withMark) items.push(item("error", MARK, "compaction"));
  return items.join("   ");
}

function row(theme: Theme, label: string, tokens: number | null, detail = "", indent = 0): string {
  const pad = " ".repeat(indent);
  const name = `${pad}${label}`.padEnd(LABEL_WIDTH);
  const value = (tokens === null ? "—" : formatTokens(tokens)).padStart(VALUE_WIDTH);
  const colored = tokens === 0 ? theme.fg("dim", value) : theme.fg("accent", value);
  const tail = detail ? `  ${theme.fg("dim", detail)}` : "";
  return `${theme.fg(indent > 0 ? "muted" : "text", name)}${colored}${tail}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function render(report: Report, theme: Theme, expand: boolean): string[] {
  const lines: string[] = [];
  const window = report.contextWindow;

  lines.push(theme.fg("accent", theme.bold("Context")), "");
  const cells = grid(report, theme);
  if (cells.length > 0) {
    lines.push(...cells, "", legend(theme, report.compactionEnabled), "");
  }

  const { systemPrompt } = report;
  lines.push(row(theme, "System prompt", systemPrompt.total));
  lines.push(row(theme, "base prompt", systemPrompt.base, "", 2));
  if (systemPrompt.skillCount > 0) {
    lines.push(
      row(theme, "skills", systemPrompt.skillsTokens, plural(systemPrompt.skillCount, "skill"), 2),
    );
  }
  if (systemPrompt.contextFiles.length > 0) {
    lines.push(
      row(
        theme,
        "context files",
        systemPrompt.contextFilesTokens,
        plural(systemPrompt.contextFiles.length, "file"),
        2,
      ),
    );
    if (expand) {
      for (const file of systemPrompt.contextFiles) {
        lines.push(row(theme, file.name, file.tokens, "", 4));
      }
    }
  }

  lines.push("");
  lines.push(row(theme, "Tool schemas", report.activeTokens));
  for (const group of report.active) {
    lines.push(row(theme, group.label, group.tokens, plural(group.tools.length, "tool"), 2));
    if (expand) {
      for (const tool of group.tools) {
        lines.push(row(theme, tool.name, tool.tokens, "", 4));
      }
    }
  }

  if (report.idle.length > 0) {
    lines.push("");
    lines.push(
      theme.fg("muted", "Configured, not in context") +
        theme.fg("dim", `  ${plural(report.idleToolCount, "tool")}, costing nothing`),
    );
    for (const group of report.idle) {
      const detail = group.tools.length === 0 ? "no tools registered" : plural(group.tools.length, "tool");
      lines.push(row(theme, group.label, 0, detail, 2));
      if (expand) {
        for (const tool of group.tools) {
          lines.push(row(theme, tool.name, 0, "", 4));
        }
      }
    }
  }

  lines.push("");
  lines.push(
    row(
      theme,
      "Static overhead",
      report.staticTokens,
      window > 0 ? `${formatPercent(report.staticTokens, window)} of ${formatTokens(window)}` : "",
    ),
  );
  lines.push(
    row(
      theme,
      "Session total",
      report.sessionTokens,
      report.sessionTokens === null
        ? "no assistant reply yet"
        : window > 0
          ? formatPercent(report.sessionTokens, window)
          : "",
    ),
  );

  if (report.compactionEnabled && window > 0) {
    const left = report.compactionAt - (report.sessionTokens ?? report.staticTokens);
    lines.push(
      theme.fg(
        "dim",
        left > 0
          ? `Compaction at ${formatTokens(report.compactionAt)} — ${formatTokens(left)} to go`
          : `Past the compaction point (${formatTokens(report.compactionAt)})`,
      ),
    );
  } else if (window > 0) {
    lines.push(theme.fg("dim", "Auto-compaction disabled"));
  }

  if (!expand) {
    lines.push("", theme.fg("dim", "/context all to expand"));
  }

  return lines;
}

/** One line, for the modes that have no room for a grid. */
export function renderPlain(report: Report): string {
  const parts = [
    `static ${formatTokens(report.staticTokens)}`,
    `prompt ${formatTokens(report.systemPrompt.total)}`,
    `tools ${formatTokens(report.activeTokens)}`,
  ];
  if (report.sessionTokens !== null) parts.push(`session ${formatTokens(report.sessionTokens)}`);
  return parts.join(" · ");
}
