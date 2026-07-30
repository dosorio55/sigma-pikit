import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Grouping tools by MCP server needs the server list, and `pi.getAllTools()`
 * does not carry it: a tool arrives as a flat name plus `sourceInfo`, with the
 * server folded into the name prefix by `pi-mcp-adapter`.
 *
 * So we read `mcp.json` and rebuild the same prefixes the adapter builds, then
 * match tools back to servers by name. One small file, read on `/context` and
 * never cached across invocations — cheaper than a watcher and always current.
 *
 * Only the agent-dir config is read. A project-local server would fall through
 * to the extension grouping rather than being mislabelled.
 */

type ToolPrefix = "server" | "none" | "short" | "mcp";

interface McpConfigFile {
  mcpServers?: Record<string, unknown>;
  settings?: { toolPrefix?: ToolPrefix };
}

export interface McpInfo {
  /** Server names in config order. */
  servers: string[];
  /** Server name for a tool, or undefined if the tool is not an MCP direct tool. */
  serverFor(toolName: string): string | undefined;
}

const EMPTY: McpInfo = { servers: [], serverFor: () => undefined };

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

export function readMcpInfo(): McpInfo {
  let parsed: McpConfigFile;
  try {
    parsed = JSON.parse(readFileSync(join(getAgentDir(), "mcp.json"), "utf8")) as McpConfigFile;
  } catch {
    // No MCP config, or config we cannot parse. Either way there is nothing to
    // group by, and a broken mcp.json is not /context's problem to report.
    return EMPTY;
  }

  const servers = Object.keys(parsed.mcpServers ?? {});
  if (servers.length === 0) return EMPTY;

  const mode = parsed.settings?.toolPrefix ?? "server";
  // Longest prefix first: with servers "db" and "db-metadata", a tool named
  // `db_metadata_list` belongs to the latter, and a shorter match would steal it.
  const prefixes = servers
    .map((name) => ({ name, prefix: serverPrefix(name, mode) }))
    .filter((entry) => entry.prefix.length > 0)
    .sort((a, b) => b.prefix.length - a.prefix.length);

  return {
    servers,
    serverFor(toolName: string) {
      return prefixes.find((entry) => toolName.startsWith(`${entry.prefix}_`))?.name;
    },
  };
}
