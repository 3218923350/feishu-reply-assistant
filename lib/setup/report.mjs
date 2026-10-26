// doctor --report：给 Issue 用的诊断报告。Issues 是公开的：人名、群名、消息正文、各种 id 都换成占位符，key 脱敏
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../memory/secrets.mjs';
import { listEntries } from '../memory/store.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 同一个值每次都换成同一个编号，编号按第一次出现的顺序
function stable(text, re, label) {
  const seen = new Map();
  return text.replace(re, (m, ...g) => {
    const k = label(m, ...g);
    if (!seen.has(m)) seen.set(m, `${k}#${[...seen.keys()].filter((x) => label(x) === k).length + 1}`);
    return seen.get(m);
  });
}
const CONTENT = /^((?:\S+ )?(?:process|candidate|skip|draft)\b.*?): .*$/; // 这几类日志后面跟的是消息正文
const TAIL = /^((?:\S+ )?(?:ALERT \S+|ERR jsonl)) .*$/; // 提醒和坏行日志里也可能带正文：整段去掉
const STAMP = /^\d{4}-\d{2}-\d{2}T/; // 一条日志的开头；正文可能有多行，到下一条日志之前都算正文

export function anonymize(text, { names = [], prefixes = [], home = '' } = {}) {
  let t = redact(String(text), { prefixes }).text;
  if (home && home.length > 1) t = t.replaceAll(home, '~'); // 本机用户名常是真名
  t = t.replace(/\b(https?:\/\/)[^\/\s"']+/g, '$1<主机>'); // 公司域名
  t = stable(t, /\b(ou|oc|om|omt|on|cli)_[A-Za-z0-9]+/g, (m) => m.split('_')[0]);
  const ns = [...new Set(names.filter((n) => n && n.length >= 2))].sort((a, b) => b.length - a.length);
  if (ns.length) t = stable(t, new RegExp(ns.map(esc).join('|'), 'g'), () => '人');
  let body = false;
  return t.split('\n').map((l) => {
    const m = l.match(CONTENT);
    if (m) { body = true; return `${m[1]}: …`; }
    const a = l.match(TAIL);
    if (a) { body = true; return `${a[1]}: …`; }
    if (STAMP.test(l)) body = false;
    return body ? '…' : l;
  }).join('\n');
}

// 报告里要替换掉的名字和 key 前缀。配置读不到（正是来提 Issue 的时候）也要尽量收全：坏配置里能抠出来的、日志固定格式、事件、跟进、state、记忆人物卡
export function reportNames(home, cfg) {
  const names = [];
  let prefixes = cfg?.secretPrefixes || [];
  if (cfg) names.push(cfg.name, ...cfg.leaders);
  else {
    const raw = (() => { try { return fs.readFileSync(path.join(home, 'config.json'), 'utf8'); } catch { return ''; } })();
    names.push(...[...raw.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]));
    names.push(...[...(raw.match(/"leaders"\s*:\s*\[([^\]]*)\]/)?.[1] || '').matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    prefixes = [...(raw.match(/"secret_prefixes"\s*:\s*\[([^\]]*)\]/)?.[1] || '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }
  const read = (f) => { try { return fs.readFileSync(path.join(home, f), 'utf8'); } catch { return ''; } };
  for (const m of read('assistant.log').matchAll(/ process (.+?) @ (.+?)(?:（\d+ 条连发）)?: /g)) names.push(m[1], m[2]);
  for (const m of read('assistant.log').matchAll(/ (?:draft \w+|sent →|candidate|work (?:start|done)) (\S+)/g)) names.push(m[1]);
  const jsonl = (t) => t.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  let evs = [];
  try { evs = fs.readdirSync(path.join(home, 'events')).flatMap((f) => jsonl(read(path.join('events', f)))); } catch {}
  for (const e of [...evs, ...jsonl(read('followups.jsonl'))]) names.push(e.toName, e.orig?.sender_name, e.orig?.chat_name, e.watch?.name);
  try { for (const it of Object.values(JSON.parse(read('state.json')).items || {})) names.push(it.orig?.sender_name, it.orig?.chat_name); } catch {}
  try { for (const e of listEntries(cfg?.memoryDir || path.join(home, 'memory'))) if (e.meta.type === 'person') names.push(e.meta.entities?.[0]); } catch {}
  return { names: [...new Set(names.filter((n) => typeof n === 'string' && n.length >= 2 && !/^(ou|oc|om)_/.test(n)))].sort((a, b) => b.length - a.length), prefixes };
}
