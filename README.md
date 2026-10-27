# 飞书回复助手

A Feishu (Lark) reply assistant for one person on one Mac. It watches messages that @mention you or DM you, has Claude Code look things up and draft a reply, and posts the draft as an interactive card in a private "drafts" group. Nothing is sent until you press a button or say so; then it replies as you, or goes and does the work you asked for. It keeps a local memory (people, policies, recipes, open items) that grows from every exchange and that Claude Code can use in your everyday work too.

盯着飞书里 **@我** 和 **私聊我** 的消息：先从本地记忆库预取「这个人是谁、相关口径和做法、我以前在这个会话说过什么」，再交给 Claude Code 去查、去起草，草稿发到你自己的「草稿群」里等你点头；你点「发送」才以你的身份回复，说一句「去办」它就真的去办。每次办完、每天早上，聊天会沉淀成新的记忆，日常用 Claude Code 写代码时也能用上。

一台 Mac 就够，不需要任何服务器；目前只支持 macOS 和 Claude Code。

## 它怎么工作

```
每 90 秒搜一次 @我 + 私聊 → 去掉 @所有人、机器人、我已经回过的
  → 同一个人的连发合成一件事；纯「好的 / 谢谢」不起草
  → 以你的身份在对方消息上点个「了解」表情（对方知道你在处理；不想点就把配置里的 `auto_react` 改成 false）
  → 预取：人物卡、相关记忆、你在这个会话说过的话、本地 agent 会话片段（装了 Orca 才有）
  → claude -p 起草：什么命令都能跑、只查不改，唯独不能发飞书消息
  → 草稿群里出一张卡：原消息、可直接改的拟发送、「发出这句 / 按吩咐办 / 不回，收起」，查证过程收在折叠里
你点「发出这句」→ 以你的身份回复（发之前查一遍：答应了还没做的事、没验证就说「好了」的，拦下来让你确认）
你在卡片下说任何别的话 → 交给起草时那个 Claude 会话去办：改稿、查线上、动手、以你的身份发消息（只能走 bin/fr，见「安全」）
  → 办完出一张报告卡：已发了什么、做了什么、验证、还要你定什么
  → 办的时候接口报错断了（断流 / 服务端错）：马上 --resume 同一个会话接着办，卡下说一声，最多 2 次；重开也没用的错（提示太长 / 安全拦截 / 登录失败）马上告诉你
  → 办完关掉 Orca 终端；关漏了的（助手 / Orca 重启过、超时）每 10 分钟按进程扫一遍收掉，空闲的 claude 不一直占内存
你没理卡片、直接在原会话回了 → 卡片自动收起，「草稿 vs 你实际怎么回的」记下来，第二天用来校正口吻
群里回复统一开话题；助手自己开的话题在 6 小时内自动跟原收件人的新回复（别人插话仍要 @我），私聊继续留在主消息流
每天 06:30：昨天的飞书 → 抽记忆 → 和已有记忆合并 → 草稿群发「记忆日报」（新增、待你确认、到期的事、昨天花了多少钱）
```

更多设计考虑见 docs/DESIGN.md，记忆格式见 docs/MEMORY.md。

## 需要什么

