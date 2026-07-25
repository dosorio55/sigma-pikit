# sigma — how to work in this repo

## Language

Everything in English: README, docs, code comments, commit messages.

## Design principle: lightness

The whole point of pi and of these plugins is being **light**. I came from
opencode and Claude Code, which weigh considerably more — mainly in RAM, and also
in CPU. Size on disk is not a concern; idle resource consumption is.

This is not an aesthetic preference: it is the constraint that orders design
decisions. A plugin that works correctly but leaves processes, timers or watchers
running when I am not using it is a plugin that fails at the thing that matters.

### Practical rules

- **Lazy by default.** Do not load, connect or spawn anything until it is
  actually used. Cache metadata so that anything which only needs to *know a
  thing exists* works without a live connection.
- **Nothing persistent without justifying it.** Child processes, `fs.watch`,
  `setInterval`, local servers and global listeners all cost something at idle.
  If a plugin needs one, say so explicitly and give it a way to shut down.
- **Bounded per-turn cost.** Handlers for `before_agent_start`, `context` or
  `message_update` run very often. No repeated disk I/O and no filesystem walks
  in there.
- **Only what is active.** Load the config and resources of the profile or mode
  in use, not all of them "just in case" so switching feels instant.

### Idle-cost declaration

Every new extension declares, in its README section, what it leaves running at
idle: processes, timers, watchers, listeners, connections. If the answer is
"nothing", say that too.

### Required heads-up

If an idea we are discussing or implementing compromises this principle — a
resident process, polling, eager loading, a heavy dependency tree — **warn me
before writing the code**, even if I did not ask. Be concrete about the cost
(what stays alive, and when) and propose the lazy alternative. Do not treat it as
an automatic veto: sometimes I will accept it. But it should be my decision and
not a side effect.

Watch for **indirect** cost too: a plugin that is cheap in itself but makes it
easy to accumulate expensive things (more MCP servers, more resident subagents)
breaks the goal just the same. Flag that case as well.

## Discuss before building

Follow the conversation. Questions get thought through, not implemented. Build
when I ask for it.

## Structure

`package.json` declares `"pi": { "extensions": ["./agent/extensions/*/index.ts"] }`.
Each extension lives in its own folder with an `index.ts` exporting the default
function. They are installable separately on purpose: I want to be able to take
only what I use.

## Checks

```bash
npm run check   # tsc --noEmit
```

Run a single extension without installing it:

```bash
pi -ne -e ./agent/extensions/<name>/index.ts
```
