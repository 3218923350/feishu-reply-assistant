// 不等确认直接发：哪些草稿能直接发、发出去带什么、要查很久时先回对方一句。纯函数，assistant.mjs / fr 用
import { claims } from './promise.mjs';

// 起草判定「直接发」、硬规则也没拦下的现成回复：不要我批操作、没有做完才能说的话、没答应还没做的事、没说没验证的「已经好了」
export function autoSendable(res, shadow) {
  if (shadow?.tier !== 'auto' || res.kind !== 'answer' || !res.draft?.trim()) return false;
  if (res.options?.length || res.draft_after?.trim()) return false;
  const c = claims(res.draft);
  return !c.promise.length && !c.done.length;
}

// 不等我确认发出去的：结尾一行署名，对方知道这条是助手代回的
export const signed = (text, signature) => (signature ? `${String(text).trimEnd()}\n${signature}` : String(text));

// 草稿里用了 markdown（列表、代码、链接、加粗、标题）就按富文本发，飞书会排好版；没用就发纯文本
const MD = /^\s*([-*+]|\d+[.)])\s|`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/|^#{1,6}\s/m;
export const msgArgs = (text) => (MD.test(text) ? ['--markdown', text] : ['--text', text]);

// 草稿里留着「我再去看下 / 还在查」：没查完就交了，接着查一轮
const UNFINISHED = /我再(去|来)?(看|查|拉|核|试|确认|对)(一?下|一遍|看)?|还在(查|看|核|拉|捞)|我先(去|自己)?(看|查|核|拉)(一?下|一遍)|(核|查|拉|捞)完(再|了再)(发|给|回|说|贴)|晚点(给|发|回|再)/;
export const unfinished = (draft) => String(draft || '').match(UNFINISHED)?.[0] || null;

// 要查很久时先回对方一句：只在私聊（群里常是 @ 了好几个人、不一定是我要接的事，回「我看一下」反而不好）；同一个会话 2 小时内回过（先回的、或者发过的）就不再回，免得刷屏
export function ackAllowed({ events, chatId, chatType, now, leader, external }) {
  if (chatType !== 'p2p' || leader || external) return false;
  return !events.some((e) => ['ack', 'sent', 'fr-sent'].includes(e.kind) && (e.chat_id === chatId || e.orig?.chat_id === chatId) && now - Date.parse(e.ts) < 2 * 3600_000);
}
