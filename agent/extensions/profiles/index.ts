import type {
  ExtensionAPI, ExtensionCommandContext, ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";

import { loadManifest, type Manifest } from "./manifest.js";
import {
  activeProfile, applyProfile, clearActiveProfile, createProfile, findMigrations,
  listProfiles, materializeProfile, migrate, profileDir, setActiveProfile,
} from "./swap.js";
import {
  claim, claimExclusive, register, release, releaseExclusive,
} from "./lock.js";

const DEFAULT_PROFILE = "code";
const ENTRY_TYPE = "profiles";

/**
 * Manifest problems are worth saying out loud, once, when they matter. Entries
 * name a swap path, a blacklist path, a bare key or the manifest file itself, so
 * the message stays neutral about which.
 */
function warnIgnored(ctx: ExtensionContext, ignored: Array<{ path: string; reason: string }>): void {
  for (const { path, reason } of ignored) {
    ctx.ui.notify(`profiles: "${path}" — ${reason}`, "warning");
  }
}

/**
 * Move real config files into the active profile before swapping away from it,
 * so nothing is stranded. Never clobbers: a path the profile already holds needs
 * a human decision.
 */
async function runMigrations(ctx: ExtensionContext, manifest: Manifest, from: string): Promise<boolean> {
  const needs = findMigrations(manifest, from);
  if (needs.length === 0) return true;

  const conflicts = needs.filter((n) => n.conflict);
  if (conflicts.length > 0) {
    const list = conflicts.map((c) => c.path).join(", ");
    ctx.ui.notify(
      `profiles: ${list} exists both in ~/.pi/agent and in profile "${from}". ` +
        `Remove one by hand — refusing to guess.`,
      "error",
    );
    return false;
  }

  const list = needs.map((n) => n.path).join(", ");
  const ok = await ctx.ui.confirm(
    `Adopt into profile "${from}"?`,
    `${list}\n\nThese move into ${profileDir(from)}/ and are symlinked back.`,
  );
  if (!ok) return false;

  for (const need of needs) migrate(need);
  return true;
}

/** The profile stamped on the *live* session, if any. Last one wins. */
function sessionStamp(ctx: ExtensionContext): string | null {
  let found: string | null = null;
  for (const e of ctx.sessionManager.getEntries() as Array<{
    type?: string; customType?: string; data?: { profile?: string };
  }>) {
    if (e.type === "custom" && e.customType === ENTRY_TYPE && e.data?.profile) {
      found = e.data.profile;
    }
  }
  return found;
}

/** Read the profile a session was created under, if it carries the stamp. */
function stampedProfile(sessionFile: string): string | null {
  if (!existsSync(sessionFile)) return null;
  let found: string | null = null;
  try {
    for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
      if (!line.includes(`"${ENTRY_TYPE}"`)) continue;
      const entry = JSON.parse(line) as { type?: string; customType?: string; data?: { profile?: string } };
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data?.profile) {
        found = entry.data.profile; // keep the last: the most recent truth
      }
    }
  } catch {
    // A session we cannot parse simply has no stamp.
  }
  return found;
}

/**
 * Repoint the symlinks. Shared by the `/profile` command and by resuming a
 * session that belongs to another profile.
 */
async function switchTo(
  ctx: ExtensionContext,
  manifest: Manifest,
  target: string,
): Promise<{ changed: number } | null> {
  if (!listProfiles().includes(target)) {
    ctx.ui.notify(`profiles: no profile "${target}"`, "error");
    return null;
  }

  // `active` is written last, so a crash mid-swap leaves it pointing at the old
  // profile while some links point at the new one. Reconciling is just
  // re-applying, which is idempotent — so never short-circuit on `active` alone.

  const conflict = claim(target);
  if (conflict) {
    ctx.ui.notify(
      `profiles: pi (pid ${conflict.pid}) is using profile "${conflict.profile}" — ` +
        `close it or switch it first`,
      "error",
    );
    return null;
  }

  const current = activeProfile() ?? DEFAULT_PROFILE;
  if (!(await runMigrations(ctx, manifest, current))) {
    register(current); // we never left; do not leave a claim we did not honour
    return null;
  }

  const result = applyProfile(manifest, target);
  if (result.blocked.length > 0) {
    ctx.ui.notify(
      `profiles: ${result.blocked.join(", ")} is a real file in ~/.pi/agent — not swapped`,
      "warning",
    );
  }

  setActiveProfile(target);
  return { changed: result.linked.length + result.cleared.length };
}

