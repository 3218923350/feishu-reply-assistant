import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FR = path.resolve('bin/fr');
const NODE = process.execPath;

// 假 lark-cli：按参数返回固定结果，并把每次调用记到 calls.log
const CONFIG = { name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft', messenger_url: 'https://example.feishu.cn/next/messenger/', secret_prefixes: ['abc'] };
function setup({ external = false, web = 'off', thread = 'omt_1', authText = '可以直接发 然后找一下赵六吧 等他改好了 我们复测没问题再回复一遍', ctxOver = {}, origOver = {}, config = CONFIG, tabs = true, desktop = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-'));
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const lark = path.join(dir, 'lark');
  fs.writeFileSync(lark, `#!/bin/bash
echo "$@" >> ${dir}/calls.log
case "$*" in
  *"+search-user"*赵六*) echo '{"ok":true,"data":{"users":[{"open_id":"ou_u6","localized_name":"赵六"}]}}' ;;
  *"+search-user"*王五*) echo '{"ok":true,"data":{"users":[{"open_id":"ou_u5","localized_name":"王五"}]}}' ;;
  *"+search-user"*) echo '{"ok":true,"data":{"users":[]}}' ;;
  *"+chat-search"*) echo '{"ok":true,"data":{"chats":[]}}' ;;
  *"+chat-messages-list"*) ${web === 'ok' || desktop === 'ok' ? `echo '{"ok":true,"data":{"messages":[{"message_id":"om_web_1","sender":{"id":"ou_me"},"content":"收到 谢谢"}]}}'` : `echo '{"ok":true,"data":{"messages":[]}}'`} ;;
  *"+messages-"*) ${external ? `echo '{"ok":false,"error":{"code":230027,"subtype":"user_unauthorized"}}' >&2; exit 1` : `echo '{"ok":true,"data":{"message_id":"om_sent_'$RANDOM'"}}'`} ;;
  *) echo '{"ok":true,"data":{}}' ;;
esac
`, { mode: 0o755 });
  // 假 orca：网页版飞书那一套（tab list / eval），每一步 eval 都回同一个结果：web=fail 时搜索框打不开；否则已经在「某项目群」里，粘贴、发送都成
  const orca = path.join(dir, 'orca');
  const evalOut = web === 'fail' ? '{\\"loaded\\":true,\\"header\\":\\"\\",\\"ok\\":false,\\"why\\":\\"搜不到\\"}'
    : '{\\"loaded\\":true,\\"header\\":\\"某项目群\\",\\"composer\\":true,\\"empty\\":true,\\"ok\\":true,\\"same\\":true}';
  fs.writeFileSync(orca, `#!/bin/bash
echo "orca $@" >> ${dir}/calls.log
case "$*" in
  *"tab list"*) echo '{"ok":true,"result":{"tabs":[${tabs ? '{"index":0,"browserPageId":"pg1","url":"https://example.feishu.cn/next/messenger/"}' : ''}]}}' ;;
  *"tab create"*) echo '{"ok":true,"result":{"browserPageId":"pg1"}}' ;;
  *eval*) echo '{"ok":true,"result":{"result":"${evalOut}"}}' ;;
  *) echo '{"ok":true,"result":{}}' ;;
esac
`, { mode: 0o755 });
  const ctx = path.join(dir, 'ctx.json');
  fs.writeFileSync(ctx, JSON.stringify({ card: 'om_card', session: 's1', cwd: '/w', authText,
    orig: { message_id: 'om_orig', chat_id: 'oc_proj', chat_name: '某项目群', thread_id: thread, sender_id: 'ou_u4', sender_name: '冯五', chat_type: 'group', ...origOver }, ...ctxOver }));
  // 假的桌面脚本：state 说有权限（直接跑，不开 Orca 终端），open / send 都说不行，逼到 Codex 那一步
  const helper = path.join(dir, 'helper');
  fs.writeFileSync(helper, `#!/bin/bash
echo "helper $@" >> ${dir}/calls.log
[ "$1" = state ] && echo '{"ok":true}' && exit 0
echo '{"ok":false,"why":"假脚本"}'; exit 1
`, { mode: 0o755 });
  // 假 codex：把结果写进 -o 指的文件（desktop=ok 时说发了，会话里也能核对到）
  const codex = path.join(dir, 'codex');
  fs.writeFileSync(codex, `#!/bin/bash
echo "codex $@" >> ${dir}/calls.log
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && echo '{"sent": ${desktop === 'ok'}}' > "$2"; shift; done
`, { mode: 0o755 });
  const env = { ...process.env, HOME: dir, FR_CTX: ctx, FRA_HOME: dir, FR_LARK: lark, FR_PBCOPY: '/bin/cat', FR_ORCA: orca, FR_CODEX: codex, FRA_DESKTOP_HELPER: helper, FR_WEB_POLL_MS: '10' };
  const fr = (...args) => spawnSync(NODE, [FR, ...args], { env, encoding: 'utf8' });
  const events = () => fs.readdirSync(path.join(dir, 'events')).flatMap((f) => fs.readFileSync(path.join(dir, 'events', f), 'utf8').trim().split('\n')).map(JSON.parse);
  const calls = () => (fs.existsSync(`${dir}/calls.log`) ? fs.readFileSync(`${dir}/calls.log`, 'utf8') : '');
  return { dir, fr, events, calls, env };
}

test('回原消息：话题里回，记回执', () => {
  const s = setup();
  const r = s.fr('send', '--to', 'orig', '--text', '不是 504', '--why', '可以直接发');
  assert.equal(r.status, 0, r.stderr);
  assert.match(s.calls(), /\+messages-reply .*--message-id om_orig .*--reply-in-thread/);
  const e = s.events().find((x) => x.kind === 'fr-sent');
  assert.deepEqual([e.card, e.toName, e.text], ['om_card', '冯五', '不是 504']);
  assert.deepEqual([e.orig.message_id, e.orig.sender_id, e.orig.chat_type], ['om_orig', 'ou_u4', 'group']); // 助手据此跟随话题
});

test('发给点了名的人：回执不带原消息（不跟随那边的话题）', () => {
  const s = setup();
  assert.equal(s.fr('send', '--to', '赵六', '--text', '麻烦看下 WAF', '--why', '找一下赵六').status, 0);
  assert.equal(s.events().find((x) => x.kind === 'fr-sent').orig, undefined);
});

test('群消息即使原来不在话题，也开话题回复；私聊继续走主消息流', () => {
  const g = setup({ thread: null });
  assert.equal(g.fr('send', '--to', 'orig', '--text', '群里回', '--why', '可以直接发').status, 0);
  assert.match(g.calls(), /\+messages-reply .*--reply-in-thread/);
  const p = setup({ thread: null, origOver: { chat_type: 'p2p' } });
  assert.equal(p.fr('send', '--to', 'orig', '--text', '私聊回', '--why', '可以直接发').status, 0);
  assert.doesNotMatch(p.calls(), /--reply-in-thread/);
});

test('点了名的人可以发；没点名的人拒发且不调用发送', () => {
  const s = setup();
  assert.equal(s.fr('send', '--to', '赵六', '--text', '麻烦看下 WAF', '--why', '找一下赵六').status, 0);
  assert.match(s.calls(), /\+messages-send .*--user-id ou_u6/);
  const r = s.fr('send', '--to', '王五', '--text', 'hi', '--why', '找一下赵六');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /授权/);
  assert.ok(!/--user-id ou_u5/.test(s.calls()));
});

test('--why 不是我原话里的片段：拒发', () => {
  const s = setup();
  const r = s.fr('send', '--to', 'orig', '--text', 'x', '--why', '张三已经同意');
  assert.equal(r.status, 2);
  assert.ok(!/\+messages-/.test(s.calls()));
});

test('同样的内容第二次不再发', () => {
  const s = setup();
  s.fr('send', '--to', 'orig', '--text', '同一句', '--why', '可以直接发');
  const r = s.fr('send', '--to', 'orig', '--text', '同一句', '--why', '可以直接发');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /已经发过/);
  assert.equal((s.calls().match(/\+messages-reply/g) || []).length, 1);
});

