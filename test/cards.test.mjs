import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftCard, reportCard, closedCard, parseClick, clickWatch } from '../lib/cards.mjs';

const o = { message_id: 'om_o', sender_name: '钱二', chat_name: null, create_time: '2026-10-23 16:53', content: '张三，我想整个 kimi k3 model plan, 我要怎么申请呀', link: 'https://applink.feishu.cn/x' };
const json = (c) => JSON.stringify(c);
const find = (c, pred, acc = []) => { if (c && typeof c === 'object') { if (pred(c)) acc.push(c); for (const v of Object.values(c)) find(v, pred, acc); } return acc; };
const buttons = (c) => find(c, (x) => x.tag === 'button').map((b) => [b.name, b.text.content, b.type]);

test('起草卡（有草稿）：Card 2.0；原消息一块；拟发送是可改的输入框；发出这句 / 照我说的办 / 不回；查证收进折叠', () => {
  const c = draftCard(o, { kind: 'answer', summary: '申请入口', draft: '直接去 https://gw.example.com/ 就行', evidence: '查了开通配方', used_memories: ['/m/recipes/开通.md'], proposed_actions: '' });
  assert.equal(c.schema, '2.0');
  assert.match(c.header.title.content, /钱二/);
  const draft = find(c, (x) => x.tag === 'input' && x.name === 'draft')[0];
  assert.equal(draft.default_value, '直接去 https://gw.example.com/ 就行');
  assert.ok(find(c, (x) => x.tag === 'input' && x.name === 'note').length === 1);
  assert.deepEqual(buttons(c), [['send', '发出这句', 'primary_filled'], ['work', '照我说的办', 'default'], ['skip', '不回', 'default']]);
  assert.match(json(find(c, (x) => x.tag === 'form')[0]), /发：只把这句发出去 · 办：真的去执行/); // 按钮上方一行说明
  const panel = find(c, (x) => x.tag === 'collapsible_panel')[0];
  assert.equal(panel.expanded, false);
  assert.match(json(panel), /查了开通配方/);
  assert.match(json(panel), /开通/);
  assert.ok(json(c).includes('怎么申请呀'));
});

// 10-27 试用反馈「按钮有点误导人」：要动手卡的 draft 是办完才回的话，以前主按钮「按我说的办」空着点会被拒、「只发这句」会先说做完了
test('要动手的卡：要做的事露在外面；主按钮「去办」、办完再发；草稿放进「办完回他的话」，没有「发」按钮', () => {
  const c = draftCard(o, { kind: 'action', summary: '加白', draft: '加好了', evidence: 'x', proposed_actions: '给 u1234abc 加 model-k3', used_memories: [] });
  const panel = find(c, (x) => x.tag === 'collapsible_panel')[0];
  assert.ok(!json(panel).includes('给 u1234abc 加 model-k3'));
  assert.ok(json(c).includes('给 u1234abc 加 model-k3'));
  assert.deepEqual(buttons(c), [['approve', '去办', 'primary_filled'], ['work', '照我说的办', 'default'], ['skip', '不回', 'default']]);
  assert.equal(find(c, (x) => x.tag === 'input' && x.name === 'draft').length, 0);
  const after = find(c, (x) => x.tag === 'input' && x.name === 'draft_after')[0];
  assert.equal(after.default_value, '加好了');
  assert.match(after.label.content, /办完回他的话（空着就不回）/);
});

test('要你定、没草稿：问题露在外面，没有发送按钮', () => {
  const c = draftCard(o, { kind: 'decision', summary: '收不收费要你定', draft: '', evidence: '', proposed_actions: '', used_memories: [] });
  assert.ok(json(c).includes('收不收费要你定'));
  assert.ok(!buttons(c).some(([n]) => n === 'send'));
  assert.equal(find(c, (x) => x.tag === 'input' && x.name === 'draft').length, 0);
});

