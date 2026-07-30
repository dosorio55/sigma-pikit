import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * `~/.pi/agent/profiles` — inside the agent dir, so a dotfiles repo tracking
 * `~/.pi/agent` versions the profiles along with the rest of the config.
 *
 * Being inside means `canonical()` no longer rejects it for free, the way it did
 * when this was a sibling of the agent dir. The `profiles` entry in
 * `BUILTIN_BLACKLIST` is what replaces that protection, and it is not optional:
 * without it a manifest listing `profiles` would swap the profile store itself.
 */
export function profilesDir(): string {
  return join(getAgentDir(), "profiles");
}

export const manifestPath = () => join(profilesDir(), "manifest.json");
export const activePath = () => join(profilesDir(), "active");
export const lockPath = () => join(profilesDir(), "lock");

/** Seeded on first use. Only paths that are genuinely per-profile. */
const DEFAULT_SWAP = ["mcp.json", "agents/", "skills/", "prompts/", "AGENTS.md"];

/**
 * Never swappable, whatever the manifest says. Unioned with the user's
 * `blacklist` and not removable by editing the file: a guard you can delete by
 * deleting a line is not a guard.
 *
 * This is deliberately *not* a list of everything that should stay shared —
 * unlisted paths are already untouched, so docs and one-off files need no entry.
 * A path earns a slot only when listing it by mistake does damage that is
 * silent, hard to undo, or locks the user out of the plugin itself.
 */
const BUILTIN_BLACKLIST: Record<string, string> = {
  // Secrets and security decisions. Forking these is silent and the blast
  // radius is outside pi: `trust.json` records which project directories may
  // run code, so a per-profile copy means revoking trust in one profile leaves
  // it granted in the other.
  "auth.json": "credentials",
  "trust.json": "project trust decisions, security state",

  // Pi-managed runtime. Heavy, machine-specific, regenerated on demand.
  "git": "credentials",
  "npm": "re-downloading packages per profile is heavy",
  "bin": "pi-managed runtime",
  "tmp": "pi-managed scratch space",

  // Caches derived from a file that *is* swapped, which is exactly why someone
  // would reasonably assume they must be swapped too. They must not be:
  // `mcp-cache.json` keys every entry by a hash of the server's config, so a
  // shared cache is already correct across profiles and simply re-derives what
  // changed. Swapping it instead throws that away and re-probes every server on
  // every switch. `mcp-npx-cache.json` holds resolved absolute binary paths,
  // which are a property of the machine, not the profile.
  "mcp-cache.json": "cache keyed by config hash, correct and cheaper shared",
  "mcp-npx-cache.json": "resolved binary paths are machine state",
  "mcp-onboarding.json": "one-time setup state, not per-profile",

  // Global preference and catalogue.
  "sessions": "shared across profiles on purpose",
  "settings.json": "global preference, not per-profile",
  "models-store.json": "global provider catalogue",

  // Trap doors. Swapping these takes away the means of undoing it.
  //
  // `extensions` is pi's drop-in directory: a profile that lacks it has its
  // symlink *removed*, so every extension in it disappears at once. Put this
  // plugin there and switching to such a profile deletes `/profile` — the only
  // supported way back — leaving hand-edited symlinks as the recovery path.
  //
  // `.git` matters because the agent dir is commonly a tracked dotfiles repo,
  // and the profile store now lives inside it. Swapping `.git` moves the whole
  // repository into one profile, and switching to a profile without it unlinks
  // the history entirely. Note this is not covered by the `git` entry above:
  // that guards pi's package clone cache, and `.git` is a different path.
  "extensions": "swapping these can remove the way back",
  ".git": "the dotfiles repo the agent dir lives in",
  "profiles": "the profile store itself",
};

export interface Manifest {
  swap: string[];
  blacklist: string[];
}

