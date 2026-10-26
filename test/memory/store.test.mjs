import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEntry, serializeEntry, slugify, entryPath, listEntries, findMatch, TYPE_DIRS } from '../../lib/memory/store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wym-'));
const entry = {
  meta: { type: 'person', title: '孙七：服务甲 / 服务乙 合并负责人', entities: ['孙七', 'u9999qqq'], scope: 'work/svc-a',
    sources: ['oc_x#e265f62af4'], observed: '2026-09-22', updated: '2026-10-22', status: 'active', confidence: 'high', review: 'auto' },
  body: '2026-10-22 负责 svc-a main 合并（oc_x#e265f62af4）\n',
};

test('parseEntry(serializeEntry(x)) 往返不丢字段', () => {
  assert.deepEqual(parseEntry(serializeEntry(entry)), entry);
});

test('slugify 去掉不安全字符并截到 60 字以内', () => {
  const s = slugify('a/b:c?' + '长'.repeat(80));
  assert.ok(!/[/:?]/.test(s));
  assert.ok([...s].length <= 60);
});

test('entryPath 同名不覆盖：第二个加 -2', () => {
  const root = tmp();
  const p1 = entryPath(root, 'policy', '开通规则', {});
  fs.mkdirSync(path.dirname(p1), { recursive: true });
  fs.writeFileSync(p1, 'x');
  const p2 = entryPath(root, 'policy', '开通规则', {});
  assert.equal(path.basename(p1), '开通规则.md');
  assert.equal(path.basename(p2), '开通规则-2.md');
  assert.equal(path.dirname(p1), path.join(root, 'policy'));
});

test('entryPath pending 进 inbox/<目录>/', () => {
  const root = tmp();
  assert.equal(path.dirname(entryPath(root, 'recipe', '加白', { pending: true })), path.join(root, 'inbox', TYPE_DIRS.recipe));
});

test('listEntries 包含 inbox 里的条目', () => {
  const root = tmp();
  for (const [dir, t] of [['policy', '甲'], ['inbox/recipes', '乙']]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, t + '.md'), serializeEntry({ ...entry, meta: { ...entry.meta, title: t } }));
  }
  assert.deepEqual(listEntries(root).map((e) => e.meta.title).sort(), ['乙', '甲']);
});

test('findMatch：同类型同标题（忽略空白和全半角标点）命中', () => {
  const es = [{ path: 'a', ...entry, meta: { ...entry.meta, type: 'policy', title: '开通：按量 计费' } }];
  assert.equal(findMatch(es, { type: 'policy', title: '开通:按量计费' })?.path, 'a');
  assert.equal(findMatch(es, { type: 'fact', title: '开通：按量 计费' }), null);
});

test('findMatch：person 按 entities[0] 命中', () => {
  const es = [{ path: 'p', ...entry }];
  assert.equal(findMatch(es, { type: 'person', title: '孙七（七哥）', entities: ['孙七'] })?.path, 'p');
});