test('影子期：卡上不写「放手 / 等你点」这类内部说法；折叠里第一行写要等你的原因；没开直接发时才提一句「开了会直接发」', () => {
  const c = draftCard(o, { kind: 'answer', summary: 's', draft: 'd', evidence: '', proposed_actions: '', used_memories: [] }, { tier: 'hold', reasons: ['涉及钱'] });
  assert.ok(!json(c).includes('放手'));
  const panel = find(c, (x) => x.tag === 'collapsible_panel')[0];
  assert.equal(panel.elements[0].text.content, '为什么要等你：涉及钱');
  const a = (live) => JSON.stringify(draftCard(o, { kind: 'answer', summary: 's', draft: 'd', evidence: '', used_memories: [] }, { tier: 'auto', reasons: [] }, { live }));
  assert.match(a(false), /开了直接发的话，这条会不等你直接发/);
  assert.ok(!a(true).includes('开了直接发'));
});

test('消息里的 < > 原样当文字显示，不被当成标签', () => {
  const c = draftCard({ ...o, content: '<font color=red>x</font> <at id=all></at>' }, { kind: 'answer', summary: 's', draft: 'd', evidence: '', proposed_actions: '', used_memories: [] });
  const quote = find(c, (x) => x.tag === 'div' && /font color/.test(x.text?.content || ''))[0];
  assert.equal(quote.text.tag, 'plain_text');
});

test('报告卡：已发来自回执、要你定的露在外面；有拟回复就能直接改了发；做了什么收进折叠', () => {
  const c = reportCard(o, { did: '查了账号，加了白名单', verification: 'curl /v1/models → 有 model-k3', waiting: '', ask: '要不要也开模型 B', draft: '加好了' },
    [{ kind: 'fr-sent', toName: '钱二', text: '钱二，直接去门户建 key' }], 'sess-1');
  assert.ok(json(c).includes('已发给钱二'));
  assert.ok(json(c).includes('要不要也开模型 B'));
  assert.equal(find(c, (x) => x.tag === 'input' && x.name === 'draft')[0].default_value, '加好了');
  const panel = find(c, (x) => x.tag === 'collapsible_panel')[0];
  assert.match(json(panel), /查了账号/);
  assert.match(json(panel), /sess-1/);
  assert.ok(buttons(c).some(([n]) => n === 'send'));
});

test('报告卡没有拟回复：只留「接着办」', () => {
  const c = reportCard(o, { did: '做完了', verification: '', waiting: '', ask: '', draft: '' }, [], 's');
  assert.deepEqual(buttons(c).map(([n, t]) => [n, t]), [['work', '接着办']]);
  assert.ok(!json(c).includes('「发」只以你的身份')); // 没有「发」按钮就不写说明
});

test('要你定、没草稿：主按钮是「照我说的办」，吩咐框提示写决定', () => {
  const c = draftCard(o, { kind: 'decision', summary: '收不收费要你定', draft: '', evidence: '', proposed_actions: '', used_memories: [] });
  assert.deepEqual(buttons(c), [['work', '照我说的办', 'primary_filled'], ['skip', '不回', 'default']]);
  assert.match(find(c, (x) => x.tag === 'input' && x.name === 'note')[0].placeholder.content, /写你的决定/);
});

test('全卡不再出现旧的含糊文案', () => {
  const cards = [
    draftCard(o, { kind: 'answer', summary: 's', draft: 'd', evidence: '', proposed_actions: '', used_memories: [] }, { tier: 'auto', reasons: [] }),
    draftCard(o, { kind: 'action', summary: 's', draft: 'd', evidence: '', proposed_actions: 'p', used_memories: [] }, null, { warning: ['马上告诉你'] }),
    draftCard(o, { kind: 'action', summary: 's', draft: 'd', draft_after: 'x', options: opts, evidence: '', proposed_actions: 'p', used_memories: [] }),
    reportCard(o, { did: 'x', ask: 'a', options: opts, draft: 'd' }, [], 's', { warning: ['马上'] }),
    closedCard(o, '已发送', 'x', { pending: ['p'] }),
  ];
  for (const c of cards) for (const old of ['按吩咐办', '不回，收起', '同意所选', '只发这句', '只回话', '我自己办，先发这句', '不写就照卡上', '放手会', '"不发"', '"去做"']) assert.ok(!json(c).includes(old), old);
});

