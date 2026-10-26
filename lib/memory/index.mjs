// 检索索引：node:sqlite FTS5，中文在应用层切成二字词；按 mtime 增量刷新
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listEntries, parseEntry } from './store.mjs';

const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff';
const RUN = new RegExp(`[${CJK}]+|[^\\s${CJK}]+`, 'g');
const IS_CJK = new RegExp(`^[${CJK}]`);
const CHUNK_CHARS = 6000;

export function bigrams(text) {
  const out = [];
  for (const run of String(text).toLowerCase().match(RUN) || []) {
    if (!IS_CJK.test(run) || run.length === 1) {
      out.push(run);
      // 带连字符的英文词（比如 api-key / team_plan）再各补一个连写形式，口语里写成「apikey」也能搜到
      const parts = IS_CJK.test(run) ? [] : run.split(/[-_./:]+/).filter(Boolean);
      for (let i = 0; i + 1 < parts.length; i++) out.push(parts[i] + parts[i + 1]);
    } else for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out.join(' ');
}

// 查询里的口头禅：几乎每条记忆都有，只会把不相关的条目带进来
const STOP = /是不是|看一下|看看|一下|这个|那个|可以|我们|你们|他们|什么|怎么|帮忙|麻烦|谢谢|好的|现在|还是|就是|然后|没有|如果|因为|所以|已经|还有|一个|这边|那边|老师|哈哈|帮我|给我|继续/g;
// ignore：查询里要去掉的词（我自己的名字，几乎每条记忆都提到）；aliases：同一个东西的几种叫法 [正则, 记忆里的写法]，来自配置
export function queryText(q, { ignore = [], aliases = [] } = {}) {
  let t = String(q);
  for (const w of ignore) if (w) t = t.replaceAll(w, ' ');
  return `${t.replace(STOP, ' ')} ${aliases.filter(([re]) => re.test(q)).map(([, a]) => a).join(' ')}`;
}
const VERSION = 3; // 切词规则变了就升版本，旧索引整个重建

export function openIndex(dbPath) {
  const db = new DatabaseSync(dbPath, { timeout: 15_000 }); // 别的进程正在刷新索引就等着（预取时 mem who 和 mem search 是同时跑的）
  // 索引可随时重建：表结构或切词规则旧了就整个丢掉重来
  if (db.prepare('PRAGMA user_version').get().user_version < VERSION) db.exec(`DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS fts; PRAGMA user_version = ${VERSION};`);
  db.exec(`CREATE TABLE IF NOT EXISTS docs(rowid INTEGER PRIMARY KEY, path TEXT, file TEXT, root TEXT, type TEXT, title TEXT,
             updated TEXT, status TEXT, review TEXT, mtime REAL, body TEXT, entities TEXT);
           CREATE INDEX IF NOT EXISTS docs_file ON docs(file);
           CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, body, tokenize='unicode61');`);
  return db;
}

export function DEFAULT_ROOTS(home, memDir) {
  const roots = [{ root: 'mine', dir: memDir }];
  const projects = path.join(home, '.claude', 'projects');
  if (fs.existsSync(projects)) for (const p of fs.readdirSync(projects)) {
    const dir = path.join(projects, p, 'memory');
    if (fs.existsSync(dir)) roots.push({ root: `claude:${p}`, dir, type: 'project-memory' });
  }
  const codex = path.join(home, '.codex', 'memories');
  roots.push({ root: 'codex', dir: codex, type: 'project-memory', exclude: ['phase2_workspace_diff.md'] }); // 合并前的中间 diff，全是重复
  roots.push({ root: 'codex', dir: path.join(codex, 'rollout_summaries'), type: 'project-memory' }); // 每个任务一份摘要
  return roots;
}

// 一个文件 → 若干索引行（超长的外部文件按 #/## 标题切块）
function rowsFor(root, file) {
  const stat = fs.statSync(file);
  const { meta, body } = parseEntry(fs.readFileSync(file, 'utf8'));
  const base = { file, root: root.root, mtime: stat.mtimeMs, status: meta.status || 'active', review: meta.review || 'auto',
    entities: JSON.stringify(Array.isArray(meta.entities) ? meta.entities : []),
    updated: meta.updated || meta.modified?.slice(0, 10) || stat.mtime.toISOString().slice(0, 10) };
  const title = meta.title || meta.name || body.match(/^#+\s+(.+)$/m)?.[1] || path.basename(file, '.md');
  const type = root.type || meta.type || 'unknown';
  if (root.root === 'mine' || body.length <= CHUNK_CHARS) return [{ ...base, path: file, type, title, body }];
  const parts = body.split(/\n(?=#{1,2}\s)/);
  return parts.map((part, i) => ({ ...base, path: `${file}#${i + 1}`, type,
    title: `${title} › ${part.match(/^#+\s+(.+)$/m)?.[1] || i + 1}`, body: part }));
}

function filesOf(root) {
  if (root.root === 'mine') return listEntries(root.dir).map((e) => e.path);
  if (!fs.existsSync(root.dir)) return [];
  return fs.readdirSync(root.dir).filter((f) => f.endsWith('.md') && !(root.exclude || []).includes(f)).map((f) => path.join(root.dir, f));
}

export function refresh(db, roots) {
  const del = (file) => {
    for (const { rowid } of db.prepare('SELECT rowid FROM docs WHERE file = ?').all(file)) db.prepare('DELETE FROM fts WHERE rowid = ?').run(rowid);
    db.prepare('DELETE FROM docs WHERE file = ?').run(file);
  };
  const ins = db.prepare('INSERT INTO docs(path, file, root, type, title, updated, status, review, mtime, body, entities) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const insFts = db.prepare('INSERT INTO fts(rowid, title, body) VALUES (?,?,?)');
  let changed = 0;
  db.exec('BEGIN IMMEDIATE'); // 一开始就拿写锁：先读后写的普通事务两边一起升级会直接报 database is locked，不等
  const known = new Map(db.prepare('SELECT DISTINCT file, mtime FROM docs').all().map((r) => [r.file, r.mtime])); // 拿到锁之后再读，别用别的进程刚改过的旧快照
  for (const root of roots) for (const file of filesOf(root)) {
    const mtime = fs.statSync(file).mtimeMs;
    const seen = known.get(file);
    known.delete(file);
    if (seen === mtime) continue;
    if (seen !== undefined) del(file);
    for (const r of rowsFor(root, file)) {
      const { lastInsertRowid } = ins.run(r.path, r.file, r.root, r.type, r.title, r.updated, r.status, r.review, r.mtime, r.body, r.entities);
      insFts.run(lastInsertRowid, bigrams(`${r.title} ${JSON.parse(r.entities).join(' ')}`), bigrams(r.body)); // 账号码、open_id 也能搜到
    }
    changed++;
  }
  for (const file of known.keys()) { del(file); changed++; }
  db.exec('COMMIT');
  return { changed };
}

function snippet(body, terms) {
  const text = body.replace(/\s+/g, ' ');
  const at = Math.max(0, Math.min(...terms.map((t) => text.toLowerCase().indexOf(t)).filter((i) => i >= 0), text.length));
  return (at > 40 ? '…' : '') + text.slice(Math.max(0, at - 40), at + 80).trim();
}

const hit = ({ body, entities, ...r }, terms) => ({ ...r, entities: JSON.parse(entities || '[]'), snippet: snippet(body, terms) });
// 排序加权（bm25 越小越好）：记忆库本身优先，口径和配方再优先、口吻卡靠后；各项目的记忆最多占 2 条
const weight = (r) => (r.root === 'mine' ? 1 : 0.5) * ({ policy: 1.3, recipe: 1.3, style: 0.7 }[r.type] || 1);
const MAX_EXTERNAL = 2;

export function search(db, q, { type, limit = 8, scope = 'all', ignore = [], aliases = [] } = {}) {
  const terms = [...new Set(bigrams(queryText(String(q), { ignore, aliases })).split(' ').filter((t) => /[\p{L}\p{N}]/u.test(t)))];
  if (!terms.length) return [];
  const match = terms.map((t) => `"${t.replace(/"/g, '""')}"${IS_CJK.test(t) && t.length === 1 ? '*' : ''}`).join(' OR ');
  const where = [type && 'd.type = :type', scope === 'mine' && "d.root = 'mine'"].filter(Boolean).join(' AND ');
  const rows = db.prepare(`SELECT d.path, d.root, d.type, d.title, d.updated, d.status, d.review, d.body, d.entities, bm25(fts, 3.0, 1.0) AS score
    FROM fts JOIN docs d ON d.rowid = fts.rowid WHERE fts MATCH :match ${where ? 'AND ' + where : ''} ORDER BY score LIMIT :n`)
    .all({ match, n: Math.max(limit * 5, 40), ...(type ? { type } : {}) });
  let external = 0;
  return rows.sort((a, b) => a.score * weight(a) - b.score * weight(b))
    .filter((r) => r.root === 'mine' || external++ < MAX_EXTERNAL).slice(0, limit).map((r) => hit(r, terms));
}

// 人物卡：本人的卡（entities 首位 / 标题开头是这个名字）排在「提到他」的卡前面
// 带 open_id（或直接传 open_id）时按 entities 精确找，飞书显示名和卡上名字对不上也不会错人
export function who(db, name, { id = /^ou_/.test(name) ? name : null, ignore = [], aliases = [] } = {}) {
  const exact = id ? db.prepare("SELECT * FROM docs WHERE root = 'mine' AND type = 'person' AND entities LIKE ?").all(`%${JSON.stringify(id)}%`) : [];
  const own = (h) => (h.entities[0] === name || h.title.startsWith(name) ? 0 : h.entities.includes(name) ? 1 : 2);
  const person = exact.length ? exact.slice(0, 3).map((r) => hit(r, [id]))
    : search(db, name, { type: 'person', scope: 'mine', limit: 10, aliases }).sort((a, b) => own(a) - own(b)).slice(0, 3);
  const related = ['policy', 'open'].flatMap((type) => search(db, name, { type, scope: 'mine', limit: 4, ignore: ignore.filter((w) => w !== name), aliases })); // 查的就是我自己时别把名字去掉
  return { person, related };
}
