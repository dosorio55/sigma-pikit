import { formatSkillsForPrompt, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";

import { GATEWAY_TOOL, readMcpInfo } from "./mcp.js";
import { tokensOf } from "./tokens.js";

type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

/** Tools whose MCP server we could not name. Kept separate so no row lies. */
export const UNATTRIBUTED = "MCP · server unknown";

export interface ToolRow {
  name: string;
  tokens: number;
}

export interface Group {
  label: string;
  tokens: number;
  tools: ToolRow[];
}

export interface Report {
  model: string;
  contextWindow: number;
  /** Where auto-compaction fires: `contextWindow - reserveTokens`. */
  compactionAt: number;
  compactionEnabled: boolean;
  /** Whole-session usage, or null right after compaction before the next reply. */
  sessionTokens: number | null;

  systemPrompt: {
    /** Everything in the prompt string that is not a context file or a skill. */
    base: number;
    /** True when base had to be clamped — the slices do not fit the whole. */
    baseUnknown: boolean;
    contextFiles: ToolRow[];
    contextFilesTokens: number;
    /** Skills ride in the prompt only while the read tool is active. */
    skillsInPrompt: boolean;
    skillsTokens: number;
    skillCount: number;
    total: number;
  };

  /** Groups whose schemas are in the request right now. */
  active: Group[];
  activeTokens: number;

  /** Configured, costing nothing: inactive tools and servers with no active tool. */
  idle: Group[];
  idleToolCount: number;
  /**
   * True when every MCP tool found its server. While false, no server can be
   * called idle — its tools may be sitting in the unattributed group.
   */
  serversResolved: boolean;

  staticTokens: number;
}

/**
 * Extension sources are not all paths. Package extensions give `npm:pi-subagents`
 * or `git:host/user/repo`; locally loaded ones give the bare loader kind —
 * `local`, `auto`, `cli`, `inline` — which would collapse every extension in a
 * repo into one row. For those the directory is the only thing that names them.
 */
function extensionLabel(tool: ToolInfo): string {
  const source = tool.sourceInfo?.source;
  const anonymous = source === "local" || source === "auto" || source === "cli" || source === "inline";

  if (anonymous || !source) {
    const path = tool.sourceInfo?.baseDir ?? tool.sourceInfo?.path;
    if (path) {
      const dir = /\.(ts|js|mts|mjs|cts|cjs)$/.test(path) ? dirname(path) : path;
      const name = dir.split(/[\\/]/).filter(Boolean).at(-1);
      if (name) return `Extension · ${name}`;
    }
    return `Extension · ${source ?? "unknown"}`;
  }

  // `npm:pi-subagents` and `git:github.com/user/repo` both read best as the tail.
  const withoutScheme = source.replace(/^[a-z]+:/, "");
  const tail = withoutScheme.split(/[\\/]/).filter(Boolean).at(-1);
  return `Extension · ${tail || source}`;
}

/**
 * Group by the thing you could actually switch off — an MCP server, an
 * extension — rather than by `sourceInfo.source`, which reports where pi loaded
 * the code from. "extension: 4.9k" names nothing you can act on.
 */
function groupLabel(
  tool: ToolInfo,
  mcp: ReturnType<typeof readMcpInfo>,
): { label: string; server?: string; unattributed?: boolean } {
  const source = tool.sourceInfo?.source;

  // Built-ins first. A server named `web` must not capture the built-in-looking
  // `web_search` of some other extension just by sharing a name prefix.
  if (source === "builtin") return { label: "Built-in tools" };
  if (source === "sdk") return { label: "SDK tools" };

  if (mcp.isMcpTool(source)) {
    // The gateway is the whole of proxy-mode MCP: one schema standing in for
    // every server, which is why proxy mode is cheap. It is not a server.
    if (tool.name === GATEWAY_TOOL) return { label: "MCP gateway" };
    const server = mcp.serverFor(tool.name);
    if (server) return { label: `MCP · ${server}`, server };
    return { label: UNATTRIBUTED, unattributed: true };
  }

  return { label: extensionLabel(tool) };
}

/**
 * What a tool costs is its schema: the model is sent the name, the description
 * and the parameter shape. `promptGuidelines` ride along in the system prompt
 * and are already counted there.
 */
function toolTokens(tool: ToolInfo): number {
  let parameters = "";
  try {
    // Schemas come from third-party servers; a self-referential one would throw
    // here and take the whole report down over a single row.
    if (tool.parameters) parameters = JSON.stringify(tool.parameters) ?? "";
  } catch {
    parameters = "";
  }
  return tokensOf(`${tool.name ?? ""}\n${tool.description ?? ""}\n${parameters}`);
}

/**
 * pi's own settings resolution, not a hand-rolled read of the two files.
 *
 * The difference is not cosmetic: project settings are ignored unless the
 * project is trusted, so reading `.pi/settings.json` directly would draw the
 * compaction mark using a number pi is not using — in the one view whose job is
 * predicting that moment.
 */
function compactionSettings(ctx: ExtensionCommandContext) {
  try {
    return SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    }).getCompactionSettings();
  } catch {
    return { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
  }
}

