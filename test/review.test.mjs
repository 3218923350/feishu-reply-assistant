import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReview } from '../lib/review.mjs';

const items = [{ n: 1, kind: 'pending' }, { n: 2, kind: 'pending' }, { n: 3, kind: 'pending' }, { n: 4, kind: 'overdue' }, { n: 5, kind: 'overdue' }];
const ns = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.map((x) => x.n ?? x)]));

test('日报卡回复：编号在前、动词在后，逗号分段', () => {
  assert.deepEqual(ns(parseReview('1 3 确认，2 删，5 结', items)), { accept: [1, 3], reject: [2], close: [5], bad: [] });
});
test('动词在前、范围、全角数字也认', () => {
  assert.deepEqual(ns(parseReview('确认 1-2；删 ３', items)), { accept: [1, 2], reject: [3], close: [], bad: [] });
});
test('全部确认只作用于待确认的；结只作用于到期事项', () => {
  assert.deepEqual(ns(parseReview('全部确认', items)), { accept: [1, 2, 3], reject: [], close: [], bad: [] });
  assert.deepEqual(ns(parseReview('都结了', items)), { accept: [], reject: [], close: [4, 5], bad: [] });
});
test('编号不存在或类型不对：放进 bad，其他照做', () => {
  assert.deepEqual(ns(parseReview('4 确认 9 删', items)), { accept: [], reject: [], close: [], bad: [4, 9] });
});
test('看不懂（只有编号没动词、或一句闲话）：返回 null', () => {
  assert.equal(parseReview('1 3', items), null);
  assert.equal(parseReview('这几条我晚点看', items), null);
});
