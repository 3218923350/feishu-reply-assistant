# 换底层模型（比如 DeepSeek）

助手里有两处用到大模型：

| 用在哪 | 用的是 | 怎么换 |
|---|---|---|
| 起草、办事、闭环抽记忆、每天的记忆和复盘 | Claude Code（`claude -p` / Orca 终端里的 `claude`） | 配置 `claude_settings` |
| 外部群代发的兜底（`desktop_send` 时脚本没发成，让它看着飞书客户端发） | Codex（`codex exec`） | 配置 `desktop_model` + Codex 自己的配置 |

助手只依赖 Claude Code 的两样能力：工具调用和按 JSON Schema 强制输出（`--json-schema`）。底层模型只要能通过 **Anthropic Messages 协议**接进 Claude Code、支持工具调用，就能换。

## 一、Claude Code 换成 DeepSeek

1. 准备一个兼容 Anthropic Messages 协议的地址和 key：你们公司的模型网关，或者模型厂商自己提供的 Anthropic 兼容接口。
2. 复制 `templates/claude-settings.example.json`，填上地址、key、模型名，存成比如 `~/.feishu-reply-assistant/claude-settings.json`，`chmod 600`。
3. `config.json` 里写：

   ```json
   "claude_settings": "~/.feishu-reply-assistant/claude-settings.json"
   ```

4. `./install.sh`。它会生成 `$FRA_HOME/claude`（等于 `claude --settings <你的文件>`），写进常驻服务和每日任务。日志里起草那行的 `cost=$` 仍是按 Anthropic 价目估的，不是真实花费，真实花费看你的网关账单。
5. 先挑一条消息试：`FRA_CLAUDE=$FRA_HOME/claude node assistant.mjs --dry om_xxx`，看草稿和 JSON 正常再等它接真消息。

**为什么模板里写的是 `claude-opus-4-8[1m]` 加 `modelOverrides`**：Claude Code 按它认识的模型名决定上下文窗口和输出上限。直接把 `ANTHROPIC_MODEL` 写成 `deepseek-xxx`，会被当成未知模型、按 20 万上下文 / 3.2 万输出处理，长会话会被提前压缩。对内用一个 1M 上下文的 Claude 模型名，再用 `modelOverrides` 把实际发出去的模型名换掉，就能拿到 1M 上下文。

**只换助手，不影响你自己的 Claude Code**：`--settings` 只对这几个进程生效，你平时开的 Claude Code 照旧。

### 实测（作者本机，2026-10，经公司模型网关接 deepseek-v4.1-flash）

- `--json-schema`、工具调用、前缀缓存都正常；起草质量和 Claude 不分高下，几家模型盲评胜负基本持平。
- 起草一条比 Claude 便宜很多，速度相当或更快。
- 不限轮数时 DeepSeek 更爱「多查几轮」：中位 30 轮左右，长的上百轮。所以默认给起草 15 分钟的时间上限（`draft_timeout_minutes`），也可以写 `max_turns` 限轮数。

## 二、Codex 换成 DeepSeek（只影响外部群代发的兜底）

Codex 走 **Responses 协议**（`wire_api = "responses"`）。要让 Codex 用 DeepSeek，需要一个把 DeepSeek 暴露成 Responses 协议的网关（很多模型网关都做了这层转换）。

1. 在 Codex 自己的配置里加这个网关当 provider（`~/.codex/config.toml`）：

   ```toml
   [model_providers.my-gateway]
   name = "my gateway"
   base_url = "https://<网关地址>/v1"
   wire_api = "responses"
   env_key = "MY_GATEWAY_KEY"
   ```

   并把它设成默认 provider（`model_provider = "my-gateway"`），或者另建一个 profile。
2. 助手的 `config.json`：

   ```json
   "desktop_send": true,
   "desktop_model": "deepseek-v4.1-flash"
   ```

实测：有现成脚本可用时，Codex + DeepSeek 约 1 分钟发成；脚本坏掉、让它自己读飞书客户端的辅助功能树，约 3.5 分钟发成。DeepSeek 看不了图片，提示词里已经禁止它截图（截图还会把请求体撑到网关上限、报 413）。大多数时候用不到 Codex：确定性脚本 10 秒左右就发完了。

## 三、换回 Claude

`config.json` 里删掉 `claude_settings`（或写 `null`），重跑 `./install.sh`。
