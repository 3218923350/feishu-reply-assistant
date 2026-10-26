import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claims } from '../lib/promise.mjs';

// 真实草稿（10-23 / 10-24）
test('答应要做的事：「我现在把…摘掉，弄完告诉你」「开好了跟你说」都认出来', () => {
  assert.ok(claims('我现在把 B 组里的自部署节点摘掉让它只走云厂商，弄完告诉你，你再两路一起跑一遍看看').promise.length > 0);
  assert.ok(claims('收到，账号码 u5678xyz 这边给你开国外模型白名单，开好了跟你说').promise.length > 0);
  assert.ok(claims('好的，我马上给他调到 600 路').promise.length > 0);
  assert.ok(claims('我今晚修好了跟你说').promise.length > 0);
});

test('说已经做好了：「已经加上了」「摘好了」认出来', () => {
  assert.ok(claims('账号码 u1234abc 这个账号已经加上 model-k3 了，现在就能用').done.length > 0);
  assert.ok(claims('摘好了，B 组现在只走云厂商').done.length > 0);
  assert.ok(claims('并发和 TPM 已经给你提到 160 路 / 6000w').done.length > 0);
});

test('纯事实 / 指引 / 补问 不算', () => {
  for (const t of ['直接去 https://gw.example.com/ 登录建 key 就行', '你把账号码发我一下', '不是网关的问题，是 B 组里挂了自部署节点',
    '查清楚了，两路在抢同一台机器，配置还没改', '可以的～这次修的是网关，不分模型']) {
    const c = claims(t);
    assert.deepEqual([c.promise, c.done], [[], []], t);
  }
});

// 2026-10-26 实测：提示词说了别在先回的话里答应，Claude 还是写了；这类也要拦
test('「我先写进去，写好马上告诉你」「处理好第一时间回你」也算答应', () => {
  assert.ok(claims('收到，我先写进去，写好马上告诉你。').promise.length > 0);
  assert.ok(claims('好的，我这边处理好第一时间回你').promise.length > 0);
  assert.ok(claims('我先去看下，晚点给你调').promise.length > 0);
});
