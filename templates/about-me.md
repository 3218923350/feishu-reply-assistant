<!-- 复制到 ~/.feishu-reply-assistant/about-me.md 再改（bin/fra setup 会帮你复制）。
     这份文字会原样拼进起草时的系统提示词，写得越具体，草稿越像你。下面是虚构的示例，全部换成你自己的。 -->

## 我是谁

张三，某公司平台组，负责 API 网关和内部开发者门户。邮箱 zhangsan@example.com。

## 负责什么

- API 网关：开 key、调限额、查调用报错（看 request_id）。
- 开发者门户（portal.example.com）：账号开通、权限申请。
- 别人常来找我：要 key、问某个接口怎么用、报 5xx。

## 常用仓库和目录

- 网关代码：`~/work/gateway`；门户代码：`~/work/portal`。
- 模型 / 接口目录（只读）：`curl -s https://gw.example.com/internal/catalog`。
- 线上只读：`kubectl -n gateway get pods`、`kubectl -n gateway logs <pod>`。

## 判断提示

- 消息里的 8 位字母数字串通常是用户 id；`req_` 开头的是 request_id，可以到网关日志里查。
- 「开个 key / 调一下限额」几乎都是要动手（action），按记忆里的配方写出具体步骤。
- 涉及价格、合同、排期的，一律交给我拍板（decision）。
