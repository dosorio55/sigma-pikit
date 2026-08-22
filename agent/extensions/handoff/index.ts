import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Model,
  type ModelThinkingLevel,
  uuidv7,
} from "@earendil-works/pi-ai";
import {
  completeSimple,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai/compat";
import {
  BorderedLoader,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  SessionManager,
  serializeConversation,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  type Focusable,
  type KeybindingsManager,
  Loader,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";

const SYSTEM_PROMPT = `You create compact handoffs between coding-agent sessions.

Turn the supplied conversation into a self-contained initial prompt for a new session. Preserve only information needed to continue effectively:
- the user's goal and constraints
- completed work and current state
- key decisions and their rationale
- relevant files, commands, errors, and concrete technical details
- unresolved questions and the next useful action

Do not claim work was completed unless the conversation shows it. Keep exact identifiers, paths, and values when they matter. If focus instructions are supplied, prioritize that subject without dropping prerequisites needed to understand it.

Use concise Markdown. Do not add a preamble such as "Here is the handoff". Do not address the user or continue the task; produce only the context prompt for the next agent.`;

const GENERAL_FOCUS = "Create a balanced handoff of the current work.";
const CONFIG_PATH = join(getAgentDir(), "handoff.json");
const MAX_VISIBLE_MODELS = 12;
const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "low";
const THINKING_LEVELS = new Set<ModelThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

type HandoffConfig = {
  models: string[];
  thinkingLevel: ModelThinkingLevel;
};

type GeneratedHandoff = {
  text: string;
  model: string;
  thinkingLevel: ModelThinkingLevel;
};

function loadConfig(path = CONFIG_PATH): HandoffConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { models: [], thinkingLevel: DEFAULT_THINKING_LEVEL };
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { models?: unknown }).models)
  ) {
    throw new Error('Expected an object with a "models" array');
  }

  const data = parsed as { models: unknown[]; thinkingLevel?: unknown };
  if (!data.models.every((model) => typeof model === "string")) {
    throw new Error('Every entry in "models" must be a string');
  }
  if (
    data.thinkingLevel !== undefined &&
    (typeof data.thinkingLevel !== "string" ||
      !THINKING_LEVELS.has(data.thinkingLevel as ModelThinkingLevel))
  ) {
    throw new Error(
      '"thinkingLevel" must be off, minimal, low, medium, high, xhigh, or max',
    );
  }

  return {
    models: data.models
      .map((model) => (model as string).trim())
      .filter(Boolean),
    thinkingLevel:
      (data.thinkingLevel as ModelThinkingLevel | undefined) ??
      DEFAULT_THINKING_LEVEL,
  };
}

function saveConfig(config: HandoffConfig, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function parseModelReference(
  reference: string,
): { provider: string; modelId: string } | undefined {
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return undefined;
  return {
    provider: reference.slice(0, separator),
    modelId: reference.slice(separator + 1),
  };
}

function modelKey(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

class HandoffLoader extends BorderedLoader {
  setMessage(message: string): void {
    const loader = this.children.find((child) => child instanceof Loader);
    loader?.setMessage(message);
  }
}

class HandoffModelPicker extends Container implements Focusable {
  private readonly searchInput = new Input();
  private readonly list = new Container();
  private filtered: Model<any>[] = [];
  private selectedIndex = 0;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: ExtensionCommandContext["ui"]["theme"],
    private readonly keybindings: KeybindingsManager,
    private readonly models: Model<any>[],
    private readonly onSelect: (model: Model<any>) => void,
    private readonly onCancel: () => void,
  ) {
    super();
    this.addChild(
      new Text(
        this.theme.fg("accent", this.theme.bold("Add a handoff model")),
        0,
        0,
      ),
    );
    this.addChild(
      new Text(
        this.theme.fg(
          "dim",
          "Type to search · ↑↓ navigate · Enter add · Esc cancel",
        ),
        0,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.searchInput.onSubmit = () => this.selectCurrent();
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.filter("");
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.selectCurrent();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          this.selectedIndex === 0
            ? this.filtered.length - 1
            : this.selectedIndex - 1;
        this.rebuildList();
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          this.selectedIndex === this.filtered.length - 1
            ? 0
            : this.selectedIndex + 1;
        this.rebuildList();
        this.tui.requestRender();
      }
      return;
    }

    this.searchInput.handleInput(data);
    this.filter(this.searchInput.getValue());
    this.tui.requestRender();
  }

  override invalidate(): void {
    super.invalidate();
    this.rebuildList();
  }

  private filter(query: string): void {
    const sorted = [...this.models].sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.id.localeCompare(right.id),
    );
    this.filtered = query.trim()
      ? fuzzyFilter(
          sorted,
          query,
          (model) => `${model.provider} ${model.id} ${model.name}`,
        )
      : sorted;
    this.selectedIndex = 0;
    this.rebuildList();
  }

  private selectCurrent(): void {
    const model = this.filtered[this.selectedIndex];
    if (model) this.onSelect(model);
  }

  private rebuildList(): void {
    this.list.clear();
    const start = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(MAX_VISIBLE_MODELS / 2),
        this.filtered.length - MAX_VISIBLE_MODELS,
      ),
    );
    const end = Math.min(start + MAX_VISIBLE_MODELS, this.filtered.length);

    for (let index = start; index < end; index++) {
      const model = this.filtered[index];
      if (!model) continue;
      const selected = index === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "→") : " ";
      const id = selected ? this.theme.fg("accent", model.id) : model.id;
      this.list.addChild(
        new Text(
          `${prefix} ${id} ${this.theme.fg("muted", `[${model.provider}]`)}`,
          0,
          0,
        ),
      );
    }

    if (this.filtered.length === 0) {
      this.list.addChild(
        new Text(this.theme.fg("muted", "No matching models"), 0, 0),
      );
    } else if (start > 0 || end < this.filtered.length) {
      this.list.addChild(
        new Text(
          this.theme.fg(
            "dim",
            `${this.selectedIndex + 1}/${this.filtered.length}`,
          ),
          0,
          0,
        ),
      );
    }
  }
}

