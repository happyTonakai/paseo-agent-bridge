> **English** · [中文文档](README.zh-CN.md)

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
  returned so you can keep talking to it. This tool never deletes agents; clean
  up with the native `paseo archive <id>`.
- If `model` is empty, the tool asks that daemon for the provider's default
  model. If `provider` is empty, it auto-detects the first available.
- Every call requires `--target <alias>`; run `--list-targets` to see them.

### Find a target's details (`serverId`, `publicKeyB64`)

These are the **target daemon's** pairing credentials — they belong to the
machine B you want to reach, not to the relay — and they live on that machine:

- `serverId`: the target's daemon id, read from `~/.paseo/server-id` on that
  machine (a `srv_XXXX` string).
- `publicKeyB64`: the target daemon's public key, read from
  `~/.paseo/daemon-keypair.json` on that machine → the `publicKeyB64` field.
- Relay address (`relay.endpoint` / `relay.useTls`): `~/.paseo/config.json` →
  `daemon.relay.endpoint`. `useTls` is `true` when that endpoint starts with
  `wss://`, `false` for `ws://`.

### ⚠️ Direct local URL needs `/ws`

A direct daemon endpoint must include the `/ws` path, e.g.
`ws://127.0.0.1:6767/ws`. Connecting to the bare host root is closed by the
daemon. (Relay URLs already carry `/ws` themselves.)

## Usage

```bash
# One shot — creates a NEW agent on the target, runs one turn, returns its reply
agent-bridge --target remote "docker ps"
agent-bridge --target remote --cwd /home/user/Docker "docker ps"
agent-bridge --target remote --model <other-model> "task"

# Continuous conversation — first call creates & keeps the agent
agent-bridge --target remote "remember: ship the fix"
#   → returns agentId; reuse it on later turns
agent-bridge --target remote --agent <agentId> "describe the diff"

# Talk to an EXISTING agent on that machine (discover it first)
agent-bridge --target remote --list-agents
agent-bridge --target remote --agent <existingId> "continue"

# Debug: include the full trace (default prints only the final reply)
agent-bridge --target remote --verbose "task"

# Use a different config file
agent-bridge --config ./other.json --target remote "task"
```

## Output

`stdout` gets one JSON object (exit 0/1; a usage error exits 2 and prints to stderr
with no JSON):

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
- `agentId` is what you pass to `--agent` on later turns — a **Paseo agent id**,
  not the underlying tool's session id (see below).
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

## agent ID, not session ID

`--agent` takes a **Paseo agent ID** — the daemon's id for that agent session.
It is **not** the session id that Claude Code, Codex, or Pi track internally;
they are different ids for the same running agent. Get a Paseo agent id either
way:

- **Paseo client** (mobile app or web): open the agent tab, right-click the
  agent, and choose **Copy agent ID**.
- **CLI**: list agents on a target and read the `agentId` column:
  `agent-bridge --target <alias> --list-agents`.

Then pass it with `--agent <id>`.

```bash
# copy the id from the client, then reuse the SAME running agent
agent-bridge --target remote --agent <id> "continue"
```

## Talk to an existing agent on another machine

You do not need the agent to know its own id. The daemon lists all agents:

```bash
agent-bridge --target remote --list-agents   # shows agentId + status + title
```

Then continue one of them with `--agent <id>`. If the agent is currently
`running`, the bridge waits for it to become idle (a coding agent serializes
turns) before sending, so your message queues behind the active turn. If it
stays busy past `--timeout-ms`, the call fails with a clear error.