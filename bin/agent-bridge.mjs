#!/usr/bin/env node
// Remote-agent bridge.
//
// Connects to a daemon on THIS or ANOTHER machine and drives a coding agent
// there. It prints the agent's final reply to stdout as JSON for the calling
// process to consume. The agent on THIS machine drives the agent on THAT
// machine: local agent -> relay -> remote daemon -> remote agent.
//
// Multiple machines are configured as named "targets" in config.json. Each
// target is either a REMOTE machine reached through the relay (serverId +
// publicKeyB64) or a LOCAL machine reached directly (url). Pick one with
// --target <alias> (default: config.defaultTarget or the first target).
//
// Examples:
//   agent-bridge "docker ps"                     # default target
//   agent-bridge --target remote "task"           # a remote machine (via relay)
//   agent-bridge --target local "task"            # this machine's daemon
//   agent-bridge --cwd /some/dir "task"           # override cwd
//   agent-bridge --model <m> "task"               # override model
//   agent-bridge --verbose "task"                 # also print full trace
//
// Continuous conversation (multi-turn is the norm):
//   agent-bridge "first task"   # agent is kept; read agentId from output
//   agent-bridge --agent <id> "next"   # same session, keeps context
//
// A created agent is kept so you can reuse its agentId on later turns. Pass
// --archive to clean up the agent when you are done with it.
//
// Exit codes: 0 success, 1 failure/timeout, 2 bad usage.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createPaseoClient } from "@getpaseo/client";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";

const BOOL_FLAGS = new Set(["archive", "verbose", "list-agents"]);
const VALUE_FLAGS = new Set(["config", "target", "cwd", "model", "provider", "agent", "timeout-ms"]);
const FLAGS = new Set([...BOOL_FLAGS, ...VALUE_FLAGS]);

const DEFAULT_CONFIG_NAME = "agent-bridge.json";

const USAGE = `usage: agent-bridge
  [--config <p>] [--target <alias>] [--cwd <dir>] [--model <m>] [--provider <p>]
  [--agent <id>] [--archive] [--verbose] [--timeout-ms <n>] [--list-agents]
  ["<task>"]

  --list-agents   list agents on the target (no task needed), then pick an id

Config is read from ~/.paseo/${DEFAULT_CONFIG_NAME}; pass --config <path> to
point at a different file.`;

// Default config lives next to the Paseo home (distinct name), so a globally
// installed agent-bridge picks it up from any directory.
function defaultConfigHome() {
  return join(process.env.PASEO_HOME || join(homedir(), ".paseo"), DEFAULT_CONFIG_NAME);
}

function resolveConfigPath(opts) {
  // Only the global location, or an explicit --config override. No fallbacks.
  return opts.config ?? defaultConfigHome();
}

function parseArgs(argv) {
  const opts = { raw: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (!FLAGS.has(key)) {
        console.error("Unknown flag: --" + key + "\n" + USAGE);
        process.exit(2);
      }
      if (BOOL_FLAGS.has(key)) {
        opts[key] = true;
        continue;
      }
      const val = argv[++i];
      if (val === undefined) {
        console.error("Flag --" + key + " needs a value\n" + USAGE);
        process.exit(2);
      }
      opts[key] = val;
    } else {
      opts.raw.push(a);
    }
  }
  opts.task = opts.raw.join(" ").trim();
  return opts;
}

function resolveTarget(cfg, opts) {
  if (cfg.targets) {
    const alias = opts.target ?? cfg.defaultTarget;
    let name;
    if (alias) {
      name = alias;
    } else {
      name = Object.keys(cfg.targets)[0];
    }
    const t = cfg.targets?.[name];
    if (!t) {
      console.error(
        `No target "${name}". Available: ${Object.keys(cfg.targets).join(", ")}. ` +
          "Pass --target <alias> or set defaultTarget.",
      );
      process.exit(2);
    }
    return { name, ...t };
  }
  // Backward compatibility: single "remote.*" config acts as target "default".
  if (cfg.remote) {
    return {
      name: "default",
      serverId: cfg.remote.serverId,
      publicKeyB64: cfg.remote.publicKeyB64,
      cwd: cfg.remote.cwd,
      provider: cfg.remote.provider,
      model: cfg.remote.model,
      title: cfg.remote.title,
    };
  }
  console.error("Config has no targets (and no legacy remote.*). See README.");
  process.exit(2);
}

