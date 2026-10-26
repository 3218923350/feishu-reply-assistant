# 记忆库

回复助手、日常的 Claude Code（以及 Codex 等别的 agent）共用一个本地记忆库。代码在 lib/memory/，命令是 bin/mem；数据放在配置里 `memory_dir` 指定的目录（默认 `~/.feishu-reply-assistant/memory`），是一个只在本机的 git 仓库，不配远端（里面有同事信息，也可能有 key）。

## 目录

| 目录 | type | 放什么 |
|---|---|---|
| `people/` | person | 人物卡：角色 / 团队、负责什么、常找你做什么、id、沟通注意点。一人一张 |
| `policy/` | policy | 口径、常见问题的标准答案、定下的规则 / 价格 / 方案 / 分工 |
| `recipes/` | recipe | 可复用的操作步骤（前置条件、命令、验证、回滚） |
| `facts/` | fact | 系统与业务事实：地址、限额、环境差异、合作方 |
| `open/` | open | 进行中的事：你欠别人的 / 别人欠你的（可带 `due`，到期进日报） |
| `style/` | style | 你的回复风格、常用说法、什么情况怎么回 |
| `inbox/<目录>/` | 同上 | 待你确认的条目（review=pending） |

`mem search` 还会**只读**地检索 `~/.claude/projects/*/memory/*.md`（各项目的 Claude Code 记忆）和 `~/.codex/memories/*.md`，排在记忆库自己的条目后面，最多占 2 条。

## 条目格式

```markdown
---
type: policy
title: "示例：报销流程统一走新系统"
entities: ["报销","新系统"]
scope: 财务
sources: ["oc_xxx#om_xxx"]
observed: 2026-01-05
updated: 2026-01-12
status: active
confidence: high
review: pending
---
2026-01-05 报销统一走新系统，旧表格停用（oc_xxx#om_xxx）
2026-01-12 新系统支持手机端提交（oc_xxx#om_yyy）
```

- 字段：`type title entities scope sources observed updated status confidence review`，`open` 可以加 `due`。列表和含 `:` 的字符串写成 JSON。完整定义见 schema/memory.json。
- status：active｜superseded｜conflict｜open｜overdue｜done；review：auto｜confirmed｜pending；confidence：high｜medium｜low。
- 正文是事实行，每行 `YYYY-MM-DD 内容（来源）`。更新 = 追加一行，不删旧行。
- 两条说法矛盾时不按日期自动覆盖：都标 conflict，等你判。余额、白名单、发布状态这类动态信息只当线索，用之前实时复核。

## 必须等你确认的（进 inbox）

价格 / 计费规则、权限 / 白名单规则、生产环境操作配方、对外承诺。每天的记忆日报卡会列出来，在卡下回「1 3 确认，2 删」处理；也可以 `mem review` / `mem accept` / `mem reject`。

## key

key、token、密码可以原样写进记忆（写清是谁的、做什么用、什么时候给的），方便以后办事用；但助手不会把它们发给别人，除非你当次在原话里明确让发（见 README「安全」）。

## mem 命令

```bash
mem search <关键词> [--type policy] [--limit 8] [--scope mine|all] [--json]   # all（默认）连带各项目的 Claude / Codex 记忆；mine 只搜记忆库
mem who <姓名|open_id> [--id ou_xxx] [--json]   # 人物卡（带 open_id 时按 id 精确找）+ 相关口径 / 事项
mem add [文件|-] [--message 提交说明]          # JSON 数组或 JSONL，字段见 schema/memory.json
mem review [--json]                            # 列出待确认
mem accept <路径> / mem reject <路径>          # 只处理 inbox 里待确认的；已经入库的条目写错了，直接改或删那个 .md 文件再 git commit
mem reindex                                    # 重建检索索引（平时每次搜索会自动增量刷新）
```

`mem add` 的输入是 JSON 数组（或一行一个 JSON），每条都要有这些字段，缺了整批拒收：

```json
[{"type": "fact", "title": "网关地址", "entities": ["网关"], "scope": "prod", "content": "2026-01-05 网关地址是 https://gw.example.com/v1",
  "sources": ["私聊 李四#om_xxx"], "observed": "2026-01-05", "confidence": "high", "review": "auto"}]
```

正文写在 `content`（多条事实用换行分开，每行以日期开头）；`review` 填 `auto` 或 `pending`；`updated` 由程序填。已有同类型、同标题（人物按姓名 / open_id）的条目时，会追加到那一条而不是新建。

检索是 SQLite 全文索引，中文按相邻两个字切词；配置里的 `aliases` 可以补同义词（比如口语里的「开个 key」对应记忆里的「开通 key」）。

## 记忆从哪来

- **冷启动**（scripts/coldstart.sh）：拉最近 N 天你发的、@你的、私聊你的消息和相关群的上下文，按会话整理成批次，每批让 Claude（sonnet）抽候选，再按类型合并去重，入库。
- **每天 06:30**（scripts/daily.sh）：同样处理昨天的聊天，外加「草稿 vs 你实际怎么回的」和你撤回的消息（用来校正口吻）；和已有记忆比对，决定新建、追加还是标冲突；对照聊天结掉已经办完的事；发记忆日报。
- **每次闭环后**：一条回复发出去、一件事办完，起草那个会话会顺手把新知道的人物信息、口径、做法记下来。
