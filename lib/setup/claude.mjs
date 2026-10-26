// setup 往 Claude Code 里装两样：每次提问自动带记忆线索的 hook（~/.claude/settings.json），和「先 mem search」那段全局说明（~/.claude/CLAUDE.md）。都可以重复跑
import { shq } from '../work.mjs';
import { MEM_MARKER } from './checks.mjs';

export const hookCommand = (repo) => `${shq(`${repo}/bin/mem-hook`)} 2>/dev/null || true`;

export function mergeHook(settingsText, cmd) {
  let s;
  try { s = settingsText.trim() ? JSON.parse(settingsText) : {}; } catch (e) { throw new Error(`~/.claude/settings.json 不是合法的 JSON（${e.message}）：先修好再跑 setup`); }
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('~/.claude/settings.json 最外层要是一个对象：先修好再跑 setup');
  if (s.hooks != null && (typeof s.hooks !== 'object' || Array.isArray(s.hooks))) throw new Error('~/.claude/settings.json 的 hooks 要是一个对象：先修好再跑 setup');
  if (s.hooks?.UserPromptSubmit != null && !Array.isArray(s.hooks.UserPromptSubmit)) throw new Error('~/.claude/settings.json 的 hooks.UserPromptSubmit 要是数组：先修好再跑 setup');
  const groups = ((s.hooks ||= {}).UserPromptSubmit ||= []);
  const mine = groups.flatMap((g) => g.hooks || []).filter((h) => /bin\/mem-hook\b/.test(h.command || ''));
  if (mine.length === 1 && mine[0].command === cmd) return { text: settingsText, changed: false };
  for (const g of groups) g.hooks = (g.hooks || []).filter((h) => !/bin\/mem-hook\b/.test(h.command || '')); // 旧路径的先摘掉
  s.hooks.UserPromptSubmit = groups.filter((g) => g.hooks.length);
  s.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: cmd }] });
  return { text: JSON.stringify(s, null, 2) + '\n', changed: true };
}

export const MEM_SNIPPET = `## 共享记忆（mem）

动手前先 \`mem search <关键词>\`（人用 \`mem who <姓名>\`）查记忆库和各项目记忆；结果是线索，动态状态（余额、白名单、发布）要实时复核。
得出以后用得上的结论时用 \`mem add\` 写入（格式见 feishu-reply-assistant 仓库的 docs/MEMORY.md；价格/权限/生产配方/对外承诺标 review=pending）。`;
const END = '<!-- /feishu-reply-assistant:mem -->';

export function addSnippet(mdText, snippet) {
  const block = `${MEM_MARKER}\n${snippet}\n${END}`;
  const i = mdText.indexOf(MEM_MARKER), j = mdText.indexOf(END);
  if ((i >= 0) !== (j >= 0) || j < i || mdText.indexOf(MEM_MARKER, i + 1) >= 0) throw new Error(`~/.claude/CLAUDE.md 里 ${MEM_MARKER} 的标记不成对：手动删掉残留的标记那一段再跑 setup`);
  const text = i >= 0 && j > i ? mdText.slice(0, i) + block + mdText.slice(j + END.length)
    : `${mdText}${mdText && !mdText.endsWith('\n') ? '\n' : ''}${mdText ? '\n' : ''}${block}\n`;
  return { text, changed: text !== mdText };
}
