import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
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
 *    Exact when ownership is unique, and it works even when `toolPrefix` is
 *    `none` and there is no prefix left to match on.
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

/** `loadMetadataCache` rejects the file outright on any other version. */
const CACHE_VERSION = 1;

interface RawConfig {
  mcpServers?: unknown;
  "mcp-servers"?: unknown;
  settings?: { toolPrefix?: unknown; hostConfigDiscovery?: unknown };
  imports?: unknown;
}

/**
 * Host configs the adapter can import, and the keys each keeps its servers
 * under. Paths mirror `IMPORT_PATHS` in the adapter's config.ts — including the
 * ones that are relative to the project, not to `$HOME`.
 *
 * `codex` also keeps a TOML config that is read first when present. Parsing a
 * second config language to label a row is not worth it, so only its JSON form
 * is discovered here.
 */
const IMPORT_SOURCES: Record<string, { paths: (cwd: string) => string[]; keys: string[] }> = {
  cursor: { paths: () => [join(homedir(), ".cursor", "mcp.json")], keys: ["mcpServers", "mcp-servers"] },
  "claude-code": {
    paths: () => [
      join(homedir(), ".claude", "mcp.json"),
      join(homedir(), ".claude.json"),
      join(homedir(), ".claude", "claude_desktop_config.json"),
    ],
    keys: ["mcpServers"],
  },
  "claude-desktop": {
    paths: () => [
      join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    ],
    keys: ["mcpServers"],
  },
  vscode: { paths: (cwd) => [resolve(cwd, ".vscode", "mcp.json")], keys: ["mcpServers", "mcp-servers"] },
  windsurf: {
    paths: () => [join(homedir(), ".windsurf", "mcp.json")],
    keys: ["mcpServers", "mcp-servers"],
  },
  codex: { paths: () => [join(homedir(), ".codex", "config.json")], keys: ["mcp_servers", "mcpServers"] },
  opencode: {
    paths: (cwd) => [join(homedir(), ".config", "opencode", "opencode.json"), findOpenCodeProject(cwd)],
    keys: ["mcp"],
  },
};

/** The parts of `sourceInfo` that can betray where a tool came from. */
export interface ToolOrigin {
  source?: string;
  path?: string;
  baseDir?: string;
}

export interface McpInfo {
  /** Server names we could discover, in discovery order. */
  servers: string[];
  /** Server owning this tool, or undefined if we cannot tell. */
  serverFor(toolName: string): string | undefined;
  /** True when a tool came from the MCP adapter. */
  isMcpTool(origin: ToolOrigin | undefined): boolean;
}

/**
 * An adapter installed from npm or git announces itself in `source`
 * (`npm:pi-mcp-adapter`), but one dropped into `<agentDir>/extensions` or listed
 * in `settings.extensions` reports the bare loader kind — `auto`, `local` —
 * and only the path names it.
 *
 * Missing it is not a cosmetic failure: its tools would group as an extension,
 * every server would look like it has no active tools, and the report would
 * call them all free while their schemas sit in the request.
 */
function isAdapterOrigin(origin: ToolOrigin | undefined): boolean {
  if (!origin) return false;
  return [origin.source, origin.path, origin.baseDir].some(
    (value) => typeof value === "string" && value.includes(ADAPTER_SOURCE),
  );
}

/** No MCP at all. Still answers `isMcpTool`, which is how callers decide. */
export const NO_MCP: McpInfo = {
  servers: [],
  serverFor: () => undefined,
  isMcpTool: isAdapterOrigin,
};

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

/** Mirrors `resourceNameToToolName`; resources register as `read_<name>`. */
function resourceToolName(name: string): string {
  let normalized = name
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!normalized || /^\d/.test(normalized)) {
    normalized = `resource${normalized ? `_${normalized}` : ""}`;
  }
  return `read_${normalized}`;
}

/**
 * MCP configs are JSONC: the adapter runs every one of them through
 * `stripJsonComments(raw, { trailingCommas: true })`. Editor-written configs
 * routinely carry `//` comments, and strict `JSON.parse` reads those files as
 * empty — which here means "no servers", which means every server goes
 * unattributed. Same treatment, so the same files parse.
 */
