import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 10-28：我引用了 10-26 少杰说「DeepSeek 那边商务爱搭不理」那句问「话说怎么样了」，少杰回「我给你我的账号吧」。
// 起草时上下文里只有按时间排的消息，看不到引用，就当成在接我上一条说的智谱。引用的原文要写进上下文（不在上下文里的补查）
test('起草上下文：引用回复写出引用的是哪条；引用的老消息不在上下文里也补查原文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft', auto_react: false }));
  const u = (id, t, who, text, o = {}) => ({ message_id: id, chat_id: 'oc_p2p', chat_type: 'p2p', msg_type: 'text', create_time: t, content: text,
    sender: { id: who === '张三' ? 'ou_me' : 'ou_u1', name: who, sender_type: 'user' }, ...o });
  const old = u('om_old', '2026-10-26 16:07', '李四', '模型 B 那边商务总是爱搭不理的');
  const ctx = [u('om_a', '2026-10-28 00:34', '张三', '模型 A 的余额用完了，明天麻烦充一下'),
    u('om_q', '2026-10-28 11:43', '张三', '话说怎么样了', { reply_to: 'om_old' }), u('om_in', '2026-10-28 11:44', '李四', '我给你我的账号吧')];
  const lark = path.join(dir, 'lark'), claude = path.join(dir, 'claude');
  fs.writeFileSync(lark, `#!/bin/bash
case "$*" in
  *"+messages-mget"*om_old*) echo '${JSON.stringify({ ok: true, data: { messages: [old] } })}' ;;
  *"+messages-mget"*) echo '${JSON.stringify({ ok: true, data: { messages: [ctx[2]] } })}' ;;
  *"+chat-messages-list"*) echo '${JSON.stringify({ ok: true, data: { messages: [...ctx].reverse() } })}' ;;
  *) echo '{"ok":true,"data":{"messages":[]}}' ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(claude, `#!/bin/bash
for a in "$@"; do case "$a" in *需要处理的消息*) printf '%s' "$a" > ${dir}/prompt.txt ;; esac; done
echo '{"session_id":"s1","num_turns":1,"total_cost_usd":0,"structured_output":{"kind":"skip","summary":"测试"}}'
`, { mode: 0o755 });
  const r = spawnSync(process.execPath, ['assistant.mjs', '--dry', 'om_in'], { env: { ...process.env, HOME: dir, FRA_HOME: dir, FRA_LARK: lark, FRA_CLAUDE: claude, FRA_ORCA: '/nonexistent' }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const p = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
  assert.match(p, /\[2026-10-28 11:43\] 张三\(我\): 话说怎么样了\n {4}↳ 引用 \[2026-10-26 16:07\] 李四: 模型 B 那边商务总是爱搭不理的\n\[2026-10-28 11:44\] 李四: 我给你我的账号吧/);
});

// 10-28：刘王琴「加完了 您这边看一下」被判成不用回、没出卡；我后来自己回了，这种判错的以前完全不进统计
test('判了不用回、之后我自己回了：记一条 manual-reply（带 skipped），进日报统计', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skipped-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft', auto_react: false }));
  const orig = { message_id: 'om_in', chat_id: 'oc_g', chat_type: 'group', chat_name: '对接群', sender_id: 'ou_u1', sender_name: '李四', create_time: '2026-10-28 11:30', content: '@张三 加完了 您这边看一下' };
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lastPollAt: now, lastConfirmAt: now, seen: {}, queue: [], items: {},
    skipped: { om_in: { orig, summary: '李四说加完了，不用回', at: now - 60_000 } } }));
  const mine = { message_id: 'om_mine', chat_id: 'oc_g', create_time: '2099-01-01 00:00', content: '看了，到账了，谢谢', reply_to: 'om_in', sender: { id: 'ou_me', name: '张三' } };
  const lark = path.join(dir, 'lark');
  fs.writeFileSync(lark, `#!/bin/bash
echo "lark $@" >> ${dir}/calls.log
case "$*" in
  *"+chat-messages-list"*oc_g*) echo '${JSON.stringify({ ok: true, data: { messages: [mine] } })}' ;;
  *) echo '{"ok":true,"data":{"messages":[]}}' ;;
esac
`, { mode: 0o755 });
  spawnSync('/bin/bash', ['-c', `FRA_HOME=${dir} HOME=${dir} FRA_LARK=${lark} FRA_ORCA=/nonexistent '${process.execPath}' assistant.mjs & p=$!; for i in $(seq 1 80); do grep -q manual-reply ${dir}/events/*.jsonl 2>/dev/null && break; sleep 0.25; done; kill $p`], { encoding: 'utf8', timeout: 30_000 });
  const ev = fs.readdirSync(path.join(dir, 'events')).flatMap((f) => fs.readFileSync(path.join(dir, 'events', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  const e = ev.find((x) => x.kind === 'manual-reply');
  assert.ok(e, JSON.stringify(ev));
  assert.deepEqual([e.orig.message_id, e.skipped, e.actual, e.draft], ['om_in', '李四说加完了，不用回', ['看了，到账了，谢谢'], '']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).skipped, {}); // 记过就不再查
});

// 卡片收起这条路以前没有进程级测试：laterMessages 改成按列表返回后，收起拿到的是嵌套数组、一张都收不起来（单测全过没发现）
test('出了卡、我在原会话自己回了：卡片收起，记下草稿 vs 我实际怎么回的', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handled-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft', auto_react: false }));
  const orig = { message_id: 'om_in', chat_id: 'oc_p', chat_type: 'p2p', sender_id: 'ou_u1', sender_name: '李四', create_time: '2026-10-28 11:30', content: '帮我开一下' };
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lastPollAt: now, lastConfirmAt: now, seen: {}, queue: [],
    items: { om_card: { orig, draft: '在开了，稍等', status: 'pending', createdAt: now - 60_000, ui: 'card' } } }));
  const mine = { message_id: 'om_mine', chat_id: 'oc_p', create_time: '2099-01-01 00:00', content: '开好了', sender: { id: 'ou_me', name: '张三' } };
  const lark = path.join(dir, 'lark');
  fs.writeFileSync(lark, `#!/bin/bash
case "$*" in
  *"+chat-messages-list"*oc_p*) echo '${JSON.stringify({ ok: true, data: { messages: [mine] } })}' ;;
  *) echo '{"ok":true,"data":{"messages":[]}}' ;;
esac
`, { mode: 0o755 });
  spawnSync('/bin/bash', ['-c', `FRA_HOME=${dir} HOME=${dir} FRA_LARK=${lark} FRA_ORCA=/nonexistent '${process.execPath}' assistant.mjs & p=$!; for i in $(seq 1 80); do grep -q manual-reply ${dir}/events/*.jsonl 2>/dev/null && break; sleep 0.25; done; kill $p`], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).items.om_card.status, 'handled');
  const e = fs.readdirSync(path.join(dir, 'events')).flatMap((f) => fs.readFileSync(path.join(dir, 'events', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l))).find((x) => x.kind === 'manual-reply');
  assert.deepEqual([e.card, e.draft, e.actual], ['om_card', '在开了，稍等', ['开好了']]);
});
