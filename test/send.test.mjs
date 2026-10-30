import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExternalDenied, manualNotice } from '../lib/commands.mjs';

test('外部群拒发识别：只认 230027', () => {
  assert.equal(isExternalDenied(new Error('lark-cli im +messages-reply 非 JSON 输出: {"ok": false, "error": {"code": 230027, "subtype": "user_unauthorized"}}')), true);
  assert.equal(isExternalDenied(new Error('lark-cli im +messages-reply 失败: {"code":99991663,"message":"token expired"}')), false);
});

test('外部群提示：说清原因、给原消息链接、列出附件', () => {
  const t = manualNotice({ orig: { chat_name: '阿里云对接', link: 'https://applink/x' }, files: ['/a/b.csv'] });
  assert.match(t, /外部群/);
  assert.match(t, /剪贴板/);
  assert.match(t, /长按复制或转发/);
  assert.match(t, /重发/);
  assert.match(t, /\(https:\/\/applink\/x\)/);
  assert.match(t, /\/a\/b\.csv/);
  assert.ok(!/附件/.test(manualNotice({ orig: { chat_name: 'x', link: 'l' } })));
});

test('外部私聊：写「和 xx 的私聊」，不写成「私聊」是外部群', () => {
  const t = manualNotice({ orig: { chat_type: 'p2p', sender_name: '褚二', link: 'l' } });
  assert.match(t, /和褚二的私聊是外部会话/);
  assert.ok(!t.includes('「私聊」'));
});