/**
 * Reduce a manifest entry to a canonical path relative to the agent dir, or
 * `null` if it does not belong to one.
 *
 * Canonicalising *first* is the whole point: `auth.json`, `./auth.json` and
 * `agents/../auth.json` are the same file, and a blacklist that compares raw
 * strings only stops the first spelling. Refusing `""` covers the agent dir
 * itself (`.`, `./`, `agents/..`) — swapping that would move the entire config
 * tree, credentials and sessions included, into a profile directory.
 */
function canonical(entry: string): string | null {
  if (typeof entry !== "string" || entry === "") return null;
  const root = resolve(getAgentDir());
  const rel = relative(root, resolve(root, entry));
  // Exactly `..` or a `../` prefix — not merely "starts with two dots", which
  // would also reject a legitimate `..foo` segment.
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  return rel;
}

/** `git/config` must be caught by the `git` entry, not just an exact match. */
function blacklistedAs(path: string, list: string[]): string | null {
  // `sep`, not "/": `canonical` returns `relative()` output, which is
  // backslash-separated on Windows.
  return list.find((b) => path === b || path.startsWith(b + sep)) ?? null;
}

/** Tolerate a hand-edited file that is valid JSON but the wrong shape. */
function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string");
}

export interface LoadResult {
  manifest: Manifest;
  /** Paths dropped from `swap`, with the reason. Warned once, never fatal. */
  ignored: Array<{ path: string; reason: string }>;
}

/**
 * Read the manifest, creating it with defaults if absent. Invalid entries are
 * dropped with a reason rather than throwing — a typo should degrade, not brick
 * pi.
 */
export function loadManifest(): LoadResult {
  const file = manifestPath();

  if (!existsSync(file)) {
    mkdirSync(profilesDir(), { recursive: true });
    writeFileSync(file, JSON.stringify({ swap: DEFAULT_SWAP, blacklist: [] }, null, 2) + "\n");
  }

  const ignored: LoadResult["ignored"] = [];

  let raw: Partial<Manifest> = {};
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Manifest>;
  } catch (err) {
    // Fall back to defaults rather than throwing: this runs inside event
    // handlers where an exception is swallowed, silently disabling the
    // profile-safety checks with no visible cause.
    ignored.push({ path: file, reason: `not valid JSON (${(err as Error).message}) — using defaults` });
    raw = {};
  }

  const rawSwap = stringArray(raw.swap);
  if (raw.swap !== undefined && rawSwap === null) {
    ignored.push({ path: "swap", reason: "not a list — using defaults" });
  } else if (rawSwap && Array.isArray(raw.swap) && rawSwap.length < raw.swap.length) {
    ignored.push({ path: "swap", reason: `${raw.swap.length - rawSwap.length} non-string entries dropped` });
  }

  const rawBlacklist = stringArray(raw.blacklist);
  if (raw.blacklist !== undefined && rawBlacklist === null) {
    ignored.push({ path: "blacklist", reason: "not a list — ignored" });
  }

  const userBlacklist: string[] = [];
  for (const entry of rawBlacklist ?? []) {
    const path = canonical(entry);
    // A dropped blacklist entry is a weakened guard, so say so rather than
    // discarding it quietly.
    if (path === null) ignored.push({ path: entry, reason: "blacklist entry is not inside the agent dir" });
    else userBlacklist.push(path);
  }

  const swap: string[] = [];

  for (const entry of rawSwap ?? DEFAULT_SWAP) {
    const path = canonical(entry);

    if (path === null) {
      ignored.push({ path: entry, reason: "not inside the agent dir" });
      continue;
    }

    const builtin = blacklistedAs(path, Object.keys(BUILTIN_BLACKLIST));
    if (builtin) {
      ignored.push({ path: entry, reason: `blacklisted (${BUILTIN_BLACKLIST[builtin]})` });
      continue;
    }
    if (blacklistedAs(path, userBlacklist)) {
      ignored.push({ path: entry, reason: "blacklisted" });
      continue;
    }
    if (!swap.includes(path)) swap.push(path);
  }

  return { manifest: { swap, blacklist: userBlacklist }, ignored };
}
