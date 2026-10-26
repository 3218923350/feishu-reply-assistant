import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('没有配置：assistant.mjs 打一行人话然后退出 1，不甩堆栈', () => {
  const fra = fs.mkdtempSync(path.join(os.tmpdir(), 'start-'));
  const r = spawnSync(process.execPath, ['assistant.mjs', '--once'], { env: { ...process.env, HOME: fra, FRA_HOME: fra }, encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /bin\/fra setup/);
  assert.ok(!/\n\s+at /.test(r.stderr), r.stderr);
});

test('命令行入口的 shebang 不写死 node 路径', () => {
  for (const f of ['bin/fr', 'bin/mem', 'bin/mem-hook', 'bin/fra']) {
    assert.equal(fs.readFileSync(f, 'utf8').split('\n')[0], '#!/usr/bin/env -S node --no-warnings', f);
  }
});

test('--dry 不带 message_id：一行用法提示，不甩堆栈', () => {
  const fra = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-'));
  fs.writeFileSync(path.join(fra, 'config.json'), JSON.stringify({ name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft' }));
  const r = spawnSync(process.execPath, ['assistant.mjs', '--dry'], { env: { ...process.env, HOME: fra, FRA_HOME: fra, FRA_LARK: '/usr/bin/false', FRA_ORCA: '/nonexistent' }, encoding: 'utf8', timeout: 20_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /用法/);
  assert.ok(!/\n\s+at /.test(r.stderr), r.stderr);
});
