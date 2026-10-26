// 影子期：起草的 Claude 提议「放手的话怎么发」，程序用硬规则只往严里改；现在只标在卡上、记下来，不真的自动发
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TIERS = ['auto', 'countdown', 'hold'];
const PLACEHOLDER = /<[^<>\n]{1,24}>|\{[^{}\n]{1,24}\}|【[^】]{1,12}】|若[^。\n]{0,24}[:：]/;
const MONEY = /价格|价钱|元|¥|￥|折扣|优惠|充值|付费|收费|计费|免费|多少钱|报价|\d+(\.\d+)?\s*(块|w|万)\b/;
const WHEN = /(今天|明天|今晚|后天|下周|周[一二三四五六日天]|\d{1,2}\s*[点:：]|马上|一会|待会|稍后)[^。，,\n]{0,8}(上线|修好|修复|发布|给你|搞定|弄好|开好|上|发你|跟你说|通知你)|(上线|修好|发布|搞定)[^。，,\n]{0,4}(今天|明天|今晚|下周)/;
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// 草稿里每个事实都要有这一轮的查证。Claude 引用命令时常会改写（少个参数、Read 过的文件写成 sed），
// 所以命令里有网址 / 文件路径就按它们对：每个都得在会话里真碰过；没有就按整条命令对
const anchors = (c) => (c.match(/https?:\/\/[^\s'"|)]+|\/(?:[^\s'"|;)]+\/)+[^\s'"|;)]+/g) || []).map((a) => a.replace(/[.,]+$/, ''));
function unverified(facts, commands) {
  const cmds = commands.map(squash);
  return facts.filter((f) => {
    const c = squash(f.cmd);
    if (!c || c === '推断') return true;
    if (/^记忆[:：]/.test(c)) return false;
    const a = anchors(c);
    if (a.length) return !a.every((x) => cmds.some((y) => y.includes(x)));
    return !(c.length >= 6 && cmds.some((x) => x.includes(c) || (x.length >= 6 && c.includes(x))));
  });
}
const pendingMemory = (f) => /^记忆[:：].*\/inbox\//.test(squash(f.cmd)) || anchors(squash(f.cmd)).some((a) => /\/inbox\//.test(a) && /\.md$/.test(a));

export function holds(res, ctx) {
  const r = [], draft = res.draft || '';
  if (res.kind === 'decision') r.push('要你拍板');
  if (res.kind === 'action') r.push('要动手（写操作等你；草稿是做完之后的话）');
  if (PLACEHOLDER.test(draft)) r.push('草稿里有占位或两套答案');
  if (MONEY.test(draft)) r.push('涉及钱（价格 / 免费 / 充值）');
  if (WHEN.test(draft)) r.push('承诺时间或结果');
  const facts = Array.isArray(res.facts) ? res.facts : [];
  if (!facts.length && draft.trim()) r.push('没写依据');
  const bad = unverified(facts, ctx.commands || []);
  if (bad.length) r.push(`没查证：${bad.map((f) => f.claim).join('；').slice(0, 80)}`);
  if (facts.some(pendingMemory)) r.push('依据的记忆还待确认');
  if (ctx.firstContact) r.push('第一次找你的人');
  if (ctx.leader) r.push('你的上级');
  if (ctx.external) r.push('外部会话');
  return r;
}

export const finalTier = (res, reasons) => (reasons.length || !TIERS.includes(res.send_tier) ? 'hold' : res.send_tier);

// Claude Code 按目录存会话：非字母数字都换成 -
export const projectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
export function sessionCommands(cwd, session, home = os.homedir()) {
  const f = path.join(home, '.claude', 'projects', projectDir(cwd), `${session}.jsonl`);
  if (!session || !fs.existsSync(f)) return [];
  const out = [];
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    for (const c of (j.type === 'assistant' && Array.isArray(j.message?.content) ? j.message.content : [])) {
      if (c.type !== 'tool_use') continue;
      const i = c.input || {};
      if (i.command) out.push(i.command);
      else if (i.file_path) out.push(i.file_path);
      else if (i.pattern) out.push(squash(`${i.pattern} ${i.path || ''}`));
    }
  }
  return out;
}
