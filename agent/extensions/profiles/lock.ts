import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { lockPath, profilesDir } from "./manifest.js";

type Lock = Record<string, string>;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0); // existence check, no signal delivered
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read the lock, dropping entries whose process is gone. */
function read(): Lock {
  const file = lockPath();
  if (!existsSync(file)) return {};

  let raw: Lock = {};
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Lock;
  } catch {
    return {}; // a corrupt lock must never block a switch
  }

  const live: Lock = {};
  for (const [pid, profile] of Object.entries(raw)) {
    if (alive(Number(pid))) live[pid] = profile;
  }
  return live;
}

function write(lock: Lock): void {
  mkdirSync(profilesDir(), { recursive: true });
  writeFileSync(lockPath(), JSON.stringify(lock, null, 2) + "\n");
}

export interface Conflict {
  pid: number;
  profile: string;
}

/**
 * Refuse if another live pi holds a different profile.
 *
 * This does not coordinate anything — you cannot reach into another running pi
 * and change its profile. It turns a silent config yank into a clear error.
 */
export function claim(profile: string): Conflict | null {
  const lock = read();

  for (const [pid, held] of Object.entries(lock)) {
    if (Number(pid) !== process.pid && held !== profile) {
      return { pid: Number(pid), profile: held };
    }
  }

  lock[String(process.pid)] = profile;
  write(lock);
  return null;
}

/**
 * Record which profile this instance is running, without refusing.
 *
 * Called at session start: an instance that never runs `/profile` still needs an
 * entry, otherwise a second pi sees an empty lock and happily swaps config out
 * from under it — the exact failure the lock exists to prevent.
 */
export function register(profile: string): void {
  const lock = read();
  if (lock[String(process.pid)] === profile) return;
  lock[String(process.pid)] = profile;
  write(lock);
}

/** Drop our entry so a recycled pid cannot inherit a phantom conflict. */
export function release(): void {
  const lock = read();
  if (!(String(process.pid) in lock)) return;
  delete lock[String(process.pid)];
  write(lock);
}