test('结果卡：没有按钮和输入框，写清结果', () => {
  const c = closedCard(o, '已发送', '直接去 model-plan 就行');
  assert.equal(buttons(c).length, 0);
  assert.equal(find(c, (x) => x.tag === 'input').length, 0);
  assert.ok(json(c).includes('已发送'));
  assert.ok(json(c).includes('直接去 model-plan 就行'));
});

test('parseClick：只认我点的；带回改过的草稿和吩咐', () => {
  const ev = { operator_id: 'ou_me_bot', message_id: 'om_card', action_tag: 'button', action_name: 'send', form_value: '{"draft":"改过的","note":""}', event_id: 'e1' };
  assert.deepEqual(parseClick(ev, 'ou_me_bot'), { card: 'om_card', action: 'send', draft: '改过的', draft_after: '', note: '', selected: [], id: 'e1', form: { draft: '改过的', note: '' } });
  assert.equal(parseClick({ ...ev, operator_id: 'ou_other' }, 'ou_me_bot'), null);
  assert.equal(parseClick({ ...ev, action_name: 'xx' }, 'ou_me_bot'), null);
  assert.deepEqual(parseClick({ ...ev, action_name: 'work', form_value: '{"note":"先查一下"}' }, 'ou_me_bot').note, '先查一下');
});

// ---- v4：要你定的操作做成勾选、两份草稿、报告卡标题按状态、拦承诺、答应了还没做 ----
const opts = [{ id: 'ark', label: '摘掉 B 组的自部署成员', cost: '服务丙改走云厂商按量' }, { id: 'pub', label: '公开组的自部署成员也摘' },
  { id: 'a', label: '方案 A：限流', group: 'how' }, { id: 'b', label: '方案 B：扩容', group: 'how' }];

test('报告卡标题按状态：查清了待你定 / 办完了 / 部分完成 / 受阻', () => {
  const t = (state) => reportCard(o, { state, did: 'x', ask: '', draft: '', verification: '', waiting: '' }, [], 's').header.title.content;
  assert.match(t('decide'), /查清了，待你定/);
  assert.match(t('done'), /办完了/);
  assert.match(t('partial'), /部分完成/);
  assert.match(t('blocked'), /受阻/);
  assert.match(reportCard(o, { did: 'x', ask: '要不要摘', draft: '' }, [], 's').header.title.content, /待你定/); // 没写 state 但有 ask
});

test('有选项：独立的是勾选框（默认不勾），互斥的是下拉；两份草稿；主按钮「办勾选项」单独一行', () => {
  const c = reportCard(o, { state: 'decide', did: '查清了', ask: '要不要摘', options: opts, draft: '查到了，配置还没改', draft_after: '摘好了，你再跑一遍' }, [], 's');
  const checkers = find(c, (x) => x.tag === 'checker');
  assert.deepEqual(checkers.map((x) => [x.name, x.checked]), [['opt_ark', false], ['opt_pub', false]]);
  assert.match(checkers[0].text.content, /服务丙改走云厂商按量/);
  const sel = find(c, (x) => x.tag === 'select_static');
  assert.deepEqual(sel.map((x) => [x.name, x.options.map((y) => y.value)]), [['grp_how', ['a', 'b']]]);
  assert.equal(find(c, (x) => x.tag === 'input' && x.name === 'draft')[0].default_value, '查到了，配置还没改');
  assert.equal(find(c, (x) => x.tag === 'input' && x.name === 'draft_after')[0].default_value, '摘好了，你再跑一遍');
  assert.deepEqual(buttons(c).map(([n, t]) => [n, t]), [['approve', '办勾选项'], ['send', '先发这句'], ['work', '照我说的办'], ['skip', '不回']]);
  assert.ok(!json(sel).includes('不选就是都不做')); // 不选点了会被拒，别说「不选就是都不做」
  const rows = find(c, (x) => x.tag === 'column_set' && x.columns?.some((col) => col.elements?.some((e) => e.tag === 'button')));
  assert.equal(rows.length, 2); // 主按钮一行，其余一行
});

