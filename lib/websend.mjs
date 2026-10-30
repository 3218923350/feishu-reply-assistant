// 外部会话（飞书 230027：不让程序以我身份发）：用 Orca 内置浏览器里登录着的网页版飞书替我发
// 一步一段短脚本（搜会话 → 打开 → 核对标题 → 粘贴 → 核对内容 → 点发送），等待都在这边轮询：
// 以前一段长的异步脚本一口气做完，页面中途换了执行上下文就整段失败（10-29：外部会话发了 20 次只成 4 次，多数是 Cannot find default execution context）
// 发完用 lark-cli 在 chat_id 里核对真发出去了
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as runProc } from './run.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/[\s​]/g, '').replace(/\[[^\]]{1,6}\]/g, ''); // [看] 这类表情网页会转成图
const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

// 每段脚本都带上的页面工具函数；脚本都是同步的，返回 JSON 字符串
const LIB = `
  const norm = (s) => String(s || '').replace(/[\\s\\u200b]/g, '').replace(/\\[[^\\]]{1,6}\\]/g, '');
  const paste = (el, s) => { el.focus(); const dt = new DataTransfer(); dt.setData('text/plain', s);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); };
  const header = () => norm(document.querySelector('.chatWindow_chatName')?.textContent);
  const composer = () => [...document.querySelectorAll('.lark__editor--container [contenteditable=true]')]
    .find((e) => !e.closest('.serp-nav') && e.getBoundingClientRect().height > 0);
  const empty = (ed) => { const t = norm(ed.innerText); return !t || t.startsWith('发送给'); };
  const searchBox = () => document.querySelector('.serp-search-bar [contenteditable=true]');
  const title = (c, group) => norm(c.querySelector(group ? '.chat-text-title' : '.user-chatter-info-name')?.textContent).replace(/\\(\\d+\\)$/, '');
  const hits = (name, group) => [...document.querySelectorAll(group ? '.group-chat-card' : '.user-result-card')].filter((c) => title(c, group) === norm(name));
  const out = (o) => JSON.stringify(o);`;
