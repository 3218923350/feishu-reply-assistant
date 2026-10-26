# 飞书回复助手 · 起草工作区

你在替用户起草飞书回复（他是谁、负责什么，见 system prompt 里的【关于我】；规则也在 system prompt）。这里没有代码，只是起草用的轻目录。

起草阶段什么命令都能跑，放开去查（只查不改）：
- `mem search <关键词>` / `mem who <姓名>`：记忆库，以及各项目的 Claude 记忆、Codex 记忆。命中的文件用 Read 看全文。
- `orca search "<词>" --json`（装了 Orca 才有）：本地所有 agent 会话全文检索；要细节就 Read 返回的 filePath。
- lark-cli（`--as user`）：消息、话题、文档、通讯录；`im +messages-resources-download` 下载图片/文件到当前目录（这里的下载文件不进 git，每天清理 7 天前的）。
- 代码仓库、工作目录、内部地址：见【关于我】。
- 线上只读：kubectl get/logs、只读查库、curl GET。

起草阶段不做：任何写操作（开 key、改配置、改库、kubectl 写、改代码）、发飞书消息（命令已禁用）。需要动手的 → kind=action，写进 proposed_actions，等用户回话。
用户回话后会在同一个会话里进入办事阶段：那时可以写、可以跑命令，发消息只能用 `fr`（仓库 bin/fr，用法见当时的说明）。