function buildConversationText(ctx: ExtensionCommandContext): string {
  const messages = ctx.sessionManager
    .buildContextEntries()
    .flatMap((entry) => sessionEntryToContextMessages(entry));
  return serializeConversation(convertToLlm(messages));
}

function buildRequest(conversation: string, focus: string): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "<conversation>",
          conversation,
          "</conversation>",
          "",
          "<focus>",
          focus || GENERAL_FOCUS,
          "</focus>",
        ].join("\n"),
      },
    ],
    timestamp: Date.now(),
  };
}

function responseText(response: AssistantMessage): string {
  return response.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function generateHandoff(
  ctx: ExtensionCommandContext,
  conversation: string,
  focus: string,
  preferredModels: string[],
  thinkingLevel: ModelThinkingLevel,
): Promise<GeneratedHandoff | null> {
  if (!ctx.model) return null;

  const selectedModel = ctx.model;
  const candidates: (typeof selectedModel)[] = [];
  const failures: string[] = [];
  const seen = new Set<string>();

  for (const reference of preferredModels) {
    const parsed = parseModelReference(reference);
    if (!parsed) {
      failures.push(`${reference}: expected provider/model`);
      continue;
    }
    const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model) {
      failures.push(`${reference}: model not found`);
      continue;
    }
    const key = `${model.provider}/${model.id}`;
    if (!seen.has(key)) {
      candidates.push(model);
      seen.add(key);
    }
  }

  const selectedKey = `${selectedModel.provider}/${selectedModel.id}`;
  if (!seen.has(selectedKey)) candidates.push(selectedModel);

  return ctx.ui.custom<GeneratedHandoff | null>(
    (tui, theme, _keybindings, done) => {
      const loader = new HandoffLoader(tui, theme, "Preparing handoff...");
      loader.onAbort = () => done(null);

      const run = async (): Promise<GeneratedHandoff | null> => {
        for (const model of candidates) {
          if (loader.signal.aborted) return null;
          const key = `${model.provider}/${model.id}`;
          const effectiveThinkingLevel = model.reasoning
            ? thinkingLevel
            : "off";
          loader.setMessage(
            `Generating handoff with ${model.name} · ${effectiveThinkingLevel} effort...`,
          );

          try {
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
            if (!auth.ok) throw new Error(auth.error);

            const response = await completeSimple(
              model,
              {
                systemPrompt: SYSTEM_PROMPT,
                messages: [buildRequest(conversation, focus)],
              },
              {
                apiKey: auth.apiKey,
                headers: auth.headers,
                env: auth.env,
                signal: loader.signal,
                cacheRetention: "none",
                sessionId: uuidv7(),
                reasoning:
                  model.reasoning && thinkingLevel !== "off"
                    ? thinkingLevel
                    : undefined,
              },
            );
            if (response.stopReason === "aborted" || loader.signal.aborted)
              return null;

            const text = responseText(response);
            if (response.stopReason !== "stop") {
              throw new Error(
                response.errorMessage || `stopped with ${response.stopReason}`,
              );
            }
            if (!text) throw new Error("empty response");
            return {
              text,
              model: key,
              thinkingLevel: effectiveThinkingLevel,
            };
          } catch (error) {
            if (loader.signal.aborted) return null;
            failures.push(
              `${key}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        throw new Error(`All models failed (${failures.join("; ")})`);
      };

      run()
        .then(done)
        .catch((error: unknown) => {
          ctx.ui.notify(
            `Handoff generation failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          done(null);
        });

      return loader;
    },
  );
}

function sessionName(focus: string, currentName: string | undefined): string {
  const subject = focus.trim() || currentName?.trim() || "current work";
  const compact = subject.replace(/\s+/g, " ");
  return `Handoff · ${compact.length > 60 ? `${compact.slice(0, 57)}...` : compact}`;
}

function persistPendingSession(session: SessionManager): string {
  const path = session.getSessionFile();
  const header = session.getHeader();
  if (!path || !header) {
    throw new Error("Pi did not create a persistent session file");
  }

  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  const entries = [header, ...session.getEntries()];
  writeFileSync(
    tempPath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  renameSync(tempPath, path);
  return path;
}

function saveHandoff(
  ctx: ExtensionCommandContext,
  summary: string,
  focus: string,
): string {
  const session = SessionManager.create(
    ctx.cwd,
    ctx.sessionManager.getSessionDir(),
    {
      parentSession: ctx.sessionManager.getSessionFile(),
    },
  );
  session.appendMessage({
    role: "user",
    content: [{ type: "text", text: summary }],
    timestamp: Date.now(),
  });
  session.appendSessionInfo(
    sessionName(focus, ctx.sessionManager.getSessionName()),
  );
  return persistPendingSession(session);
}

async function addHandoffModel(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/handoff-add-model requires interactive mode", "error");
    return;
  }

  await ctx.waitForIdle();

  let config: HandoffConfig;
  try {
    config = loadConfig();
  } catch (error) {
    ctx.ui.notify(
      `Could not read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}. The file was not changed.`,
      "error",
    );
    return;
  }

  const configured = new Set(config.models);
  const available = ctx.modelRegistry
    .getAvailable()
    .filter((model) => !configured.has(modelKey(model)));
  if (available.length === 0) {
    ctx.ui.notify(
      "Every available model is already in the handoff configuration",
      "info",
    );
    return;
  }

  const selected = await ctx.ui.custom<Model<any> | null>(
    (tui, theme, keybindings, done) =>
      new HandoffModelPicker(tui, theme, keybindings, available, done, () =>
        done(null),
      ),
  );
  if (!selected) return;

  const key = modelKey(selected);
  try {
    saveConfig({ ...config, models: [...config.models, key] });
  } catch (error) {
    ctx.ui.notify(
      `Could not update ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  ctx.ui.notify(`Added ${key} to handoff models`, "info");
}

export default function handoff(pi: ExtensionAPI): void {
  pi.registerCommand("handoff", {
    description: "Create a focused new session from the current conversation",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/handoff requires interactive mode", "error");
        return;
      }

      await ctx.waitForIdle();

      if (!ctx.model) {
        ctx.ui.notify("No model is selected", "error");
        return;
      }

      let focus = args.trim();
      if (!focus) {
        const entered = await ctx.ui.input(
          "Handoff focus",
          "Optional — leave blank for a general handoff",
        );
        if (entered === undefined) return;
        focus = entered.trim();
      }

      let config: HandoffConfig = {
        models: [],
        thinkingLevel: DEFAULT_THINKING_LEVEL,
      };
      try {
        config = loadConfig();
      } catch (error) {
        ctx.ui.notify(
          `Could not read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}. Using the selected model at ${DEFAULT_THINKING_LEVEL} effort.`,
          "warning",
        );
      }

      const conversation = buildConversationText(ctx);
      if (!conversation.trim()) {
        ctx.ui.notify("There is no conversation to hand off", "warning");
        return;
      }

      const generated = await generateHandoff(
        ctx,
        conversation,
        focus,
        config.models,
        config.thinkingLevel,
      );
      if (generated === null) {
        ctx.ui.notify("Handoff cancelled", "info");
        return;
      }
      ctx.ui.notify(
        `Handoff generated with ${generated.model} · ${generated.thinkingLevel} effort`,
        "info",
      );

      const edited = await ctx.ui.editor("Review handoff", generated.text);
      if (edited === undefined) return;
      const summary = edited.trim();
      if (!summary) {
        ctx.ui.notify("The handoff is empty", "warning");
        return;
      }

      const action = await ctx.ui.select("Handoff ready", [
        "Save and switch",
        "Save for later",
        "Cancel",
      ]);
      if (!action || action === "Cancel") return;

      let sessionPath: string;
      try {
        sessionPath = saveHandoff(ctx, summary, focus);
      } catch (error) {
        ctx.ui.notify(
          `Could not save handoff: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }

      if (action === "Save for later") {
        ctx.ui.notify(
          `Handoff saved as ${sessionName(focus, ctx.sessionManager.getSessionName())}`,
          "info",
        );
        return;
      }

      const result = await ctx.switchSession(sessionPath, {
        withSession: async (replacementCtx) => {
          replacementCtx.ui.notify("Switched to the handoff session", "info");
        },
      });
      if (result.cancelled) {
        ctx.ui.notify(
          "Session switch cancelled; the handoff remains saved",
          "info",
        );
      }
    },
  });

  pi.registerCommand("handoff-add-model", {
    description: "Add an available model to the handoff fallback list",
    handler: async (_args, ctx) => addHandoffModel(ctx),
  });
}

export {
  buildRequest,
  loadConfig,
  parseModelReference,
  persistPendingSession,
  saveConfig,
  sessionName,
};