function buildConnection(target, cfg) {
  if (target.url) {
    // Direct connection (e.g. this machine's daemon). No relay, no E2EE.
    return { url: target.url, e2ee: undefined };
  }
  const url = buildRelayWebSocketUrl({
    endpoint: cfg.relay.endpoint,
    useTls: cfg.relay.useTls ?? false,
    serverId: target.serverId,
    role: "client",
  });
  return {
    url,
    e2ee: { enabled: true, daemonPublicKeyB64: target.publicKeyB64 },
  };
}

function main() {
  if (process.argv.length < 3) {
    console.error(USAGE);
    process.exit(2);
  }
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.task && !opts["list-agents"]) {
    console.error(USAGE);
    process.exit(2);
  }

  let cfg;
  const configPath = resolveConfigPath(opts);
  if (!existsSync(configPath)) {
    console.error(
      "No config found. Put one at " + defaultConfigHome() +
        " (see config.example.json), or pass --config <path>.",
    );
    process.exit(2);
  }
  try {
    cfg = JSON.parse(readFileSync(resolve(configPath), "utf8"));
  } catch (err) {
    console.error("Cannot read config " + configPath + ": " + err.message);
    process.exit(2);
  }

  const target = resolveTarget(cfg, opts);

  // CLI flags override the selected target's values.
  const cwd = opts.cwd ?? target.cwd;
  let provider = (opts.provider ?? target.provider)?.trim();
  let model = (opts.model ?? target.model)?.trim();
  const agentId = opts.agent;
  const listAgents = opts["list-agents"] === true;
  const archive = opts.archive === true;
  const verbose = opts.verbose === true;
  const timeoutMs = Number(opts["timeout-ms"] ?? cfg.timeoutMs ?? 600_000);

  const missing = [];
  if (!target.url && !cfg.relay?.endpoint) missing.push("relay.endpoint");
  if (!target.url && !target.serverId) missing.push("target.serverId");
  if (!target.url && !target.publicKeyB64) missing.push("target.publicKeyB64");
  // cwd is only needed to CREATE a new agent; reusing one (--agent) uses the
  // agent's own stored working directory on the daemon.
  if (!agentId && !cwd) missing.push("cwd (only needed when creating a new agent)");
  if (missing.length) {
    console.error(
      "Missing config fields for target \"" + target.name + "\" (edit " + configPath + " or pass flags): " +
        missing.join(", "),
    );
    process.exit(2);
  }

  const { url, e2ee } = buildConnection(target, cfg);

  const client = createPaseoClient({
    url,
    clientId: "agent-bridge-" + randomUUID(),
    ...(e2ee ? { e2ee } : {}),
    reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 4000 },
    connectTimeoutMs: 20_000,
  });

  let finished = false;
  const done = async (code) => {
    if (finished) return;
    finished = true;
    try {
      await client.close();
    } catch {}
    process.exit(code);
  };

  client
    .connect()
    .then(async () => {
      // Discovery mode: list agents on the target daemon so you can pick an
      // existing agent's id and talk to it with --agent <id>.
      if (listAgents) {
        const r = await client.agents.list();
        const rows = (r.entries ?? []).map((e) => {
          const a = e.agent ?? e;
          return {
            agentId: a.id,
            status: a.status ?? "?",
            provider: a.provider ?? "?",
            model: a.model ?? a.runtimeInfo?.model ?? null,
            cwd: a.cwd ?? null,
            title: a.title ?? null,
            archivedAt: a.archivedAt ?? null,
          };
        });
        console.log(JSON.stringify({ target: target.name, agents: rows }, null, 2));
        await done(0);
        return;
      }

      if (!provider) {
        const avail = await client.providers.listAvailable();
        const list = avail.providers ?? avail.entries ?? [];
        const first = list.find((p) => p.enabled !== false)?.provider
          ?? (Array.isArray(avail) ? avail[0]?.provider : null);
        if (!first) {
          throw new Error(
            "No provider configured and none detected on the remote daemon. " +
              "Set provider in config.json or pass --provider.",
          );
        }
        provider = first;
      }

      // If no model was configured, ask that daemon for the provider's default
      // model. SDK 0.8.0 requires config.provider as "provider/model" (first
      // "/" splits), so a bare provider alone is not enough.
      if (!model) {
        try {
          const m = await client.providers.listModels(provider);
          const chosen = m.models?.find((x) => x.isDefault === true) ?? m.models?.[0];
          if (chosen?.id) model = chosen.id;
        } catch {}
      }
      const providerSelection = model ? `${provider}/${model}` : provider;

      const created = !agentId;
      const agent = created
        ? await client.agents.create({
            config: { provider: providerSelection },
            cwd,
            prompt: opts.task,
            title: target.title ?? "agent-bridge",
          })
        : client.agents.ref(agentId);

      const texts = [];
      let errorText = null;
      let pendingPermissions = 0;
      const unsub = agent.timeline.subscribe((ev) => {
        const event = ev?.event;
        if (!event) return;
        if (event.type === "timeline") {
          const item = event.item;
          if (!item) return;
          if (item.type === "assistant_message") texts.push(item.text);
          else if (item.type === "user_message") texts.push("\n[user] " + item.text);
          else if (item.type === "error") {
            errorText = item.message;
            texts.push("\n[error] " + item.message);
          }
        } else if (event.type === "permission_requested") {
          pendingPermissions += 1;
          texts.push(`\n[permission needed] ${event.request?.title ?? event.request?.name}`);
        } else if (event.type === "attention_required" && event.reason === "permission") {
          texts.push("\n[attention required: permission]");
        }
      });

      if (unsub && typeof unsub.ready === "function") {
        try {
          await unsub.ready;
        } catch {}
      }

      const result = created
        ? await agent.waitForFinish(timeoutMs)
        : await agent.run(opts.task, { timeoutMs });

      await new Promise((r) => setTimeout(r, 800));

      // Pull the authoritative timeline and take the most recent complete
      // assistant message so token-chunked streaming fragments don't leak in.
      let cleanReply = null;
      try {
        const tl = await agent.timeline.refetch({ direction: "tail", limit: 200 });
        const entries = tl.entries ?? tl.items ?? [];
        for (const entry of entries) {
          const item = entry.item ?? entry;
          if (item.type === "assistant_message") cleanReply = item.text;
        }
      } catch {}

      const status = result.final?.status ?? result.status ?? "unknown";
      const transcript = texts.join("\n").trim();
      const reply = cleanReply ?? (transcript || `(no assistant text captured; final status: ${status})`);

      const out = {
        ok: !errorText && status !== "error" && status !== "failed",
        target: target.name,
        agentId: agent.id,
        cwd,
        provider,
        model: model ?? null,
        status,
        reused: !created,
        pendingPermissions,
        reply,
      };
      if (verbose) out.transcript = transcript;

      unsub?.();
      // Agents are kept by default so their agentId stays reusable for later
      // turns. Archive only when explicitly asked (--archive).
      if (archive) {
        try {
          await agent.archive();
          out.archived = true;
        } catch {}
      }

      console.log(JSON.stringify(out, null, 2));
      await done(out.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error("agent-bridge error: " + (err?.stack || err?.message || String(err)));
      done(1);
    });
}

main();