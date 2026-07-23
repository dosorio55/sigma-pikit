import type { ExtensionAPI, ExtensionContext, Theme, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

import { formatTokens, formatCost } from "./format.js";

// Un trozo del footer. `drop` = orden de eliminación cuando falta espacio
// (menor = se elimina antes; 0 = nunca se elimina). `side` = izquierda o derecha.
interface Part {
  text: string;
  side: "l" | "r";
  drop: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// footer — versión propia, de una sola fila. Imitación simplificada del footer
// de pikit. Muestra:  π  modelo (proveedor)  ruta  rama*  [barra] tokens/max %  NIVEL  $coste
//
// Decisiones de diseño (a propósito distintas del original):
//  · Sin registro de "segmentos": construimos la línea con funciones pequeñas.
//  · Barra de contexto por umbrales de color (verde→ámbar→rojo), no degradado RGB.
//  · La rama sale de footerData.getGitBranch(); solo el estado "sucio" usa git.
// ─────────────────────────────────────────────────────────────────────────────

interface Usage {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  lastContextTokens: number;
}

/** Suma tokens/coste de todos los mensajes del asistente en la rama actual. */
function collectUsage(ctx: ExtensionContext): Usage {
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  const u: Usage = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: 0 };

  for (const entry of branch as Array<{ type: string; message?: { role: string; usage?: AssistantMessage["usage"]; stopReason?: string } }>) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const m = entry.message;
    if (!m.usage || m.stopReason === "error" || m.stopReason === "aborted") continue;
    u.cost += m.usage.cost.total;
    u.input += m.usage.input;
    u.output += m.usage.output;
    u.cacheRead += m.usage.cacheRead;
    u.cacheWrite += m.usage.cacheWrite;
    // El contexto "vivo" es el del último mensaje del asistente.
    u.lastContextTokens = m.usage.input + m.usage.output + m.usage.cacheRead + m.usage.cacheWrite;
  }
  return u;
}

/** Barra de 10 caracteres coloreada por cuánto contexto se ha usado. */
function contextBar(theme: Theme, pct: number): string {
  const width = 10;
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const token = pct >= 90 ? "error" : pct >= 70 ? "warning" : "success";
  const on = theme.fg(token, "█".repeat(filled));
  const off = theme.fg("dim", "░".repeat(width - filled));
  return on + off;
}

/** Color del nivel de thinking, para que se lea de un vistazo. */
function thinkingColor(level: string): Parameters<Theme["fg"]>[0] {
  switch (level) {
    case "off": return "dim";
    case "minimal": return "muted";
    case "low": return "warning";
    case "medium": return "success";
    default: return "accent"; // high / xhigh / max
  }
}

/** Ruta absoluta abreviada con ~ para el home. */
function formatPath(cwd: string): string {
  const home = process.env.HOME ?? "";
  return home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
}

/**
 * Reúne todas las partes de la línea principal (todo menos la ruta), cada una
 * con su prioridad de eliminación cuando falta espacio.
 */
function buildParts(pi: ExtensionAPI, ctx: ExtensionContext, theme: Theme, branch: string | null): Part[] {
  const dim = (t: string) => theme.fg("dim", t);
  const parts: Part[] = [];

  // π + modelo (proveedor) — nunca se elimina
  const modelName = ctx.model?.name ?? ctx.model?.id ?? "no-model";
  let model = theme.fg("accent", "π ") + modelName;
  if (ctx.model?.provider) model += " " + dim(`(${ctx.model.provider})`);
  parts.push({ text: model, side: "l", drop: 0 });

  // Rama de git (solo el nombre)
  if (branch) {
    parts.push({ text: theme.fg("success", branch), side: "l", drop: 40 });
  }

  const u = collectUsage(ctx);

  // Barra de contexto (drop 20) + tokens/max/% (drop 50, casi siempre se queda)
  const window = ctx.model?.contextWindow ?? 0;
  if (window > 0) {
    const pct = (u.lastContextTokens / window) * 100;
    parts.push({ text: contextBar(theme, pct), side: "r", drop: 20 });
    const label = `${formatTokens(u.lastContextTokens)}/${formatTokens(window)} ${pct.toFixed(0)}%`;
    parts.push({ text: theme.fg("muted", label), side: "r", drop: 50 });
  }

  // Desglose de tokens: ↑in ↓out Rcache (Wcache si hay) — drop 25
  const tok: string[] = [
    dim("↑") + theme.fg("muted", formatTokens(u.input)),
    dim("↓") + theme.fg("muted", formatTokens(u.output)),
  ];
  if (u.cacheRead) tok.push(dim("R") + theme.fg("muted", formatTokens(u.cacheRead)));
  if (u.cacheWrite) tok.push(dim("W") + theme.fg("muted", formatTokens(u.cacheWrite)));
  parts.push({ text: tok.join(" "), side: "r", drop: 25 });

  // Thinking level (drop 45)
  const level = pi.getThinkingLevel();
  parts.push({ text: theme.fg(thinkingColor(level), level.toUpperCase()), side: "r", drop: 45 });

  // Coste — nunca se elimina
  parts.push({ text: dim("$") + theme.fg("muted", formatCost(u.cost)), side: "r", drop: 0 });

  return parts;
}

