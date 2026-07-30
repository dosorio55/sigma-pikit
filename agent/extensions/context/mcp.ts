import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Grouping tools by MCP server needs the server list, and `pi.getAllTools()`
 * does not carry it: a tool arrives as a flat name plus `sourceInfo`, with the
 * server folded into the name prefix by `pi-mcp-adapter`.
 *
 * Two sources answer that, in this order:
 *
 * 1. `mcp-cache.json`, the adapter's own metadata cache — server to tool names.
 *    Exact, and it works even when `toolPrefix` is `none` and there is no
 *    prefix left to match on.
 * 2. The prefix scheme, rebuilt from `formatToolName`, for servers the cache
 *    has never seen.
 *
 * Both are read on `/context` and never cached across invocations: a stale
 * answer here is worse than a file read, and a watcher is worse than both.
 *
 * What this deliberately does not do is re-implement the adapter's config
 * precedence. It reads the JSON sources and expands `imports` for the JSON
 * host formats, which is what makes a server *appear*; it does not reproduce
 * merge order, credential stripping, or the TOML formats. So the server list
 * is "what we could discover", never "what pi has" — and `unattributed`
 * exists so the display can say which of the two it is.
 */

export type ToolPrefix = "server" | "none" | "short" | "mcp";

/** `sourceInfo.source` on every tool the adapter registers. */
const ADAPTER_SOURCE = "pi-mcp-adapter";

/** The adapter's own proxy tool: one schema standing in for every server. */
export const GATEWAY_TOOL = "mcp";

interface RawConfig {
  mcpServers?: unknown;
  settings?: { toolPrefix?: unknown };
  imports?: unknown;
}

/** Host configs the adapter can import, and the key each keeps its servers under. */
const IMPORT_SOURCES: Record<string, { paths: string[]; key: string }> = {
  cursor: { paths: [join(homedir(), ".cursor", "mcp.json")], key: "mcpServers" },
  "claude-code": {
    paths: [
      join(homedir(), ".claude", "mcp.json"),
      join(homedir(), ".claude.json"),
      join(homedir(), ".claude", "claude_desktop_config.json"),
    ],
    key: "mcpServers",
  },
  "claude-desktop": {
    paths: [join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")],
    key: "mcpServers",
  },
  vscode: { paths: [join(homedir(), ".vscode", "mcp.json")], key: "mcpServers" },
  windsurf: { paths: [join(homedir(), ".codeium", "windsurf", "mcp_config.json")], key: "mcpServers" },
  opencode: { paths: [join(homedir(), ".config", "opencode", "opencode.json")], key: "mcp" },
  // codex keeps its servers in TOML. Parsing a second config language to name a
  // row is not worth it: its servers land in "unattributed" instead of being
  // guessed at.
};

export interface McpInfo {
  /** Server names we could discover, in discovery order. */
  servers: string[];
  /** Server owning this tool, or undefined if we cannot tell. */
  serverFor(toolName: string): string | undefined;
  /** True when a tool came from the MCP adapter. */
  isMcpTool(source: string | undefined): boolean;
}

const EMPTY: McpInfo = {
  servers: [],
  serverFor: () => undefined,
  isMcpTool: (source) => sourceIsAdapter(source),
};

function sourceIsAdapter(source: string | undefined): boolean {
  // Sources arrive as `npm:pi-mcp-adapter`, a path, or a bare name depending on
  // how the adapter was installed. Matching the package name covers all three.
  return typeof source === "string" && source.includes(ADAPTER_SOURCE);
}

/** Mirrors `getServerPrefix` in pi-mcp-adapter. */
function serverPrefix(serverName: string, mode: ToolPrefix): string {
  if (mode === "none") return "";
  if (mode === "short") {
    const short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
    return short || "mcp";
  }
  if (mode === "mcp") return `mcp__${serverName.replace(/-/g, "_")}`;
  return serverName.replace(/-/g, "_");
}

/** Mirrors `formatToolName`. */
function formatToolName(toolName: string, serverName: string, mode: ToolPrefix): string {
  const prefix = serverPrefix(serverName, mode);
  const sanitized = toolName.replace(/\./g, "_");
  return prefix ? `${prefix}_${sanitized}` : sanitized;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    // Missing, unreadable or malformed. A broken MCP config is not /context's
    // problem to report, and every caller treats "nothing here" as valid.
    return undefined;
  }
}

