import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 对一条私聊走一遍 --test：假 lark-cli / claude 把每次调用记到 calls.log，看有没有以我的身份点表情
function runOnce(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft', ...config }));
  const msg = { message_id: 'om_in', chat_id: 'oc_p2p', chat_type: 'p2p', msg_type: 'text', content: '帮我看下这个报错', create_time: '2026-10-27 10:00', sender: { id: 'ou_u1', name: '李四', sender_type: 'user' } };
  const lark = path.join(dir, 'lark'), claude = path.join(dir, 'claude');
  fs.writeFileSync(lark, `#!/bin/bash
echo "lark $@" >> ${dir}/calls.log
case "$*" in
  *"+messages-mget"*) echo '${JSON.stringify({ ok: true, data: { messages: [msg] } })}' ;;
  *"-messages-list"*|*"+messages-search"*) echo '{"ok":true,"data":{"messages":[]}}' ;;
  *) echo '{"ok":true,"data":{}}' ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(claude, `#!/bin/bash
echo "claude" >> ${dir}/calls.log
echo '{"session_id":"s1","num_turns":1,"total_cost_usd":0,"structured_output":{"kind":"skip","summary":"测试"}}'
`, { mode: 0o755 });
  const r = spawnSync(process.execPath, ['assistant.mjs', '--test', 'om_in'], { env: { ...process.env, HOME: dir, FRA_HOME: dir, FRA_LARK: lark, FRA_CLAUDE: claude, FRA_ORCA: '/nonexistent' }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8');
  assert.match(calls, /^claude$/m, calls); // 确实走到了起草，不是半路退出
  return calls.split('\n').filter((l) => l.includes('reactions create'));
}

test('默认：开始起草时以我的身份在对方消息上点「了解」', () => {
  const reacts = runOnce({});
  assert.equal(reacts.length, 1, reacts.join('\n'));
  assert.match(reacts[0], /--as user/);
  assert.match(reacts[0], /om_in/);
  assert.match(reacts[0], /"emoji_type":"Get"/);
});

test('auto_react: false：不点表情，照常起草', () => {
  assert.deepEqual(runOnce({ auto_react: false }), []);
});
