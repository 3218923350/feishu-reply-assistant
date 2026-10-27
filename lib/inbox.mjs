// 收件箱判断：这条是不是我已经回过了、要不要起草

// 时间都是 lark-cli 的 "YYYY-MM-DD HH:MM"（北京时间），字符串比较即可
// 这条之后我的哪些消息算是回了它：私聊主消息流里我说的都算；私聊话题和群里只认引用它、同一话题或 @ 发送人
// 「我看看 / 稍等 / 我查一下」只是先占个位，事情还没答：不算回过（助手照样起草、卡片不收起）
const HOLD = /^(好的?|嗯+|ok|收到)?(我)?(先|来)?(看看|看下|看一下|看一眼|瞅瞅|瞅一眼|查查|查下|查一下|稍等|等下|等一下|马上)(哈|啊|吧|呢|哦)?$/i;
const strip = (t) => String(t || '').replace(/@\S+/g, '').replace(/[\s\p{P}~]/gu, '');
const isHold = (t) => HOLD.test(strip(t));

export function myReplies(m, laterMsgs, me) {
  const mineAfter = laterMsgs.filter((x) => x.sender?.id === me && x.create_time >= m.create_time && !isHold(x.content));
  if (m.chat_type === 'p2p') {
    if (!m.thread_id) return mineAfter;
    // 私聊话题里，别把我在另一个话题里说的话误算成对这条的回复
    return mineAfter.filter((x) => x.thread_id === m.thread_id || x.reply_to === m.message_id);
  }
  return mineAfter.filter((x) => x.reply_to === m.message_id
    || (m.thread_id && x.thread_id === m.thread_id)
    || (x.mentions || []).some((u) => u.id === m.sender?.id));
}
export const repliedTo = (m, laterMsgs, me) => myReplies(m, laterMsgs, me).length > 0;

// 已知话题的自动跟随只认原收件人的新回复；别人插话仍要 @我 才处理
export function watchedThreadReply(m, thread, seen, me) {
  if (!thread?.watch_sender_id || !thread.thread_id) return false;
  if (m.message_id === thread.root_message_id || m.sender?.id === me || m.sender?.id !== thread.watch_sender_id) return false;
  if (m.sender?.sender_type && m.sender.sender_type !== 'user') return false;
  return !seen[m.message_id];
}

export const shouldDraft = (m, state) => !Object.values(state.items).some((it) => it.orig?.message_id === m.message_id || it.orig?.burst?.includes(m.message_id));

// 纯确认（好的 / OK / 谢谢 / 表情）：不用起草，省一次 Claude
const ACK = /^(好的?|好滴|好嘞|好哒|嗯+|哦+|ok+|okay|收到|了解|明白了?|谢谢|谢了|多谢|感谢|辛苦了?|thx|thanks|👍|🙏)+$/i;
export function isAck(text) {
  const noAt = String(text || '').replace(/@\S+/g, '').trim();
  if (!noAt) return false; // 只 @ 了我（常跟在「@别人 帮忙点一下」后面）：是在叫我
  const t = noAt.replace(/\[[^\]]{1,8}\]|:[A-Za-z_]+:/g, '').replace(/[\s\p{P}~]/gu, '');
  return t === '' || ACK.test(t);
}
// 一批消息都是纯确认、且我上一句不是在问对方 → 跳过（我问了「行吗？」对方回「好的」可能要接着办）
export function skipAck(msgs, ctxMsgs, me) {
  if (!msgs.every((x) => isAck(x.content))) return false;
  const first = msgs[0].create_time;
  const lastMine = ctxMsgs.filter((x) => x.sender?.id === me && x.create_time <= first && !msgs.some((y) => y.message_id === x.message_id)).at(-1);
  return !/[?？]|[吗么呢]\s*$/.test(lastMine?.content || '');
}

// 同一会话、同一个人、同一话题里的连发算一件事，合起来起草一次
export const burstKey = (m) => `${m.chat_id}|${m.sender?.id}|${m.thread_id || ''}`;
export function nextBatches(queue, busy, now = Date.now()) {
  const groups = new Map();
  for (const m of queue) (groups.get(burstKey(m)) || groups.set(burstKey(m), []).get(burstKey(m))).push(m);
  return [...groups.entries()].filter(([k, ms]) => !busy.has(k) && !ms.some((x) => x.retryAt && x.retryAt > now))
    .map(([, ms]) => ms.sort((a, b) => String(a.create_time).localeCompare(b.create_time)));
}

// 一条消息处理完：成功出队；失败留着稍后重试，连续失败 3 次才放弃
const MAX_ATTEMPTS = 3;
export function settle(state, id, ok) {
  const m = state.queue.find((x) => x.message_id === id);
  if (!m) return 'done';
  if (!ok && (m.attempts = (m.attempts || 0) + 1) < MAX_ATTEMPTS) { m.retryAt = Date.now() + m.attempts * 5 * 60_000; return 'retry'; }
  state.queue = state.queue.filter((x) => x.message_id !== id);
  return ok ? 'done' : 'drop';
}

// 卡片发出后（since 之后）我在原会话亲自回了它：卡片可以收起。助手以我身份发的（sent）不算
export const handledBy = (orig, laterMsgs, me, sent, since) =>
  myReplies(orig.sender ? orig : { ...orig, sender: { id: orig.sender_id } }, laterMsgs, me).filter((x) => !sent.has(x.message_id) && x.create_time >= since)
    .sort((a, b) => String(a.create_time).localeCompare(b.create_time));