/** Object keys, or nothing — `null`, arrays and scalars all parse as JSON. */
function keysOf(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>);
}

function isToolPrefix(value: unknown): value is ToolPrefix {
  return value === "server" || value === "none" || value === "short" || value === "mcp";
}

/** The JSON config sources, lowest precedence first — same order as the adapter. */
function configPaths(cwd: string): string[] {
  return [
    join(homedir(), ".config", "mcp", "mcp.json"),
    join(homedir(), ".agents", "mcp.json"),
    join(homedir(), ".agents", "mcp", "mcp.json"),
    join(getAgentDir(), "mcp.json"),
    resolve(cwd, ".mcp.json"),
    resolve(cwd, ".pi", "mcp.json"),
  ];
}

export function readMcpInfo(cwd: string): McpInfo {
  const servers: string[] = [];
  const addServers = (names: string[]) => {
    for (const name of names) if (!servers.includes(name)) servers.push(name);
  };

  // Last source wins for toolPrefix, matching the adapter's merge.
  let mode: ToolPrefix = "server";
  const imports = new Set<string>();

  for (const path of configPaths(cwd)) {
    const parsed = readJson(path) as RawConfig | undefined;
    if (!parsed || typeof parsed !== "object") continue;
    addServers(keysOf(parsed.mcpServers));
    if (isToolPrefix(parsed.settings?.toolPrefix)) mode = parsed.settings.toolPrefix;
    if (Array.isArray(parsed.imports)) {
      for (const kind of parsed.imports) if (typeof kind === "string") imports.add(kind);
    }
  }

  for (const kind of imports) {
    const source = IMPORT_SOURCES[kind];
    if (!source) continue;
    for (const path of source.paths) {
      const parsed = readJson(path) as Record<string, unknown> | undefined;
      if (!parsed || typeof parsed !== "object") continue;
      addServers(keysOf(parsed[source.key]));
      break; // First candidate that parses wins, as in resolveImportPath.
    }
  }

  // The metadata cache maps servers to the tool names they really registered,
  // so attribution stops being a guess for anything that has ever connected.
  const exact = new Map<string, string>();
  const cache = readJson(join(getAgentDir(), "mcp-cache.json")) as
    | { servers?: Record<string, { tools?: Array<{ name?: unknown }> }> }
    | undefined;
  const cached = cache?.servers;
  if (cached && typeof cached === "object") {
    for (const [server, entry] of Object.entries(cached)) {
      if (!servers.includes(server)) servers.push(server);
      for (const tool of entry?.tools ?? []) {
        if (typeof tool?.name !== "string") continue;
        exact.set(formatToolName(tool.name, server, mode), server);
      }
    }
  }

  if (servers.length === 0 && exact.size === 0) return EMPTY;

  // Longest prefix first: with servers "db" and "db-metadata", a tool named
  // `db_metadata_list` belongs to the latter, and a shorter match would steal it.
  const prefixes = servers
    .map((name) => ({ name, prefix: serverPrefix(name, mode) }))
    .filter((entry) => entry.prefix.length > 0)
    .sort((a, b) => b.prefix.length - a.prefix.length);

  return {
    servers,
    isMcpTool: sourceIsAdapter,
    serverFor(toolName: string) {
      if (typeof toolName !== "string") return undefined;
      const known = exact.get(toolName);
      if (known) return known;
      // Prefix matching only means anything while there are prefixes. Under
      // `toolPrefix: none` an uncached tool is simply unattributable, and
      // saying so beats filing it under a server it may not belong to.
      return prefixes.find((entry) => toolName.startsWith(`${entry.prefix}_`))?.name;
    },
  };
}
