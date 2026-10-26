import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { holds, finalTier, sessionCommands, projectDir } from '../lib/shadow.mjs';

const res = (o = {}) => ({ kind: 'answer', draft: '直接去 https://gw.example.com/ 登录建 key 就行', proposed_actions: '', send_tier: 'auto',
  facts: [{ claim: '按量已默认开通', cmd: '记忆:/mem/recipes/开通.md' }], ...o });
const ctx = (o = {}) => ({ commands: ['mem search 开通'], firstContact: false, leader: false, external: false, ...o });

test('干净的入口指引：不拦，按模型建议', () => {
  assert.deepEqual(holds(res(), ctx()), []);
  assert.equal(finalTier(res(), []), 'auto');
  assert.equal(finalTier(res({ send_tier: 'countdown' }), []), 'countdown');
  assert.equal(finalTier(res({ send_tier: '乱写' }), []), 'hold');
});

test('硬规则：任一命中就等你，程序只往严里改', () => {
  const cases = [
    [res({ kind: 'decision' }), ctx(), /拍板/],
    [res({ draft: '是 `<分支名>` 这个分支' }), ctx(), /占位/],
    [res({ draft: '若有录音：发你。若没录：没录呢' }), ctx(), /占位|两套/],
    [res({ draft: '模型 B 是 67.30 元每百万' }), ctx(), /钱/],
    [res({ draft: 'model-k3 免费用' }), ctx(), /钱/],
    [res({ draft: '今天上，晚上发你' }), ctx(), /时间/],
    [res({ draft: '我今晚修好了跟你说' }), ctx(), /时间/],
    [res({ facts: [{ claim: '我们没用这个接入点', cmd: '推断' }] }), ctx(), /查证/],
    [res({ facts: [{ claim: '并发 320', cmd: 'kubectl exec model-plan -- mysql -e select' }] }), ctx(), /查证/],
    [res({ facts: [] }), ctx(), /依据/],
    [res({ facts: [{ claim: 'x', cmd: '记忆:/mem/inbox/recipes/开通.md' }] }), ctx(), /待确认/],
    [res({ kind: 'action', proposed_actions: '给他加白名单' }), ctx(), /动手/],
    [res(), ctx({ firstContact: true }), /第一次/],
    [res(), ctx({ leader: true }), /上级/],
    [res(), ctx({ external: true }), /外部/],
  ];
  for (const [r, c, re] of cases) {
    const h = holds(r, c);
    assert.ok(h.some((x) => re.test(x)), `${JSON.stringify(r.draft || r.kind)} → ${JSON.stringify(h)}`);
    assert.equal(finalTier(r, h), 'hold');
  }
});

test('查证要对得上会话里真跑过的命令（空白不算差别）', () => {
  const r = res({ facts: [{ claim: '有 model-k3', cmd: 'curl -s https://gw.example.com/v1/models' }] });
  assert.deepEqual(holds(r, ctx({ commands: ['curl  -s https://gw.example.com/v1/models -H "Authorization: Bearer $K"'] })), []);
  assert.ok(holds(r, ctx({ commands: ['curl -s https://example.com'] })).length);
});

test('sessionCommands：从会话记录里取出 Bash 命令、读过的文件、搜过的词', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const cwd = '/tmp/w/feishu-reply-assistant/workspace';
  const dir = path.join(home, '.claude', 'projects', projectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const line = (content) => JSON.stringify({ type: 'assistant', message: { content } });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), [
    line([{ type: 'tool_use', name: 'Bash', input: { command: 'mem who 钱二' } }]),
    line([{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'Read', input: { file_path: '/mem/recipes/开通.md' } }]),
    line([{ type: 'tool_use', name: 'Grep', input: { pattern: 'model-k3', path: '/repo' } }]),
    'not json',
  ].join('\n'));
  assert.equal(projectDir(cwd), '-tmp-w-feishu-reply-assistant-workspace');
  assert.deepEqual(sessionCommands(cwd, 's1', home), ['mem who 钱二', '/mem/recipes/开通.md', 'model-k3 /repo']);
  assert.deepEqual(sessionCommands(cwd, 'missing', home), []);
});

// 2026-10-24 实测：Claude 引用命令时会改写（少了 --max-time、Read 过的文件写成 sed），按命令里的网址 / 文件路径对
test('查证按命令里的网址和文件路径对：改写过的命令也算；网址或文件没碰过就不算', () => {
  const commands = ['curl -s --max-time 30 https://gw.example.com/internal/billing/catalog | python3 -c "..."', '/mem/recipes/开通.md'];
  const r = (cmd) => res({ facts: [{ claim: 'c', cmd }] });
  assert.deepEqual(holds(r(`curl -s https://gw.example.com/internal/billing/catalog | python3 -c "print(1)"`), ctx({ commands })), []);
  assert.deepEqual(holds(r(`sed -n 13,24p '/mem/recipes/开通.md'`), ctx({ commands })), []);
  assert.ok(holds(r('curl -s https://gw.example.com/v1/models'), ctx({ commands })).some((x) => /查证/.test(x)));
  assert.ok(holds(r(`sed -n 1,5p '/mem/inbox/recipes/开通.md'`), ctx({ commands: ['/mem/inbox/recipes/开通.md'] })).some((x) => /待确认/.test(x)));
});

// 2026-10-24 实测：answer 卡上 Claude 顺手写了「他要 model-k3 就发账号码加白」，那是以后的事，不影响这句先发
test('answer 卡的 proposed_actions 是以后的事，不拦；action 卡的草稿是做完之后的话，拦', () => {
  assert.ok(!holds(res({ proposed_actions: '他发账号码就加白' }), ctx()).some((x) => /动手/.test(x)));
});
