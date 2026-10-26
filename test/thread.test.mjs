import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiError, retryPrompt, threadReplies, workPrompt } from '../lib/commands.mjs';

test('办事提示词：带上我的原话、fr 用法、默认只做到测试结论、报告文件', () => {
  const p = workPrompt('可以直接发 然后找一下赵六吧', '/r/x.json');
  assert.ok(p.includes('「可以直接发 然后找一下赵六吧」'));
  assert.match(p, /fr send/);
  assert.match(p, /fr wait/);
  assert.match(p, /只做到测试结论/);
  assert.match(p, /\/r\/x\.json/);
  assert.ok(!/绝不要|不能发/.test(p));
  assert.match(p, /不要重复已经用 fr 发出去的正文/);
});

test('话题里我的回复都算作对这张卡的回复，别人的和卡片本身不算', () => {
  const msgs = [
    { message_id: 'om_card', sender: { id: 'ou_bot' }, content: '卡片' },
    { message_id: 'om_1', sender: { id: 'ou_me' }, content: '执行，只测试', thread_id: 'omt_x' },
    { message_id: 'om_2', sender: { id: 'ou_other' }, content: '路过' },
  ];
  assert.deepEqual(threadReplies(msgs, 'om_card', 'ou_me').map((m) => [m.message_id, m.reply_to]), [['om_1', 'om_card']]);
});

test('跟进唤醒的提示词：换开场白，规则不变', () => {
  const p = workPrompt('等他改好了 我们复测没问题再回复一遍', '/r/y.json', '你在等赵六，他回了：「放行了」');
  assert.ok(p.startsWith('你在等赵六，他回了：「放行了」'));
  assert.match(p, /fr send/);
  assert.match(p, /\/r\/y\.json/);
});

test('办事提示词带上最近已经以我身份发出的消息，避免别的会话重复发', () => {
  const p = workPrompt('没问题后 可以再通知冯五', '/r/z.json', undefined, ['11:41 给冯五：文博，昨晚那个 405 查清了…']);
  assert.match(p, /最近 24 小时已经以\{\{name\}\}身份发出/);
  assert.match(p, /11:41 给冯五/);
  assert.ok(p.startsWith('{{name}}刚在草稿卡片下说'));
  assert.ok(!/最近 24 小时/.test(workPrompt('x', '/r/z.json')));
});

test('办事报告要写清查了哪些信息、看到了什么，不再限一两句话', () => {
  const p = workPrompt('再测试一下', '/r/w.json');
  assert.ok(!/一两句话/.test(p));
  assert.match(p, /查了哪些信息/);
});

test('办事提示词：本机的 key 都能用，但不能发给别人，除非我原话里允许（--secret-ok）', () => {
  const p = workPrompt('再测试一下', '/r/k.json');
  assert.match(p, /本机的 key 都可以用/);
  assert.match(p, /不准外传给别人/);
  assert.match(p, /--secret-ok/);
});

// 2026-10-23 20:03 起待处理 + 已收起的卡超过 50 张，messages-mget 一次最多 50 个 id，整个草稿群轮询报错、我的回复全被跳过
import { chunk } from '../lib/commands.mjs';
test('chunk：按 50 个一组切开', () => {
  const ids = Array.from({ length: 101 }, (_, i) => `om_${i}`);
  assert.deepEqual(chunk(ids, 50).map((c) => c.length), [50, 50, 1]);
  assert.deepEqual(chunk([], 50), []);
});

// v3 第 1 步：Claude 自己挂的跟进被叫醒，只能查和出卡；fr wait 写明 --why 才算我要求的；报告里写这条是不是在回等的事
import { wakePrompt } from '../lib/commands.mjs';
test('wakePrompt：没授权的跟进 → 不能发、不能写，回复写进 draft；要求写 related', () => {
  const f = { watch: { name: '钱二' }, then: '他发账号码就加白并回他', auth: 'none', authText: 'OK 你发他吧' };
  const p = wakePrompt(f, { create_time: '17:00', content: '我的账号码是 u1234abc' }, '/r/w.json', []);
  assert.match(p, /钱二.*u1234abc/s);
  assert.match(p, /不是\{\{name\}\}要求的/);
  assert.match(p, /不能用 fr 发消息/);
  assert.match(p, /不能做写操作/);
  assert.match(p, /"related"/);
  assert.ok(!/现在可以发/.test(p));
});
test('wakePrompt：我原话要求的跟进 → 在原话范围内可以办和发', () => {
  const f = { watch: { name: '赵六' }, then: '复测通过就回冯五', auth: 'said', why: '等他改好了 我们复测没问题再回复一遍', authText: '可以直接发 然后找一下赵六吧 等他改好了 我们复测没问题再回复一遍' };
  const p = wakePrompt(f, { create_time: '11:40', content: '放行了' }, '/r/w.json', []);
  assert.match(p, /等他改好了 我们复测没问题再回复一遍/);
  assert.match(p, /fr send/);
  assert.match(p, /"related"/);
});
test('fr wait 的用法写明：我要求跟进才带 --why', () => {
  assert.match(workPrompt('x', '/r/z.json'), /fr wait .*--why/);
});