function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let comment: "line" | "block" | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    const next = text[i + 1];

    if (comment === "line") {
      if (char === "\n") {
        comment = null;
        out += char;
      }
      continue;
    }
    if (comment === "block") {
      if (char === "*" && next === "/") {
        comment = null;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 1;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      comment = "line";
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      comment = "block";
      i += 1;
      continue;
    }
    out += char;
  }

  // Remove trailing commas without touching comma-brace text inside strings.
  let cleaned = "";
  inString = false;
  for (let i = 0; i < out.length; i += 1) {
    const char = out[i]!;
    if (inString) {
      cleaned += char;
      if (char === "\\") {
        cleaned += out[i + 1] ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      cleaned += char;
      continue;
    }
    if (char === ",") {
      let next = i + 1;
      while (/\s/.test(out[next] ?? "")) next += 1;
      if (out[next] === "}" || out[next] === "]") continue;
    }
    cleaned += char;
  }
  return cleaned;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(stripJsonc(readFileSync(path, "utf8"))) as unknown;
  } catch {
    // Missing, unreadable or malformed. A broken MCP config is not /context's
    // problem to report, and every caller treats "nothing here" as valid.
    return undefined;
  }
}

/** `null`, arrays and scalars all parse as JSON, and none of them is a map. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function keysOf(value: unknown): string[] {
  return isPlainObject(value) ? Object.keys(value) : [];
}

function findOpenCodeProject(cwd: string): string {
  const start = resolve(cwd);
  let gitRoot: string | undefined;
  let current = start;
  while (true) {
    if (existsSync(join(current, ".git"))) {
      gitRoot = current;
      break;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }

  if (!gitRoot) return join(start, "opencode.json");
  current = start;
  while (true) {
    const candidate = join(current, "opencode.json");
    if (existsSync(candidate) || current === gitRoot) return candidate;
    current = resolve(current, "..");
  }
}

function isToolPrefix(value: unknown): value is ToolPrefix {
  return value === "server" || value === "none" || value === "short" || value === "mcp";
}

/** The JSON config sources, lowest precedence first — same order as the adapter. */
function configPaths(cwd: string, overridePath?: string): string[] {
  return [
    join(homedir(), ".config", "mcp", "mcp.json"),
    join(homedir(), ".agents", "mcp.json"),
    join(homedir(), ".agents", "mcp", "mcp.json"),
    overridePath ? resolve(overridePath) : join(getAgentDir(), "mcp.json"),
    resolve(cwd, ".mcp.json"),
    resolve(cwd, ".pi", "mcp.json"),
  ];
}

export function readMcpInfo(cwd: string, overridePath?: string): McpInfo {
  try {
    return discover(cwd, overridePath);
  } catch {
    // Config files are user-editable and cache files are written by someone
    // else's code. Neither is worth taking the whole command down for: with no
    // MCP information the report still has everything else, and the display
    // already knows how to say "server unknown".
    return NO_MCP;
  }
}