test('起草卡也能带选项（要动手的卡）', () => {
  const c = draftCard(o, { kind: 'action', summary: '加白', draft: '收到，我看下', draft_after: '加好了', options: [{ id: 'w', label: '给 u1234abc 加 model-k3' }], evidence: '', proposed_actions: '加白', used_memories: [] });
  assert.equal(find(c, (x) => x.tag === 'checker').length, 1);
  assert.equal(buttons(c)[0][0], 'approve');
});

test('拦承诺：卡上标红说明是哪句；主按钮「让它去办」，「发出这句」换成「照发，我自己办」', () => {
  const c = draftCard(o, { kind: 'answer', summary: 's', draft: '我现在把节点摘掉，弄完告诉你', evidence: '', proposed_actions: '', used_memories: [] }, null, { warning: ['我现在把节点摘', '弄完告诉你'] });
  assert.ok(json(c).includes('我现在把节点摘'));
  assert.ok(!buttons(c).some(([n]) => n === 'send'));
  assert.ok(buttons(c).some(([n, t]) => n === 'send_anyway' && t === '照发，我自己办'));
  assert.deepEqual(buttons(c)[0], ['do_promise', '让它去办', 'primary_filled']);
  assert.ok(!json(c).includes('上面的「办」'));
});

test('结果卡挂着「答应了还没做」和「去办 / 我办好了 / 不办了」按钮', () => {
  const c = closedCard(o, '已发送', '我现在把节点摘掉，弄完告诉你', { pending: ['我现在把节点摘'] });
  assert.ok(json(c).includes('答应了还没做'));
  assert.deepEqual(buttons(c).map(([n]) => n), ['keep', 'kept_self', 'drop']);
  assert.equal(buttons(closedCard(o, '已发送', 'x')).length, 0);
});

test('parseClick：同意所选带回勾了哪些（勾选 + 下拉）和做完再回的话', () => {
  const ev = { operator_id: 'me', message_id: 'om_c', action_tag: 'button', action_name: 'approve', event_id: 'e2',
    form_value: JSON.stringify({ opt_ark: true, opt_pub: false, grp_how: 'b', draft: '查到了', draft_after: '摘好了', note: '' }) };
  const r = parseClick(ev, 'me');
  assert.deepEqual([r.action, r.selected, r.draft_after], ['approve', ['ark', 'b'], '摘好了']);
  assert.equal(parseClick({ ...ev, action_name: 'send_anyway' }, 'me').action, 'send_anyway');
  assert.equal(parseClick({ ...ev, action_name: 'keep', form_value: '' }, 'me').action, 'keep');
});

test('一个组里只有一个选项：画成勾选框，不画只有一项的下拉', () => {
  const c = draftCard(o, { kind: 'action', summary: 's', draft: 'd', draft_after: 'x', options: [{ id: 'w', label: '写文件', group: '本机' }], evidence: '', proposed_actions: 'p', used_memories: [] });
  assert.deepEqual(find(c, (x) => x.tag === 'checker').map((x) => x.name), ['opt_w']);
  assert.equal(find(c, (x) => x.tag === 'select_static').length, 0);
});