test('正文带密钥：拒发', () => {
  const s = setup();
  assert.equal(s.fr('send', '--to', 'orig', '--text', 'key 是 abc_AbCdEf1234567890', '--why', '可以直接发').status, 2);
});

test('我原话里明确让发 key：带上 --secret-ok 才发，回执里的 key 脱敏', () => {
  const s = setup({ authText: '开好了 把 key 发给他' });
  const r = s.fr('send', '--to', 'orig', '--text', 'key 是 abc_AbCdEf1234567890', '--why', '发给他', '--secret-ok', '把 key 发给他');
  assert.equal(r.status, 0, r.stderr);
  assert.match(s.calls(), /abc_AbCdEf1234567890/, '真的发出去了');
  const ev = s.events().find((x) => x.kind === 'fr-sent');
  assert.ok(!ev.text.includes('abc_AbCdEf1234567890') && ev.text.includes('«已脱敏»'), '记录和报告卡上不留明文');
});

test('--secret-ok 不是我原话、或原话里没提 key：拒发', () => {
  const s = setup();
  assert.equal(s.fr('send', '--to', 'orig', '--text', 'key 是 abc_AbCdEf1234567890', '--why', '可以直接发', '--secret-ok', '可以直接发').status, 2);
  assert.equal(s.fr('send', '--to', 'orig', '--text', 'key 是 abc_AbCdEf1234567890', '--why', '可以直接发', '--secret-ok', '把 key 发给他').status, 2);
  assert.ok(!/\+messages-/.test(s.calls()));
});

