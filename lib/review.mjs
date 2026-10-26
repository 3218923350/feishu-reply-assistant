// 记忆日报卡下我的回复：「1 3 确认，2 删，5 结」→ 要确认 / 删除 / 结案的条目。看不懂就返回 null
const VERB = { 确认: 'accept', 通过: 'accept', 接受: 'accept', ok: 'accept', 删: 'reject', 删除: 'reject', 不要: 'reject', 拒绝: 'reject', 结: 'close', 结案: 'close', 完成: 'close', 办完: 'close', done: 'close' };
const TOKEN = /(\d+\s*[-~到]\s*\d+|\d+|全部|所有|都|确认|通过|接受|ok|删除|删|不要|拒绝|结案|结|完成|办完|done)/gi;
const KIND = { accept: ['pending'], reject: ['pending'], close: ['overdue', 'open'] };

export function parseReview(text, items) {
  const t = String(text || '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/@\S+/g, ' ');
  const tokens = t.match(TOKEN) || [];
  const verbFirst = tokens.length && !/^\d|^(全部|所有|都)$/.test(tokens[0]);
  const out = { accept: [], reject: [], close: [], bad: [] };
  let nums = [], all = false, verb = null, used = false;
  const flush = (v) => {
    if (!v || (!nums.length && !all)) return;
    const pick = all ? items.filter((x) => KIND[v].includes(x.kind)) : nums.map((n) => items.find((x) => x.n === n) || n);
    for (const x of pick) (typeof x === 'object' && KIND[v].includes(x.kind) ? out[v] : out.bad).push(typeof x === 'object' ? x : x);
    nums = []; all = false; used = true;
  };
  for (const tok of tokens) {
    const v = VERB[tok.toLowerCase()];
    if (v) { if (verbFirst) { flush(verb); verb = v; } else flush(v); continue; }
    if (/^(全部|所有|都)$/.test(tok)) { all = true; continue; }
    const [a, b] = tok.split(/\s*[-~到]\s*/).map(Number);
    for (let n = a; n <= (b ?? a); n++) nums.push(n);
  }
  if (verbFirst) flush(verb);
  if (!used || nums.length) return null; // 有编号没说怎么处理，宁可问
  out.bad = out.bad.map((x) => x.n ?? x);
  return out;
}
