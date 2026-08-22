import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  type Focusable,
  type KeybindingsManager,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  type Component,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

const FAVORITES_PATH = join(getAgentDir(), "model-favorites.json");
const PRICES_PATH = join(getAgentDir(), "model-prices.json");
const MAX_VISIBLE = 10;

type AvailableModel = Model<any>;
type ModelPrice = { input: number; output: number };
type SortMode = "favorites" | "price-asc" | "price-desc";

const SORT_MODES: SortMode[] = ["favorites", "price-asc", "price-desc"];

type FavoritesFile = {
  version: 1;
  favorites: string[];
};

type PricesFile = {
  version: 1;
  prices: Record<string, ModelPrice>;
};

function modelKey(model: AvailableModel): string {
  return `${model.provider}/${model.id}`;
}

function loadFavorites(path = FAVORITES_PATH): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FavoritesFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.favorites)) return new Set();
    return new Set(parsed.favorites.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function saveFavorites(favorites: ReadonlySet<string>, path = FAVORITES_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  const data: FavoritesFile = { version: 1, favorites: [...favorites].sort() };
  writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function loadPrices(path = PRICES_PATH): Map<string, ModelPrice> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PricesFile>;
    if (parsed.version !== 1 || !parsed.prices || typeof parsed.prices !== "object") return new Map();
    return new Map(
      Object.entries(parsed.prices).filter(
        (entry): entry is [string, ModelPrice] =>
          typeof entry[1]?.input === "number" &&
          Number.isFinite(entry[1].input) &&
          entry[1].input >= 0 &&
          typeof entry[1]?.output === "number" &&
          Number.isFinite(entry[1].output) &&
          entry[1].output >= 0,
      ),
    );
  } catch {
    return new Map();
  }
}

function modelPrice(
  model: AvailableModel,
  prices: ReadonlyMap<string, ModelPrice>,
): ModelPrice | undefined {
  return prices.get(modelKey(model)) ?? model.cost;
}

function formatRate(rate: number): string {
  return Number.isInteger(rate) ? String(rate) : String(Number(rate.toFixed(2)));
}

function formatPrice(price: ModelPrice): string {
  return `↓$${formatRate(price.input)} ↑$${formatRate(price.output)}`;
}

class ModelRow implements Component {
  constructor(
    private readonly label: string,
    private readonly price: string | undefined,
    private readonly selected: boolean,
  ) {}

  render(width: number): string[] {
    if (!this.price || visibleWidth(this.label) + visibleWidth(this.price) + 2 > width) {
      return [truncateToWidth(this.label, width)];
    }
    const gapWidth = width - visibleWidth(this.label) - visibleWidth(this.price);
    const gap = this.selected ? ` ${"·".repeat(gapWidth - 2)} ` : " ".repeat(gapWidth);
    return [`${this.label}${gap}${this.price}`];
  }

  invalidate(): void {}
}

function favoriteFirst(models: AvailableModel[], favorites: ReadonlySet<string>): AvailableModel[] {
  const favoriteModels: AvailableModel[] = [];
  const otherModels: AvailableModel[] = [];
  for (const model of models) {
    (favorites.has(modelKey(model)) ? favoriteModels : otherModels).push(model);
  }
  return [...favoriteModels, ...otherModels];
}

function sortModels(
  models: AvailableModel[],
  mode: SortMode,
  favorites: ReadonlySet<string>,
  prices: ReadonlyMap<string, ModelPrice>,
): AvailableModel[] {
  if (mode === "favorites") return favoriteFirst(models, favorites);

  const direction = mode === "price-asc" ? 1 : -1;
  return [...models].sort((a, b) => {
    const aPrice = modelPrice(a, prices);
    const bPrice = modelPrice(b, prices);
    if (!aPrice && !bPrice) return 0;
    if (!aPrice) return 1;
    if (!bPrice) return -1;
    return direction * (aPrice.output - bPrice.output || aPrice.input - bPrice.input);
  });
}

