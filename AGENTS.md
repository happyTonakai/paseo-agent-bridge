# AGENTS.md — for coding agents using agent-bridge

This project is a bridge that lets **you** (an agent) run work on ANOTHER
machine's agent, or on this machine's own agent, and get the final result back
as JSON. Put this file somewhere the agent can read (its working directory or
system prompt), and tell it: *when you need to run something you cannot do
locally (e.g. Docker), use the agent-bridge CLI below.*

## The command

```bash
agent-bridge [flags] "<task>"
```

(`agent-bridge` is installed globally; if you run it from source use
`node <repo>/bin/agent-bridge.mjs` instead.)

It prints one JSON object to stdout. Read the `reply` field — that is the
remote agent's final answer. `ok:true` means the turn finished cleanly.

## When to use it

Use it for work that must happen on a specific machine or that you have no
permission/ability to do here (Docker, a particular host, an existing session
on another machine).

## Normal flow

1. **Pick a machine** with `--target <alias>` (default target is used if omitted):
   ```bash
   agent-bridge --target remote "<task>"   # remote machine (via relay)
   agent-bridge --target local "<task>"    # this machine's own daemon
   ```
2. **One-shot** is fine. **Multi-turn**: the first call returns an `agentId`.
   Keep it and pass `--agent <agentId>` on later calls to continue the same
   session (it keeps context).
3. **Talk to an existing agent** you did not create: list them, pick one, continue it:
   ```bash
   agent-bridge --target remote --list-agents
   agent-bridge --target remote --agent <existingId> "<task>"
   ```
   Prefer agents whose status is `idle`; do not message one that is `running`.

## Recommended flags

- `--cwd <dir>` — working directory on the target (overrides config default).
- `--archive` — archive the agent when this call finishes (cleanup).
- `--verbose` — include the full trace; omit it to get only the final `reply`.
- No `model`/`provider` needed if the config target already sets them.

## Output contract

Parse stdout as JSON. Key fields:

- `reply` — the final assistant message. This is what you act on.
- `agentId` — the session handle; pass it back via `--agent` to continue.
- `status` — `idle` on success; `error` means the turn failed.
- `pendingPermissions` — >0 means the turn needed a permission decision.
- `target` — which machine ran it.

Exit code `0` = success, `1` = failure/timeout, `2` = bad usage.

## Rules for the agent

- Always send **one complete, self-contained task** per call. The remote agent
  has no memory of your prior conversation unless you reuse the same `agentId`.
- Do not commit your config (the file at `~/.paseo/agent-bridge.json`) — it holds relay credentials.
- Treat the remote machine as fully trusted but limited to what you ask; never
  ask it to run something the user has not authorized.