import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 点一次卡片按钮（--click 回放 card.action.trigger 事件），假 lark-cli / claude 记下每次调用：看点了之后发没发、起没起办事、办事拿到的授权是什么
// 假 claude 被 --resume 起来办事时，把提示词存下来，再照提示词里的报告路径写一份报告
function click(item, form, action, { state = {}, events = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'click-'));
  fs.mkdirSync(path.join(dir, 'ws')); // 起草会话的目录：办事 --resume 要回到这里
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft' }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lastPollAt: 0, lastConfirmAt: 0, seen: {}, queue: [],
    items: { om_card: { orig: { message_id: 'om_orig', chat_id: 'oc_p2p', chat_type: 'p2p', sender_id: 'ou_u1', sender_name: '李四', create_time: '2026-10-27 10:00', content: '帮我开一下' },
      session: 's1', cwd: path.join(dir, 'ws'), status: 'pending', createdAt: Date.now(), ui: 'card', ...item } }, ...state }));
  if (events.length) { fs.mkdirSync(path.join(dir, 'events')); fs.writeFileSync(path.join(dir, 'events', `${new Date().toISOString().slice(0, 7)}.jsonl`), events.map((e) => JSON.stringify({ ts: new Date().toISOString(), ...e })).join('\n') + '\n'); }
  const lark = path.join(dir, 'lark'), claude = path.join(dir, 'claude');
  fs.writeFileSync(lark, `#!/bin/bash
echo "lark $@" >> ${dir}/calls.log
echo '{"ok":true,"data":{"message_id":"om_new_'$RANDOM'"}}'
`, { mode: 0o755 });
  fs.writeFileSync(claude, `#!/bin/bash
p="\${@: -1}"
printf '%s' "$p" > ${dir}/work-prompt.txt
rf=$(printf '%s' "$p" | grep -o '${dir}/runs/[^ ]*\\.report\\.json' | head -1)
echo '{"state":"done","did":"办了","verification":"curl 看过了，返回 200"}' > "$rf"
echo "claude $*" >> ${dir}/calls.log
`, { mode: 0o755 });
  const ev = path.join(dir, 'ev.json');
  fs.writeFileSync(ev, JSON.stringify({ operator_id: 'ou_me', message_id: 'om_card', action_tag: 'button', action_name: action, event_id: 'e1', form_value: JSON.stringify(form) }));
  const r = spawnSync(process.execPath, ['assistant.mjs', '--click', ev], { env: { ...process.env, HOME: dir, FRA_HOME: dir, FRA_LARK: lark, FRA_CLAUDE: claude, FRA_ORCA: '/nonexistent' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') : '';
  const prompt = fs.existsSync(path.join(dir, 'work-prompt.txt')) ? fs.readFileSync(path.join(dir, 'work-prompt.txt'), 'utf8') : '';
  const ctx = !fs.existsSync(path.join(dir, 'runs')) ? undefined : fs.readdirSync(path.join(dir, 'runs')).filter((f) => f.endsWith('.ctx.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'runs', f), 'utf8')))[0];
  const botSays = calls.split('\n').filter((l) => l.includes('--as bot') && l.includes('--markdown')).join('\n');
  return { dir, calls, prompt, ctx, botSays, sentAsMe: /\+messages-reply --as user/.test(calls), worked: /^claude /m.test(calls) };
}

const action = { kind: 'action', draft: '加好了，你刷新一下试试', view: { type: 'draft', res: { kind: 'action', proposed_actions: '给账号 u1234abc 加 model-k3 白名单', draft: '加好了，你刷新一下试试' } } };

test('要动手卡点「执行上面要做的，办完再回他」：不写吩咐也起办事；授权 = 卡上要做的那件事 + 办完把那句发给他；不先以我身份发', () => {
  const r = click(action, { draft_after: '加好了，你刷新一下试试', note: '' }, 'approve');
  assert.ok(r.worked, r.calls);
  assert.ok(!r.sentAsMe, r.calls);
  assert.match(r.ctx.authText, /同意：给账号 u1234abc 加 model-k3 白名单；办完把做完再回的话发给李四/);
  assert.match(r.prompt, /做完再回的话：「加好了，你刷新一下试试」/);
});

test('要动手卡把「办完发给他的话」清空再点：只办不发（授权里没有发送那句）', () => {
  const r = click(action, { draft_after: '', note: '' }, 'approve');
  assert.ok(r.worked);
  assert.ok(!/发给李四/.test(r.ctx.authText), r.ctx.authText);
  assert.match(r.prompt, /不要以他身份发任何消息/);
});

test('「按吩咐办」吩咐框空着：不起办事、不发，回一句让我写吩咐（10-27 以前普通回复卡会被当成「照卡上的拟回复发给他」）', () => {
  for (const item of [{ kind: 'answer', draft: '直接去门户建 key' }, { kind: 'decision', draft: '' }, action]) {
    const r = click(item, { draft: item.draft, note: '' }, 'work');
    assert.ok(!r.worked && !r.sentAsMe, `${item.kind}\n${r.calls}`);
    assert.match(r.botSays, /先在吩咐框里写要它做什么/, item.kind);
  }
});

test('「按吩咐办」写了吩咐：吩咐原话就是授权；改过的「办完发给他的话」一起告诉它', () => {
  const r = click(action, { draft_after: '加好了，B 端号也一起加了', note: '先查一下他 B 端号，一起加上' }, 'work');
  assert.ok(r.worked);
  assert.equal(r.ctx.authText, '先查一下他 B 端号，一起加上');
  assert.match(r.prompt, /办完发的话改成了：「加好了，B 端号也一起加了」/);
});

test('「发出这句」：以我身份回原消息，不起办事', () => {
  const r = click({ kind: 'answer', draft: '直接去门户建 key' }, { draft: '直接去门户建 key', note: '' }, 'send');
  assert.ok(r.sentAsMe && !r.worked, r.calls);
  assert.match(r.calls, /\+messages-reply --as user --message-id om_orig --text 直接去门户建 key/);
});

test('有选项、什么都没勾就点「办勾选的」：不起办事，提示先勾', () => {
  const r = click({ kind: 'decision', draft: '', options: [{ id: 'a', label: '推迟改价', group: 'how' }, { id: 'b', label: '照常改价', group: 'how' }] }, { note: '' }, 'approve');
  assert.ok(!r.worked && !r.sentAsMe);
  assert.match(r.botSays, /先勾选（或在下拉里选）要办的/);
});

// 助手停了一小时以上再起来：报告早写好了。以前一上来就判超时（「一小时没出结果」），报告不读、终端不关
test('重启后接着等的办事已经过了一小时、报告早写好：照常出报告卡，不报超时', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft' }));
  fs.mkdirSync(path.join(dir, 'runs'));
  const reportFile = path.join(dir, 'runs', 'om_card-1.report.json');
  fs.writeFileSync(reportFile, JSON.stringify({ state: 'done', did: '加好了白名单', verification: 'curl 看过了，返回 200' }));
  const old = Date.now() - 2 * 3600_000;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lastPollAt: Date.now(), lastConfirmAt: Date.now(), seen: {}, queue: [],
    items: { om_card: { orig: { message_id: 'om_orig', chat_id: 'oc_p2p', chat_type: 'p2p', sender_id: 'ou_u1', sender_name: '李四', create_time: '2026-10-27 10:00', content: 'x' },
      session: 's1', cwd: dir, status: 'working', createdAt: old, ui: 'card', work: { reportFile, startedAt: old, replyTo: 'om_card' } } } }));
  const lark = path.join(dir, 'lark');
  fs.writeFileSync(lark, `#!/bin/bash
echo "lark $@" >> ${dir}/calls.log
case "$*" in
  *"-messages-list"*|*"+messages-search"*|*"+messages-mget"*) echo '{"ok":true,"data":{"messages":[]}}' ;;
  *) echo '{"ok":true,"data":{"message_id":"om_rep"}}' ;;
esac
`, { mode: 0o755 });
  // 常驻模式起来，等它处理完恢复的那一件就杀掉（不然一直轮询）
  spawnSync('/bin/bash', ['-c', `FRA_HOME=${dir} HOME=${dir} FRA_LARK=${lark} FRA_ORCA=/nonexistent '${process.execPath}' assistant.mjs & p=$!; for i in $(seq 1 80); do grep -q '加好了白名单\\|一小时' ${dir}/calls.log 2>/dev/null && break; sleep 0.25; done; kill $p`], { encoding: 'utf8', timeout: 30_000 });
  const log = fs.readFileSync(path.join(dir, 'assistant.log'), 'utf8');
  assert.match(log, /work done 李四/, log);
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8');
  assert.ok(!calls.includes('一小时没出结果'), calls);
  assert.match(calls, /加好了白名单/); // 报告卡发出来了
});

