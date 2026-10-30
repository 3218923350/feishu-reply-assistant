import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasTask, openTasks, repoFor, startPrompt, taskByCard, taskFrom, taskState, taskText, worktreeName } from '../lib/tasks.mjs';
import { draftCard, parseClick, taskCard } from '../lib/cards.mjs';

const orig = { sender_name: '李四', chat_name: '', create_time: '2026-10-30 10:00', content: '调接口一直 500', link: 'https://applink/x' };

test('任务：起草给了 task 就用；没给就拿结论当标题，吩咐算补充', () => {
  assert.equal(hasTask({ task: { title: ' ' } }), false);
  assert.equal(hasTask({ task: { title: '修 usage 判空' } }), true);
  const a = taskFrom({ orig, view: { res: { task: { title: '修 usage 判空', repo: '/r/gw', brief: '流式 usage 为 null 时报 500' }, evidence: '查了日志' } } }, '顺便加测试');
  assert.deepEqual(a, { title: '修 usage 判空', repo: '/r/gw', brief: '流式 usage 为 null 时报 500\n我补充：顺便加测试', evidence: '查了日志' });
  const b = taskFrom({ orig, view: { type: 'report', rep: { did: '查到了：是 litellm 没判空' }, res: undefined } });
  assert.equal(b.title, '调接口一直 500');
  assert.equal(b.evidence, '查到了：是 litellm 没判空');
});

test('任务描述 / 开工提示词：带原消息、链接、查到的、仓库；不替我回对方', () => {
  const t = { title: '修 usage 判空', repo: '/r/gw', brief: '判空', evidence: '日志里 NoneType' };
  const d = taskText(t, orig, { taskUrl: 'https://applink/task' });
  for (const x of ['李四', '调接口一直 500', 'https://applink/x', '判空', 'NoneType', '/r/gw', 'https://applink/task']) assert.ok(d.includes(x), x);
  const p = startPrompt(t, orig, { taskUrl: 'https://applink/task', name: '张三' });
  assert.match(p, /张三让你接手/);
  assert.match(p, /我来发/);
  assert.match(p, /task \+complete .*https:\/\/applink\/task/);
});

test('worktree 名：短、只有安全字符', () => {
  assert.equal(worktreeName('修 usage 判空', Date.parse('2026-10-30T02:05:00Z')), 'task-10301005');
});

test('仓库：路径或它下面的目录、名字都能对上 Orca 里的仓库', () => {
  const repos = [{ id: '1', name: 'gw', path: '/w/gw' }, { id: '2', displayName: 'svc', path: '/w/svc' }];
  assert.equal(repoFor('/w/gw', repos).id, '1');
  assert.equal(repoFor('/w/gw/src/a.ts', repos).id, '1');
  assert.equal(repoFor('svc', repos).id, '2');
  assert.equal(repoFor('/w/gwx', repos), null);
  assert.equal(repoFor('', repos), null);
});

test('任务状态：add → start → done；按卡找', () => {
  const log = [{ op: 'add', id: 'a', title: 'A', card: 'c1' }, { op: 'add', id: 'b', title: 'B', card: 'c2' }, { op: 'start', id: 'a', worktree: 'task-1' }, { op: 'done', id: 'b' }];
  assert.deepEqual(taskState(log).map((t) => [t.id, t.status]), [['a', 'started'], ['b', 'done']]);
  assert.deepEqual(openTasks(log).map((t) => t.id), ['a']);
  assert.equal(taskByCard(log, 'c1').worktree, 'task-1');
  assert.equal(taskByCard(log, 'nope'), null);
});

const buttons = (c) => JSON.stringify(c).match(/"name":"(\w+)"/g).map((x) => x.slice(8, -1));

test('草稿卡：要开发的事出「加入任务」按钮和说明；不是就没有', () => {
  const res = { kind: 'answer', summary: 's', draft: '查到了', options: [], task: { title: '修 usage 判空', repo: '/r/gw', brief: '' } };
  assert.ok(buttons(draftCard(orig, res)).includes('task'));
  assert.match(JSON.stringify(draftCard(orig, res)), /像是要开发：修 usage 判空（\/r\/gw）/);
  assert.ok(!buttons(draftCard(orig, { ...res, task: { title: '', repo: '', brief: '' } })).includes('task'));
  assert.ok(buttons(draftCard(orig, { ...res, options: [{ id: 'a', label: 'x' }] })).includes('task'));
});

test('任务卡：待开发有「开工」「完成」，开工了只剩「完成」，完成了没按钮；按钮点击能解析', () => {
  const t = { title: '修', repo: '/r', url: 'https://applink/task' };
  assert.deepEqual(buttons(taskCard({ ...t, status: 'open' }, orig)), ['task_start', 'task_done']);
  assert.deepEqual(buttons(taskCard({ ...t, status: 'started', worktree: 'task-1' }, orig)), ['task_done']);
  assert.match(JSON.stringify(taskCard({ ...t, status: 'started', worktree: 'task-1' }, orig)), /task-1/);
  assert.equal(JSON.stringify(taskCard({ ...t, status: 'done' }, orig)).includes('"button"'), false);
  const c = parseClick({ operator_id: 'me', action_tag: 'button', action_name: 'task_start', message_id: 'om_t', event_id: 'e1' }, 'me');
  assert.equal(c.action, 'task_start');
});