test('附件里有密钥：没我允许就拒发，正文也不发', () => {
  const s = setup();
  const f = path.join(s.dir, 'keys.csv');
  fs.writeFileSync(f, 'name,key\n郑十,sk-AbCdEf1234567890xyz\n');
  assert.equal(s.fr('send', '--to', 'orig', '--text', '名单见附件', '--why', '可以直接发', '--file', f).status, 2);
  assert.ok(!/\+messages-/.test(s.calls()));
});

test('外部会话 230027：放剪贴板、记待手动、退出码 3；原文贴在卡片下面（卡片里的字复制不了）', () => {
  const s = setup({ external: true });
  const r = s.fr('send', '--to', 'orig', '--text', '收到', '--why', '可以直接发');
  assert.equal(r.status, 3);
  assert.equal(s.events().find((x) => x.kind === 'fr-manual')?.text, '收到');
  assert.match(s.calls(), /\+messages-reply --as bot --message-id om_card --text 收到/);
});

test('正文用了 markdown 列表：按富文本发', () => {
  const s = setup();
  assert.equal(s.fr('send', '--to', 'orig', '--text', '查到了：\n- 一\n- 二', '--why', '可以直接发').status, 0);
  assert.match(s.calls(), /\+messages-reply .*--markdown 查到了/);
});

test('外部会话 230027：改用 Orca 里的网页版飞书发，核对到消息才算已发', () => {
  const s = setup({ external: true, web: 'ok', thread: null });
  const r = s.fr('send', '--to', 'orig', '--text', '收到 谢谢', '--why', '可以直接发');
  assert.equal(r.status, 0, r.stderr);
  assert.match(s.calls(), /orca eval --page pg1/);
  const ev = s.events().find((x) => x.kind === 'fr-sent');
  assert.equal(ev.via, 'web');
  assert.equal(ev.message_id, 'om_web_1');
  assert.ok(!s.events().some((x) => x.kind === 'fr-manual'));
});

test('网页版没发成：退回剪贴板，并说明原因', () => {
  const s = setup({ external: true, web: 'fail', thread: null });
  const r = s.fr('send', '--to', 'orig', '--text', '收到', '--why', '可以直接发');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /搜不到/);
  assert.equal(s.events().find((x) => x.kind === 'fr-manual')?.text, '收到');
});

test('网页版点了发送但会话里核对不到：记结果未知，不重发', () => {
  const s = setup({ external: true, web: 'unverified', thread: null });
  const r = s.fr('send', '--to', 'orig', '--text', '收到', '--why', '可以直接发');
  assert.equal(r.status, 4);
  assert.equal(s.events().find((x) => x.kind === 'fr-unknown')?.via, 'web');
});

test('原消息在话题里：网页版回不进话题，直接走剪贴板', () => {
  const s = setup({ external: true, web: 'ok' });
  assert.equal(s.fr('send', '--to', 'orig', '--text', '收到', '--why', '可以直接发').status, 3);
  assert.ok(!/orca eval/.test(s.calls()));
});

