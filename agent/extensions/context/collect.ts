import {
  DEFAULT_COMPACTION_SETTINGS,
  formatSkillsForPrompt,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readMcpInfo } from "./mcp.js";
import { tokensOf } from "./tokens.js";

type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

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
    contextFiles: ToolRow[];
    contextFilesTokens: number;
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

  staticTokens: number;
}

/** Extension tool sources arrive as paths; the folder name is what you recognise. */
function shortSource(source: string | undefined): string {
  if (!source) return "unknown";
  const parts = source.split(/[\\/]/).filter(Boolean);
  const last = parts.at(-1) ?? source;
  return last === "index.ts" || last === "index.js" ? (parts.at(-2) ?? last) : last;
}

/**
 * Group by the thing you could actually switch off — an MCP server, a skill, an
 * extension — rather than by `sourceInfo.source`, which reports where pi loaded
 * the code from. "extension: 4.9k" names nothing you can act on.
 */
function groupLabel(tool: ToolInfo, serverFor: (name: string) => string | undefined): string {
  // The gateway tool is the whole of proxy-mode MCP: one schema standing in for
  // every server, which is exactly why proxy mode is cheap. It is not a server.
  if (tool.name === "mcp") return "MCP gateway";

  const server = serverFor(tool.name);
  if (server) return `MCP · ${server}`;

  const source = tool.sourceInfo?.source;
  if (source === "builtin") return "Built-in tools";
  if (source === "sdk") return "SDK tools";
  return `Extension · ${shortSource(source)}`;
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
  return tokensOf(`${tool.name}\n${tool.description ?? ""}\n${parameters}`);
}

function readReserveTokens(cwd: string): number {
  const fallback = DEFAULT_COMPACTION_SETTINGS.reserveTokens ?? 16384;
  // Project settings win over global, same precedence pi applies.
  for (const path of [join(cwd, ".pi", "settings.json"), join(getAgentDir(), "settings.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        compaction?: { reserveTokens?: number; enabled?: boolean };
      };
      const value = parsed.compaction?.reserveTokens;
      if (typeof value === "number" && value >= 0) return value;
    } catch {
      // Missing or unreadable: fall through to the next scope.
    }
  }
  return fallback;
}

function readCompactionEnabled(cwd: string): boolean {
  for (const path of [join(cwd, ".pi", "settings.json"), join(getAgentDir(), "settings.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        compaction?: { enabled?: boolean };
      };
      if (typeof parsed.compaction?.enabled === "boolean") return parsed.compaction.enabled;
    } catch {
      // Same as above.
    }
  }
  return DEFAULT_COMPACTION_SETTINGS.enabled ?? true;
}

function sortGroups(groups: Map<string, Group>): Group[] {
  const list = [...groups.values()];
  for (const group of list) group.tools.sort((a, b) => b.tokens - a.tokens);
  return list.sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
}

export function collect(pi: ExtensionAPI, ctx: ExtensionCommandContext): Report {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const reserveTokens = readReserveTokens(ctx.cwd);

  const mcp = readMcpInfo();
  const activeNames = new Set(pi.getActiveTools());
  const all = pi.getAllTools();

  const activeGroups = new Map<string, Group>();
  const idleGroups = new Map<string, Group>();
  const serversWithActiveTool = new Set<string>();
  let idleToolCount = 0;

  for (const tool of all) {
    const label = groupLabel(tool, mcp.serverFor);
    // A tool that is not active has no schema in the request. Its cost is zero,
    // whatever its metadata weighs on disk — so it is listed, never summed.
    const isActive = activeNames.has(tool.name);
    const target = isActive ? activeGroups : idleGroups;
    const group = target.get(label) ?? { label, tokens: 0, tools: [] };

    if (isActive) {
      const tokens = toolTokens(tool);
      group.tokens += tokens;
      group.tools.push({ name: tool.name, tokens });
      const server = mcp.serverFor(tool.name);
      if (server) serversWithActiveTool.add(server);
    } else {
      idleToolCount += 1;
      group.tools.push({ name: tool.name, tokens: 0 });
    }

    target.set(label, group);
  }

  // A configured server with no registered tool at all — proxy mode, or simply
  // never connected. It exists, and it is costing nothing.
  for (const server of mcp.servers) {
    if (serversWithActiveTool.has(server)) continue;
    const label = `MCP · ${server}`;
    if (idleGroups.has(label) || activeGroups.has(label)) continue;
    idleGroups.set(label, { label, tokens: 0, tools: [] });
  }

  const options = ctx.getSystemPromptOptions();
  // Sensitive: contextFiles carries full file contents. Only the path and a
  // token count ever leave this function.
  const contextFiles = (options.contextFiles ?? []).map((file) => ({
    name: file.path,
    tokens: tokensOf(`${file.path}\n${file.content}`),
  }));
  const contextFilesTokens = contextFiles.reduce((sum, file) => sum + file.tokens, 0);

  const skills = options.skills ?? [];
  // The exact block pi puts in the prompt, not a guess at its shape. Skills with
  // disableModelInvocation are excluded by formatSkillsForPrompt — as they are
  // in the real prompt, so they correctly cost nothing here.
  const skillsTokens = skills.length > 0 ? tokensOf(formatSkillsForPrompt(skills)) : 0;

  const promptTotal = tokensOf(ctx.getSystemPrompt());
  // Clamped: the prompt string is measured whole, and the two slices are
  // measured again from their sources. Small formatting differences must not
  // turn into a negative "everything else" line.
  const base = Math.max(0, promptTotal - contextFilesTokens - skillsTokens);

  const active = sortGroups(activeGroups);
  const activeTokens = active.reduce((sum, group) => sum + group.tokens, 0);

  return {
    model: ctx.model?.id ?? "unknown model",
    contextWindow,
    compactionAt: Math.max(0, contextWindow - reserveTokens),
    compactionEnabled: readCompactionEnabled(ctx.cwd),
    sessionTokens: usage?.tokens ?? null,
    systemPrompt: {
      base,
      contextFiles,
      contextFilesTokens,
      skillsTokens,
      skillCount: skills.length,
      total: promptTotal,
    },
    active,
    activeTokens,
    idle: sortGroups(idleGroups),
    idleToolCount,
    staticTokens: promptTotal + activeTokens,
  };
}
