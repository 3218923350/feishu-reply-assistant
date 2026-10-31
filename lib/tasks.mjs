// 要开发的事（bug、反馈查完要改代码的）：一次说不完、得我自己开会话干的，记成任务。
// 存两份：飞书任务（手机上也能看、能勾完成）+ 本地 tasks.jsonl（只追加：add / start / done），程序靠它画任务卡、开会话
import path from 'node:path';

// 起草判定「要开发」的：标题非空才算
export const hasTask = (res) => !!res?.task?.title?.trim();

// 从卡上的这件事拼任务：起草时给了就用，没给（我在卡下手动「加任务」）就拿结论当标题
export function taskFrom(item, note = '') {
  const t = item.view?.res?.task || item.task || {};
  const res = item.view?.res || item.view?.rep || {};
  return {
    title: (t.title || res.summary || item.orig.content || '').trim().slice(0, 80),
    repo: (t.repo || '').trim(),
    brief: [t.brief, note && `我补充：${note}`].filter(Boolean).join('\n').trim(),
    evidence: (res.evidence || res.did || '').trim(),
  };
}

// 原消息里的图片和文件：[{ key, type: image|file, name }]，加任务时下载下来作为飞书任务的附件
export function origResources(content) {
  const out = [], seen = new Set();
  for (const m of String(content || '').matchAll(/<file key="(file_[\w-]+)" name="([^"]*)"\s*\/?>/g)) if (!seen.has(m[1])) { seen.add(m[1]); out.push({ key: m[1], type: 'file', name: m[2] }); }
  for (const m of String(content || '').matchAll(/\b(img_v\d_[\w-]+)/g)) if (!seen.has(m[1])) { seen.add(m[1]); out.push({ key: m[1], type: 'image', name: `${m[1].slice(-12)}.png` }); }
  return out;
}

// 飞书任务的描述会把 markdown 链接当链接校验，不是 http(s) / applink 的（消息里的图片 ![Image](img_v3_…)、附件）直接报 1470400：换成文字
export const plainLinks = (s) => String(s || '')
  .replace(/!\[[^\]]*\]\((?!https?:\/\/|applink:\/\/)[^)]*\)/g, '[图片，见附件]')
  .replace(/\[([^\]]*)\]\((?!https?:\/\/|applink:\/\/)[^)]*\)/g, '$1');

// 飞书任务的描述 / 开工时给 Claude 的提示词：原消息、查到的、要做什么、去哪改
export function taskText(task, orig, { taskUrl = '', name = '我' } = {}) {
  return [
    `${orig.sender_name}（${orig.chat_name ? `群「${orig.chat_name}」` : '私聊'} ${orig.create_time}）：${orig.content}`,
    orig.link && `原消息：${orig.link}`,
    task.brief && `\n要做什么：\n${task.brief}`,
    task.evidence && `\n回复助手已经查到的：\n${task.evidence}`,
    task.repo && `\n仓库：${task.repo}`,
    taskUrl && `飞书任务：${taskUrl}`,
  ].filter(Boolean).join('\n');
}
export const startPrompt = (task, orig, opts = {}) => `${opts.name || '我'}让你接手一个开发任务：${task.title}

${taskText(task, orig, opts)}

${origResources(orig.content).length ? `原消息里的图片 / 文件：lark-cli im +messages-resources-download --as user --message-id ${(orig.burst || [orig.message_id]).join(' 或 ')} --file-key <key> --type image|file 下载下来看（key 就在原消息里）。\n\n` : ''}先把问题复现或者把要改的地方确认清楚，再动手；按这个仓库平时的流程走（分支、测试、MR / PR）。改完、验证过之后告诉我改了什么、怎么验证的，要回给${orig.sender_name}的话写出来，我来发。${opts.taskUrl ? `全部做完把飞书任务勾掉：lark-cli task +complete --as user --task-id ${opts.taskUrl}` : ''}`;

// Orca 新 worktree 的名字：短、只用安全字符
export function worktreeName(title, now = Date.now()) {
  const d = new Date(now + 8 * 3600_000).toISOString();
  return `task-${d.slice(5, 10).replace('-', '')}${d.slice(11, 13)}${d.slice(14, 16)}`;
}

// 仓库在不在 Orca 里：给的路径是某个注册仓库或它下面的目录就用那个仓库
export function repoFor(repo, repos) {
  if (!repo) return null;
  const p = path.resolve(repo.replace(/^~(?=\/|$)/, process.env.HOME || ''));
  return repos.find((r) => p === r.path || p.startsWith(r.path + '/'))
    || repos.find((r) => [r.displayName, r.name].includes(repo) || path.basename(r.path) === repo) || null;
}

// tasks.jsonl → 每个任务的最新状态（add 记全量，start / done 只记变化）
export function taskState(log) {
  const m = new Map();
  for (const r of log) {
    if (r.op === 'add') m.set(r.id, { ...r, status: 'open' });
    else if (m.has(r.id)) Object.assign(m.get(r.id), r.op === 'start' ? { status: 'started', worktree: r.worktree, startedAt: r.at } : r.op === 'done' ? { status: 'done', doneAt: r.at } : {});
  }
  return [...m.values()];
}
export const openTasks = (log) => taskState(log).filter((t) => t.status !== 'done');
export const taskByCard = (log, card) => taskState(log).find((t) => t.card === card) || null;
