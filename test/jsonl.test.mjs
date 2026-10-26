import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonl } from '../lib/jsonl.mjs';

test('readJsonl：坏行跳过并回调，文件不存在给空数组', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-'));
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"a":\n\n{"a":2}\n');
  const bad = [];
  assert.deepEqual(readJsonl(f, { onBad: (l) => bad.push(l) }), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(bad, ['{"a":']);
  assert.deepEqual(readJsonl(path.join(dir, 'nope.jsonl')), []);
});
