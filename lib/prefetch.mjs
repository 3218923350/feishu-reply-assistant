// 起草前预取（零 LLM）：人物卡、相关记忆、我在这个会话说过的话、本地 agent 会话片段。各路独立超时，取不到就写进【没取到】
import fs from 'node:fs';

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const fmtBJ = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 19) + '+08:00';
const tag = (h) => `[${h.type}${h.review === 'pending' ? '|待确认' : ''}${h.status && h.status !== 'active' ? '|' + h.status : ''}]`;

async function json(run, cmd, args, timeout) {
  const r = await run(cmd, args, { timeout });
  if (r.code === null) throw new Error('超时');
  if (r.code !== 0) throw new Error(`退出码 ${r.code}`);
  try { return JSON.parse(r.out); } catch { throw new Error(`输出无法解析：${cut(r.out || r.err, 60)}`); }
}

// 检索词：去掉 @ 和我自己的名字（几乎每条记忆都提到我），带上最近几条上下文（「给我账号码」这种关键词常在前文）
const queryOf = (orig, ignore) => ignore.reduce((t, w) => (w ? t.replaceAll(w, ' ') : t), `${orig.content || ''} ${orig.recent || ''}`.replace(/@\S+/g, ' ')).replace(/\s+/g, ' ').trim();
// 记忆抽取等批处理会话（cwd 在数据目录下）什么都包含，不算参考
const isMeta = (h, home) => `${h.cwd}/`.startsWith(`${home}/`) || /\/\.feishu-reply-assistant\//.test(`${h.cwd}/`);

// bins：{ mem, lark, orca } 命令路径；me：我的 open_id；ignore：检索时去掉的词（我的名字）
export async function prefetch(orig, { run, now = Date.now(), bins, me, ignore = [], home = '' }) {
  const content = queryOf(orig, ignore);
  const jobs = {
    人物卡: orig.sender_name ? json(run, bins.mem, ['who', orig.sender_name, ...(orig.sender_id ? ['--id', orig.sender_id] : []), '--json'], 3000) : null,
    相关记忆: content ? json(run, bins.mem, ['search', content.slice(0, 200), '--json', '--limit', '8'], 3000) : null,
    我的历史发言: orig.chat_id ? json(run, bins.lark, ['im', '+messages-search', '--as', 'user', '--query', '', '--sender', me, '--chat-id', orig.chat_id,
      '--start', fmtBJ(now - 90 * 86400_000), '--end', fmtBJ(now + 60_000), '--page-size', '20', '--no-reactions'], 10_000) : null,
    本地会话: content && bins.orca ? json(run, bins.orca, ['search', content.slice(0, 60), '--limit', '6', '--json'], 3000) : null, // 没装 Orca 就不搜
  };
  const names = Object.keys(jobs);
  const settled = await Promise.allSettled(names.map((k) => jobs[k]));
  const got = {}, gaps = [];
  settled.forEach((s, i) => (s.status === 'fulfilled' ? (got[names[i]] = s.value) : gaps.push(`${names[i]}：${s.reason.message}`)));

  const person = got.人物卡?.person || [];
  const memories = [...(got.人物卡?.related || []), ...(Array.isArray(got.相关记忆) ? got.相关记忆 : [])];
  const memoryPaths = [...new Set([...person, ...memories].map((h) => h.path))];

  const sec = [];
  // 本人卡直接给全文，省一轮 Read
  const card = person[0] && (() => { try { return fs.readFileSync(person[0].path.split('#')[0], 'utf8'); } catch { return person[0].snippet; } })();
  sec.push('【这个人】', person.length ? `${person[0].title}（${person[0].path}）\n${cut(card, 1500)}` : '（记忆里没有这个人）');
  const seen = new Set(person.slice(0, 1).map((h) => h.path));
  const mems = memories.filter((h) => !seen.has(h.path) && seen.add(h.path));
  sec.push('', '【相关记忆】', mems.length ? mems.map((h) => `- ${tag(h)} ${h.title} — ${h.path}\n  ${cut(h.snippet, 160)}`).join('\n') : '（没有命中）');
  const mine = (got.我的历史发言?.data?.messages || []).sort((a, b) => String(b.create_time).localeCompare(a.create_time)).slice(0, 10);
  sec.push('', '【我以前在这个会话说过】', mine.length ? mine.map((m) => `[${m.create_time}] ${cut(m.content, 200)}`).join('\n') : '（近 90 天没有）');
  const hits = (got.本地会话?.result?.hits || []).filter((h) => !isMeta(h, home || '\0')).slice(0, 3);
  if (bins.orca) sec.push('', '【本地 agent 会话片段】', hits.length
    ? hits.map((h) => `- ${cut(h.title, 60)}（${h.agent} ${h.cwd} 会话 ${h.sessionId}）\n  ${cut(h.evidence?.snippet, 160)}`).join('\n') : '（没有命中）');
  if (gaps.length) sec.push('', '【没取到】', gaps.map((g) => `- ${g}`).join('\n'));
  return { text: sec.join('\n'), memoryPaths };
}
