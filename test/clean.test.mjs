import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { publishable, scanFiles } from '../scripts/check-clean.mjs';

test('scanFiles：黑名单词、真实 id、本机路径、图片都算；测试目录里的假 key 不算', () => {
  const hits = scanFiles([
    { path: 'a.mjs', text: 'x\n// 李雷说的\n' },
    { path: 'b.mjs', text: `const ME = 'ou_${'a'.repeat(32)}'` },
    { path: 'c.md', text: `see /${'Users'}/bob/x` },
    { path: 'd.png', text: '' },
    { path: 'test/e.test.mjs', text: "redact('sk-AbCdEf1234567890xyz')" },
    { path: 'f.mjs', text: "const k = 'sk-AbCdEf1234567890xyz'" },
    { path: 'g.mjs', text: 'const ok = 1; // 普通代码\n' },
  ], { blocklist: ['李雷'], prefixes: [] });
  assert.deepEqual(hits.map((h) => `${h.file}:${h.line}`), ['a.mjs:2', 'b.mjs:1', 'c.md:1', 'd.png:0', 'f.mjs:1']);
});

test('scanFiles：公司专有前缀的 key 按配置拦；黑名单不分大小写', () => {
  const hits = scanFiles([{ path: 'a.md', text: 'key abc_AbCdEf1234567890\nAcme 网关' }], { blocklist: ['acme'], prefixes: ['abc'] });
  assert.deepEqual(hits.map((h) => h.line), [1, 2]);
});

test('publishable：.gitignore 里的目录即使被跟踪也不发布；没跟踪但没忽略的新文件要发布', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'docs', 'design'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'design', 'x.md'), 'secret');
  fs.writeFileSync(path.join(dir, 'a.mjs'), '1');
  git('add', '-A'); git('commit', '-qm', 'x');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'docs/design/\nnode_modules/\n');
  fs.writeFileSync(path.join(dir, 'new.md'), 'n');
  fs.mkdirSync(path.join(dir, 'node_modules')); fs.writeFileSync(path.join(dir, 'node_modules', 'z.js'), 'z');
  assert.deepEqual(publishable(dir).sort(), ['.gitignore', 'a.mjs', 'new.md']);
});
