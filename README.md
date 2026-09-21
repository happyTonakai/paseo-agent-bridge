# agent-bridge — paseo Agent Bridge

A small Node CLI that drives AI coding agents on **this machine or another
machine** through Paseo, so one agent can command another.

```
agent on machine A --(relay E2EE / direct)--> daemon on machine B --> agent on B runs the task
```

It depends only on `@getpaseo/client` and `@getpaseo/protocol` from the public npm
registry. It is **not** a Paseo plugin and does not need Paseo's source.

## Why

You have a coding agent on machine A that cannot do something (say, Docker),
but a daemon on machine B can. This bridge lets A's agent create or reuse an
agent on B, send it a task, wait for the turn, and get the **final** reply back
as JSON. Multi-turn conversations reuse the same remote agent/session.

## Install

Requires **Node.js 22+** (the Paseo SDK needs a global `WebSocket`). Install
globally so `agent-bridge` works from any directory:

```bash
# install straight from the GitHub repo (gives you the `agent-bridge` command)
npm install -g https://github.com/happyTonakai/paseo-agent-bridge
agent-bridge --help
```

Config lives at `~/.paseo/agent-bridge.json` (the default location, read from
any directory). Create it from the template and fill in your targets:

```bash
mkdir -p ~/.paseo
cp config.example.json ~/.paseo/agent-bridge.json
# edit ~/.paseo/agent-bridge.json with your relay + target details
```

`agent-bridge` always reads `~/.paseo/agent-bridge.json`; pass `--config <path>`
to point it at a different file.

## Config: targets (~/.paseo/agent-bridge.json)

The config lists machines as named **targets**. Each target is either:

- a **remote** machine reached through your relay: `serverId` + `publicKeyB64`
  (+ `cwd`, `provider`, `model`);
- a **local** machine reached directly: a `url`.

```jsonc
{
  "relay": { "endpoint": "proxy-10063...:80", "useTls": false },
  "defaultTarget": "remote",
  "timeoutMs": 600000,
  "targets": {
    "remote": {
      "serverId": "srv_XXXX",
      "publicKeyB64": "REPLACE-WITH-REMOTE-DAEMON-PUBLIC-KEY",
      "cwd": "/home/user/Docker",
      "provider": "pi",
      "model": "sglang/deepseek-ai/DeepSeek-V4-Flash-0731"
    },
    "local": {
      "url": "ws://127.0.0.1:6767/ws",
      "cwd": "/Users/me/projects",
      "provider": "pi",
      "model": ""
    }
  }
}
```

- **Multi-turn is the default**: a created agent is kept and its `agentId` is
  returned so you can keep talking to it. Only `--archive` cleans it up.
- If `model` is empty, the tool asks that daemon for the provider's default
  model. If `provider` is empty, it auto-detects the first available.
- Pick a target with `--target <alias>` (default: `defaultTarget` or the first).

### Find a target's details

- `serverId` and `publicKeyB64`: read them on that machine from
  `~/.paseo/server-id` and `~/.paseo/daemon-keypair.json` (`publicKeyB64`).
- Relay address: `~/.paseo/config.json` → `daemon.relay.endpoint`.

### ⚠️ Direct local URL needs `/ws`

A direct daemon endpoint must include the `/ws` path, e.g.
`ws://127.0.0.1:6767/ws`. Connecting to the bare host root is closed by the
daemon. (Relay URLs already carry `/ws` themselves.)

## Usage

```bash
# Single turn on the default target
agent-bridge "docker ps"

# Choose a target-by-alias / override cwd or model
agent-bridge --target remote --cwd /home/user/Docker "docker ps"
agent-bridge --target remote --model <other-model> "task"

# Continuous conversation — first call creates & keeps the agent
agent-bridge --target remote "remember: ship the fix"
#   → returns agentId; reuse it on later turns
agent-bridge --target remote --agent <agentId> "describe the diff"

# Talk to an EXISTING agent on that machine (discover it first)
agent-bridge --target remote --list-agents
agent-bridge --target remote --agent <existingId> "continue"

# Clean up a session when done
agent-bridge --target remote --agent <agentId> --archive "wrap up"

# Debug: include the full trace (default prints only the final reply)
agent-bridge --verbose "task"

# Use a different config file
agent-bridge --config ./other.json "task"
```

## Output

`stdout` gets one JSON object:

```json
{
  "ok": true,
  "target": "remote",
  "agentId": "710abd37-...",
  "cwd": "/home/user/Docker",
  "provider": "pi",
  "model": "sglang/deepseek-ai/DeepSeek-V4-Flash-0731",
  "status": "idle",
  "agentStatus": "idle",
  "reused": false,
  "pendingPermissions": 0,
  "error": null,
  "reply": "Docker version 28.1.1, build 4eba377"
}
```

- `reply` is the **final assistant message** of the turn (like a notification);
  intermediate `reasoning`/tool calls are not included unless `--verbose`.
- `status` is the wait outcome: `idle` (success), `error`, `permission`, or
  `timeout`. `agentStatus` is the agent lifecycle status.
- `ok` is true only when `status === "idle"` and there is no error. A turn that
  is paused waiting for `permission` or times out exits `1` (the agent stays
  alive and can be continued later with `--agent`).
- `agentId` is what you pass to `--agent` on later turns.
- Exit code `0` success, `1` failure/timeout, `2` bad usage.

## Security

- The config file (which you create at `~/.paseo/agent-bridge.json`) holds relay
  pairing credentials (`serverId`, `publicKeyB64`). Keep it private and never
  commit it. Only `config.example.json` (generic placeholders) is safe to share.
- Anything the calling agent asks is executed on the target machine with the
  daemon user's permissions. Restrict what you send, and keep the config with
  the credentials private.
- On targets where the daemon asks for tool permission, the turn pauses until a
  decision is made; these agents are unattended, so pre-approve as needed.

## Talk to an existing agent on another machine

You do not need the agent to know its own id. The daemon lists all agents:

```bash
agent-bridge --target remote --list-agents   # shows agentId + status + title
```

Then continue one of them with `--agent <id>`. If the agent is currently
`running`, the bridge waits for it to become idle (a coding agent serializes
turns) before sending, so your message queues behind the active turn. If it
stays busy past `--timeout-ms`, the call fails with a clear error.