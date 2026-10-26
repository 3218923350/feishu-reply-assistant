import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serializeEntry } from '../../lib/memory/store.mjs';
import { openIndex, refresh } from '../../lib/memory/index.mjs';
import { promptHook } from '../../lib/memory/hook.mjs';

function db() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-hook-'));
  fs.mkdirSync(path.join(base, 'recipes'), { recursive: true });
  fs.writeFileSync(path.join(base, 'recipes', 'opus-白名单.md'), serializeEntry({ meta: { type: 'recipe', title: 'opus 白名单开通配方', status: 'active', review: 'auto', updated: '2026-10-22' }, body: '用 grant.py 给账号码对应 userId 加白名单\n' }));
  const d = openIndex(path.join(base, 'idx.sqlite'));
  refresh(d, [{ root: 'mine', dir: base }]);
  return d;
}

test('相关的 prompt：注入共享记忆线索', () => {
  const out = promptHook(db(), '我们的 opus 白名单怎么开？');
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /共享记忆线索[\s\S]*opus 白名单开通配方/);
});

test('太短、斜杠命令、没命中：什么都不输出', () => {
  const d = db();
  assert.equal(promptHook(d, '继续'), null);
  assert.equal(promptHook(d, '/code-review high'), null);
  assert.equal(promptHook(d, '今天天气怎么样呢朋友'), null);
});
