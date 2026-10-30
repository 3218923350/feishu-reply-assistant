import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopPrompt, desktopSend, parseDesktop, sendExternal } from '../lib/desktopsend.mjs';

test('Codex 的结果：取最后一行 JSON；没有就当没发', () => {
  assert.deepEqual(parseDesktop('打开了群\n核对过标题\n{"sent": true}'), { sent: true });
  assert.deepEqual(parseDesktop('{"ok":true,"chat":"a"}\n{"ok":true,"pressed":true}'), { ok: true, pressed: true });
  assert.deepEqual(parseDesktop('{"sent": false, "why": "搜到两个同名"}\n'), { sent: false, why: '搜到两个同名' });
  assert.equal(parseDesktop('出错了').sent, false);
});

test('提示词：正文走文件，先用现成脚本，核对会话，只发一次，不截图，不许用 lark-cli 发；带上脚本失败的原因', () => {
  const p = desktopPrompt({ name: '阿里云对接', group: true, chatId: 'oc_x', textFile: '/tmp/t.txt', helper: 'swift /h.swift', why: '搜不到' });
  for (const x of ['群「阿里云对接」', 'oc_x', '/tmp/t.txt', "swift /h.swift send '阿里云对接' /tmp/t.txt", '发送给 阿里云对接', '只按一次发送', '不要截图', '不许用 lark-cli 发消息', '刚才脚本失败了：搜不到', '{"sent": true}'])
    assert.ok(p.includes(x), x);
});

// 假的 bash（脚本 / codex 都在 bash 里跑）/ lark-cli：bash 把结果写进脚本里 > 指的输出文件；lark-cli 返回会话里最近的消息
function fakeRun({ helperOut, codexOut = '', msgs = [], afterCodex = null }) {
  const calls = [], scripts = [];
  let list = msgs;
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'bash') {
      const script = fs.readFileSync(args[0], 'utf8');
      scripts.push(script);
      const out = script.match(/> '([^']+\.out)' 2>&1/)[1];
      if (script.includes(' exec ')) { // codex
        const o = script.match(/-o '([^']+)'/)[1];
        fs.writeFileSync(o, codexOut);
        if (afterCodex) list = afterCodex;
        fs.writeFileSync(out, '');
      } else fs.writeFileSync(out, helperOut);
      return { code: 0, out: '', err: '' };
    }
    return { code: 0, out: JSON.stringify({ ok: true, data: { messages: list } }), err: '' };
  };
  return { run, calls, scripts: () => scripts };
}
const base = { name: '阿里云对接', group: true, chatId: 'oc_x', text: '张老师，复测好了', codex: 'codex', lark: 'lark-cli', me: 'ou_me', pollMs: 1, axTrusted: true };
const lock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-')), 'lock');
const mine = (id) => [{ message_id: id, sender: { id: 'ou_me' }, content: '张老师，复测好了' }];

test('桌面代发：脚本发成、会话里核对到 → 成功，不动 Codex', async () => {
  const f = fakeRun({ helperOut: '{"ok":true,"chat":"阿里云对接"}\n{"ok":true,"pressed":true,"cleared":true}', msgs: mine('om_1') });
  const r = await desktopSend({ ...base, run: f.run, lock: lock() });
  assert.deepEqual(r, { ok: true, message_id: 'om_1', how: '脚本' });
  assert.equal(f.scripts().length, 1);
  assert.match(f.scripts()[0], /feishu-desktop\.swift' open '阿里云对接' && swift .* send '阿里云对接'/);
  assert.ok(!f.calls.some((c) => c[0] === 'swift')); // 没有真去跑脚本
});

test('桌面代发：脚本没成 → 交给 Codex（带上失败原因、指定的模型），核对到才算发了', async () => {
  const f = fakeRun({ helperOut: '{"ok":false,"why":"搜不到叫「阿里云对接」的会话"}', codexOut: '{"sent": true}', afterCodex: mine('om_2') });
  const r = await desktopSend({ ...base, model: 'deepseek-v4.1-flash-1017', run: f.run, lock: lock() });
  assert.deepEqual(r, { ok: true, message_id: 'om_2', how: 'Codex' });
  const c = f.scripts()[1];
  assert.match(c, /-m 'deepseek-v4\.1-flash-1017'/);
  assert.match(c, /刚才脚本失败了：搜不到叫「阿里云对接」的会话/);
});

test('桌面代发：脚本按了回车但核对不到 → 结果未知，不再交给 Codex（免得发两遍）', async () => {
  const f = fakeRun({ helperOut: '{"ok":true,"pressed":true,"cleared":false}' });
  const r = await desktopSend({ ...base, run: f.run, lock: lock() });
  assert.equal(r.unknown, true);
  assert.equal(f.scripts().length, 1);
});

test('桌面代发：脚本和 Codex 都没成 → 没发，两边原因都写上；没给 codex 就只跑脚本', async () => {
  const f = fakeRun({ helperOut: '{"ok":false,"why":"输入框里有没发出的内容，没动它"}', codexOut: '{"sent": false, "why": "同上"}' });
  const r = await desktopSend({ ...base, run: f.run, lock: lock() });
  assert.deepEqual(r, { ok: false, why: '桌面客户端：脚本 输入框里有没发出的内容，没动它；Codex 同上' });
  const g = fakeRun({ helperOut: '{"ok":false,"why":"x"}' });
  assert.deepEqual(await desktopSend({ ...base, codex: '', run: g.run, lock: lock() }), { ok: false, why: '桌面客户端：x' });
});

test('桌面代发：Codex 说没发，但会话里其实有了 → 算发了', async () => {
  const f = fakeRun({ helperOut: '{"ok":false,"why":"x"}', codexOut: '{"sent": false, "why": "不确定"}', afterCodex: mine('om_3') });
  assert.deepEqual(await desktopSend({ ...base, run: f.run, lock: lock() }), { ok: true, message_id: 'om_3', how: 'Codex' });
});

test('外部会话发送顺序：网页版成了就不动客户端；网页版没成再走客户端；结果未知不再试', async () => {
  const seen = [];
  const senders = (w, d) => ({ web: async () => (seen.push('web'), w), desktop: async () => (seen.push('desktop'), d) });
  assert.deepEqual(await sendExternal({ web: {}, desktop: {}, senders: senders({ ok: true, message_id: 'w' }, null) }), { ok: true, message_id: 'w', via: 'web' });
  assert.deepEqual(seen.splice(0), ['web']);
  let told = '';
  const r = await sendExternal({ web: {}, desktop: {}, onDesktop: (why) => { told = why; }, senders: senders({ ok: false, why: '没登录' }, { ok: true, message_id: 'd' }) });
  assert.deepEqual([r, told, seen.splice(0)], [{ ok: true, message_id: 'd', via: 'desktop' }, '没登录', ['web', 'desktop']]);
  assert.equal((await sendExternal({ web: {}, desktop: {}, senders: senders({ ok: false, unknown: true, why: '?' }, null) })).unknown, true);
  assert.deepEqual(seen.splice(0), ['web']);
  const n = await sendExternal({ web: null, webWhy: '没开 Orca', desktop: {}, senders: senders(null, { ok: false, why: '桌面客户端：搜不到' }) });
  assert.deepEqual(n, { ok: false, why: '网页版：没开 Orca；桌面客户端：搜不到' });
  assert.equal((await sendExternal({ web: {}, desktop: null, senders: senders({ ok: false, why: 'x' }, null) })).why, 'x'); // 没开 desktop_send：不走客户端
});
