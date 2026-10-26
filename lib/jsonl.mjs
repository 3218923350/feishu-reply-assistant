// 只追加的 jsonl（事件、跟进、承诺账本）：写到一半崩了会留下坏行，读的时候跳过，别让一行坏数据卡住整轮
import fs from 'node:fs';

export function readJsonl(file, { onBad = () => {} } = {}) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch (e) { onBad(l, e); }
  }
  return out;
}