export default function profiles(pi: ExtensionAPI) {
  pi.registerCommand("profile", {
    description: "Switch pi configuration profiles",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const { manifest, ignored } = loadManifest();
      warnIgnored(ctx, ignored);

      const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const active = activeProfile();
      const current = active ?? DEFAULT_PROFILE;

      if (verb === "disable") {
        if (!active) {
          ctx.ui.notify("profiles: already disabled", "info");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("profiles: /profile disable requires interactive confirmation", "error");
          return;
        }

        await ctx.waitForIdle();

        const ok = await ctx.ui.confirm(
          `Disable profiles and materialize "${active}"?`,
          `Managed paths become real files in ~/.pi/agent.\n\n` +
            `Profiles are retained at ${profileDir(active)}/ as backups.`,
        );
        if (!ok) return;

        const conflict = claimExclusive(active);
        if (conflict) {
          ctx.ui.notify(
            `profiles: pi (pid ${conflict.pid}) is still open on profile "${conflict.profile}" — ` +
              `close it before disabling`,
            "error",
          );
          return;
        }

        let materialized: number;
        try {
          const result = materializeProfile(manifest, active);
          materialized = result.materialized.length;
          release();
          clearActiveProfile(); // profile state changes only after every path lands
        } catch (err) {
          releaseExclusive();
          register(active);
          ctx.ui.notify(`profiles: disable failed — ${(err as Error).message}`, "error");
          return;
        }

        releaseExclusive();
        ctx.ui.notify(
          `profiles: disabled — ${materialized} path(s) materialized; profile directories retained`,
          "info",
        );
        await ctx.reload();
        return;
      }

      if (verb === "new") {
        const name = rest[0];
        if (!name) {
          ctx.ui.notify("usage: /profile new <name> [--from <profile>]", "error");
          return;
        }
        const fromIndex = rest.indexOf("--from");
        const from = fromIndex >= 0 ? rest[fromIndex + 1] : undefined;
        try {
          createProfile(name, from);
          ctx.ui.notify(`profiles: created "${name}"${from ? ` from "${from}"` : " (empty)"}`, "info");
        } catch (err) {
          ctx.ui.notify(`profiles: ${(err as Error).message}`, "error");
        }
        return;
      }

      // First run: adopt whatever is already in the agent dir as the default.
      if (listProfiles().length === 0) {
        createProfile(current);
        setActiveProfile(current);
      }

      let target = verb;
      if (!target) {
        if (!ctx.hasUI) {
          ctx.ui.notify(`profiles: ${listProfiles().join(", ")} (active: ${current})`, "info");
          return;
        }
        const options = listProfiles().map((p) => (p === current ? `${p}  (active)` : p));
        const picked = await ctx.ui.select("Switch profile", options);
        if (!picked) return;
        target = picked.split(/\s+/)[0];
      }

      const alreadyActive = target === current;
      const outcome = await switchTo(ctx, manifest, target);
      if (!outcome) return;
      const reconciled = outcome.changed;

      if (alreadyActive) {
        // Reconciling can repoint links (a newly added manifest entry, or
        // recovery from a half-applied switch). If it did, the running session
        // is holding config it has not read.
        if (reconciled > 0) {
          ctx.ui.notify(`profiles: "${target}" reconciled — /reload to pick it up`, "warning");
        } else {
          ctx.ui.notify(`profiles: already on "${target}"`, "info");
        }
        return;
      }

      // A new session is mandatory: the old transcript references tools the new
      // profile may not register. newSession() also reloads and rebinds
      // extensions, so no separate ctx.reload() is needed. The stamp is written
      // by the session_start handler below, which fires for the new session.
      const { cancelled } = await ctx.newSession();
      if (cancelled) {
        // Another extension vetoed the new session. Leaving the config swapped
        // under the old transcript is the one state this design forbids, so roll
        // back — and say so plainly if the rollback itself cannot land.
        if (await switchTo(ctx, manifest, current)) {
          ctx.ui.notify(`profiles: session change cancelled — stayed on "${current}"`, "warning");
        } else {
          ctx.ui.notify(
            `profiles: session change cancelled but config is on "${target}" — ` +
              `run /profile ${current} or /reload`,
            "error",
          );
        }
      }
    },
  });

  pi.on("session_start", (_event: { reason?: string }, ctx: ExtensionContext) => {
    const current = activeProfile();
    if (!current) return; // plugin unused, nothing to do

    // Claim a slot even when this instance never switches, so a second pi
    // cannot silently swap config out from under it.
    const conflict = register(current);
    if (conflict) {
      ctx.ui.notify(
        `profiles: pi (pid ${conflict.pid}) is disabling profiles — closing this instance`,
        "error",
      );
      ctx.shutdown();
      return;
    }

    // The session's own stamp is the only state that survives here: pi calls the
    // extension factory afresh on every runtime construction, so module and
    // closure variables reset on reload, /new, /resume and /fork alike.
    const stamp = sessionStamp(ctx);

    if (stamp === null) {
      pi.appendEntry(ENTRY_TYPE, { profile: current });
      return;
    }

    // A stamp that disagrees with the active profile means this transcript was
    // written under a different config — either another instance switched, or
    // `pi -c` / `pi --resume` reopened it, neither of which emits
    // session_before_switch. Warn only: swapping config mid-startup is worse.
    if (stamp !== current) {
      // Only suggest switching to a profile that still exists — the resume path
      // already warns when it does not, and telling the user to switch to a
      // deleted profile is worse than saying nothing.
      const hint = listProfiles().includes(stamp) ? ` /profile ${stamp} to switch.` : "";
      ctx.ui.notify(
        `profiles: this session belongs to "${stamp}" but "${current}" is active — ` +
          `tools may not match.${hint}`,
        "warning",
      );
    }
  });

  pi.on("session_shutdown", (event: { reason?: string }) => {
    if (event.reason === "quit") release();
  });

  pi.on("session_before_switch", async (
    event: { reason?: string; targetSessionFile?: string },
    ctx: ExtensionContext,
  ) => {
    if (event.reason !== "resume" || !event.targetSessionFile) return;

    const current = activeProfile();
    const wanted = stampedProfile(event.targetSessionFile);
    if (!current || !wanted || wanted === current) return;

    // A stamped profile that no longer exists must not make the session
    // permanently unopenable — warn and let it through under the current one.
    if (!listProfiles().includes(wanted)) {
      ctx.ui.notify(
        `profiles: this session belongs to "${wanted}", which no longer exists — ` +
          `opening it under "${current}"`,
        "warning",
      );
      return;
    }

    const { manifest } = loadManifest();
    if (!(await switchTo(ctx, manifest, wanted))) return { cancel: true };

    ctx.ui.notify(`profiles: switched to "${wanted}" for this session`, "info");
  });
}