// v4：报告要写状态、要你定的拆成选项、两份草稿；答应过还没做的要列出来，做完写 kept
test('办事提示词：报告带 state / options / draft_after / kept；草稿不许答应还没批准的事', () => {
  const p = workPrompt('先查清楚', '/r/z.json', undefined, [], [{ id: 'c-1', what: '我现在把节点摘', toName: '周八' }]);
  for (const k of ['"state"', '"options"', '"draft_after"', '"kept"']) assert.ok(p.includes(k), k);
  assert.match(p, /draft 只说已经查实|不要在 draft 里答应/);
  assert.match(p, /c-1.*我现在把节点摘.*周八/s);
  assert.ok(!/c-1/.test(workPrompt('x', '/r/z.json')));
});
import { approvePrompt } from '../lib/commands.mjs';
test('同意所选：授权原话就是勾了的那几项；没勾的写明不要做；做完再回的话原样交给它', () => {
  const opts = [{ id: 'ark', label: '摘掉 B 组的自部署成员' }, { id: 'pub', label: '公开组也摘' }];
  const { authText, intro } = approvePrompt(opts, ['ark'], '摘好了，你再跑一遍', '周八');
  assert.match(authText, /同意：摘掉 B 组的自部署成员/);
  assert.match(authText, /办完把做完再回的话发给周八/);
  assert.ok(!authText.includes('公开组'));
  assert.match(intro, /没勾.*公开组也摘.*不要做/s);
  assert.match(intro, /摘好了，你再跑一遍/);
});

// 2026-10-26 事故：seen 3 天过期，而话题里还有 3 天内的卡，10-23 我在话题里说的「先给他 tpm 和并发提高吧」被当成新吩咐又办了一遍
test('话题里只认这轮拉取窗口里的新话（create_time 是北京时间、精确到分），老话 seen 过期了也不重放', () => {
  const since = Date.parse('2026-10-26T15:20:10+08:00');
  const msgs = [
    { message_id: 'om_old', sender: { id: 'ou_me' }, content: '先给他 tpm 和并发提高吧', create_time: '2026-10-23 15:19' },
    { message_id: 'om_new', sender: { id: 'ou_me' }, content: '发', create_time: '2026-10-26 15:20' }, // 同一分钟里、since 之后
    { message_id: 'om_new2', sender: { id: 'ou_me' }, content: '不', create_time: '2026-10-26 15:21' },
  ];
  assert.deepEqual(threadReplies(msgs, 'om_card', 'ou_me', since).map((m) => m.message_id), ['om_new', 'om_new2']);
});

// 2026-10-26 孙七那轮：14:53 接口报错（malformed stream）会话停了，程序干等一小时才提示
const jl = (...xs) => xs.map((x) => JSON.stringify(x)).join('\n');
const errEntry = (ts, error, text) => ({ type: 'assistant', timestamp: ts, isApiErrorMessage: true, error, message: { content: [{ type: 'text', text }] } });
test('办事会话最后一件事是接口报错：认出来；断流这类可以重开，提示太长 / 登录这类不重开；报错之后还有动静、或者报错在这轮之前的都不算', () => {
  const since = Date.parse('2026-10-26T06:47:00Z');
  const tool = { type: 'user', timestamp: '2026-10-26T06:52:31Z', message: { content: [{ type: 'tool_result', content: 'x' }] } };
  const turn = { type: 'system', subtype: 'turn_duration', timestamp: '2026-10-26T06:53:24.873Z' };
  const e = apiError(jl(tool, errEntry('2026-10-26T06:53:24.849Z', 'server_error', 'API Error: The response stream was malformed.'), turn) + '\n{坏行', since);
  assert.deepEqual(e, { error: 'server_error', text: 'API Error: The response stream was malformed.', retry: true });
  assert.equal(apiError(jl(errEntry('2026-10-26T06:53:24Z', 'invalid_request', 'Prompt is too long')), since).retry, false);
  assert.equal(apiError(jl(errEntry('2026-10-26T06:53:24Z', 'authentication_failed', 'Please run /login')), since).retry, false);
  assert.equal(apiError(jl(errEntry('2026-10-26T06:53:24Z', 'server_error', 'x'), { ...tool, timestamp: '2026-10-26T06:55:00Z' }), since), null);
  assert.equal(apiError(jl(errEntry('2026-10-26T06:40:00Z', 'server_error', 'x')), since), null);
  assert.equal(apiError(jl(tool), since), null);
});

test('报错重开的提示词：接着办、发过的别重发、报告写回原来的文件', () => {
  const p = retryPrompt('API Error: The response stream was malformed.', '/r/x.report.json');
  assert.match(p, /接口报错/);
  assert.match(p, /不要重发/);
  assert.match(p, /\/r\/x\.report\.json/);
});
