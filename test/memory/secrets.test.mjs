import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../lib/memory/secrets.mjs';

test('redact 替换 key 和密码', () => {
  const r = redact('key abc_AbCdEf123456789 和 密码: hunter2xyz', { prefixes: ['abc'] });
  assert.equal(r.hits, 2);
  assert.ok(!r.text.includes('abc_AbCdEf123456789'));
  assert.ok(!r.text.includes('hunter2xyz'));
  assert.equal((r.text.match(/«已脱敏»/g) || []).length, 2);
});

test('redact 不动飞书 id', () => {
  const s = 'ou_me om_x100b62949080d4a8';
  assert.deepEqual(redact(s), { text: s, hits: 0 });
});

test('redact 处理 Bearer、私钥块和 sshpass', () => {
  const r = redact('Bearer abcdefghijklmnop1234 -----BEGIN OPENSSH PRIVATE KEY-----\nAAA\n-----END OPENSSH PRIVATE KEY----- sshpass -p s3cret ssh');
  assert.equal(r.hits, 3);
  assert.ok(!/abcdefghijklmnop1234|AAA|s3cret/.test(r.text));
});

test('redact 处理云厂商 AK/SK（飞书消息里常见的「Access Key ID:xxx」写法）', () => {
  const r = redact('Access Key ID:AKLTFakeFakeFake0123456789abcd ⏎ Secret Access Key:RmFrZUZha2VGYWtlRmFrZUZha2U= 阿里 LTAIFakeFake01234567');
  assert.ok(!/AKLTFake|RmFrZUZh|LTAIFake/.test(r.text), r.text);
  assert.ok(r.hits >= 3);
});

test('redact 不误伤讲「access key 在哪拿」的说明文字', () => {
  const s = 'Access Key: 在网关账户设置获取，AccessKey 不要发群里';
  assert.deepEqual(redact(s), { text: s, hits: 0 });
});

test('redact：公司专有前缀只在配置里给了才拦', () => {
  assert.equal(redact('key abc_AbCdEf1234567890').hits, 0);
  assert.equal(redact('key abc_AbCdEf1234567890', { prefixes: ['abc'] }).hits, 1);
  assert.equal(redact('key a.b_AbCdEf1234567890', { prefixes: ['a.b'] }).hits, 1); // 前缀按字面量
  assert.equal(redact('sk-AbCdEf1234567890xyz').hits, 1);
});

test('redact：配置里的前缀写成 abc_ / abc- 也一样拦；前缀后面要有分隔符，普通长单词不误伤', () => {
  assert.equal(redact('key abc_AbCdEf1234567890', { prefixes: ['abc_'] }).hits, 1);
  assert.equal(redact('key abc-AbCdEf1234567890', { prefixes: ['abc-'] }).hits, 1);
  assert.equal(redact('abcdefghijklmnopqrst 普通单词', { prefixes: ['abc'] }).hits, 0);
});