test('群里发出去的卡点「不用盯了」：这张卡发出的消息不再登记话题，已登记的删掉，卡上改成「已不再盯」', () => {
  const orig = { message_id: 'om_orig', chat_id: 'oc_grp', chat_type: 'group', chat_name: '某群', sender_id: 'ou_u1', sender_name: '李四', create_time: '2026-10-27 10:00', content: '说明一下' };
  const r = click({ orig, kind: 'answer', draft: '收到', status: 'sent', sentText: '收到' }, {}, 'unwatch', {
    state: { threads: { omt_1: { thread_id: 'omt_1', chat_id: 'oc_grp', watch_sender_id: 'ou_u1', root_message_id: 'om_sent1', created_at: Date.now() },
      omt_2: { thread_id: 'omt_2', chat_id: 'oc_grp', watch_sender_id: 'ou_u9', root_message_id: 'om_other', created_at: Date.now() } } },
    events: [{ kind: 'sent', card: 'om_card', orig, message_id: 'om_sent1', text: '收到' }] });
  const st = JSON.parse(fs.readFileSync(path.join(r.dir, 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(st.threads), ['omt_2']);
  assert.ok(st.noFollow.om_sent1);
  assert.equal(st.items.om_card.unwatched, true);
  assert.match(r.calls, /messages patch .*已不再盯这个话题/);
  assert.ok(!r.sentAsMe && !r.worked);
});
