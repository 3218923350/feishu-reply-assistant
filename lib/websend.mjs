// 外部会话（飞书 230027：不让程序以我身份发）：用 Orca 内置浏览器里登录着的网页版飞书替我发
// 页面里一口气做完：搜会话 → 打开 → 核对标题 → 粘贴 → 再核对标题和内容 → 点发送；之后用 lark-cli 在 chat_id 里核对真发出去了
import fs from 'node:fs';
import path from 'node:path';
import { run } from './run.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/[\s​]/g, '').replace(/\[[^\]]{1,6}\]/g, ''); // [看] 这类表情网页会转成图

// 在页面里跑的脚本：返回 JSON 字符串 { sent: true } 或 { sent: false, why, dirty? }
export const pageScript = ({ name, group, text }) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 8000) => { for (let t = 0; t < ms; t += 250) { const v = f(); if (v) return v; await sleep(250); } return null; };
  const norm = (s) => String(s || '').replace(/[\\s\\u200b]/g, '').replace(/\\[[^\\]]{1,6}\\]/g, '');
  const NAME = ${JSON.stringify(name)}, TEXT = ${JSON.stringify(text)}, GROUP = ${!!group};
  const out = (o) => JSON.stringify(o);
  const paste = (el, s) => { el.focus(); const dt = new DataTransfer(); dt.setData('text/plain', s);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); };
  const header = () => document.querySelector('.chatWindow_chatName')?.textContent.trim();
  const composer = () => [...document.querySelectorAll('.lark__editor--container [contenteditable=true]')]
    .find((e) => !e.closest('.serp-nav') && e.getBoundingClientRect().height > 0);
  const empty = (ed) => { const t = norm(ed.innerText); return !t || t.startsWith('发送给'); };
  if (!(await until(() => document.querySelector('.a11y_feed_card_item'), 20000))) return out({ sent: false, why: '网页版飞书没加载出来（没登录或被挤下线）' });
  if (header() !== NAME) {
    const entry = [...document.querySelectorAll('p')].find((p) => p.textContent === '(⌘+K)')?.parentElement;
    if (!entry) return out({ sent: false, why: '找不到搜索框' });
    entry.click();
    const box = await until(() => document.querySelector('.serp-search-bar [contenteditable=true]'));
    if (!box) return out({ sent: false, why: '搜索框没打开' });
    paste(box, NAME);
    const title = (c) => (c.querySelector(GROUP ? '.chat-text-title' : '.user-chatter-info-name')?.textContent || '').trim().replace(/\\(\\d+\\)$/, '');
    const cards = await until(() => { const cs = [...document.querySelectorAll(GROUP ? '.group-chat-card' : '.user-result-card')].filter((c) => title(c) === NAME); return cs.length ? cs : null; });
    if (!cards) return out({ sent: false, why: '网页版飞书搜不到「' + NAME + '」' });
    if (cards.length > 1) return out({ sent: false, why: '网页版飞书搜到 ' + cards.length + ' 个同名的「' + NAME + '」' });
    cards[0].click();
    if (!(await until(() => header() === NAME))) return out({ sent: false, why: '没能打开和「' + NAME + '」的会话（当前是「' + header() + '」）' });
  }
  const ed = await until(composer);
  if (!ed) return out({ sent: false, why: '找不到输入框' });
  if (!empty(ed)) return out({ sent: false, why: '「' + NAME + '」的输入框里有没发出的内容，没动它' });
  paste(ed, TEXT);
  if (!(await until(() => norm(ed.innerText) === norm(TEXT), 3000))) return out({ sent: false, dirty: true, why: '粘贴进输入框的内容对不上' });
  const btn = document.querySelector('.send__button');
  if (!btn || btn.classList.contains('send__button--disable')) return out({ sent: false, dirty: true, why: '发送按钮不可用' });
  if (header() !== NAME) return out({ sent: false, dirty: true, why: '发送前会话变了（当前是「' + header() + '」）' });
  (btn.closest('button') || btn).click();
  await until(() => empty(ed), 5000);
  return out({ sent: true });
})()`;

const json = (r) => { try { return JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { return {}; } };

// 同一时间只有一个网页发送（网页版飞书只有一个标签页）
async function withLock(dir, fn) {
  const lock = path.join(dir, 'websend.lock');
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock, { recursive: false }); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 180_000) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
      if (i >= 90) return { ok: false, why: '网页版飞书正被另一次发送占着' };
      await sleep(1000);
    }
  }
  try { return await fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

// 网页版飞书标签页：放在助手仓库的 worktree 里，只留一个（多开会互相挤下线）
async function feishuTab(orca, repo, messenger) {
  const W = ['--worktree', `path:${repo}`];
  const tabs = json(await run(orca, ['tab', 'list', ...W, '--json'])).result?.tabs || [];
  const t = tabs.find((x) => /feishu\.cn\/next\/messenger/.test(x.url || ''));
  if (!t) return json(await run(orca, ['tab', 'create', ...W, '--url', messenger, '--json'])).result?.browserPageId;
  if (/degraded/.test(t.url)) await run(orca, ['goto', '--page', t.browserPageId, '--url', messenger, '--json']);
  return t.browserPageId;
}

// { ok: true, message_id } | { ok: false, why }（确定没发出）| { ok: false, unknown: true, why }（点了发送但没核对到）
// me：我的 open_id（核对消息是我发的）；messenger：租户网页版飞书的消息页
export function webSend({ name, group, chatId, text, orca, lark, repo, dir, me, messenger, pollMs = 3000 }) {
  return withLock(dir, async () => {
    const page = await feishuTab(orca, repo, messenger);
    if (!page) return { ok: false, why: 'Orca 里开不了网页版飞书（Orca 没开？）' };
    const r = await run(orca, ['eval', '--page', page, '--expression', pageScript({ name, group, text }), '--json'], { timeout: 90_000 });
    let res; try { res = JSON.parse(json(r).result?.result); } catch { res = { sent: false, why: `网页脚本没跑通：${(r.err || r.out).slice(0, 160)}` }; }
    if (!res.sent) {
      if (res.dirty) { await run(orca, ['keypress', '--worktree', `path:${repo}`, '--key', 'Meta+a', '--json']); await run(orca, ['keypress', '--worktree', `path:${repo}`, '--key', 'Backspace', '--json']); }
      return { ok: false, why: res.why };
    }
    for (let i = 0; i < 8; i++) {
      const l = json(await run(lark, ['im', '+chat-messages-list', '--as', 'user', '--chat-id', chatId, '--order', 'desc', '--page-size', '5', '--no-reactions']));
      const m = (l.data?.messages || []).find((x) => x.sender?.id === me && norm(x.content).includes(norm(text).slice(0, 40)));
      if (m) return { ok: true, message_id: m.message_id };
      await sleep(pollMs);
    }
    return { ok: false, unknown: true, why: '网页上点了发送，但在会话里没核对到这条消息' };
  });
}
