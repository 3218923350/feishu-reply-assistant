// 往草稿群发异常提醒：每类各自一小时最多一次（别刷屏，也别让一类提醒吃掉另一类，比如授权过期）
export function makeAlerter({ send, log, now = Date.now, windowMs = 3600_000 }) {
  const last = new Map();
  return async (msg, kind = 'other') => {
    log('ALERT', kind, msg);
    if (last.has(kind) && now() - last.get(kind) < windowMs) return;
    try { await send(`⚠️ 回复助手异常：${msg.slice(0, 500)}`); last.set(kind, now()); } catch (e) { log('alert failed', e.message); } // 没发出去不算，下一轮再试
  };
}