/** Ancho que ocupan varias partes unidas por separadores de 2 espacios. */
function groupWidth(parts: Part[]): number {
  if (parts.length === 0) return 0;
  return parts.reduce((w, p) => w + visibleWidth(p.text), 0) + 2 * (parts.length - 1);
}

/**
 * Compone la línea final: izquierda pegada al borde izquierdo, derecha al
 * derecho, relleno en medio (space-between). Si no cabe, elimina partes por
 * prioridad hasta que quepa; como última red, recorta.
 */
const MARGIN_L = 1; // margen izquierdo
const MARGIN_R = 2; // margen derecho

function compose(width: number, parts: Part[]): string {
  const active = parts.filter((p) => p.text);
  const sep = "  ";

  const fits = () => {
    const l = groupWidth(active.filter((p) => p.side === "l"));
    const r = groupWidth(active.filter((p) => p.side === "r"));
    return MARGIN_L + l + 1 + r + MARGIN_R <= width; // +1 mínimo entre grupos
  };

  while (!fits()) {
    const victim = active
      .filter((p) => p.drop > 0)
      .sort((a, b) => a.drop - b.drop)[0];
    if (!victim) break;
    active.splice(active.indexOf(victim), 1);
  }

  const leftStr = active.filter((p) => p.side === "l").map((p) => p.text).join(sep);
  const rightStr = active.filter((p) => p.side === "r").map((p) => p.text).join(sep);

  const avail = Math.max(0, width - MARGIN_L - MARGIN_R);
  const rightW = visibleWidth(rightStr);

  // Si ni el grupo derecho cabe solo, mostramos solo él (recortado): es el
  // que contiene coste/thinking, lo más importante.
  if (rightW >= avail) {
    return " ".repeat(MARGIN_L) + truncateToWidth(rightStr, avail);
  }

  // Recortamos el grupo IZQUIERDO (modelo/ruta) para preservar el derecho intacto.
  const finalLeft = truncateToWidth(leftStr, Math.max(0, avail - rightW - 1));
  const gap = Math.max(1, avail - visibleWidth(finalLeft) - rightW);

  return " ".repeat(MARGIN_L) + finalLeft + " ".repeat(gap) + rightStr;
}

/** Línea 1: solo la ruta del proyecto. */
function buildPathLine(ctx: ExtensionContext, theme: Theme, width: number): string {
  const cwd = ctx.cwd ?? process.cwd();
  return truncateToWidth(" ".repeat(MARGIN_L) + theme.fg("dim", formatPath(cwd)), Math.max(0, width - MARGIN_R));
}

/** Línea 2: modelo, git, contexto, tokens, thinking, coste (space-between). */
function buildMainLine(pi: ExtensionAPI, ctx: ExtensionContext, theme: Theme, branch: string | null, width: number): string {
  return compose(width, buildParts(pi, ctx, theme, branch));
}

export default function footer(pi: ExtensionAPI) {
  let currentCtx: ExtensionContext | null = null;

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    currentCtx = ctx;
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      // Redibuja cuando pi detecta un cambio de rama.
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          if (!currentCtx) return [];
          const branch = footerData.getGitBranch();
          try {
            const pathLine = buildPathLine(currentCtx, theme, width);
            const mainLine = buildMainLine(pi, currentCtx, theme, branch, width);
            return [pathLine, mainLine];
          } catch {
            return [];
          }
        },
      };
    });
  });
}
