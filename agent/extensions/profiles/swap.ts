import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { activePath, profilesDir, type Manifest } from "./manifest.js";

export const profileDir = (name: string) => join(profilesDir(), name);

/** Reserved because they are files this plugin owns inside the profiles dir. */
const RESERVED = new Set(["manifest.json", "active", "lock"]);

/**
 * Profile names become directory names, so they get the same treatment as
 * manifest paths: no traversal, no collisions with our own files.
 */
export function validName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !RESERVED.has(name);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory(); // follows links, unlike Dirent
  } catch {
    return false;
  }
}

export function listProfiles(): string[] {
  const dir = profilesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !RESERVED.has(e.name))
    // A profile symlinked to a dotfiles repo is a directory too; `Dirent`
    // uses lstat semantics and would report it as neither.
    .filter((e) => (e.isSymbolicLink() ? isDir(join(dir, e.name)) : e.isDirectory()))
    .map((e) => e.name)
    .sort();
}

export function activeProfile(): string | null {
  const file = activePath();
  if (!existsSync(file)) return null;
  const name = readFileSync(file, "utf8").trim();
  // Hand-edited `active` is the last path that reaches the filesystem without
  // validation: it feeds `profileDir()` during migration, so `../../tmp/x` would
  // write outside the profiles dir.
  return validName(name) ? name : null;
}

export function setActiveProfile(name: string): void {
  mkdirSync(profilesDir(), { recursive: true });
  writeFileSync(activePath(), name + "\n");
}

/** `lstat` without throwing on a missing path. */
function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Whether a symlink in the agent dir was put there by us.
 *
 * A link pointing anywhere else is the user's own wiring — a dotfiles setup
 * like `~/.pi/agent/AGENTS.md -> ~/dotfiles/AGENTS.md` is config too, and
 * deleting it because the target profile lacks that path would destroy it with
 * no undo.
 */
function ownedByUs(agentPath: string): boolean {
  try {
    const target = resolve(agentPath, "..", readlinkSync(agentPath));
    const rel = relative(profilesDir(), target);
    return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Whether this path is ours to repoint or remove.
 *
 * Shared by `findMigrations` and `applyProfile` on purpose: the two must agree
 * exactly, or a switch adopts one set of paths while refusing another and
 * half-applies while reporting success.
 */
function ours(agentPath: string, st: ReturnType<typeof lstatOrNull>): boolean {
  return st !== null && st.isSymbolicLink() && ownedByUs(agentPath);
}

export interface MigrationNeed {
  path: string;
  /** Real file/dir sitting where a symlink belongs. */
  agentPath: string;
  target: string;
  /** True when the profile already holds this path, so copying would clobber. */
  conflict: boolean;
}

/**
 * Per-path, on demand. Not a once-ever step: installing a new plugin drops a new
 * real config file into the agent dir, and adding one manifest line is meant to
 * be the whole install procedure.
 */
export function findMigrations(manifest: Manifest, profile: string): MigrationNeed[] {
  const agentDir = getAgentDir();
  const needs: MigrationNeed[] = [];

  for (const path of manifest.swap) {
    const agentPath = join(agentDir, path);
    const st = lstatOrNull(agentPath);
    if (!st) continue; // absent: nothing to adopt
    if (ours(agentPath, st)) continue; // already ours

    // A real file, or the user's own symlink: both get adopted so the wiring
    // survives the swap. `cpSync` keeps a link as a link.
    const target = join(profileDir(profile), path);
    needs.push({ path, agentPath, target, conflict: existsSync(target) });
  }
  return needs;
}

/** Copy the real file into the profile, then let `applyProfile` symlink it back. */
export function migrate(need: MigrationNeed): void {
  mkdirSync(join(need.target, ".."), { recursive: true });
  cpSync(need.agentPath, need.target, { recursive: true });
  rmSync(need.agentPath, { recursive: true, force: true });
}

export interface SwapResult {
  linked: string[];
  cleared: string[];
  /** Real files blocking a swap — migration should have handled these. */
  blocked: string[];
}

/**
 * Point the agent dir at `profile`.
 *
 * `symlink` to a temp name + `rename` is atomic on Linux, so a crash leaves
 * either the old profile or the new one, never a hole. A path the target profile
 * lacks is *removed*, not stubbed: absent is the state every plugin already
 * handles, because it is the fresh-install state.
 */
export function applyProfile(manifest: Manifest, profile: string): SwapResult {
  const agentDir = getAgentDir();
  const result: SwapResult = { linked: [], cleared: [], blocked: [] };

  for (const path of manifest.swap) {
    const agentPath = join(agentDir, path);
    const target = join(profileDir(profile), path);
    const st = lstatOrNull(agentPath);

    // Only ever remove or overwrite links we created. Anything else — a real
    // file, or the user's own symlink — is reported, not touched.
    if (st && !ours(agentPath, st)) {
      result.blocked.push(path);
      continue;
    }

    if (!existsSync(target)) {
      if (st) {
        rmSync(agentPath, { force: true });
        result.cleared.push(path);
      }
      continue;
    }

    if (st && resolve(agentPath, "..", readlinkSync(agentPath)) === resolve(target)) {
      continue; // already correct
    }

    // Relative link text, because both ends live inside the agent dir and that
    // dir may be a tracked dotfiles repo: git stores the target verbatim, so an
    // absolute `/home/<user>/.pi/agent/...` would land broken on any other
    // machine. `readlinkSync` consumers below already resolve against the link's
    // own directory, so relative and absolute behave identically at runtime.
    const link = relative(dirname(agentPath), target);
    const tmp = `${agentPath}.profiles-tmp-${process.pid}`;
    rmSync(tmp, { force: true });
    symlinkSync(link, tmp);
    renameSync(tmp, agentPath);
    result.linked.push(path);
  }

  return result;
}

export function createProfile(name: string, from?: string): void {
  if (!validName(name)) throw new Error(`invalid profile name "${name}"`);
  const dir = profileDir(name);
  if (existsSync(dir)) throw new Error(`profile "${name}" already exists`);

  if (from) {
    // The source needs the same guard as the name, and then some: `--from
    // ../agent` would copy the whole config tree, credentials included, into a
    // profile. "An existing profile" is the contract, so require exactly that.
    if (!validName(from) || !listProfiles().includes(from)) {
      throw new Error(`no profile "${from}" to copy from`);
    }
    cpSync(profileDir(from), dir, { recursive: true, dereference: true });
    return;
  }

  // Empty means the files are *absent*, not `{}` or `[]`.
  mkdirSync(dir, { recursive: true });
}