// 2026-10-26 网页版实测：有选项的卡被拦后，警告在卡片上方看不到、按钮还是「只回话」，再点还是被拦 → 「没反应」
test('被拦后：警告挨着按钮（在表单里、按钮行之前）；有选项的卡也换成「照发，我自己办」', () => {
  for (const c of [
    draftCard(o, { kind: 'action', summary: 's', draft: '我先写进去，写好马上告诉你', draft_after: '写好了', options: [{ id: 'w', label: '写文件' }], evidence: '', proposed_actions: 'p', used_memories: [] }, null, { warning: ['写好马上告诉你'] }),
    draftCard(o, { kind: 'answer', summary: 's', draft: '我现在把节点摘掉，弄完告诉你', evidence: '', proposed_actions: '', used_memories: [] }, null, { warning: ['弄完告诉你'] }),
  ]) {
    const form = find(c, (x) => x.tag === 'form')[0];
    const iWarn = form.elements.findIndex((e) => JSON.stringify(e).includes('⚠️'));
    const iButtons = form.elements.findIndex((e) => JSON.stringify(e).includes('"tag":"button"'));
    assert.ok(iWarn >= 0 && iWarn < iButtons, `warn ${iWarn} buttons ${iButtons}`);
    assert.ok(buttons(c).some(([n, t]) => n === 'send_anyway' && t === '照发，我自己办'));
    assert.ok(!buttons(c).some(([n]) => n === 'send'));
  }
});

test('单应用（配置里不写 bot_open_id）：按钮回调的 operator_id 就是 open_id，也认得出', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { loadConfig } = await import('../lib/config.mjs');
  const fra = fs.mkdtempSync(path.join(os.tmpdir(), 'click-'));
  fs.writeFileSync(path.join(fra, 'config.json'), JSON.stringify({ name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft' }));
  const me = loadConfig({ env: { FRA_HOME: fra } }).botOpenId;
  const ev = { operator_id: 'ou_me', action_tag: 'button', action_name: 'send', message_id: 'om_c', event_id: 'e1', form_value: '{}' };
  assert.notEqual(parseClick(ev, me), null);
});

test('报告卡：后台办事时折叠里给出日志路径', () => {
  const c = JSON.stringify(reportCard(o, { did: '查了', state: 'done' }, [], 's1', { log: '/r/w.log' }));
  assert.ok(c.includes('📄 过程日志：/r/w.log'));
  assert.ok(!JSON.stringify(reportCard(o, { did: '查了', state: 'done' }, [], 's1')).includes('过程日志'));
});

test('clickWatch：没订阅回调一直断 → 同样的报错只记一次、重连间隔翻倍到 10 分钟封顶；连上后复位', () => {
  const w = clickWatch();
  const err = (id) => `[event] error: event card.action.trigger not subscribed (log_id ${id})\n`;
  assert.equal(w.stderr('[event] listening for events'), null);
  assert.match(w.stderr(err(111)), /not subscribed/);
  assert.deepEqual(w.exit(1), { delay: 30_000, line: '监听退出 code=1，30 秒后重连' });
  const delays = [];
  for (let i = 0; i < 6; i++) {
    assert.equal(w.stderr(err(200 + i)), null, '只是数字不同也算同样的报错');
    const e = w.exit(1);
    assert.equal(e.line, null);
    delays.push(e.delay / 1000);
  }
  assert.deepEqual(delays, [60, 120, 240, 480, 600, 600]);
  assert.match(w.stderr('[event] error: app not found'), /app not found/, '换了报错要记');
  assert.match(w.exit(1).line, /600 秒后重连/);
  assert.match(w.stderr('[event] ready event_key=card.action.trigger'), /ready/);
  assert.deepEqual(w.exit(0), { delay: 30_000, line: '监听退出 code=0，30 秒后重连' });
  assert.match(w.stderr(err(1)), /not subscribed/, '复位后同样的报错又会记一次');
});

test('收起的卡：群里发出去的显示「在盯这个话题」和「不用盯了」按钮；点过之后只剩一行说明；单聊没有', async () => {
  const { closedCard } = await import('../lib/cards.mjs');
  const o = { sender_name: '李四', chat_name: '某群', content: 'x' };
  const on = JSON.stringify(closedCard(o, '已发送', '收到', { watch: 'on' }));
  assert.match(on, /盯着话题/); assert.match(on, /"name":"unwatch"/);
  const off = JSON.stringify(closedCard(o, '已发送', '收到', { watch: 'off' }));
  assert.match(off, /已不再盯这个话题/); assert.ok(!off.includes('"name":"unwatch"'));
  assert.ok(!JSON.stringify(closedCard(o, '已发送', '收到')).includes('盯'));
});
