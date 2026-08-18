import type {
  ExtensionAPI, ExtensionCommandContext, ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";

import { loadManifest, type Manifest } from "./manifest.js";
import {
  activeProfile, applyProfile, clearActiveProfile, createProfile, deleteProfile,
  ensureProfileDirectories, findMigrations, listProfiles, materializeProfile, migrate,
  profileDir, setActiveProfile,
} from "./swap.js";
import {
  claim, claimExclusive, holder, register, release, releaseExclusive,
} from "./lock.js";

const DEFAULT_PROFILE = "code";
const ENTRY_TYPE = "profiles";
const CREATE_ACTION = "＋ Create new profile";
const DELETE_ACTION = "− Delete profile";
const HELP_ACTION = "? Commands and help";
const DISABLE_ACTION = "⚠ Disable profiles";

function showHelp(ctx: ExtensionContext): void {
  ctx.ui.notify(
    [
      "profiles commands:",
      "/profile — choose a profile or action",
      "/profile <name> — switch directly",
      "/profile new <name> — create an empty profile",
      "/profile new <name> --from <profile> — clone a profile",
      "/profile delete <name> — permanently delete an inactive profile",
      "/profile disable — restore real config paths and disable profiles",
    ].join("\n"),
    "info",
  );
}

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

  ensureProfileDirectories(manifest, target);
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

      let [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      let active = activeProfile();
      const current = active ?? DEFAULT_PROFILE;

      if (verb === "help" || verb === "--help" || verb === "-h") {
        showHelp(ctx);
        return;
      }

      // First run: adopt whatever is already in the agent dir as the default.
      if (!verb && listProfiles().length === 0) {
        createProfile(current);
        setActiveProfile(current);
        active = current;
      }

      if (!verb) {
        if (!ctx.hasUI) {
          showHelp(ctx);
          ctx.ui.notify(`profiles: ${listProfiles().join(", ")} (active: ${current})`, "info");
          return;
        }

        const profileOptions = listProfiles().map((p) => (p === current ? `${p}  (active)` : p));
        const actions = [CREATE_ACTION, HELP_ACTION];
        if (active) actions.push(DISABLE_ACTION);
        actions.push(DELETE_ACTION);
        const picked = await ctx.ui.select("Switch profile", [...profileOptions, ...actions]);
        if (!picked) return;

        if (picked === HELP_ACTION) {
          showHelp(ctx);
          return;
        }
        if (picked === DISABLE_ACTION) {
          verb = "disable";
        } else if (picked === CREATE_ACTION) {
          const kind = await ctx.ui.select("Create profile", ["Empty profile", "Clone existing profile"]);
          if (!kind) return;

          let from: string | undefined;
          if (kind === "Clone existing profile") {
            from = await ctx.ui.select("Clone from", listProfiles());
            if (!from) return;
          }

          const name = (await ctx.ui.input("Profile name", "e.g. study"))?.trim();
          if (!name) return;
          verb = "new";
          rest = from ? [name, "--from", from] : [name];
        } else if (picked === DELETE_ACTION) {
          const deletable = listProfiles().filter((name) => name !== active);
          if (deletable.length === 0) {
            ctx.ui.notify("profiles: no inactive profiles to delete", "info");
            return;
          }
          const name = await ctx.ui.select("Delete profile", deletable);
          if (!name) return;
          verb = "delete";
          rest = [name];
        } else {
          verb = picked.split(/\s+/)[0];
        }
      }

      if (verb === "delete") {
        const name = rest[0];
        if (!name) {
          ctx.ui.notify("usage: /profile delete <name>", "error");
          return;
        }
        if (!listProfiles().includes(name)) {
          ctx.ui.notify(`profiles: no profile "${name}"`, "error");
          return;
        }
        if (name === active) {
          ctx.ui.notify(
            `profiles: "${name}" is active — switch to another profile before deleting it`,
            "error",
          );
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("profiles: deleting a profile requires interactive confirmation", "error");
          return;
        }

        const conflict = holder(name);
        if (conflict) {
          ctx.ui.notify(
            `profiles: pi (pid ${conflict.pid}) is using profile "${name}" — close it first`,
            "error",
          );
          return;
        }

        const confirmation = await ctx.ui.input(
          `Permanently delete profile "${name}"?`,
          `Type "${name}" to confirm`,
        );
        if (confirmation !== name) {
          ctx.ui.notify("profiles: deletion cancelled", "info");
          return;
        }

        const raced = holder(name);
        if (raced) {
          ctx.ui.notify(
            `profiles: pi (pid ${raced.pid}) is using profile "${name}" — close it first`,
            "error",
          );
          return;
        }

        try {
          deleteProfile(name);
          ctx.ui.notify(`profiles: deleted "${name}"`, "info");
        } catch (err) {
          ctx.ui.notify(`profiles: ${(err as Error).message}`, "error");
        }
        return;
      }

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
          createProfile(name, from, manifest.directories);
          ctx.ui.notify(`profiles: created "${name}"${from ? ` from "${from}"` : " (empty)"}`, "info");
        } catch (err) {
          ctx.ui.notify(`profiles: ${(err as Error).message}`, "error");
        }
        return;
      }

      // A direct switch is also the first-use path, so preserve the existing
      // configuration as the default profile before moving away from it.
      if (listProfiles().length === 0) {
        createProfile(current);
        setActiveProfile(current);
      }

      const target = verb;
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
