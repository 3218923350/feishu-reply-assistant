import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const README = fs.readFileSync('README.md', 'utf8');
const repoPaths = (t) => [...t.matchAll(/(?:^|[\s`(（])((?:bin|scripts|lib|docs|templates)\/[\w./-]+)/gm)].map((m) => m[1].replace(/[.,)]+$/, ''));

test('README 和 docs 里提到的仓库内路径都存在', () => {
  const docs = ['README.md', 'docs/DESIGN.md', 'docs/MEMORY.md', 'docs/feishu-app.md'];
  for (const d of docs) assert.ok(fs.existsSync(d), d);
  const paths = docs.flatMap((d) => repoPaths(fs.readFileSync(d, 'utf8')).map((p) => [d, p]));
  assert.ok(paths.length >= 8);
  for (const [d, p] of paths) assert.ok(fs.existsSync(p), `${d} 提到的 ${p} 不存在`);
});

test('README 写到了每个配置键和每个 doctor 检查项', async () => {
  for (const k of Object.keys(JSON.parse(fs.readFileSync('templates/config.example.json', 'utf8'))).filter((k) => !k.startsWith('//'))) assert.ok(README.includes(`\`${k}\``), k);
  const src = fs.readFileSync('lib/setup/checks.mjs', 'utf8');
  for (const [, name] of src.matchAll(/add\('([^']+)'/g)) assert.ok(README.includes(name), name);
});

test('飞书应用文档列的用户权限覆盖 setup 申请的那几个；README 有英文简介、LICENSE 是 MIT', () => {
  const app = fs.readFileSync('docs/feishu-app.md', 'utf8');
  for (const s of ['search:message', 'im:message.send_as_user', 'im:message:send_as_bot', 'im:message:update', 'im:chat:create', 'im:chat.members:read', 'card.action.trigger']) assert.ok(app.includes(s), s);
  assert.match(README.split('\n').slice(0, 8).join('\n'), /[A-Za-z]{4,} [A-Za-z]{3,} [A-Za-z]{3,}/);
  assert.match(fs.readFileSync('LICENSE', 'utf8'), /MIT License/);
  assert.ok(fs.existsSync('.github/ISSUE_TEMPLATE/bug_report.md'));
});
