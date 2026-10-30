import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendInPage } from '../lib/websend.mjs';

// 假的网页版飞书：按脚本里的特征认出是哪一步，改页面状态；lose 里的步骤前几次「执行上下文没了」
function fakePage({ chats = ['陈文庆'], lose = {}, header = '' } = {}) {
  const page = { header, searchOpen: false, query: '', composer: '', sent: [], calls: [] };
  const n = {};
  const which = (e) => (e.includes('send__button') ? 'send' : e.includes('paste(box') ? 'typeSearch' : e.includes('paste(ed') ? 'pasteText'
    : e.includes('cs[0].click') ? 'pick' : e.includes('entry.click') ? 'openSearch' : e.includes('ready:') ? 'searchReady'
    : e.includes('n: hits') ? 'results' : e.includes('same:') ? 'composed' : e.includes("execCommand('delete')") ? 'clear' : 'probe');
  const arg = (e, k) => JSON.parse(e.match(new RegExp(`const ${k} = (".*?"|true|false);`))[1]);
  page.evaluate = async (e) => {
    const s = which(e);
    page.calls.push(s);
    n[s] = (n[s] || 0) + 1;
    if ((lose[s] || 0) >= n[s]) return { ok: false, why: 'Failed to evaluate in browser page x: Cannot find default execution context' };
    const out = (o) => ({ ok: true, value: JSON.stringify(o) });
    switch (s) {
      case 'probe': return out({ loaded: true, header: page.header, composer: true, empty: !page.composer });
      case 'openSearch': page.searchOpen = true; return out({ ok: true });
      case 'searchReady': return out({ ready: page.searchOpen });
      case 'typeSearch': page.query += arg(e, 'NAME'); return out({ ok: true });
      case 'results': return out({ n: chats.filter((c) => c === page.query).length });
      case 'pick': page.header = page.query; return out({ ok: true });
      case 'pasteText': {
        const t = arg(e, 'TEXT');
        if (page.composer === t) return out({ ok: true });
        if (page.composer) return out({ ok: false, why: '输入框里有没发出的内容，没动它' });
        page.composer = t; return out({ ok: true });
      }
      case 'composed': return out({ same: page.composer === arg(e, 'TEXT') });
      case 'send':
        if (!page.composer) return out({ ok: false, why: '发送按钮不可用' });
        page.sent.push(page.composer); page.composer = ''; return out({ ok: true });
      case 'clear': page.composer = ''; return out({ ok: true });
    }
  };
  return page;
}
const ctx = (p) => ({ evaluate: p.evaluate, retryMs: 1, tickMs: 1, scale: 0.01 });

test('网页发送：搜会话 → 打开 → 粘贴 → 发送', async () => {
  const p = fakePage();
  assert.deepEqual(await sendInPage(ctx(p), { name: '陈文庆', group: false, text: '你好' }), { sent: true });
  assert.deepEqual(p.sent, ['你好']);
});

test('网页发送：执行上下文中途没了，那一步重来，不整段失败（10-29 的主要失败）', async () => {
  const p = fakePage({ lose: { openSearch: 2, results: 1, pasteText: 1, send: 1 } });
  assert.deepEqual(await sendInPage(ctx(p), { name: '陈文庆', group: false, text: '你好' }), { sent: true });
  assert.deepEqual(p.sent, ['你好']);
});

test('网页发送：已经在这个会话里就不再搜', async () => {
  const p = fakePage({ header: '陈文庆' });
  assert.deepEqual(await sendInPage(ctx(p), { name: '陈文庆', text: '好' }), { sent: true });
  assert.ok(!p.calls.includes('openSearch'));
});

test('网页发送：搜不到就说搜不到，不乱点', async () => {
  const p = fakePage({ chats: ['别人'] });
  const r = await sendInPage({ ...ctx(p) }, { name: '陈文庆', text: '好' });
  assert.equal(r.sent, false);
  assert.match(r.why, /搜不到「陈文庆」/);
  assert.deepEqual(p.sent, []);
});

test('网页发送：一直跑不起来就放弃，说清原因', async () => {
  const p = fakePage({ lose: { probe: 99 } });
  const r = await sendInPage({ ...ctx(p) }, { name: '陈文庆', text: '好' });
  assert.equal(r.sent, false);
  assert.match(r.why, /网页脚本没跑通.*execution context/);
});

test('网页发送：输入框里有别人没发的话，不动它', async () => {
  const p = fakePage({ header: '陈文庆' });
  p.composer = '还没发的半句';
  const r = await sendInPage(ctx(p), { name: '陈文庆', text: '好' });
  assert.equal(r.sent, false);
  assert.match(r.why, /没发出的内容/);
  assert.equal(p.composer, '还没发的半句');
});
