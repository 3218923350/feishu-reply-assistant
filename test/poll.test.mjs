import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// --once 扫一次收件箱：假 lark-cli 的 @我 搜索返回下面这些，看哪些成了候选
const at = (id) => [{ id, key: '@_user_1', name: id === 'ou_me' ? '张三' : '别人' }];
const msg = (name, o) => ({ message_id: `om_${name}`, chat_id: 'oc_g', chat_type: 'group', chat_name: '群', msg_type: 'post', content: name, create_time: '2026-10-29 15:45', mentions: at('ou_me'), ...o, sender: { id: 'ou_u1', name, sender_type: 'user', ...o.sender } });
const atMe = [
  msg('真人@我', { sender: {} }),
  msg('机器人@我', { sender: { id: 'cli_x', sender_type: 'app' } }),
  msg('机器人卡片@我', { msg_type: 'interactive', sender: { id: 'cli_x', sender_type: 'app' } }),
  msg('机器人@别人', { mentions: at('ou_u2'), sender: { id: 'cli_x', sender_type: 'app' } }),
  msg('机器人私聊', { chat_type: 'p2p', chat_name: '', sender: { id: 'cli_x', sender_type: 'app' } }),
  msg('我自己', { sender: { id: 'ou_me' } }),
];

test('--once：机器人在群里发文字 @我 算候选；机器人的卡片、私聊，没 @我 的，我自己发的不算', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft' }));
  const lark = path.join(dir, 'lark');
  fs.writeFileSync(lark, `#!/bin/bash
case "$*" in
  *"--is-at-me"*) echo '${JSON.stringify({ ok: true, data: { messages: atMe } })}' ;;
  *) echo '{"ok":true,"data":{"messages":[]}}' ;;
esac
`, { mode: 0o755 });
  const r = spawnSync(process.execPath, ['assistant.mjs', '--once'], { env: { ...process.env, HOME: dir, FRA_HOME: dir, FRA_LARK: lark, FRA_ORCA: '/nonexistent' }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const got = [...r.stdout.matchAll(/candidate (\S+) @/g)].map((x) => x[1]);
  assert.deepEqual(got, ['真人@我', '机器人@我'], r.stdout);
});
