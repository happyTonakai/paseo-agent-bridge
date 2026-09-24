# agent-bridge — Paseo Agent Bridge

> [English](README.md) · **中文**

一个轻量的 Node CLI,通过 Paseo 驱动**本机或另一台机器**上的 AI 编程 Agent,让一个 Agent 能命令另一个 Agent。

```
A 机上的 agent --(relay 端到端加密 / 直连)--> B 机上的 daemon --> B 上的 agent 执行任务
```

它只依赖 npm 公共仓库里的 `@getpaseo/client` 和 `@getpaseo/protocol`。它**不是** Paseo 插件,也不需要 Paseo 源码。

## 为什么

你在 A 机上有一个没法做某些事(比如 Docker)的编程 Agent,但 B 机的 daemon 可以。这个 bridge 让 A 机的 Agent 在 B 机上创建或复用 agent、把任务发过去、等一个回合,然后把**最终**回复以 JSON 拿回来。多轮对话会复用同一台远程 agent/会话。

## 安装

需要 **Node.js 22+**(Paseo SDK 需要全局 `WebSocket`)。全局安装,这样任何目录下都能用 `agent-bridge`:

```bash
# 直接从 GitHub 仓库安装(会提供 `agent-bridge` 命令)
npm install -g https://github.com/happyTonakai/paseo-agent-bridge
agent-bridge --help
```

配置在 `~/.paseo/agent-bridge.json`(默认位置,任意目录都会读取)。从模板创建并填好你的 targets:

```bash
mkdir -p ~/.paseo
cp config.example.json ~/.paseo/agent-bridge.json
# 编辑 ~/.paseo/agent-bridge.json,填上 relay 和 target 信息
```

`agent-bridge` 始终读取 `~/.paseo/agent-bridge.json`;用 `--config <path>` 可指向别的文件。

## 配置:targets (~/.paseo/agent-bridge.json)

配置把机器列成命名的 **target**。每个 target 要么是:

- **remote**(远程,通过 relay 到达):`serverId` + `publicKeyB64`(+ `cwd`、`provider`、`model`);
- **local**(本机,直连):一个 `url`。

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

- **多轮对话是默认行为**:创建的 agent 会被保留并返回其 `agentId`,你可以继续跟它对话。本工具从不删除 agent;用原生的 `paseo archive <id>` 清理。
- 如果 `model` 为空,工具会向该 daemon 询问该 provider 的默认模型。如果 `provider` 为空,会自动检测第一个可用的。
- 每次调用都必须带 `--target <alias>`;运行 `--list-targets` 查看有哪些。

### 获取 target 的详细信息(`serverId`、`publicKeyB64`)

这些是**目标 daemon** 的配对凭据——它们属于你要连的那台 B 机,不是 relay 的——并且存放在那台机器上:

- `serverId`:目标 daemon 的 id,读该机的 `~/.paseo/server-id`(一个 `srv_XXXX` 字符串)。
- `publicKeyB64`:目标 daemon 的公钥,读该机的 `~/.paseo/daemon-keypair.json` → 其中的 `publicKeyB64` 字段。
- Relay 地址(`relay.endpoint` / `relay.useTls`):`~/.paseo/config.json` → `daemon.relay.endpoint`。当该 endpoint 以 `wss://` 开头时 `useTls` 为 `true`,`ws://` 则为 `false`。

### ⚠️ 直连本机 URL 要带 `/ws`

直连 daemon 的 endpoint 必须包含 `/ws` 路径,例如 `ws://127.0.0.1:6767/ws`。连裸主机根路径会被 daemon 拒绝。(Relay URL 本身已带 `/ws`。)

## 用法

```bash
# 一次性 —— 在 target 上创建一个新 agent,跑一个回合,返回它的回复
agent-bridge --target remote "docker ps"
agent-bridge --target remote --cwd /home/user/Docker "docker ps"
agent-bridge --target remote --model <other-model> "task"

# 连续对话 —— 第一次调用创建并保留 agent
agent-bridge --target remote "remember: ship the fix"
#   → 返回 agentId;后续回合复用它
agent-bridge --target remote --agent <agentId> "describe the diff"

# 跟那台机器上已有的 agent 对话(先发现它)
agent-bridge --target remote --list-agents
agent-bridge --target remote --agent <existingId> "continue"

# 调试:输出完整轨迹(默认只打印最终回复)
agent-bridge --target remote --verbose "task"

# 使用另一个配置文件
agent-bridge --config ./other.json --target remote "task"
```

## 输出

`stdout` 得到一个 JSON 对象(exit 0/1;用法错误以 exit 2 打印到 stderr,不输出 JSON):

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

- `reply` 是该回合的**最终 assistant 消息**(类似通知);中间的 `reasoning`/工具调用不含在内,除非加 `--verbose`。
- `status` 是等待的结果:`idle`(成功)、`error`、`permission` 或 `timeout`。`agentStatus` 是 agent 的生命周期状态。
- 只有当 `status === "idle"` 且没有错误时 `ok` 才为 `true`。等待 `permission` 或超时的回合会以 exit `1` 退出(agent 仍然存活,之后可用 `--agent` 继续)。
- `agentId` 就是后续回合传给 `--agent` 的值——是一个 **Paseo agent id**,不是底层工具自身的 session id(见下文)。
- 退出码 `0` 成功,`1` 失败/超时,`2` 用法错误。

## 安全

- 配置文件(你自己在 `~/.paseo/agent-bridge.json` 创建的)存有 relay 配对凭据(`serverId`、`publicKeyB64`)。请保持私密,绝不要提交它。只有 `config.example.json`(通用占位符)可以共享。
- 调用方 Agent 要求做的事,都会以目标 daemon 用户的权限在那台机器上执行。请谨慎决定发送什么,并把带凭据的配置保密。
- 在 daemon 需要工具授权的 target 上,回合会暂停等待决定;这些 agent 无人值守,请按需预先批准。

## agent ID,不是 session ID

`--agent` 接受一个 **Paseo agent ID**——daemon 为该 agent 会话分配的 id。它**不是** Claude Code、Codex 或 Pi 内部记录的 session id;它们是同一个运行中的 agent 的不同 id。两种方式获取 Paseo agent id:

- **Paseo 客户端**(手机 App 或 Web):打开 agent 标签页,右键点击该 agent,选择 **Copy agent ID**。
- **CLI**:在某个 target 上列出 agent,读取 `agentId` 列:`agent-bridge --target <alias> --list-agents`。

然后用 `--agent <id>` 传给它。

```bash
# 从客户端复制 id,然后复用同一个运行中的 agent
agent-bridge --target remote --agent <id> "continue"
```

## 跟另一台机器上已有的 agent 对话

你不需要让 agent 知道它自己的 id。daemon 会列出所有 agent:

```bash
agent-bridge --target remote --list-agents   # 显示 agentId + status + title
```

然后用 `--agent <id>` 继续其中某一个。如果该 agent 正在 `running`,bridge 会等它变为 idle(编程 agent 会串行化回合)再发送,所以你的消息会排在当前活跃回合之后。如果它超过 `--timeout-ms` 仍 busy,调用会以清晰的错误失败。