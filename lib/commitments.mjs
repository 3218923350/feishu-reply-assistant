// 承诺账本（只追加）：话发出去了、答应的事还没做。add → kept（做完、验证过、也告诉对方了）/ dropped（不做了，要发更正）；reminded 只提醒一次
import crypto from 'node:crypto';
import { claims } from './promise.mjs';

const URGENT = /现在|马上|这就|等下|待会|稍后|一会/;

// 一条发出去的消息 → 承诺记录；没承诺返回 null
export function fromSend(text, { card, session = null, to = null, toName = '', message_id = null, at = Date.now() }) {
  const p = claims(text).promise;
  if (!p.length) return null;
  return { op: 'add', id: crypto.randomUUID(), at, card, session, to, toName, message_id, what: p.join('；'), text: String(text).slice(0, 500), urgent: p.some((x) => URGENT.test(x)) };
}

export function openCommitments(log, { session, card } = {}) {
  const closed = new Set(log.filter((r) => r.op === 'kept' || r.op === 'dropped').map((r) => r.id));
  return log.filter((r) => r.op === 'add' && !closed.has(r.id) && (!session || r.session === session) && (!card || r.card === card));
}

// 急的（说了「现在 / 马上」）30 分钟还没做 → 提醒一次；不急的在日报里列
export function dueReminders(log, now = Date.now()) {
  const reminded = new Set(log.filter((r) => r.op === 'reminded').map((r) => r.id));
  return openCommitments(log).filter((r) => r.urgent && !reminded.has(r.id) && now - r.at >= 30 * 60_000);
}
