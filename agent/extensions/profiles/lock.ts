import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { disableLockPath, lockPath, profilesDir } from "./manifest.js";

type Lock = Record<string, string>;

export interface Conflict {
  pid: number;
  profile: string;
}

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

function exclusive(): Conflict | null {
  const file = disableLockPath();
  if (!existsSync(file)) return null;

  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<Conflict>;
    if (typeof value.pid === "number" && typeof value.profile === "string" && alive(value.pid)) {
      return { pid: value.pid, profile: value.profile };
    }
  } catch {
    // Corrupt or interrupted acquisition is stale, not a permanent veto.
  }

  rmSync(file, { force: true });
  return null;
}

function dropOwnEntry(): void {
  const lock = read();
  if (!(String(process.pid) in lock)) return;
  delete lock[String(process.pid)];
  write(lock);
}

/**
 * Refuse if another live pi holds a different profile.
 *
 * This does not coordinate anything — you cannot reach into another running pi
 * and change its profile. It turns a silent config yank into a clear error.
 */
export function claim(profile: string): Conflict | null {
  const heldExclusive = exclusive();
  if (heldExclusive && heldExclusive.pid !== process.pid) return heldExclusive;

  const lock = read();
  for (const [pid, held] of Object.entries(lock)) {
    if (Number(pid) !== process.pid && held !== profile) {
      return { pid: Number(pid), profile: held };
    }
  }

  lock[String(process.pid)] = profile;
  write(lock);

  const racedExclusive = exclusive();
  if (racedExclusive && racedExclusive.pid !== process.pid) {
    dropOwnEntry();
    return racedExclusive;
  }
  return null;
}

/** Disabling changes the shared layout, so no other pi instance may remain. */
export function claimExclusive(profile: string): Conflict | null {
  mkdirSync(profilesDir(), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    const held = exclusive();
    if (held) {
      if (held.pid === process.pid) break;
      return held;
    }

    try {
      writeFileSync(
        disableLockPath(),
        JSON.stringify({ pid: process.pid, profile }, null, 2) + "\n",
        { flag: "wx" },
      );
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 1) throw err;
    }
  }

  const lock = read();
  for (const [pid, held] of Object.entries(lock)) {
    if (Number(pid) !== process.pid) {
      releaseExclusive();
      return { pid: Number(pid), profile: held };
    }
  }

  lock[String(process.pid)] = profile;
  write(lock);
  return null;
}

/**
 * Record which profile this instance is running, unless disable owns the layout.
 */
export function register(profile: string): Conflict | null {
  const heldExclusive = exclusive();
  if (heldExclusive && heldExclusive.pid !== process.pid) return heldExclusive;

  const lock = read();
  if (lock[String(process.pid)] !== profile) {
    lock[String(process.pid)] = profile;
    write(lock);
  }

  const racedExclusive = exclusive();
  if (racedExclusive && racedExclusive.pid !== process.pid) {
    dropOwnEntry();
    return racedExclusive;
  }
  return null;
}

/** Drop our entry so a recycled pid cannot inherit a phantom conflict. */
export function release(): void {
  dropOwnEntry();
}

export function releaseExclusive(): void {
  const held = exclusive();
  if (held?.pid === process.pid) rmSync(disableLockPath(), { force: true });
}