function sortGroups(groups: Map<string, Group>): Group[] {
  const list = [...groups.values()];
  for (const group of list) group.tools.sort((a, b) => b.tokens - a.tokens);
  return list.sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
}

export function collect(pi: ExtensionAPI, ctx: ExtensionCommandContext): Report {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const compaction = compactionSettings(ctx);

  const mcp = readMcpInfo(ctx.cwd);
  const activeNames = new Set(pi.getActiveTools());
  const all = pi.getAllTools();

  const activeGroups = new Map<string, Group>();
  const idleGroups = new Map<string, Group>();
  const serversWithActiveTool = new Set<string>();
  let idleToolCount = 0;
  let serversResolved = true;

  for (const tool of all) {
    const { label, server, unattributed } = groupLabel(tool, mcp);
    if (unattributed) serversResolved = false;

    // A tool that is not active has no schema in the request. Its cost is zero,
    // whatever its metadata weighs on disk — so it is listed, never summed.
    const isActive = activeNames.has(tool.name);
    const target = isActive ? activeGroups : idleGroups;
    const group = target.get(label) ?? { label, tokens: 0, tools: [] };

    if (isActive) {
      const tokens = toolTokens(tool);
      group.tokens += tokens;
      group.tools.push({ name: tool.name, tokens });
      if (server) serversWithActiveTool.add(server);
    } else {
      idleToolCount += 1;
      group.tools.push({ name: tool.name, tokens: 0 });
    }

    target.set(label, group);
  }

  // A configured server with no registered tool at all — proxy mode, or simply
  // never connected. It exists, and it is costing nothing.
  //
  // Only claimed while every MCP tool found its server. With unattributed tools
  // around, a server listed here might be the very one paying for them.
  if (serversResolved) {
    for (const server of mcp.servers) {
      if (serversWithActiveTool.has(server)) continue;
      const label = `MCP · ${server}`;
      if (idleGroups.has(label) || activeGroups.has(label)) continue;
      idleGroups.set(label, { label, tokens: 0, tools: [] });
    }
  }

  const options = ctx.getSystemPromptOptions();
  // Sensitive: contextFiles carries full file contents. Only the path and a
  // token count ever leave this function.
  //
  // Measured with the wrapper pi puts around them, so the row matches what the
  // prompt actually carries rather than the bare file.
  const contextFiles = (options.contextFiles ?? []).map((file) => ({
    name: file.path,
    tokens: tokensOf(
      `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`,
    ),
  }));
  const contextFilesTokens = contextFiles.reduce((sum, file) => sum + file.tokens, 0);

  const skills = options.skills ?? [];
  // pi appends the skills block only while the read tool is active
  // (`buildSystemPrompt`: `if (hasRead && skills.length > 0)`). Counting them
  // unconditionally invents a row and shrinks the base prompt to match.
  const selected = options.selectedTools;
  const skillsInPrompt = !selected || selected.includes("read");
  // formatSkillsForPrompt drops `disable-model-invocation` skills, so both the
  // token figure and the count have to ignore them or the row disagrees itself.
  const promptSkills = skills.filter((skill) => !skill.disableModelInvocation);
  const skillsTokens =
    skillsInPrompt && promptSkills.length > 0 ? tokensOf(formatSkillsForPrompt(promptSkills)) : 0;

  const promptTotal = tokensOf(ctx.getSystemPrompt());
  // The prompt string is measured whole; the two slices are measured again from
  // their own sources. They should fit inside it — but an extension that
  // rewrites the system prompt in `before_agent_start` leaves an override in
  // place that these options never described, and then they do not. Report that
  // rather than clamping a negative into a plausible-looking zero.
  const rawBase = promptTotal - contextFilesTokens - skillsTokens;
  const baseUnknown = rawBase < 0;

  const active = sortGroups(activeGroups);
  const activeTokens = active.reduce((sum, group) => sum + group.tokens, 0);

  return {
    model: ctx.model?.id ?? "unknown model",
    contextWindow,
    compactionAt: Math.max(0, contextWindow - compaction.reserveTokens),
    compactionEnabled: compaction.enabled,
    sessionTokens: usage?.tokens ?? null,
    systemPrompt: {
      base: Math.max(0, rawBase),
      baseUnknown,
      contextFiles,
      contextFilesTokens,
      skillsInPrompt,
      skillsTokens,
      skillCount: promptSkills.length,
      total: promptTotal,
    },
    active,
    activeTokens,
    idle: sortGroups(idleGroups),
    idleToolCount,
    serversResolved,
    staticTokens: promptTotal + activeTokens,
  };
}
