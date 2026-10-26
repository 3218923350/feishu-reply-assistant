// 起草完全放行（2026-10-23 定：起草就是要到处查），只禁发飞书消息——他没开口前不对外发；办事阶段发消息只能走 fr。
// 这是防误发、防顺手发的护栏，不是沙箱：模型有意绕（写成脚本再执行、伪造 FR_CTX）是拦不住的，见 docs/DESIGN.md「安全边界」
export const EXEC_DENY = ['Bash(lark-cli im +messages-send:*)', 'Bash(lark-cli im +messages-reply:*)', 'Bash(lark-cli im +messages-forward:*)',
  'Bash(lark-cli api POST /open-apis/im/v1/messages*)', 'Bash(lark-cli api post /open-apis/im/v1/messages*)', // 原生接口发消息 / 回复也走不通
  'Bash(lark-cli api POST /open-apis/im/v1/threads*)', 'Bash(lark-cli api post /open-apis/im/v1/threads*)',
  'Bash(lark-cli im messages forward:*)', 'Bash(lark-cli im messages merge_forward:*)', 'Bash(lark-cli im threads forward:*)', // 资源风格的转发
  // 包一层（env / sh -c / 绝对路径 / 引号）也拦：命令里任何位置出现发送类子命令、写类接口都算
  'Bash(*+messages-send*)', 'Bash(*+messages-reply*)', 'Bash(*+messages-forward*)',
  'Bash(*im messages forward*)', 'Bash(*im messages merge_forward*)', 'Bash(*im messages patch*)', 'Bash(*im messages delete*)', 'Bash(*im messages urgent_*)', 'Bash(*im threads forward*)',
  ...['POST', 'PATCH', 'PUT', 'DELETE'].flatMap((m) => [`Bash(*${m} *open-apis/im/v1/*)`, `Bash(*${m.toLowerCase()} *open-apis/im/v1/*)`, `Bash(*${m} *open-apis/interactive/*)`])];
export const DRAFT_PERMS = ['--dangerously-skip-permissions', '--disallowedTools', ...EXEC_DENY];

// 按 Claude Code 的规则判断一条命令是否命中（测试用）：「xxx:*」= 前缀到词边界，其余的 * 是通配
const esc = (x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
export const allows = (rules, command) => rules.some((r) => {
  const m = r.match(/^Bash\((.*)\)$/);
  if (!m) return false;
  const legacy = m[1].match(/^(.*):\*$/);
  const src = legacy ? `${esc(legacy[1])}(?: .*)?` : m[1].split('*').map(esc).join('.*');
  return new RegExp(`^${src}$`, 's').test(command);
});
