// 记忆条目：Markdown + frontmatter 的读写、存放路径、查重
import fs from 'node:fs';
import path from 'node:path';

export const TYPE_DIRS = { person: 'people', policy: 'policy', recipe: 'recipes', fact: 'facts', open: 'open', style: 'style' };
const FIELDS = ['type', 'title', 'entities', 'scope', 'sources', 'observed', 'updated', 'status', 'confidence', 'review', 'due'];

export function parseEntry(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(': ');
    if (i < 0) continue;
    const v = line.slice(i + 2).trim();
    meta[line.slice(0, i).trim()] = /^[["]/.test(v) ? JSON.parse(v) : v;
  }
  return { meta, body: m[2] };
}

export function serializeEntry({ meta, body }) {
  const keys = [...FIELDS.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !FIELDS.includes(k))];
  const lines = keys.map((k) => {
    const v = meta[k];
    // 列表、空串、带 : " [ # 或首尾空白的字符串写成 JSON，读回来不会歧义
    const raw = !Array.isArray(v) && v !== '' && !/[:"[#]|^\s|\s$/.test(String(v));
    return `${k}: ${raw ? v : JSON.stringify(v)}`;
  });
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

export function slugify(title) {
  const s = String(title).replace(/[/\\:*?"<>|#\s]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
  return [...(s || 'untitled')].slice(0, 60).join('');
}

export function entryPath(root, type, title, { pending = false } = {}) {
  const sub = TYPE_DIRS[type];
  if (!sub) throw new Error(`未知类型 ${type}`);
  const dir = pending ? path.join(root, 'inbox', sub) : path.join(root, sub);
  const base = slugify(title);
  let p = path.join(dir, `${base}.md`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base}-${i}.md`);
  return p;
}

export function listEntries(root) {
  const dirs = Object.values(TYPE_DIRS).flatMap((d) => [path.join(root, d), path.join(root, 'inbox', d)]);
  return dirs.filter((d) => fs.existsSync(d)).flatMap((d) =>
    fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => {
      const p = path.join(d, f);
      return { path: p, ...parseEntry(fs.readFileSync(p, 'utf8')) };
    }));
}

const norm = (s) => String(s || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

const openIds = (es) => (es || []).filter((x) => /^ou_/.test(x));

// 同一条记忆：普通条目要同类型、同标题、同 scope（不同环境分开记）；人物按姓名，但 open_id 都有且不同就是两个人
export function findMatch(entries, item) {
  return entries.find((e) => {
    if (e.meta.type !== item.type) return false;
    if (item.type === 'person') {
      const a = openIds(e.meta.entities), b = openIds(item.entities);
      if (a.length && b.length && !a.some((x) => b.includes(x))) return false;
      return norm(e.meta.title) === norm(item.title) || (!!item.entities?.[0] && e.meta.entities?.[0] === item.entities[0]);
    }
    const sameScope = !e.meta.scope || !item.scope || norm(e.meta.scope) === norm(item.scope);
    return sameScope && norm(e.meta.title) === norm(item.title);
  }) || null;
}
