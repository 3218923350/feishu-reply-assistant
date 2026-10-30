# 飞书应用配置

助手用 [lark-cli](https://github.com/larksuite/cli) 访问飞书，需要你在飞书开放平台建一个**企业自建应用**。同一个应用既当「你本人」（用户身份：搜消息、以你的身份回复），也当「机器人」（在草稿群里发卡片、收按钮回调）。这是默认做法，`bin/fra setup` 也按这个引导。

## 一、建应用

1. 打开飞书开放平台（open.feishu.cn）→ 开发者后台 → 创建企业自建应用，名字随意（比如「张三的回复助手」）。
2. 「添加应用能力」→ 加上**机器人**。
3. 「应用发布」→「可用范围」里至少加上你自己（不然用户授权会失败，机器人建群拉你进去会报 232043）。
4. 「权限管理」→ 开通下面两张表里的权限。
5. 「事件与回调」→「回调配置」→ 订阅方式选**使用长连接接收回调**，添加回调 `card.action.trigger`（卡片回传交互）。如果保存时提示没检测到长连接：先把后面的 lark-cli 配好，临时跑一下 `lark-cli event consume card.action.trigger --as bot`，保存成功后 Ctrl-C 关掉（常驻服务起来以后由它来收，别同时开两个）。
6. 「版本管理与发布」→ 创建版本、申请发布。公司租户一般要管理员审核；之后每次改权限、改回调都要再发一次版本。
7. 本机跑 `lark-cli config init`，按提示填 App ID 和 App Secret（`bin/fra setup` 会帮你调起）。

## 二、权限

用户身份（`lark-cli auth login` 时授权，setup 申请的是 `--domain im,contact --scope search:message`）：

| 用来做什么 | 命令 | 权限 |
|---|---|---|
| 搜 @我 / 私聊我的消息 | `im +messages-search` | `search:message` |
| 拉会话上下文、话题、卡片 | `im +chat-messages-list`、`im +threads-messages-list`、`im +messages-mget` | `im:message:readonly`、`im:message.group_msg:get_as_user`、`im:message.p2p_msg:get_as_user`、`im:chat:read`、`contact:user.base:readonly` |
| 以你的身份回复 / 发消息（发送、`bin/fr`） | `im +messages-reply`、`im +messages-send` | `im:message`、`im:message.send_as_user` |
| 在对方消息上点「了解」表情（配置 `auto_react` 为 false 时不点） | `im reactions create` | `im:message.reactions:write_only` |
| 发附件；起草时下载消息里的图片看 | `im +messages-reply --file`、`im +messages-resources-download`（起草的 Claude 用） | `im:resource` |
| 按名字找人、找群（`bin/fr --to 人名`） | `contact +search-user`、`contact +get-user`、`im +chat-search` | `contact:user:search`、`contact:user.base:readonly`、`im:chat:read` |
| 卡上「加入任务」建飞书任务、点「完成」勾掉、日报里查完成没有（不用这个功能可以不开） | `task +create`、`task +complete`、`task tasks get` | `task:task:write`（授权：`lark-cli auth login --domain task`） |

机器人身份（应用权限，开通即可）：

| 用来做什么 | 命令 | 权限 |
|---|---|---|
| 草稿群里发卡片、在卡下回复、日报 | `im +messages-send --as bot`、`im +messages-reply --as bot` | `im:message`、`im:message:send_as_bot` |
| 点完按钮把卡片改成结果 | `im messages patch` | `im:message:update` |
| 你在原会话亲自回了：给草稿卡点个 ✅ | `im reactions create --as bot` | `im:message.reactions:write_only` |
| 建草稿群（setup） | `im +chat-create --as bot` | `im:chat:create` |
| 检查草稿群成员（doctor） | `im +chat-members-list --as bot` | `im:chat.members:read` |
| 收按钮回调 | `event consume card.action.trigger --as bot` | 回调配置里订阅 `card.action.trigger`（长连接） |

注意：
- **一个应用同一时间只能有一个进程收卡片回调**。常驻助手在跑时，不要在别处再起 `lark-cli event consume card.action.trigger`，否则按钮会时灵时不灵。
- 飞书不允许程序以你的身份往**外部群 / 外部私聊**发消息（错误码 230027）。这类回复会改用 Orca 里的网页版飞书替你发（要装 Orca 并在 config.json 配 `messenger_url`），否则放剪贴板让你手动发。

## 三、两个应用（可选）

如果你已经有一个只给自己用的 lark-cli 应用，不想给它加机器人能力，也可以另建一个应用专门当机器人：

1. 照上面建第二个应用，只开机器人能力、机器人那张表的权限和卡片回调。
2. 给它单独一个 lark-cli 配置目录：`LARKSUITE_CLI_CONFIG_DIR=~/.lark-bot lark-cli config init`。
3. config.json 里写 `"bot_env": {"LARKSUITE_CLI_CONFIG_DIR": "~/.lark-bot"}`。
4. 写 `bot_open_id`：你在**机器人应用**下的 open_id（飞书的 open_id 按应用区分，和用户身份应用下的不一样）。查法：给机器人应用开 `contact:user.id:readonly`，然后按邮箱查：
   `LARKSUITE_CLI_CONFIG_DIR=~/.lark-bot lark-cli api POST /open-apis/contact/v3/users/batch_get_id --as bot --params '{"user_id_type":"open_id"}' --data '{"emails":["你的邮箱"]}'`，返回里的 `user_id` 就是。
5. 跑 `bin/fra doctor`，「机器人身份」「草稿群」「卡片回调」三项都应该是 ✅。