- macOS，Node 24 或更新（记忆检索用 `node:sqlite`），python3 和 git（系统自带的就行；没有的话 `xcode-select --install`）
- [Claude Code](https://claude.com/claude-code)，已经登录
- [lark-cli](https://github.com/larksuite/cli)（`npm i -g @larksuite/cli`），以及一个**飞书企业自建应用**（建法和要开的权限见 docs/feishu-app.md；公司租户发布应用一般要管理员审核）
- 可选：Orca（多 agent 终端和内置浏览器）。装了而且开着时，办事在 Orca 终端里跑，你能看着、能插话；外部群（程序不能以你身份发的）用 Orca 内置浏览器里的网页版飞书替你发。没装也能完整使用：办事在后台跑，过程写日志；外部群的回复放剪贴板让你手动发。

## 安装

```bash
git clone https://github.com/3218923350/feishu-reply-assistant.git
cd feishu-reply-assistant
bin/fra setup          # 一路引导：飞书应用、登录、草稿群、配置、记忆目录、Claude Code hook，最后问要不要启动常驻服务、跑冷启动
#   setup 复制好「关于我」后，先把 $FRA_HOME/about-me.md 改成你自己的（你是谁、负责什么、常用仓库），再让它启动服务
#   （草稿像不像你，主要看它；没改的话 setup 默认不启动，改好后跑 ./install.sh）
bin/fra doctor         # 逐项检查，哪项没通会告诉你怎么修
```

`bin/fra setup` 可以反复跑，做过的步骤会跳过；每一步改你电脑上的东西之前都会先问（改 `~/.claude/settings.json`、`~/.claude/CLAUDE.md` 前会备份）。`bin/fra setup --no-start` 只装不启动常驻服务。

setup 做的事：
1. 检查 macOS / Node / Claude Code / lark-cli。
2. 让 lark-cli 绑定你的飞书应用并以你的身份登录，记下你的 open_id。
3. 问机器人是否用同一个应用（默认是，最省事）；用机器人建「飞书回复草稿箱」群并把你拉进去。
4. 问开始处理时要不要在对方消息上点「了解」表情，写 `~/.feishu-reply-assistant/config.json`，复制「关于我」模板。
5. 建记忆目录（本机 git 仓库，不配远端）。
6. 在 Claude Code 里装记忆 hook（每次提问自动带上相关记忆）和「先 `mem search`」那段全局说明；把 `mem` 命令链到 `~/.local/bin`（`~/.local/bin` 不在 PATH 里时只提示、不链）。
7. 问你要不要现在启动两个 launchd 服务（常驻助手 + 每天 06:30 的记忆日报）。启动后每 90 秒以你的身份搜一次消息，开始处理时会在对方消息上点「了解」表情（`auto_react` 为 false 时不点），这是对外可见的。改了代码之后重跑 `./install.sh` 就是重启。
8. 问要不要冷启动：从最近 30 天的飞书抽记忆（scripts/coldstart.sh，先拉消息、报批次数，再问一次，会花 Claude 的钱）。

doctor 检查的项：系统是 macOS、Node ≥ 24、Claude Code、lark-cli、git、配置文件、关于我、飞书用户身份、机器人身份、草稿群、卡片回调、记忆目录、记忆检索、Claude Code 记忆 hook、全局 CLAUDE.md、mem 命令、常驻服务、每日任务、Orca（可选）。

## 配置

数据目录默认 `~/.feishu-reply-assistant/`。要换就设环境变量 `FRA_HOME`，而且要写进 `~/.zshrc` 并在跑 setup / install.sh 之前生效：常驻服务用的是 install.sh 写进 launchd 的值，而 Claude Code 的记忆 hook、日常 `mem`、手动跑的脚本读的是 shell 里的值，两边不一致就会各读各的目录。下文的 `$FRA_HOME` 没设时就是 `~/.feishu-reply-assistant`。里面：

- `config.json`：见下表，模板在 templates/config.example.json
- `about-me.md`：关于你的说明，原样拼进起草时的系统提示词。模板在 templates/about-me.md
- `state.json`、`assistant.log`、`daily.log`、`runs/`（办事的提示词、报告、后台日志）、`events/`（发出的、办过的、费用）、`memory/`（默认的记忆目录）

| 键 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 你在飞书上的名字 |
| `open_id` | 是 | 你在 lark-cli 用户身份应用下的 open_id（setup 自动填） |
| `draft_chat_id` | 是 | 草稿群（setup 自动建） |
| `bot_open_id` | 否 | 机器人是另一个应用时，你在那个应用下的 open_id（卡片按钮回调里的 operator_id）。同一个应用不用写 |
| `bot_env` | 否 | 机器人调用 lark-cli 时额外的环境变量，比如 `{"LARKSUITE_CLI_CONFIG_DIR": "~/.lark-bot"}`。同一个应用不用写 |
| `leaders` | 否 | 你的上级，影子期里他们的消息一律标「等你」 |
| `messenger_url` | 否 | 你们租户网页版飞书的消息页（如 `https://xxx.feishu.cn/next/messenger/`），外部群用 Orca 替你发；不写就走剪贴板 |
| `memory_dir` | 否 | 记忆目录，默认 `$FRA_HOME/memory` |
| `aliases` | 否 | 记忆检索的同义词 `[["正则", "补上的写法"], ...]` |
| `secret_prefixes` | 否 | 你们公司 key 的固定前缀（如 `abc_xxxx` 写 `abc`），外发和清理检查都会拦 |
| `legacy_work_dir` | 否 | 只有从早期版本升级的人需要 |
| `auto_react` | 否 | 开始处理时以你的身份在对方消息上点「了解」表情，默认 `true`；不想点写 `false`，改完重跑 `./install.sh` |
| `launchd_label` | 否 | launchd 服务名，默认 `com.feishu-reply-assistant` |

## 日常怎么用

在草稿群里，对每张卡片：

按钮只有两种动词：「发」= 以你的身份把卡上那句发出去，不执行任何操作；「办」= 真的去执行（查线上、改配置、开权限），可能代你发消息。

- **发出这句**：把卡上「发给他的话」（你可以先改）以你的身份回给对方。
- **按吩咐办**：在吩咐框里写一句（比如「查一下他的额度，够就直接回他」），交给起草时那个 Claude 会话去办；吩咐框空着点不会起办事。也可以直接在卡片下面（引用或话题里）说话，效果一样。
- **执行上面要做的，办完再回他**（要动手的卡）：照卡上「🔧 要做」去办，办完、验证过才把「办完发给他的话」发出去；那一框清空就只办不发，结果回到草稿群。
- **办勾选的，办完再回他**（有要你批的操作时）：卡上每件事一个勾选框（互斥的方案是下拉），只办勾了的，办完同上。
- **不回，收起**：这张卡什么都不做，收起来。整句回「发」或「不」也行。
- **照发，事我自己办**：话里答应了还没做的事被拦下时才出现：照发，答应的事记下来、到点提醒你。
- 卡上标红的「答应了还没做」：话发出去了、事还没做。点「去办答应的事」交给原会话；说了「马上」的，30 分钟没做会提醒一次。

记忆：日常在 Claude Code 里 `mem search <词>`、`mem who <姓名>`；每天的记忆日报卡下回「1 3 确认，2 删，5 结」处理待确认和到期的条目。

常用命令：

```bash
node assistant.mjs --dry om_xxx   # 对某条消息只起草、打印结果（看效果 / 成本），不发卡片
tail -f ${FRA_HOME:-~/.feishu-reply-assistant}/assistant.log
scripts/daily.sh 2026-10-22       # 手动跑某天的增量记忆 + 日报（同一天只入库一次；FORCE=1 强制重跑，会把同样的事实再追加一遍，确认上次没入库再用）
mem review                        # 列出待确认的记忆
```

## 费用

起草、办事、抽记忆都用你本机 Claude Code 的账号。每次调用都记成事件，记忆日报里有一行「过去 24 小时花费」（在 Orca 终端里办的事拿不到费用，记为未知）。起草每条最多 8 轮工具调用，到上限自动收尾。

## 安全

- 起草阶段：Claude 什么命令都能跑（这样才能查清楚），但发飞书消息、改消息、撤回的命令被禁用（包一层 env / sh -c 也算），提示词要求只查不改。
- 办事阶段：以你的身份发消息只能用 bin/fr。它会校验：授权必须是你在草稿群里说的原话片段（由程序写进这一轮的上下文文件）；收件人只能是原会话 / 原发送人，或你那句话里点了名的人；同一句不重复发；正文或附件里有 key / 密码时，除非你原话里明确让发，否则不发。
- 卡片上「发送」之前拦「答应了还没做」和「没验证就说好了」；办事时用 fr 发出去的话里有承诺的，记进承诺账本，到点提醒你。
- 你没开口之前，卡片只是草稿；影子期里「查证与依据」里写的「试运行：以后完全放手的话会直接发」也只是标注，不会真的自动发。
- key 可以记进本机记忆、用来办事，但不外传。记忆目录只在本机，不配 git 远端。
- **这些是防误发、防顺手发的护栏，不是沙箱。** Claude 在你的电脑上以你的账号运行、什么命令都能跑：它要是有意绕（把发送命令写进脚本再执行、伪造上下文文件），这些规则拦不住。所以别把它接到你不信任的输入上，也别给它比你本人更大的权限。详见 docs/DESIGN.md「安全边界」。

## 常见问题

- **公司租户发布应用要管理员审核**：开机器人能力、订阅卡片回调、加权限之后都要发布新版本，可能要等管理员批。
- **按钮点了没反应**：`bin/fra doctor` 看「卡片回调」和「机器人身份」。同一个应用同一时间只能有一个进程收卡片回调，别在别处再起 `lark-cli event consume card.action.trigger`。两个应用时检查 `bot_open_id` 是不是你在机器人应用下的 open_id。
- **用户授权失败 / 建草稿群报 232043**：应用的「可用范围」里没有你自己。在开放平台 → 应用发布 → 可用范围里加上你，发一版再重跑 setup。
- **记忆 hook 好像没生效**：从程序坞打开的 Claude Code 可能没加载你 shell 里的 PATH（比如 nvm 装的 node），hook 找不到 node 就静默跳过。在终端里启动 claude 试试，或者让 node 在系统 PATH 里也能找到。
- **外部群发不出去**：飞书不允许程序以你的身份往外部群 / 外部私聊发（错误码 230027）。装了 Orca 并配了 `messenger_url` 会用网页版替你发；否则草稿放剪贴板，卡片上提示你手动发。

## 反馈

问题请到 [GitHub Issues](https://github.com/3218923350/feishu-reply-assistant/issues)，附上 `bin/fra doctor --report` 生成的报告。报告里人名、群名、消息正文、各种 id、本机路径都换成了占位符，key 已脱敏，但 Issues 是公开的，贴之前请自己再看一遍。

## 开发

```bash
node --test && (for t in test/test_*.py; do python3 "$t" || exit 1; done)
git config core.hooksPath .githooks   # 推送前自动跑清理检查
node scripts/check-clean.mjs          # 会发布的文件里有没有个人 / 内部信息（黑名单放在 $FRA_HOME/clean-blocklist.txt，一行一个词，# 开头是注释，不分大小写；不进仓库）
```

代码结构：assistant.mjs 主程序；lib/ 各模块（lib/config.mjs 配置、lib/prefetch.mjs 预取、lib/cards.mjs 卡片、lib/fr.mjs 发送规则、lib/promise.mjs 拦承诺、lib/memory/ 记忆引擎）；bin/ 命令（bin/fra、bin/fr、bin/mem、bin/mem-hook）；scripts/ 每日记忆管线和冷启动；prompt.md 起草的系统提示词。

## License

MIT
