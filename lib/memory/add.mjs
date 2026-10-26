// 写入记忆：新建 / 追加 / 进 inbox / 标冲突；key 原样保存（用户允许，外传另有把关）；路径只认记忆库里的条目
import fs from 'node:fs';
import path from 'node:path';
import { TYPE_DIRS, entryPath, findMatch, listEntries, parseEntry, serializeEntry } from './store.mjs';

const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10); // 北京时间
const DATED = /^\d{4}-\d{2}-\d{2}/;
const STATUSES = ['active', 'superseded', 'conflict', 'open', 'overdue', 'done'];
const MEMORY_DIRS = [...Object.values(TYPE_DIRS), 'inbox'];

// 一段内容 → 事实块：首行没日期就补 observed
function block(content, observed) {
  const text = String(content ?? '').trim();
  return DATED.test(text) || !observed ? text : `${observed} ${text}`;
}

// 来源统一成「会话#message_id」：去掉模型顺手加的「 (2026-10-22 16:50)」「（10-22）」后缀，同一条消息不出现两种写法
const source = (s) => String(s).trim().replace(/\s*[(（][^()（）]*[)）]$/, '');
const same = (s) => s.replace(/[\s\p{P}\p{S}]/gu, '');
const plusDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

const read = (p) => parseEntry(fs.readFileSync(p, 'utf8'));
const write = (p, e) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, serializeEntry(e)); };

// 模型给的路径：解开符号链接后必须落在记忆库的记忆目录里、是已存在的 .md，否则当没给
function memoryFile(root, p) {
  if (!p) return null;
  const abs = path.resolve(root, String(p));
  if (!abs.endsWith('.md') || !fs.existsSync(abs)) return null;
  const real = fs.realpathSync(abs), base = fs.realpathSync(root);
  const rel = path.relative(base, real);
  return !rel.startsWith('..') && !path.isAbsolute(rel) && MEMORY_DIRS.includes(rel.split(path.sep)[0]) ? abs : null;
}

// 追加；要加的行都已经在条目里（重跑同一天之类）就什么都不改，返回 false
function append(p, item, now) {
  const e = read(p);
  const have = new Set(e.body.split('\n').map(same));
  const lines = block(item.content, item.observed).split('\n').filter((l) => l.trim() && !have.has(same(l)));
  const status = STATUSES.includes(item.status) && item.status !== e.meta.status;
  if (!lines.length && !status && !(item.due && item.due !== e.meta.due)) return false;
  if (lines.length) e.body = `${e.body.replace(/\s*$/, '')}\n${lines.join('\n')}\n`;
  e.meta.sources = [...new Set([...(e.meta.sources || []), ...(item.sources || [])].map(source))].slice(-5);
  e.meta.entities = [...new Set([...(e.meta.entities || []), ...(item.entities || [])])]; // 补上 open_id、账号码
  e.meta.updated = now;
  if (STATUSES.includes(item.status)) e.meta.status = item.status; // 事项结案、作废等
  if (item.due) e.meta.due = item.due;
  write(p, e);
  return true;
}

export function addItems(root, items, { now = today() } = {}) {
  return items.map((item) => {
    if (!item.sources?.length) return { action: 'skipped', path: null };
    const pending = item.review === 'pending';
    const existing = memoryFile(root, item.target) || (!item.conflict_with && findMatch(listEntries(root), item)?.path) || null;
    if (existing && !pending) return { action: append(existing, item, now) ? 'appended' : 'skipped', path: existing };
    // 新建（或待确认的增量）：价格/权限/生产配方/对外承诺先进 inbox，确认前不碰已有条目
    const p = entryPath(root, item.type, item.title, { pending });
    const due = item.due || (item.type === 'open' ? plusDays(item.observed || now, 3) : null); // 事项默认 3 天后到期，到期进日报
    const meta = { type: item.type, title: item.title, entities: item.entities || [], scope: item.scope || '', sources: [...new Set(item.sources.map(source))].slice(-5),
      observed: item.observed || now, updated: now, status: STATUSES.includes(item.status) ? item.status : item.type === 'open' ? 'open' : 'active',
      confidence: item.confidence || 'medium', review: pending ? 'pending' : 'auto', ...(due ? { due } : {}),
      ...(existing ? { target: path.relative(root, existing) } : {}) };
    const other = memoryFile(root, item.conflict_with);
    if (other && !existing) {
      meta.status = 'conflict';
      const o = read(other); o.meta.status = 'conflict'; write(other, o);
    }
    write(p, { meta, body: `${block(item.content, item.observed)}\n` });
    return { action: pending ? 'inbox' : meta.status === 'conflict' ? 'conflict' : 'created', path: p };
  });
}

export const listPending = (root) => listEntries(root).filter((e) => e.path.startsWith(path.join(root, 'inbox') + path.sep));

function inboxFile(root, file) {
  const p = memoryFile(root, file);
  if (!p || !fs.realpathSync(p).startsWith(fs.realpathSync(path.join(root, 'inbox')) + path.sep)) throw new Error(`只能处理 inbox 里的待确认条目：${file}`);
  return p;
}

// 确认：带 target 的是对已有条目的增量，并进去；否则移出 inbox 成为正式条目
export function acceptEntry(root, file, { now = today() } = {}) {
  const src = inboxFile(root, file);
  const e = read(src);
  const target = memoryFile(root, e.meta.target);
  if (target) {
    append(target, { content: e.body, sources: e.meta.sources, observed: e.meta.observed }, now);
    fs.unlinkSync(src);
    return target;
  }
  e.meta.review = 'confirmed';
  delete e.meta.target;
  const p = entryPath(root, e.meta.type, e.meta.title, {});
  write(p, e);
  fs.unlinkSync(src);
  return p;
}

export function rejectEntry(root, file) {
  fs.unlinkSync(inboxFile(root, file));
}
