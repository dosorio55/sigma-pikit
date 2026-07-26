import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** `~/.pi/profiles` — deliberately outside the agent dir, so nothing here is ever swapped. */
export function profilesDir(): string {
  return join(dirname(getAgentDir()), "profiles");
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
 */
const BUILTIN_BLACKLIST: Record<string, string> = {
  "auth.json": "credentials",
  "git": "credentials",
  "npm": "re-downloading packages per profile is heavy",
  "sessions": "shared across profiles on purpose",
  "settings.json": "global preference, not per-profile",
  "models-store.json": "global provider catalogue",
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