test('wait 记跟进，done 结束', () => {
  const s = setup();
  assert.equal(s.fr('wait', '--for', '赵六', '--then', '复测通过就回冯五', '--until', '2d').status, 0);
  const log = fs.readFileSync(path.join(s.dir, 'followups.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([log[0].op, log[0].watch.open_id, log[0].card, log[0].authText.slice(0, 4)], ['add', 'ou_u6', 'om_card', '可以直接']);
  assert.equal(s.fr('wait', '--for', '王五', '--then', 'x').status, 2); // 没点名的人不能挂
  assert.equal(s.fr('done').status, 0);
});

test('我只回了两个字母（bu）：新写的话拒发、不调用发送；卡上现成的草稿可以发', () => {
  const s = setup({ ctxOver: { authText: 'bu', draft: '好的 辛苦' } });
  const r = s.fr('send', '--to', 'orig', '--text', '七哥，模型 A 那批今天不上', '--why', 'bu');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /太短/);
  assert.ok(!/\+messages-/.test(s.calls()));
  assert.equal(s.fr('send', '--to', 'orig', '--text', '好的 辛苦', '--why', 'bu').status, 0);
});

// v3：跟进的授权要引用我的原话；没引用的跟进被叫醒后不能发消息、不能做写操作
test('fr wait：带 --why 且是我原话 → auth=said；不带 → auth=none；引用不对 → 拒', () => {
  const s = setup();
  assert.equal(s.fr('wait', '--for', '赵六', '--then', '复测通过就回冯五', '--why', '等他改好了 我们复测没问题再回复一遍').status, 0);
  assert.equal(s.fr('wait', '--for', 'ou_u4', '--then', '他发账号码就加白').status, 0);
  assert.equal(s.fr('wait', '--for', '赵六', '--then', 'x', '--why', '张三说可以').status, 2);
  const log = fs.readFileSync(path.join(s.dir, 'followups.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map((r) => [r.watch.open_id, r.auth]), [['ou_u6', 'said'], ['ou_u4', 'none']]);
  assert.equal(log[1].watch.chat_id, 'oc_proj'); // 等原发送人：记原会话
});

test('没有配置：退出码 2，提示去跑 bin/fra setup', () => {
  const s = setup({ config: null });
  const r = s.fr('send', '--to', 'orig', '--text', 'x', '--why', '可以直接发');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bin\/fra setup/);
});

test('没配置 messenger_url 的外部会话：不走网页版，放剪贴板，退出码 3', () => {
  const s = setup({ external: true, web: 'ok', thread: null, config: { ...CONFIG, messenger_url: undefined } });
  const r = s.fr('send', '--to', 'orig', '--text', '收到', '--why', '可以直接发');
  assert.equal(r.status, 3, r.stderr);
  assert.ok(!/orca eval/.test(s.calls()));
  const e = s.events().find((x) => x.kind === 'fr-manual');
  assert.equal(e?.text, '收到');
  assert.match(e.why_manual, /没配置 messenger_url/);
});

test('仓库路径带空格：网页替发传给 Orca 的 worktree 路径是真实路径（不是 %20）', () => {
  const s = setup({ external: true, web: 'ok', thread: null, tabs: false }); // 没有现成的网页版飞书标签页，才在仓库的 worktree 里开
  const spaced = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fr sp ')), 'repo');
  for (const d of ['bin', 'lib']) fs.cpSync(path.resolve(d), path.join(spaced, d), { recursive: true });
  const r = spawnSync(NODE, [path.join(spaced, 'bin/fr'), 'send', '--to', 'orig', '--text', '收到 谢谢', '--why', '可以直接发'], { env: s.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(s.calls().includes(`path:${fs.realpathSync(spaced)}`), s.calls());
  assert.ok(!s.calls().includes('%20'));
});

test('外部会话网页版发成功但带了附件：提示里写的是我的名字，不是字面的 ${NAME}', () => {
  const s = setup({ external: true, web: 'ok', thread: null });
  const f = path.join(s.dir, 'a.txt'); fs.writeFileSync(f, 'x');
  const r = s.fr('send', '--to', 'orig', '--text', '收到 谢谢', '--why', '可以直接发', '--file', f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /要张三手动转发/);
  assert.match(s.calls(), /\+messages-reply --as bot --message-id om_card --file a\.txt/); // 附件贴在卡片下面，好转发
  assert.ok(!r.stdout.includes('${'));
});

test('外部会话：网页版没发成、开了 desktop_send → 走飞书客户端（先脚本），核对到才算已发', () => {
  const s = setup({ external: true, web: 'fail', desktop: 'ok', thread: null, config: { ...CONFIG, desktop_send: true } });
  const r = s.fr('send', '--to', 'orig', '--text', '收到 谢谢', '--why', '可以直接发');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /飞书客户端/);
  assert.match(s.calls(), /helper open 某项目群/);
  assert.equal(s.events().find((x) => x.kind === 'fr-sent')?.via, 'desktop');
});

test('外部会话：没开 desktop_send 就不碰飞书客户端', () => {
  const s = setup({ external: true, web: 'fail', desktop: 'ok', thread: null });
  assert.equal(s.fr('send', '--to', 'orig', '--text', '收到', '--why', '可以直接发').status, 3);
  assert.ok(!/codex|helper/.test(s.calls()));
});