class FavoriteModelPicker extends Container implements Focusable {
  private readonly searchInput = new Input();
  private readonly sortLabel = new Text("", 0, 0);
  private readonly list = new Container();
  private filtered: AvailableModel[] = [];
  private selectedIndex = 0;
  private sortMode: SortMode = "favorites";
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
    private readonly theme: ExtensionContext["ui"]["theme"],
    private readonly keybindings: KeybindingsManager,
    private readonly models: AvailableModel[],
    private readonly currentModel: AvailableModel | undefined,
    private readonly favorites: Set<string>,
    private readonly prices: ReadonlyMap<string, ModelPrice>,
    private readonly onSelect: (model: AvailableModel) => void,
    private readonly onCancel: () => void,
    private readonly onFavoritesChanged: () => void,
    initialQuery: string,
  ) {
    super();

    this.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("accent", this.theme.bold("Select a model")), 0, 0));
    this.addChild(
      new Text(
        this.theme.fg("dim", "Tab sort · Ctrl+F favorite · ↑↓ navigate · Enter select · Esc cancel"),
        0,
        0,
      ),
    );
    this.addChild(this.sortLabel);
    this.addChild(new Spacer(1));

    this.searchInput.setValue(initialQuery);
    this.searchInput.onSubmit = () => this.selectCurrent();
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));

    this.filter(initialQuery);
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
        this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
        this.rebuildList();
        this.tui.requestRender();
      }
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.filtered.length > 0) {
        this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
        this.rebuildList();
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "ctrl+f")) {
      this.toggleFavorite();
      return;
    }

    if (matchesKey(data, "tab")) {
      this.cycleSortMode();
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
      (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );
    const matched = query.trim()
      ? fuzzyFilter(sorted, query, (model) => `${model.provider} ${model.id} ${model.name}`)
      : sorted;
    this.filtered = sortModels(matched, this.sortMode, this.favorites, this.prices);
    this.selectedIndex = 0;
    this.rebuildList();
  }

  private cycleSortMode(): void {
    const selectedKey = this.filtered[this.selectedIndex]
      ? modelKey(this.filtered[this.selectedIndex]!)
      : undefined;
    const currentIndex = SORT_MODES.indexOf(this.sortMode);
    this.sortMode = SORT_MODES[(currentIndex + 1) % SORT_MODES.length] ?? "favorites";
    this.filter(this.searchInput.getValue());
    if (selectedKey) {
      const selectedIndex = this.filtered.findIndex((model) => modelKey(model) === selectedKey);
      this.selectedIndex = selectedIndex >= 0 ? selectedIndex : 0;
    }
    this.rebuildList();
    this.tui.requestRender();
  }

  private selectCurrent(): void {
    const model = this.filtered[this.selectedIndex];
    if (model) this.onSelect(model);
  }

  private toggleFavorite(): void {
    const model = this.filtered[this.selectedIndex];
    if (!model) return;

    const key = modelKey(model);
    if (this.favorites.has(key)) this.favorites.delete(key);
    else this.favorites.add(key);

    this.onFavoritesChanged();
    const selectedKey = key;
    this.filter(this.searchInput.getValue());
    const selectedIndex = this.filtered.findIndex((candidate) => modelKey(candidate) === selectedKey);
    this.selectedIndex = selectedIndex >= 0 ? selectedIndex : 0;
    this.rebuildList();
    this.tui.requestRender();
  }

  private rebuildList(): void {
    this.list.clear();
    const labels: Record<SortMode, string> = {
      favorites: "Favorites",
      "price-asc": "Price asc",
      "price-desc": "Price desc",
    };
    this.sortLabel.setText(this.theme.fg("muted", `Sort: ${labels[this.sortMode]}`));

    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.filtered.length - MAX_VISIBLE),
    );
    const end = Math.min(start + MAX_VISIBLE, this.filtered.length);

    for (let index = start; index < end; index++) {
      const model = this.filtered[index];
      if (!model) continue;

      const selected = index === this.selectedIndex;
      const favorite = this.favorites.has(modelKey(model));
      const current = this.currentModel && modelKey(this.currentModel) === modelKey(model);
      const prefix = selected ? this.theme.fg("accent", "→") : " ";
      const star = favorite ? this.theme.fg("warning", "★") : " ";
      const id = selected ? this.theme.fg("accent", model.id) : model.id;
      const provider = this.theme.fg("muted", `[${model.provider}]`);
      const check = current ? this.theme.fg("success", " ✓") : "";
      const price = modelPrice(model, this.prices);
      this.list.addChild(
        new ModelRow(
          `${prefix} ${star} ${id} ${provider}${check}`,
          price ? this.theme.fg("muted", formatPrice(price)) : undefined,
          selected,
        ),
      );
    }

    if (this.filtered.length === 0) {
      this.list.addChild(new Text(this.theme.fg("muted", "  No matching models"), 0, 0));
      return;
    }

    if (start > 0 || end < this.filtered.length) {
      this.list.addChild(
        new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0),
      );
    }

    const selected = this.filtered[this.selectedIndex];
    if (selected) {
      this.list.addChild(new Spacer(1));
      this.list.addChild(new Text(this.theme.fg("muted", `  ${selected.name}`), 0, 0));
    }
  }
}

async function openPicker(pi: ExtensionAPI, ctx: ExtensionContext, initialQuery = ""): Promise<void> {
  if (ctx.mode !== "tui") return;

  const scopedModels = (
    ctx as ExtensionContext & { scopedModels?: ReadonlyArray<{ model: AvailableModel }> }
  ).scopedModels;
  const models = scopedModels && scopedModels.length > 0
    ? scopedModels.map((entry) => entry.model)
    : ctx.modelRegistry.getAvailable();
  if (models.length === 0) {
    ctx.ui.notify("No authenticated models are available. Use /login first.", "warning");
    return;
  }

  const favorites = loadFavorites();
  const prices = loadPrices();
  let requestRender: (() => void) | undefined;
  const selected = await ctx.ui.custom<AvailableModel | null>((tui, theme, keybindings, done) => {
    requestRender = () => tui.requestRender();
    return new FavoriteModelPicker(
      tui,
      theme,
      keybindings,
      models,
      ctx.model,
      favorites,
      prices,
      done,
      () => done(null),
      () => {
        try {
          saveFavorites(favorites);
        } catch (error) {
          ctx.ui.notify(
            `Could not save model favorites: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      },
      initialQuery,
    );
  });

  if (!selected) return;
  if (!(await pi.setModel(selected))) {
    ctx.ui.notify(`Could not select ${modelKey(selected)}: authentication is unavailable.`, "error");
    return;
  }
  requestRender?.();
}

export default function modelFavorites(pi: ExtensionAPI): void {
  const handler = async (args: string, ctx: ExtensionContext) => openPicker(pi, ctx, args.trim());

  pi.registerCommand("models", {
    description: "Select a model with favorites",
    handler,
  });

  pi.registerShortcut("alt+m", {
    description: "Open the favorite-aware model selector",
    handler: (ctx) => openPicker(pi, ctx),
  });
}

export {
  favoriteFirst,
  formatPrice,
  loadFavorites,
  loadPrices,
  modelKey,
  modelPrice,
  saveFavorites,
  sortModels,
};
