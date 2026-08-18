import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  activePath, builtinBlacklistReason, profilesDir, type Manifest,
} from "./manifest.js";

export const profileDir = (name: string) => join(profilesDir(), name);

/** Reserved because they are files this plugin owns inside the profiles dir. */
const RESERVED = new Set(["manifest.json", "active", "lock", "disable-lock"]);
const COMMAND_NAMES = new Set(["new", "delete", "disable"]);

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

export function clearActiveProfile(): void {
  rmSync(activePath(), { force: true });
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

export interface MaterializeResult {
  materialized: string[];
  cleared: string[];
  independent: string[];
}

const DISABLE_BACKUP_SUFFIX = ".profiles-disable-backup";

/**
 * Find links that an older manifest managed too. Without this sweep, removing a
 * manifest entry before disabling could leave a hidden dependency on the store.
 */
function ownedPaths(agentDir: string): string[] {
  const found = new Set<string>();

  function walk(dir: string, prefix: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix ? join(prefix, entry.name) : entry.name;
      if (builtinBlacklistReason(path)) continue;

      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (ownedByUs(full)) {
          found.add(path.endsWith(DISABLE_BACKUP_SUFFIX) ? path.slice(0, -DISABLE_BACKUP_SUFFIX.length) : path);
        }
      } else if (entry.isDirectory()) {
        walk(full, path);
      }
    }
  }

  walk(agentDir, "");
  return [...found];
}

function copyForMaterialization(
  source: string,
  destination: string,
  agentDir: string,
  profileRoot: string,
): string | null {
  const st = lstatSync(source);
  if (!st.isSymbolicLink()) {
    cpSync(source, destination, { recursive: true });
    return null;
  }

  const link = readlinkSync(source);
  const resolved = resolve(dirname(source), link);
  const rel = relative(profileRoot, resolved);
  if (rel === "") throw new Error(`cannot materialize symlink to profile root: ${source}`);
  const insideProfile = rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);

  if (insideProfile && !builtinBlacklistReason(rel)) {
    const restored = relative(dirname(destination), join(agentDir, rel));
    symlinkSync(restored || ".", destination);
    return rel;
  }

  if (insideProfile) {
    cpSync(source, destination, { recursive: true, dereference: true });
    return null;
  }

  const restored = isAbsolute(link) ? link : relative(dirname(destination), resolved);
  symlinkSync(restored || ".", destination);
  return null;
}

/** Replace our links with independent copies of the active profile. */
export function materializeProfile(manifest: Manifest, profile: string): MaterializeResult {
  const agentDir = getAgentDir();
  const result: MaterializeResult = { materialized: [], cleared: [], independent: [] };
  const configured = new Set(manifest.swap);
  const paths = [...new Set([...manifest.swap, ...ownedPaths(agentDir)])];
  const seen = new Set(paths);
  let index = 0;

  while (true) {
    while (index < paths.length) {
      const path = paths[index++];
      const agentPath = join(agentDir, path);
      const backup = `${agentPath}${DISABLE_BACKUP_SUFFIX}`;
      let st = lstatOrNull(agentPath);
      const backupSt = lstatOrNull(backup);

      // Recover the only interruption window: the old link was parked but the
      // independent copy did not land. A fixed name makes this survive the pid.
      if (backupSt) {
        if (!ours(backup, backupSt)) {
          throw new Error(`cannot recover ${path}: ${backup} is not a profiles link`);
        }
        if (!st) {
          renameSync(backup, agentPath);
          st = lstatOrNull(agentPath);
        } else {
          rmSync(backup, { force: true });
        }
      }

      // Real paths and user-owned symlinks do not depend on the profile store.
      if (st && !ours(agentPath, st)) {
        result.independent.push(path);
        continue;
      }

      const target = configured.has(path)
        ? join(profileDir(profile), path)
        : st
          ? resolve(agentPath, "..", readlinkSync(agentPath))
          : join(profileDir(profile), path);

      if (!lstatOrNull(target)) {
        if (st) {
          rmSync(agentPath, { force: true });
          result.cleared.push(path);
        }
        continue;
      }

      mkdirSync(dirname(agentPath), { recursive: true });
      const tmp = `${agentPath}.profiles-materialize-${process.pid}`;
      rmSync(tmp, { recursive: true, force: true });

      try {
        const dependency = copyForMaterialization(target, tmp, agentDir, profileDir(profile));
        if (dependency && !seen.has(dependency)) {
          seen.add(dependency);
          paths.push(dependency);
        }
        if (st) renameSync(agentPath, backup);
        renameSync(tmp, agentPath);
        rmSync(backup, { force: true });
      } catch (err) {
        rmSync(tmp, { recursive: true, force: true });
        if (!lstatOrNull(agentPath) && lstatOrNull(backup)) renameSync(backup, agentPath);
        throw err;
      }

      result.materialized.push(path);
    }

    const nested = ownedPaths(agentDir).filter((path) => !seen.has(path));
    if (nested.length === 0) break;
    for (const path of nested) {
      seen.add(path);
      paths.push(path);
    }
  }

  return result;
}

/**
 * Point the agent dir at `profile`.
 *
 * `symlink` to a temp name + `rename` is atomic on Linux, so a crash leaves
 * either the old profile or the new one, never a hole. A path the target profile
 * lacks is *removed*, not stubbed: absent is the state every plugin already
 * handles, because it is the fresh-install state.
 */
export function ensureProfileDirectories(manifest: Manifest, profile: string): void {
  for (const path of manifest.directories) {
    mkdirSync(join(profileDir(profile), path), { recursive: true });
  }
}

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

export function createProfile(name: string, from?: string, directories: string[] = []): void {
  if (!validName(name) || COMMAND_NAMES.has(name)) throw new Error(`invalid profile name "${name}"`);
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
  } else {
    mkdirSync(dir, { recursive: true });
  }

  for (const path of directories) mkdirSync(join(dir, path), { recursive: true });
}

/** Remove an inactive profile after the command layer has confirmed ownership. */
export function deleteProfile(name: string): void {
  if (!validName(name) || !listProfiles().includes(name)) {
    throw new Error(`no profile "${name}"`);
  }
  rmSync(profileDir(name), { recursive: true, force: true });
}
