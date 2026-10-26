// Claude Code 的 UserPromptSubmit hook：拿 prompt 查共享记忆，命中就当线索注入上下文
import { search } from './index.mjs';

// 太常见的词会让什么都命中，查之前去掉
const STOP = /怎么|什么|我们|你们|一下|这个|那个|可以|是不是|帮我|看看|现在|还是|就是|然后|没有|如果|因为|所以|继续/g;

export function promptHook(db, prompt, { ignore = [], aliases = [] } = {}) {
  const p = String(prompt || '').trim();
  if (p.length < 6 || p.startsWith('/') || p.startsWith('<')) return null; // 太短、斜杠命令、系统通知
  const hits = search(db, p.slice(0, 300).replace(STOP, ' '), { limit: 5, ignore, aliases });
  if (!hits.length) return null;
  const lines = hits.map((h) => `- [${h.type}${h.review === 'pending' ? '|待确认' : ''}] ${h.title} — ${h.path}\n  ${h.snippet.slice(0, 120)}`);
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext:
    `共享记忆线索（mem search 自动检索，可能不全或不相关；动态状态要实时复核，细节用 Read 看原文）：\n${lines.join('\n')}` } };
}
