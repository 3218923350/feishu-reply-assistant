import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefetch } from '../lib/prefetch.mjs';

const ok = (o) => ({ code: 0, out: JSON.stringify(o), err: '' });
const hit = (path, title, type = 'policy') => ({ path, title, type, review: 'auto', status: 'active', snippet: `${title} 片段`, entities: [] });
const DEFAULT = {
  'mem:who': () => ok({ person: [hit('/m/people/郑十.md', '郑十：SDE 研发', 'person')], related: [hit('/m/policy/a.md', '开通规则')] }),
  'mem:search': () => ok([hit('/m/policy/a.md', '开通规则'), hit('/m/recipes/r17.md', '个人开通配方', 'recipe')]),
  lark: () => ok({ ok: true, data: { messages: [{ create_time: '2026-10-22 21:16', content: '给我账号码 我跟你开白名单' }] } }),
  orca: () => ok({ result: { hits: [{ title: '加白名单', agent: 'claude', cwd: '/w/proj', sessionId: 's1', evidence: { snippet: '账号码 开通 opus' } }] } }),
};
const BINS = { mem: 'mem', lark: 'lark-cli', orca: 'orca' };
function stub(over = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    const key = cmd === 'mem' ? `mem:${args[0]}` : cmd === 'lark-cli' ? 'lark' : 'orca';
    calls.push(key);
    return (over[key] || DEFAULT[key])();
  };
  return { run, calls };
}
const orig = { sender_name: '郑十', chat_id: 'oc_1', content: '@张三 u5678xyz' };
const ME = { me: 'ou_me', ignore: ['张三'] };

test('四路都成功：四个小节都在，记忆路径去重', async () => {
  const { text, memoryPaths } = await prefetch(orig, { ...stub(), bins: BINS, ...ME, now: Date.parse('2026-10-23T00:00:00+08:00') });
  for (const h of ['【这个人】', '【相关记忆】', '【我以前在这个会话说过】', '【本地 agent 会话片段】']) assert.ok(text.includes(h), h);
  assert.ok(!text.includes('【没取到】'));
  assert.deepEqual(memoryPaths, ['/m/people/郑十.md', '/m/policy/a.md', '/m/recipes/r17.md']);
  assert.ok(text.includes('给我账号码 我跟你开白名单'));
});

test('orca 超时：其余照出，【没取到】里写本地会话', async () => {
  const { text } = await prefetch(orig, { ...stub({ orca: () => ({ code: null, out: '', err: '' }) }), bins: BINS, ...ME });
  assert.ok(text.includes('【相关记忆】'));
  assert.match(text, /【没取到】[\s\S]*本地会话/);
});

test('lark-cli 输出不是 JSON：不抛错，记进【没取到】', async () => {
  const { text } = await prefetch(orig, { ...stub({ lark: () => ({ code: 0, out: 'token expired', err: '' }) }), bins: BINS, ...ME });
  assert.match(text, /【没取到】[\s\S]*我的历史发言/);
});

test('正文为空：不跑 mem search 和 orca', async () => {
  const s = stub();
  await prefetch({ ...orig, content: '  ' }, { ...s, bins: BINS, ...ME });
  assert.ok(!s.calls.includes('mem:search'));
  assert.ok(!s.calls.includes('orca'));
});

test('检索词去掉 @ 和我的名字，带上最近几条上下文', async () => {
  const seen = [];
  const run = async (cmd, args) => { if (cmd === 'mem' && args[0] === 'search') seen.push(args[1]); return DEFAULT[cmd === 'mem' ? `mem:${args[0]}` : cmd === 'lark-cli' ? 'lark' : 'orca'](); };
  await prefetch({ ...orig, recent: '给我账号码 我跟你开白名单' }, { run, bins: BINS, ...ME });
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].includes('张三'), seen[0]);
  assert.ok(seen[0].includes('u5678xyz') && seen[0].includes('账号码'), seen[0]);
});

test('本地会话去掉记忆抽取产生的会话', async () => {
  const hits = [
    { title: '飞书聊天记录记忆抽取', agent: 'claude', cwd: '/home/u/.feishu-reply-assistant/corpus/202609-10', sessionId: 'x', evidence: { snippet: 'a' } },
    { title: '加白名单', agent: 'claude', cwd: '/w/proj', sessionId: 's1', evidence: { snippet: 'b' } },
  ];
  const { text } = await prefetch(orig, { ...stub({ orca: () => ok({ result: { hits } }) }), bins: BINS, ...ME });
  assert.ok(!text.includes('飞书聊天记录记忆抽取'));
  assert.ok(text.includes('加白名单'));
});

test('人物卡按发送人 open_id 精确找', async () => {
  const seen = [];
  const run = async (cmd, args) => { seen.push([cmd, ...args]); return DEFAULT[cmd === 'mem' ? `mem:${args[0]}` : cmd === 'lark-cli' ? 'lark' : 'orca'](); };
  await prefetch({ ...orig, sender_id: 'ou_u10' }, { run, bins: BINS, ...ME });
  const w = seen.find((c) => c[0] === 'mem' && c[1] === 'who');
  assert.deepEqual(w.slice(1, 5), ['who', '郑十', '--id', 'ou_u10']);
});

test('我的历史发言按配置里的 open_id 搜', async () => {
  const seen = [];
  const run = async (cmd, args) => { seen.push([cmd, ...args]); return DEFAULT[cmd === 'mem' ? `mem:${args[0]}` : cmd === 'lark-cli' ? 'lark' : 'orca'](); };
  await prefetch(orig, { run, bins: BINS, ...ME });
  const l = seen.find((c) => c[0] === 'lark-cli');
  assert.equal(l[l.indexOf('--sender') + 1], 'ou_me');
});

test('没装 Orca：跳过本地会话那一路，不算没取到', async () => {
  const s = stub();
  const { text } = await prefetch(orig, { ...s, bins: { ...BINS, orca: null }, ...ME });
  assert.ok(!text.includes('本地 agent 会话片段') && !text.includes('【没取到】'), text);
  assert.ok(!s.calls.includes('orca'));
});

test('本地会话：数据目录不是默认位置时，记忆抽取会话也能滤掉', async () => {
  const hits = [
    { title: '记忆抽取', agent: 'claude', cwd: '/data/fra/corpus/daily/2026-10-22', sessionId: 'x', evidence: { snippet: 'a' } },
    { title: '加白名单', agent: 'claude', cwd: '/w/proj', sessionId: 's1', evidence: { snippet: 'b' } },
  ];
  const { text } = await prefetch(orig, { ...stub({ orca: () => ok({ result: { hits } }) }), bins: BINS, ...ME, home: '/data/fra' });
  assert.ok(!text.includes('记忆抽取'));
  assert.ok(text.includes('加白名单'));
});
