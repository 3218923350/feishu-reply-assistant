// fr：办事阶段 Claude 发消息 / 挂跟进的规则（纯函数），以及草稿群卡片的渲染
import crypto from 'node:crypto';

const norm = (s) => String(s || '').replace(/[\s​-‏⁠﻿]/g, '');

// --why 必须是我那句话里的原文片段：模型不能自己声称「已批准」；否定语境里的片段（「先不要发」里的「要发」）不算
const NEG = /[不别勿]$/;
export function whyOk(authText, why) {
  const a = norm(authText), w = norm(why);
  if (w.length < 2 || /^[不别勿]/.test(w)) return false;
  for (let i = a.indexOf(w); i >= 0; i = a.indexOf(w, i + 1)) if (!NEG.test(a.slice(Math.max(0, i - 2), i))) return true;
  return false;
}

// 收件人范围：原消息 / 原会话 / 原发送人，或我那句话里点了名的人或群
export function inScope(ctx, t) {
  const o = ctx.orig;
  if (t.kind === 'orig') return true;
  if (t.kind === 'chat' && t.id === o.chat_id) return true;
  if (t.kind === 'user' && t.id === o.sender_id) return true;
  return norm(t.name).length >= 2 && norm(ctx.authText).includes(norm(t.name));
}

// 我那句话太短（比如只回了「bu」）：读不出要发一段新写的话，只允许发卡上现成的草稿
export const tooShortToCompose = (ctx, text) => norm(ctx.authText).length < 4 && String(text).trim() !== String(ctx.draft || '').trim();

export const dedupKey = (card, to, text) => crypto.createHash('sha1').update(`${card}\n${to}\n${text}`).digest('hex').slice(0, 16);

// 跟进日志（只追加）：add / fired / done → 还在等的
export function activeFollowups(log, now = Date.now()) {
  const fired = new Set(log.filter((r) => r.op === 'fired').map((r) => r.id));
  const doneCards = new Set(log.filter((r) => r.op === 'done').map((r) => r.card));
  return log.filter((r) => r.op === 'add' && !fired.has(r.id) && !doneCards.has(r.card) && r.until > now);
}
// 只认原来那个会话：记了会话就按会话；旧记录里等的是原发送人 → 原会话；等第三人又没记会话 → 只认他的私聊
const watchChat = (f) => f.watch.chat_id || (f.watch.open_id === f.orig?.sender_id ? f.orig?.chat_id : null);
// 还在等、绑在群里的跟进：群里不 @我 的回复收件箱搜不到，要单独去拉这个群（和原话题）
export const followupChats = (log, now = Date.now()) => [...new Map(activeFollowups(log, now)
  .filter((f) => watchChat(f) && !(watchChat(f) === f.orig?.chat_id && f.orig?.chat_type === 'p2p'))
  .map((f) => [watchChat(f), { chat_id: watchChat(f), thread_id: f.orig?.thread_id || null }])).values()];
export const matchFollowup = (msg, log, now) =>
  activeFollowups(log, now).find((f) => f.watch.open_id === msg.sender?.id
    && (watchChat(f) ? msg.chat_id === watchChat(f) : msg.chat_type === 'p2p')) || null;


const memTitle = (p) => { const t = String(p).split('/').pop().replace(/\.md(#\d+)?$/, ''); return t.length > 40 ? t.slice(0, 40) + '…' : t; };


// 办事终端的标题
export const workTitle = (o) => `办·${o.sender_name}`;

// 助手以我身份发出去的消息 id（fr、「发」）：别当成我在卡片下说的话，也别当成我亲自回过
export const sentIds = (events) => new Set(events.filter((e) => ['fr-sent', 'sent', 'ack'].includes(e.kind) && e.message_id).map((e) => e.message_id));

