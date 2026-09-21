#!/usr/bin/env node
// agent-bridge — paseo Agent Bridge.
//
// Companion CLI that drives coding agents on THIS or ANOTHER machine through
// Paseo: one agent can command another. It connects to a Paseo daemon (via the
// relay with E2EE, or directly) and either creates an agent there or reuses an
// existing one, sends it a task, waits for the turn, and prints the FINAL reply
// to stdout as JSON for the calling process to consume.
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
    const name = opts.target ?? cfg.defaultTarget ?? Object.keys(cfg.targets)[0];
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
    let loopback = false;
    try {
      const u = new URL(target.url);
      loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
    } catch {
      throw new Error(`invalid direct url for target "${target.name}": ${target.url}`);
    }
    if (!loopback) {
      console.error("warning: direct target is not loopback; traffic is plaintext (no relay E2EE).");
    }
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
      "No config found. Put one at " + configPath +
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
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error("--timeout-ms must be a positive number of milliseconds");
    process.exit(2);
  }
  const connectDeadlineMs = Number(cfg.connectTimeoutMs ?? 25_000);
  if (!Number.isFinite(connectDeadlineMs) || connectDeadlineMs <= 0) {
    console.error("connectTimeoutMs must be a positive number of milliseconds");
    process.exit(2);
  }

  const missing = [];
  if (!target.url && !cfg.relay?.endpoint) missing.push("relay.endpoint");
  if (!target.url && !target.serverId) missing.push("target.serverId");
  if (!target.url && !target.publicKeyB64) missing.push("target.publicKeyB64");
  // cwd is only needed to CREATE a new agent; reusing one (--agent) uses the
  // agent's own stored working directory, and listing needs no cwd at all.
  if (!agentId && !cwd && !listAgents) missing.push("cwd (only needed when creating a new agent)");
  if (missing.length) {
    console.error(
      "Missing config fields for target \"" + target.name + "\" (edit " + configPath + " or pass flags): " +
        missing.join(", "),
    );
    process.exit(2);
  }

  let url, e2ee;
  try {
    ({ url, e2ee } = buildConnection(target, cfg));
  } catch (err) {
    console.error("agent-bridge error: bad connection config: " + err.message);
    process.exit(2);
  }

  const client = createPaseoClient({
    url,
    clientId: "agent-bridge-" + randomUUID(),
    ...(e2ee ? { e2ee } : {}),
    reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 4000 },
    connectTimeoutMs: connectDeadlineMs,
  });

  // Emit JSON to stdout and let the pipe drain before exiting (process.exit()
  // can truncate a large piped write).
  const emitAndExit = (obj, code) => {
    process.stdout.write(JSON.stringify(obj, null, 2) + "\n", () => {
      try {
        client.close().catch(() => {});
      } catch {}
      process.exit(code);
    });
  };
  // Abort path when there is nothing to emit (e.g. connect failure).
  const fail = (msg) => {
    console.error(msg);
    try {
      client.close().catch(() => {});
    } catch {}
    process.exit(1);
  };

  const run = async () => {
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
      emitAndExit({ target: target.name, agents: rows }, 0);
      return;
    }

    if (!provider) {
      const avail = await client.providers.listAvailable();
      const list = avail.providers ?? [];
      const unavailable = list.filter((p) => p.available !== true);
      const first = list.find((p) => p.available === true)?.provider;
      if (!first) {
        throw new Error(
          "No available provider on target \"" + target.name + "\". " +
            (unavailable.length
              ? "Unavailable: " + unavailable.map((p) => `${p.provider}${p.error ? ` (${p.error})` : ""}`).join(", ") + ". "
              : "") +
            "Set provider in config or pass --provider.",
        );
      }
      provider = first;
    }

    // If no model was configured, ask that daemon for the provider's default
    // model. SDK 0.8.0 requires config.provider as "provider/model" (first
    // "/" splits), so a bare provider alone is not enough.
    if (!model) {
      let lookupError = null;
      try {
        const m = await client.providers.listModels(provider);
        const chosen = m.models?.find((x) => x.isDefault === true) ?? m.models?.[0];
        if (chosen?.id) model = chosen.id;
        if (!model) lookupError = m.error ? new Error(m.error) : null;
      } catch (err) {
        lookupError = err;
      }
      if (!model) {
        throw new Error(
          `Could not resolve a default model for provider "${provider}" on target "${target.name}"` +
            (lookupError ? ` (${lookupError.message})` : "") +
            `. Set "model" in the config or pass --model <id>.`,
        );
      }
    }
    const providerSelection = `${provider}/${model}`;

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
    let streamedPermissions = 0;
    const unsub = agent.timeline.subscribe((ev) => {
      const event = ev?.event;
      if (!event) return;
      if (event.type === "timeline") {
        const item = event.item;
        if (!item) return;
        if (item.type === "assistant_message") texts.push(item.text);
        else if (item.type === "user_message") texts.push("\n[user] " + item.text);
        else if (item.type === "error") {
          errorText = errorText ?? item.message;
          texts.push("\n[error] " + item.message);
        }
      } else if (event.type === "turn_failed") {
        errorText = errorText ?? event.error;
        texts.push("\n[turn failed] " + event.error);
      } else if (event.type === "permission_requested") {
        streamedPermissions += 1;
        texts.push(`\n[permission needed] ${event.request?.title ?? event.request?.name}`);
      } else if (event.type === "attention_required" && event.reason === "permission") {
        texts.push("\n[attention required: permission]");
      } else if (event.type === "attention_required" && event.reason === "error") {
        errorText = errorText ?? "turn ended with an error (attention required)";
      }
    });

    // Await the timeline demand before the turn moves on. unsub is callable WS
    // subscription whose `.ready` is a Promise awaiting establish acknowledgement.
    if (unsub?.ready) {
      try {
        await unsub.ready;
      } catch {}
    }

    const result = created
      ? await agent.waitForFinish(timeoutMs)
      : await agent.run(opts.task, { timeoutMs });

    // Authoritative values from the daemon; fall back to what we observed.
    // result.status is the wait outcome: idle | error | permission | timeout.
    // result.final.status is the agent lifecycle status.
    const waitStatus = result.status ?? "unknown";
    const agentStatus = result.final?.status ?? null;
    errorText = errorText ?? result.error ?? null;
    const pendingPermissions =
      (result.final?.pendingPermissions?.length ?? 0) || streamedPermissions;

    // Get the final assistant message from the daemon (authoritative per turn),
    // falling back to the last one we observed.
    let cleanReply = null;
    try {
      const tl = await agent.timeline.refetch({ direction: "tail", limit: 200 });
      const entries = tl.entries ?? tl.items ?? [];
      let best = null;
      for (const entry of entries) {
        const item = entry.item ?? entry;
        if (item.type === "assistant_message") {
          if (best === null || (entry.seqEnd ?? 0) >= (best.seqEnd ?? 0)) best = { seqEnd: entry.seqEnd, text: item.text };
        }
      }
      cleanReply = best?.text ?? null;
    } catch {}

    const transcript = texts.join("\n").trim();
    const reply =
      result.lastMessage ?? cleanReply ?? (transcript || `(no assistant text captured; status: ${waitStatus})`);

    // Trust the daemon's per-turn verdict. A streamed turn_failed can be a
    // transient retry attempt inside a turn that ultimately succeeds, so a
    // sticky errorText would otherwise flip ok to false on success.
    const ok = waitStatus === "idle" && result.error == null;

    const out = {
      ok,
      target: target.name,
      agentId: agent.id,
      cwd: result.final?.cwd ?? cwd ?? null,
      provider: result.final?.provider ?? provider ?? null,
      model: result.final?.model ?? model ?? null,
      status: waitStatus,
      agentStatus,
      reused: !created,
      pendingPermissions,
      error: errorText ?? null,
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

    emitAndExit(out, ok ? 0 : 1);
  };

  // Bound only the initial connection: a failed/refused connect with reconnect
  // enabled never settles, so guard it. Keep reconnect for mid-turn drops.
  let guard;
  const guardedConnection = Promise.race([
    client.connect(),
    new Promise((_, reject) => {
      guard = setTimeout(() => reject(new Error(`cannot reach ${url} within ${connectDeadlineMs}ms`)), connectDeadlineMs);
    }),
  ]);

  guardedConnection
    .then(() => {
      clearTimeout(guard);
      return run();
    })
    .catch((err) => {
      clearTimeout(guard);
      fail("agent-bridge error: " + (err?.message || String(err)));
    });
}

main();