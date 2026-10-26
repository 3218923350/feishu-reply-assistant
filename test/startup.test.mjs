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