const js = (vars, body) => `(() => {${LIB}\n${Object.entries(vars).map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`).join(' ')}\n${body}\n})()`;

// 只读的探测可以反复跑；有副作用的动作只跑一次（重试只在脚本根本没跑起来时）
export const steps = {
  probe: () => js({}, `return out({ loaded: !!document.querySelector('.a11y_feed_card_item'), header: header(), composer: !!composer(), empty: !composer() || empty(composer()) });`),
  openSearch: () => js({}, `const entry = [...document.querySelectorAll('p')].find((p) => p.textContent === '(⌘+K)')?.parentElement;
    if (!entry) return out({ ok: false, why: '找不到搜索框' }); entry.click(); return out({ ok: true });`),
  searchReady: () => js({}, `return out({ ready: !!searchBox() });`),
  typeSearch: (name) => js({ NAME: name }, `const box = searchBox(); if (!box) return out({ ok: false, why: '搜索框没打开' }); paste(box, NAME); return out({ ok: true });`),
  results: (name, group) => js({ NAME: name, GROUP: !!group }, `return out({ n: hits(NAME, GROUP).length });`),
  pick: (name, group) => js({ NAME: name, GROUP: !!group }, `const cs = hits(NAME, GROUP); if (cs.length !== 1) return out({ ok: false, n: cs.length }); cs[0].click(); return out({ ok: true });`),
  // 输入框里已经是这段话（上次其实贴上了、只是回执丢了）就不再贴
  pasteText: (text) => js({ TEXT: text }, `const ed = composer(); if (!ed) return out({ ok: false, why: '找不到输入框' });
    if (norm(ed.innerText) === norm(TEXT)) return out({ ok: true });
    if (!empty(ed)) return out({ ok: false, why: '输入框里有没发出的内容，没动它' }); paste(ed, TEXT); return out({ ok: true });`),
  composed: (text) => js({ TEXT: text }, `const ed = composer(); return out({ same: !!ed && norm(ed.innerText) === norm(TEXT) });`),
  send: (name) => js({ NAME: name }, `if (header() !== norm(NAME)) return out({ ok: false, why: '发送前会话变了（当前是「' + header() + '」）' });
    const btn = document.querySelector('.send__button');
    if (!btn || btn.classList.contains('send__button--disable')) return out({ ok: false, why: '发送按钮不可用' });
    (btn.closest('button') || btn).click(); return out({ ok: true });`),
  clear: () => js({}, `const ed = composer(); if (ed) { ed.focus(); document.execCommand('selectAll'); document.execCommand('delete'); } return out({ ok: true });`),
};

// 页面上的一步：脚本没跑起来（执行上下文没了、标签页被换掉）就等一下重来，最多 tries 次
async function step(ctx, expr) {
  let why = '';
  for (let i = 0; i < ctx.tries; i++) {
    const r = await ctx.evaluate(expr);
    if (r.ok) { try { return JSON.parse(r.value); } catch { why = `脚本返回的不是 JSON：${cut(r.value, 80)}`; } }
    else why = r.why;
    if (/tab_not_found|no longer available/i.test(why) && ctx.reopen) await ctx.reopen();
    await sleep(ctx.retryMs);
  }
  throw new Error(`网页脚本没跑通（${cut(why, 120)}）`);
}
// 反复跑只读探测，直到 ok(v)；超时返回 null
async function until(ctx, expr, ok, ms) {
  for (const t0 = Date.now(); Date.now() - t0 < ms * ctx.scale; await sleep(ctx.tickMs)) {
    const v = await step(ctx, expr);
    if (ok(v)) return v;
  }
  return null;
}

// 在已经打开的网页版飞书里发一条：{ sent: true } | { sent: false, why, dirty? }（dirty：输入框里可能留了半截，已经清掉）
export async function sendInPage(ctx, { name, group, text }) {
  ctx = { tries: 3, retryMs: 1500, tickMs: 300, scale: 1, ...ctx }; // scale：测试里把等待缩短
  try {
    const p = await until(ctx, steps.probe(), (v) => v.loaded, 20_000);
    if (!p) return { sent: false, why: '网页版飞书没加载出来（没登录或被挤下线）' };
    if (p.header !== norm(name)) {
      const o = await step(ctx, steps.openSearch());
      if (!o.ok) return { sent: false, why: o.why };
      if (!(await until(ctx, steps.searchReady(), (v) => v.ready, 8000))) return { sent: false, why: '搜索框没打开' };
      const t = await step(ctx, steps.typeSearch(name));
      if (!t.ok) return { sent: false, why: t.why };
      const r = await until(ctx, steps.results(name, group), (v) => v.n > 0, 12_000);
      if (!r) return { sent: false, why: `网页版飞书搜不到「${name}」` };
      if (r.n > 1) return { sent: false, why: `网页版飞书搜到 ${r.n} 个同名的「${name}」` };
      await step(ctx, steps.pick(name, group));
      if (!(await until(ctx, steps.probe(), (v) => v.header === norm(name), 8000))) return { sent: false, why: `没能打开和「${name}」的会话` };
    }
    if (!(await until(ctx, steps.probe(), (v) => v.composer, 8000))) return { sent: false, why: '找不到输入框' };
    const pt = await step(ctx, steps.pasteText(text));
    if (!pt.ok) return { sent: false, why: pt.why };
    const dirty = async (why) => { await step(ctx, steps.clear()).catch(() => {}); return { sent: false, dirty: true, why }; };
    if (!(await until(ctx, steps.composed(text), (v) => v.same, 3000))) return dirty('粘贴进输入框的内容对不上');
    const s = await step(ctx, steps.send(name)).catch((e) => ({ ok: false, why: e.message }));
    // 点上了、或者没拿到回执但输入框已经清空：都去会话里核对（核对不到算「结果未知」，不算没发）
    if (await until(ctx, steps.probe(), (v) => v.empty, s.ok ? 5000 : 1000) || s.ok) return { sent: true };
    return dirty(s.why);
  } catch (e) { return { sent: false, why: e.message }; }
}

const json = (r) => { try { return JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { return {}; } };

// 同一时间只有一个网页发送：整台机器一把锁（助手、办事里的 fr、别的实例共用一个网页版飞书标签页）；桌面客户端那条路也用它，staleMs 放长
export async function withLock(lock, fn, { staleMs = 180_000, waitS = 90, busy = '网页版飞书正被另一次发送占着' } = {}) {
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock, { recursive: false }); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
      if (i >= waitS) return { ok: false, why: busy };
      await sleep(1000);
    }
  }
  try { return await fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

// 点了发送之后去会话里核对：最近几条里有我发的、开头对得上的就算发出去了
export async function confirmSent({ run = runProc, lark, chatId, me, text, pollMs = 3000, tries = 8 }) {
  for (let i = 0; i < tries; i++) {
    const l = json(await run(lark, ['im', '+chat-messages-list', '--as', 'user', '--chat-id', chatId, '--order', 'desc', '--page-size', '5', '--no-reactions']));
    const m = (l.data?.messages || []).find((x) => x.sender?.id === me && norm(x.content).includes(norm(text).slice(0, 40)));
    if (m) return m.message_id;
    await sleep(pollMs);
  }
  return null;
}

// 网页版飞书标签页：有就用（哪个 worktree 里的都行），没有才在助手仓库的 worktree 里开一个——同一账号开两个会互相挤下线
export async function feishuTab(orca, repo, messenger, run = runProc) {
  const all = json(await run(orca, ['tab', 'list', '--worktree', 'all', '--json'])).result?.tabs || [];
  const mine = (t) => String(t.worktreeId || '').endsWith(`::${repo}`);
  const tabs = all.filter((x) => /feishu\.cn\/next\/messenger/.test(x.url || '')).sort((a, b) => mine(b) - mine(a));
  const t = tabs[0];
  if (!t) return json(await run(orca, ['tab', 'create', '--worktree', `path:${repo}`, '--url', messenger, '--json'])).result?.browserPageId;
  if (/degraded/.test(t.url)) await run(orca, ['goto', '--page', t.browserPageId, '--url', messenger, '--json']);
  return t.browserPageId;
}

// { ok: true, message_id } | { ok: false, why }（确定没发出）| { ok: false, unknown: true, why }（点了发送但没核对到）
// me：我的 open_id（核对消息是我发的）；messenger：租户网页版飞书的消息页
export function webSend({ name, group, chatId, text, orca, lark, repo, me, messenger, pollMs = 3000, run = runProc, lock = path.join(os.tmpdir(), 'fra-websend.lock') }) {
  return withLock(lock, async () => {
    let page = await feishuTab(orca, repo, messenger, run);
    if (!page) return { ok: false, why: 'Orca 里开不了网页版飞书（Orca 没开？）' };
    const evaluate = async (expr) => {
      const r = await run(orca, ['eval', '--page', page, '--expression', expr, '--json'], { timeout: 30_000 });
      const j = json(r);
      return typeof j.result?.result === 'string' ? { ok: true, value: j.result.result } : { ok: false, why: j.error?.message || r.err || r.out || `orca eval 退出码 ${r.code}` };
    };
    const res = await sendInPage({ evaluate, reopen: async () => { page = (await feishuTab(orca, repo, messenger, run)) || page; } }, { name, group, text });
    if (!res.sent) return { ok: false, why: res.why };
    const id = await confirmSent({ run, lark, chatId, me, text, pollMs });
    return id ? { ok: true, message_id: id } : { ok: false, unknown: true, why: '网页上点了发送，但在会话里没核对到这条消息' };
  });
}