function discover(cwd: string, overridePath?: string): McpInfo {
  const servers: string[] = [];
  const addServers = (names: string[]) => {
    for (const name of names) if (!servers.includes(name)) servers.push(name);
  };

  // Last source wins for settings, matching the adapter's merge.
  let mode: ToolPrefix = "server";
  let hostConfigDiscovery = false;
  const imports = new Set<string>();

  for (const path of configPaths(cwd, overridePath)) {
    const parsed = readJson(path) as RawConfig | undefined;
    if (!isPlainObject(parsed)) continue;
    const settings = (parsed as RawConfig).settings;
    // `mcpServers` wins when both accepted spellings are present.
    addServers(keysOf(parsed.mcpServers ?? parsed["mcp-servers"]));
    if (isToolPrefix(settings?.toolPrefix)) mode = settings.toolPrefix;
    if (
      settings?.hostConfigDiscovery === "on" ||
      settings?.hostConfigDiscovery === "off" ||
      settings?.hostConfigDiscovery === "prompt"
    ) {
      hostConfigDiscovery = settings.hostConfigDiscovery === "on";
    }
    if (Array.isArray(parsed.imports)) {
      for (const kind of parsed.imports) if (typeof kind === "string") imports.add(kind);
    }
  }

  // Explicit host discovery loads every supported host config as a
  // lowest-precedence fallback, even when `imports` does not name it.
  if (hostConfigDiscovery) {
    for (const kind of Object.keys(IMPORT_SOURCES)) imports.add(kind);
  }

  for (const kind of imports) {
    const source = IMPORT_SOURCES[kind];
    if (!source) continue;

    if (kind === "opencode") {
      // OpenCode merges global then project entries per field. In particular, a
      // project-level `enabled: false` must remove the inherited server.
      const merged = new Map<string, Record<string, unknown>>();
      for (const path of source.paths(cwd)) {
        const parsed = readJson(path) as Record<string, unknown> | undefined;
        const map = parsed?.mcp;
        if (!isPlainObject(map)) continue;
        for (const [name, entry] of Object.entries(map)) {
          if (!isPlainObject(entry)) continue;
          merged.set(name, { ...(merged.get(name) ?? {}), ...entry });
        }
      }
      addServers([...merged].filter(([, entry]) => entry.enabled !== false).map(([name]) => name));
      continue;
    }

    for (const path of source.paths(cwd)) {
      const parsed = readJson(path) as Record<string, unknown> | undefined;
      if (!parsed || typeof parsed !== "object") continue;
      // Host formats with two accepted spellings use the first present key.
      const map = source.keys.map((key) => parsed[key]).find((value) => value !== undefined);
      addServers(keysOf(map));
      break;
    }
  }

  // The metadata cache maps servers to the tool names they really registered,
  // so attribution stops being a guess for anything that has ever connected.
  //
  // Attribution only. The cache is merged and never pruned, so a server deleted
  // from the config months ago is still in there — taking its names as the
  // server list would render ghosts as "configured, costing nothing".
  const exact = new Map<string, string>();
  const ambiguous = new Set<string>();
  const rememberOwner = (toolName: string, server: string) => {
    if (ambiguous.has(toolName)) return;
    const existing = exact.get(toolName);
    if (existing && existing !== server) {
      // Under `toolPrefix: none` multiple servers may advertise the same name.
      // Which one registered depends on current direct-tool selection, not cache
      // order, so claiming either server would be a guess.
      exact.delete(toolName);
      ambiguous.add(toolName);
      return;
    }
    exact.set(toolName, server);
  };
  const cache = readJson(join(getAgentDir(), "mcp-cache.json")) as
    | { version?: unknown; servers?: unknown }
    | undefined;
  // The adapter rejects the whole file on a version mismatch. So do we: a cache
  // written by a future shape is not a cache we can read.
  if (cache?.version === CACHE_VERSION && isPlainObject(cache.servers)) {
    const configured = new Set(servers);
    for (const [server, entry] of Object.entries(cache.servers)) {
      // The cache is merged and never pruned. Once config discovery found any
      // servers, deleted cache entries must not win duplicate tool names.
      if ((configured.size > 0 && !configured.has(server)) || !isPlainObject(entry)) continue;
      const tools = Array.isArray(entry.tools) ? entry.tools : [];
      const resources = Array.isArray(entry.resources) ? entry.resources : [];
      for (const tool of tools) {
        const name = isPlainObject(tool) ? tool.name : undefined;
        if (typeof name !== "string") continue;
        rememberOwner(formatToolName(name, server, mode), server);
      }
      for (const resource of resources) {
        const name = isPlainObject(resource) ? resource.name : undefined;
        if (typeof name !== "string") continue;
        rememberOwner(formatToolName(resourceToolName(name), server, mode), server);
      }
    }
  }

  if (servers.length === 0 && exact.size === 0) return NO_MCP;

  // Longest prefix first: with servers "db" and "db-metadata", a tool named
  // `db_metadata_list` belongs to the latter, and a shorter match would steal it.
  const prefixes = servers
    .map((name) => ({ name, prefix: serverPrefix(name, mode) }))
    .filter((entry) => entry.prefix.length > 0)
    .sort((a, b) => b.prefix.length - a.prefix.length);

  return {
    servers,
    isMcpTool: isAdapterOrigin,
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
