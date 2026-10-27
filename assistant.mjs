#!/usr/bin/env node
// 飞书回复助手：盯 @我 / 私聊 → Claude Code 查资料起草 → 草稿群确认 → 以我的身份回复
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prefetch } from './lib/prefetch.mjs';
import { burstKey, handledBy, myReplies, nextBatches, settle, shouldDraft, skipAck, watchedThreadReply } from './lib/inbox.mjs';
import { DRAFT_PERMS, EXEC_DENY } from './lib/tools.mjs';
import { parseReview } from './lib/review.mjs';
import { apiError, approvePrompt, chunk, claim, isExternalDenied, isVerified, manualNotice, owner, retryPrompt, route, threadReplies, wakePrompt, workPrompt } from './lib/commands.mjs';
import { claims } from './lib/promise.mjs';
import { dueReminders, fromSend, openCommitments } from './lib/commitments.mjs';
import { followupChats, matchFollowup, sentIds, workTitle } from './lib/fr.mjs';
import { clickWatch, closedCard, draftCard, parseClick, reportCard } from './lib/cards.mjs';
import { finalTier, holds, projectDir, sessionCommands } from './lib/shadow.mjs';
import { run as runProc } from './lib/run.mjs';
import { webSend } from './lib/websend.mjs';
import { BIN, ConfigError, botEnv, fill, loadConfig } from './lib/config.mjs';
import { readJsonl } from './lib/jsonl.mjs';
import { makeAlerter } from './lib/alert.mjs';
import { launcherFor, orcaBin } from './lib/orca.mjs';
import { alive, launchWork, workCostOnce } from './lib/work.mjs';

let cfg;
try { cfg = loadConfig(); } catch (e) { if (!(e instanceof ConfigError)) throw e; console.error(e.message); process.exit(1); }
const ME = cfg.openId; // 我在用户身份应用下的 open_id
const ME_BOT = cfg.botOpenId; // 我在机器人应用下的 open_id：卡片按钮回调里的 operator_id（单应用时和 ME 相同）
const LEADERS = cfg.leaders; // 我的上级：放手发也要等我
const DRAFT_CHAT = cfg.draftChatId; // 草稿群
const { lark: LARK, claude: CLAUDE } = BIN();
const ORCA = orcaBin(); // 可选：没装就是 null，办事改后台跑、外部群走剪贴板、预取不搜本地会话
const REPO = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(REPO, 'workspace'); // 起草用的轻目录：不自动加载大仓库的记忆和 CLAUDE.md，需要的记忆由预取塞进 prompt
const WORK_DIR = cfg.legacyWorkDir || WORKSPACE; // 早期版本的草稿，会话存在这个目录下
const DIR = cfg.home;
const STATE_FILE = `${DIR}/state.json`;
const RUNS = `${DIR}/runs`; // 「执行」的提示词和结果文件
const EVENTS = `${DIR}/events`; // 发出的回复、办事结果、fr 回执，按月一个 jsonl
const FOLLOWUPS = `${DIR}/followups.jsonl`; // fr wait 挂的跟进（只追加：add / fired / done / expired）
const DIGESTS = `${DIR}/digests`; // 记忆日报卡的编号 → 条目（digest.py 写），我在卡下回「1 3 确认，2 删」用
const COMMITS = `${DIR}/commitments.jsonl`; // 承诺账本：以我身份答应了、还没做的事（lib/commitments.mjs）
const MEM = path.join(REPO, 'bin/mem');
const MEM_ITEM = JSON.parse(fs.readFileSync(path.join(REPO, 'schema/memory.json'), 'utf8'));
const LEARN_SCHEMA = JSON.stringify({ type: 'object', properties: { memories: { type: 'array', items: MEM_ITEM } }, required: ['memories'] });
owner.name = cfg.name; // 办事提示词里的称呼
const PROMPT = fill(fs.readFileSync(new URL('./prompt.md', import.meta.url), 'utf8'), cfg); // 通用规则 + 关于我

const POLL_MS = 90_000; // 扫收件箱
const CONFIRM_MS = 20_000; // 扫草稿群
const THREAD_FOLLOW_MS = 6 * 3600_000; // 助手在群里开的话题只自动跟 6 小时
const OVERLAP_MS = 10 * 60_000; // 两次扫描时间窗重叠，防漏
const FIRST_LOOKBACK_MS = 60 * 60_000; // 首次启动回看
const MAX_PARALLEL = 2; // 同时跑的 claude 数
const CLAUDE_TIMEOUT_MS = 15 * 60_000;
const EXEC_TIMEOUT_MS = 60 * 60_000; // 一轮办事最多等这么久
const MAX_RETRIES = 2; // 办事时接口报错断了，自动新开终端接着办的次数
const CLOSE_MS = 3 * 60_000; // 扫一遍待处理卡片：我已经在原会话亲自回了的收起来

const BOT_ENV = botEnv(cfg); // 草稿群里发卡片、收按钮回调用的机器人

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['answer', 'action', 'decision', 'skip'] },
    summary: { type: 'string' },
    evidence: { type: 'string' },
    draft: { type: 'string' },
    proposed_actions: { type: 'string' },
    used_memories: { type: 'array', items: { type: 'string' } },
    // 影子期：放手的话这条怎么发（现在只标在卡上，不真的自动发）
    category: { type: 'string', enum: ['补问', '入口指引', '状态查询', '用法问答', '例行操作', '限额调整', '计费价格', '排期承诺', '排障结论', '寒暄', '其他'] },
    send_tier: { type: 'string', enum: ['auto', 'countdown', 'hold'] },
    facts: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, cmd: { type: 'string' } }, required: ['claim', 'cmd'] } },
    // 要我批的操作拆成选项（卡上勾选），做完才能说的话放 draft_after；draft 只说查实的事
    options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, cost: { type: 'string' }, group: { type: 'string' } }, required: ['id', 'label'] } },
    draft_after: { type: 'string' },
  },
  required: ['kind', 'summary', 'evidence', 'draft', 'proposed_actions', 'used_memories', 'category', 'send_tier', 'facts', 'options', 'draft_after'],
});

// ---------- 基础 ----------
fs.mkdirSync(RUNS, { recursive: true });
fs.mkdirSync(EVENTS, { recursive: true });
const logStream = fs.createWriteStream(`${DIR}/assistant.log`, { flags: 'a' });
function log(...a) {
  const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  logStream.write(line + '\n');
  console.log(line);
}

const state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  : { lastPollAt: 0, lastConfirmAt: 0, seen: {}, items: {} };
state.queue ||= []; // 待起草的消息，处理完才移除，重启后接着做
state.threads ||= {}; // 助手发过消息、且要跟随回复的已知话题
state.threadLookups ||= {}; // message_id -> { thread_id, at }，避免每轮重复查
function saveState() {
  const now = Date.now();
  for (const [k, t] of Object.entries(state.seen)) if (now - t > 3 * 86400_000) delete state.seen[k];
  for (const [k, it] of Object.entries(state.items)) if (now - it.createdAt > 14 * 86400_000) delete state.items[k];
  for (const [k, t] of Object.entries(state.threads)) if (now - (t.created_at || 0) > THREAD_FOLLOW_MS) delete state.threads[k];
  for (const [k, t] of Object.entries(state.threadLookups)) if (now - (t?.at || 0) > 3 * 86400_000) delete state.threadLookups[k];
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 1));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
// 北京时间 ISO（lark-cli 要求带时区偏移）
function fmtBJ(ms) {
  const d = new Date(ms + 8 * 3600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`;
}
// lark-cli 输出的 "2026-10-21 17:38" 是北京时间
const parseBJ = (s) => Date.parse(s.replace(' ', 'T') + ':00+08:00');
const minuteBJ = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' '); // 和 lark-cli 的 create_time 同格式

const run = (cmd, args, opts = {}) => runProc(cmd, args, { cwd: DIR, ...opts }); // 起不来 / 超时返回 code=null，不会把助手弄挂

async function lark(args, asBot = false, cwd = DIR) {
  const r = await run(LARK, args, { env: asBot ? BOT_ENV : process.env, cwd });
  let j;
  try { j = JSON.parse(r.out); } catch { throw new Error(`lark-cli ${args.slice(0, 2).join(' ')} 非 JSON 输出: ${(r.err || r.out).slice(0, 300)}`); }
  if (!j.ok) throw new Error(`lark-cli ${args.slice(0, 2).join(' ')} 失败: ${JSON.stringify(j.error).slice(0, 400)}`);
  return j.data;
}

const botSend = (md) => lark(['im', '+messages-send', '--as', 'bot', '--chat-id', DRAFT_CHAT, '--markdown', md], true);
const botReply = (msgId, md) => lark(['im', '+messages-reply', '--as', 'bot', '--message-id', msgId, '--markdown', md], true);
// 交互卡：发、回在某张卡下、点完 / 有结果后原地改成结果
const botSendCard = (c) => lark(['im', '+messages-send', '--as', 'bot', '--chat-id', DRAFT_CHAT, '--msg-type', 'interactive', '--content', JSON.stringify(c)], true);
const botReplyCard = (msgId, c) => lark(['im', '+messages-reply', '--as', 'bot', '--message-id', msgId, '--msg-type', 'interactive', '--content', JSON.stringify(c)], true);
const patchCard = (msgId, c) => lark(['im', 'messages', 'patch', '--as', 'bot', '--params', JSON.stringify({ message_id: msgId }), '--data', JSON.stringify({ content: JSON.stringify(c) })], true);
// 开始处理就以我的身份在他那条消息上点「了解」(Get)：他知道在处理，我在会话里也看得到。点了就不撤（已经让人知道在做了）；同一个表情重复点是幂等的
// 配置里 auto_react: false 就不点
const react = (msgId) => cfg.autoReact && lark(['im', 'reactions', 'create', '--as', 'user', '--params', JSON.stringify({ message_id: msgId }), '--data', JSON.stringify({ reaction_type: { emoji_type: 'Get' } })])
  .catch((e) => log('ERR react', msgId, e.message));
const jsonl = (f) => readJsonl(f, { onBad: (l) => log('ERR jsonl', f, l.slice(0, 120)) }); // 坏行跳过，别卡住整轮
const readCommits = () => jsonl(COMMITS);
const appendCommit = (r) => fs.appendFileSync(COMMITS, JSON.stringify(r) + '\n');
const pendingOf = (q) => openCommitments(readCommits(), q).map((r) => `${r.what}（对${r.toName}）`);
const OUTCOME_OF = { sent: '已发送', dismissed: '已跳过', working: '在办', superseded: '有新版本', handled: '已在原会话回', manual: '已手动发' };
function refreshCard(id, detail) {
  const it = state.items[id];
  if (!it?.ui || !OUTCOME_OF[it.status]) return; // 老的 markdown 卡改不了
  patchCard(id, closedCard(it.orig, OUTCOME_OF[it.status], detail ?? (it.status === 'sent' ? it.draft : ''), { pending: pendingOf({ card: id }) })).catch((e) => log('ERR patch', e.message));
}
// 影子期记录：卡上「放手会怎么发」和我最后怎么处理的，攒够了在日报里给我看
const outcome = (id, item, what) => recordEvent('outcome', { card: id, orig: item.orig, what, category: item.shadow?.category, tier: item.shadow?.tier });

const alert = makeAlerter({ send: (md) => botSend(md), log }); // 每类一小时最多一次；授权过期不会被别的提醒吃掉

// ---------- 收件箱 ----------
const fmtMsg = (x) =>
  `[${x.create_time}] ${x.sender?.name || x.sender?.id || '?'}${x.sender?.id === ME ? '(我)' : ''}: ${(x.content || '').replace(/\n/g, ' ⏎ ')}`;

// 助手发出的消息如果形成了飞书话题，记下 thread_id；之后只跟随这个已知话题里原收件人的回复
async function registerThreadForMessage(messageId, info = {}, baselineAt = Date.now()) {
  if (!messageId || state.threadLookups[messageId]) return;
  state.threadLookups[messageId] = { thread_id: '', at: Date.now() };
  try {
    const d = await lark(['im', '+messages-mget', '--as', 'user', '--message-ids', messageId, '--no-reactions']);
    const sent = (d.messages || [])[0];
    const tid = sent?.thread_id;
    state.threadLookups[messageId] = { thread_id: tid || '', at: Date.now() };
    if (!tid || info.chat_type === 'p2p' || !info.chat_id || info.chat_id === DRAFT_CHAT || !info.sender_id || info.sender_id === ME) return;
    const old = state.threads[tid] || {};
    const now = Date.now();
    state.threads[tid] = {
      thread_id: tid, chat_id: info.chat_id, chat_name: info.chat_name || old.chat_name || '',
      chat_type: info.chat_type || old.chat_type || 'group', watch_sender_id: info.sender_id,
      root_message_id: messageId, created_at: old.created_at || now, baseline_at: old.baseline_at || baselineAt,
      last_seen_at: old.last_seen_at || baselineAt, updated_at: now,
    };
    log('thread', `登记 ${tid}（${info.chat_name || info.chat_id}）`);
  } catch (e) { log('ERR thread-register', messageId, e.message); }
  saveState();
}

async function syncSentThreads() {
  const pending = recentEvents().filter((e) => (e.kind === 'fr-sent' || e.kind === 'sent') && e.message_id
    && !state.threadLookups[e.message_id]).slice(-30);
  for (const e of pending) {
    const ts = Date.parse(e.ts);
    await registerThreadForMessage(e.message_id, e.orig || {}, Math.max(Number.isFinite(ts) ? ts : Date.now(), Date.now() - 10 * 60_000));
  }
}

async function pollKnownThreads(now) {
  const threads = Object.values(state.threads).filter((t) => t.watch_sender_id && t.thread_id
    && t.chat_type !== 'p2p' && now - (t.created_at || 0) <= THREAD_FOLLOW_MS)
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).slice(0, 50);
  const out = [];
  for (const t of threads) {
    try {
      const d = await lark(['im', '+threads-messages-list', '--as', 'user', '--thread', t.thread_id,
        '--order', 'desc', '--page-size', '50', '--no-reactions']);
      let latest = t.last_seen_at || t.baseline_at || now;
      for (const m of d.messages || []) {
        const ts = parseBJ(m.create_time);
        if (ts > latest) latest = ts;
        if (!watchedThreadReply(m, t, state.seen, ME)) continue;
        if (ts < (t.last_seen_at || t.baseline_at || now) - 60_000) continue;
        out.push({ ...m, chat_id: t.chat_id, chat_type: t.chat_type, chat_name: t.chat_name, thread_id: t.thread_id, known_thread: true });
      }
      t.last_seen_at = latest; t.last_checked_at = now; t.updated_at = now;
    } catch (e) { log('ERR thread', t.thread_id, e.message); }
  }
  return out;
}

async function pollInbox() {
  const now = Date.now();
  await syncSentThreads();
  const since = state.lastPollAt ? state.lastPollAt - OVERLAP_MS : now - FIRST_LOOKBACK_MS;
  const common = ['im', '+messages-search', '--as', 'user', '--query', '', '--start', fmtBJ(since), '--end', fmtBJ(now + 60_000),
    '--page-size', '50', '--page-all', '--page-limit', '20', '--no-reactions'];
  const search = async (extra) => {
    const d = await lark([...common, ...extra]);
    if (d.has_more) log('inbox 截断', extra.join(' ')); // 20 页还没翻完，说明窗口里消息异常多
    return d.messages || [];
  };
  const atMe = await search(['--is-at-me']);
  const p2p = await search(['--chat-type', 'p2p', '--exclude-sender-type', 'bot']);
  // 跟进绑在群里：对方在群里 / 话题里回话常常不 @我，收件箱搜不到，单独拉这几个群
  const followups = readFollowups(), inChats = [];
  for (const c of followupChats(followups, now)) {
    try {
      const lists = [lark(['im', '+chat-messages-list', '--as', 'user', '--chat-id', c.chat_id, '--start', fmtBJ(since), '--order', 'asc', '--page-size', '50', '--no-reactions'])];
      if (c.thread_id) lists.push(lark(['im', '+threads-messages-list', '--as', 'user', '--thread', c.thread_id, '--order', 'desc', '--page-size', '50', '--no-reactions']));
      for (const d of await Promise.all(lists)) inChats.push(...(d.messages || []).map((m) => ({ ...m, chat_id: c.chat_id })));
    } catch (e) { log('ERR followup-chat', c.chat_id, e.message); }
  }
  const knownThreads = await pollKnownThreads(now);
  state.lastPollAt = now;

  const fresh = [];
  for (const m of [...atMe, ...p2p, ...inChats, ...knownThreads]) {
    if (state.seen[m.message_id]) continue;
    if (m.sender?.id === ME || m.sender?.sender_type !== 'user') continue;
    if (m.chat_id === DRAFT_CHAT) continue;
    if (['system', 'interactive', 'sticker', 'share_chat', 'share_user'].includes(m.msg_type)) continue;
    const f = matchFollowup(m, followups, now); // 在等这个人回复：叫醒原会话，不另起草
    if (f) { state.seen[m.message_id] = now; react(m.message_id); wake(f, m).catch((e) => log('ERR wake', e.message)); continue; }
    if (m.chat_type !== 'p2p' && !m.known_thread && !(m.mentions || []).some((x) => x.id === ME)) continue; // 已知话题只看原收件人；其他群消息仍要 @我
    state.seen[m.message_id] = now;
    fresh.push(m);
    enqueue(m);
  }
  saveState(); // seen 和队列一起落盘，中间崩了也不会「已见但没排队」
  if (fresh.length) log('inbox', `新消息 ${fresh.length} 条`);
  pump(); // 也捡起到点该重试的
}

// 这条消息之后我回过它 → 视为已处理（群里要引用/同话题/@发送人才算，见 lib/inbox.mjs）
async function laterMessages(m) {
  const t0 = parseBJ(m.create_time);
  const lists = [lark(['im', '+chat-messages-list', '--as', 'user', '--chat-id', m.chat_id, '--start', fmtBJ(t0),
    '--order', 'desc', '--page-size', '50', '--no-reactions'])];
  if (m.thread_id) lists.push(lark(['im', '+threads-messages-list', '--as', 'user', '--thread', m.thread_id, '--order', 'desc', '--page-size', '50', '--no-reactions']));
  return (await Promise.all(lists)).flatMap((d) => d.messages || []);
}
const alreadyReplied = async (m) => myReplies(m, await laterMessages(m), ME).length > 0;

async function gatherContext(m) {
  const end = parseBJ(m.create_time) + 60_000;
  const d = await lark(['im', '+chat-messages-list', '--as', 'user', '--chat-id', m.chat_id, '--end', fmtBJ(end),
    '--order', 'desc', '--page-size', '20', '--no-reactions']);
  let msgs = (d.messages || []).reverse().filter((x) => x.message_id !== m.message_id);
  let prefix = [];
  if (m.thread_id) {
    const t = await lark(['im', '+threads-messages-list', '--as', 'user', '--thread', m.thread_id, '--order', 'asc', '--page-size', '30', '--no-reactions']);
    const tmsgs = (t.messages || []).filter((x) => x.message_id !== m.message_id);
    if (tmsgs.length) { msgs = tmsgs; prefix = ['--- 话题内消息（当前话题） ---']; }
  }
  return { text: [...prefix, ...msgs.map(fmtMsg)].join('\n'), msgs };
}

// ---------- Claude ----------
async function askClaude(prompt, resume, cwd = WORKSPACE, { final = false } = {}) {
  const args = ['-p', prompt, '--output-format', 'json', '--json-schema', SCHEMA, '--append-system-prompt', PROMPT,
    ...DRAFT_PERMS, '--max-turns', final ? '3' : String(Number(process.env.FRA_MAX_TURNS) || 12)]; // 收尾也用同一套权限，保住 prompt 缓存
  if (resume) args.push('--resume', resume);
  const r = await run(CLAUDE, args, { cwd, timeout: CLAUDE_TIMEOUT_MS });
  let j;
  try { j = JSON.parse(r.out); } catch { throw new Error(`claude 非 JSON 输出 (exit ${r.code}): ${(r.err || r.out).slice(0, 300)}`); }
  recordEvent('cost', { what: 'draft', usd: j.total_cost_usd ?? null, session: j.session_id }); // 到轮数上限的那次也花了钱
  if (j.is_error && j.subtype === 'error_max_turns' && !final && j.session_id) {
    // 查到轮数上限：不再查，用已查到的给结论（没查清的降级为拍板/动手）
    log('claude', `到轮数上限 turns=${j.num_turns} cost=$${j.total_cost_usd?.toFixed(2)}，收尾`);
    return askClaude('查的轮数到上限了。不要再调用任何工具，就用已经查到的信息，现在按 JSON 字段给出结果；没查清的写进 evidence，并降级为 decision 或 action。',
      j.session_id, cwd, { final: true });
  }
  if (j.is_error) throw new Error(`claude 出错(${j.subtype || '?'}, ${j.num_turns ?? '?'} 轮): ${String(j.result ?? '').slice(0, 300)}`);
  let res = j.structured_output;
  if (!res) { try { res = JSON.parse(j.result); } catch { throw new Error(`claude 没有结构化输出: ${String(j.result).slice(0, 300)}`); } }
  log('claude', `kind=${res.kind} turns=${j.num_turns} cost=$${j.total_cost_usd?.toFixed(2)} session=${j.session_id}`);
  return { ...res, session: j.session_id, cwd, turns: j.num_turns, cost: j.total_cost_usd };
}

// ---------- 草稿群 ----------
const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

async function postDraft(item, res, replyTo) {
  const m = item.orig;
  const kind = res.kind === 'decision' && res.draft?.trim() ? 'answer' : res.kind; // 拍板后有了草稿就按草稿展示
  const files = (res.files || []).filter((f) => fs.existsSync(f));
  const view = { type: 'draft', orig: m, res: { ...res, kind, files }, shadow: res.shadow };
  const d = replyTo ? await botReplyCard(replyTo, renderView(view)) : await botSendCard(renderView(view));
  state.items[d.message_id] = { orig: m, kind, draft: res.draft, session: res.session, cwd: res.cwd, used_memories: res.used_memories || [], files,
    status: 'pending', createdAt: Date.now(), ui: 'card', shadow: res.shadow, options: res.options || [], draft_after: res.draft_after || '', view };
  if (res.shadow) recordEvent('shadow', { card: d.message_id, orig: m, draft: res.draft, ...res.shadow });
  // 这个人在这个会话之前还有没处理的卡：新卡带着完整上下文，旧的作废，免得两张卡说法打架
  for (const [id, it] of Object.entries(state.items)) if (id !== d.message_id && it.status === 'pending' && it.orig && origKey(it.orig) === origKey(m)) { it.status = 'superseded'; refreshCard(id); }
  saveState();
  log('draft', `${kind} ${m.sender_name} → ${d.message_id}`);
}
// 卡怎么画存在 item.view 里：拦承诺时要带着警告原样重画
function renderView(view, { draft, warning = [], pending = [] } = {}) {
  if (view.type === 'report') return reportCard(view.orig, { ...view.rep, ...(draft != null ? { draft } : {}) }, view.receipts, view.session, { warning, pending, log: view.log });
  return draftCard(view.orig || view.res.orig, { ...view.res, ...(draft != null ? { draft } : {}) }, view.shadow, { warning });
}
const origKey = (o) => burstKey({ chat_id: o.chat_id, sender: { id: o.sender_id }, thread_id: o.thread_id });

const BUSY = { sent: '这条已经发过了', sending: '正在发，稍等', manual: '这条是外部群，要你手动发（草稿就在卡片上）', dismissed: '这条已经跳过了', superseded: '这条有新版本了，在最新那张卡下说' };

async function pollConfirm() {
  const now = Date.now();
  const since = state.lastConfirmAt ? state.lastConfirmAt - 60_000 : now - 60_000;
  const d = await lark(['im', '+chat-messages-list', '--as', 'user', '--chat-id', DRAFT_CHAT, '--start', fmtBJ(since),
    '--order', 'asc', '--page-size', '50', '--no-reactions']);
  const threads = await pendingThreadReplies(since);
  state.lastConfirmAt = now; // 两边都拉成功才往前推，拉失败下一轮从原来的时间重拉，我的话不会丢
  const byFr = sentIds(recentEvents());
  for (const x of [...(d.messages || []), ...threads]) {
    if (x.sender?.id !== ME || state.seen[x.message_id] || byFr.has(x.message_id)) continue;
    state.seen[x.message_id] = now;
    const item = x.reply_to && state.items[x.reply_to];
    const digest = !item && x.reply_to && readDigest(x.reply_to);
    if (digest) { handleReview(x.reply_to, digest, x).catch((e) => { log('ERR review', e.message); botReply(x.reply_to, `❌ ${e.message}`).catch(() => {}); }); continue; }
    if (!item) { botReply(x.message_id, '要处理哪条？在那张卡片下（引用或话题里）说').catch(() => {}); continue; }
    const text = (x.content || '').trim();
    if (item.status === 'handled') item.status = 'pending'; // 自动收起的卡，我又在下面说话了：接着办
    if (item.status === 'working') { // 这轮还在办：记下，办完接着处理
      (item.queued ||= []).push({ kind: 'say', text });
      botReply(x.reply_to, '收到，这轮办完接着处理').catch(() => {});
      continue;
    }
    if (item.status !== 'pending') { botReply(x.reply_to, BUSY[item.status] || `这条状态是 ${item.status}`).catch(() => {}); continue; }
    handleCommand(item, x.reply_to, text).catch((e) => { log('ERR cmd', e.message); botReply(x.reply_to, `❌ ${e.message}`).catch(() => {}); });
  }
  saveState();
  checkExpiredFollowups();
}

// 在卡片「话题」里的回复不在主消息流里：待处理卡片有话题的，单独拉话题消息
async function pendingThreadReplies(since) {
  const ids = [...Object.entries(state.items).filter(([, it]) => ['pending', 'working', 'handled'].includes(it.status) && Date.now() - it.createdAt < 3 * 86400_000).map(([id]) => id),
    ...recentDigests()];
  if (!ids.length) return [];
  const cards = [];
  for (const part of chunk(ids, 50)) cards.push(...((await lark(['im', '+messages-mget', '--as', 'user', '--message-ids', part.join(','), '--no-reactions'])).messages || []));
  const out = [];
  for (const c of cards.filter((c) => c.thread_id)) {
    const t = await lark(['im', '+threads-messages-list', '--as', 'user', '--thread', c.thread_id, '--order', 'asc', '--page-size', '50', '--no-reactions']);
    out.push(...threadReplies(t.messages || [], c.message_id, ME, since));
  }
  return out;
}

// 整句「发」「不」走快捷路径；其余原话交给起草时那个 Claude 会话去理解和办
async function handleCommand(item, draftId, text) {
  const d = route(item, text);
  if (d.do === 'send') return guardedSend(item, draftId, { typed: true });
  if (d.do === 'dismiss') {
    if (!claim(item, 'dismissed')) return;
    saveState();
    outcome(draftId, item, 'skip');
    return item.ui ? refreshCard(draftId) : botReply(draftId, '👌 已跳过');
  }
  return work(item, draftId, d.text);
}

// 发之前查一遍：草稿里答应了还没做的事、或者没验证就说「已经好了」，不发，卡上标出来（「我自己办，先发这句」才发）
async function guardedSend(item, draftId, { edited = false, typed = false } = {}) {
  const c = claims(item.draft);
  const bad = [...c.promise, ...(item.verified ? [] : c.done)];
  if (!bad.length) return sendReply(item, draftId, { edited });
  log('guard', `拦下 ${item.orig.sender_name} ${draftId}：${bad.join('｜')}`);
  if (item.view) await patchCard(draftId, renderView(item.view, { draft: item.draft, warning: bad, pending: pendingOf({ session: item.session }) })).catch((e) => log('ERR patch', e.message));
  if (typed || !item.view) await botReply(draftId, `⚠️ 没发：这句里写了「${bad.join('」「')}」，事还没做就发出去对方会等着。要做就点「按我说的办」或勾选后「同意所选」；你自己去办就点卡上的「我自己办，先发这句」`);
}

async function sendReply(item, draftId, { edited = false } = {}) {
  if (!item.draft?.trim()) return botReply(draftId, '这条没有可发的草稿，先告诉我怎么回。');
  if (!claim(item, 'sending')) return; // 先占住，连点两次也只发一次
  saveState();
  const args = ['im', '+messages-reply', '--as', 'user', '--message-id', item.orig.message_id, '--text', item.draft];
  if (item.orig.chat_type !== 'p2p') args.push('--reply-in-thread'); // 群里统一开话题；单聊留在主消息流
  let d, via = '';
  try { d = await lark(args); } catch (e) {
    item.status = 'pending';
    saveState();
    if (!isExternalDenied(e)) throw e;
    // 外部会话：先用 Orca 里的网页版飞书发（话题里的回不进话题）；不行再放剪贴板让我手动发
    const o = item.orig;
    const web = o.thread_id ? { ok: false, why: '原消息在话题里，网页版回不进话题' }
      : !cfg.messengerUrl ? { ok: false, why: '没配置 messenger_url' }
      : !(await launcherFor(run, ORCA)) ? { ok: false, why: '没开 Orca' }
      : await webSend({ name: o.chat_type === 'p2p' ? o.sender_name : o.chat_name, group: o.chat_type !== 'p2p', chatId: o.chat_id, text: item.draft, orca: ORCA, lark: LARK, repo: REPO, dir: DIR, me: ME, messenger: cfg.messengerUrl });
    if (web.ok) { d = { message_id: web.message_id }; via = 'web'; }
    else if (web.unknown) {
      item.status = 'unknown';
      saveState();
      log('web', `结果未知 ${o.chat_name || o.sender_name} ${o.message_id}`);
      return botReply(draftId, `⚠️ 网页版飞书上点了发送，但在会话里没核对到这条消息，别重发，去会话里看一眼：[打开原消息](${o.link})`);
    } else {
      spawnSync('/usr/bin/pbcopy', { input: item.draft });
      item.status = 'manual';
      saveState();
      log('manual', `外部会话 ${o.chat_name || o.sender_name} ${o.message_id}：${web.why}`);
      recordEvent('manual', { orig: item.orig, text: item.draft, files: item.files || [] });
      refreshCard(draftId, `草稿已放剪贴板，去原会话手动发（网页版也没发成：${web.why}）`);
      return botReply(draftId, `${manualNotice(item)}（网页版也没发成：${web.why}）`);
    }
  }
  state.seen[d.message_id] = Date.now(); // 自己发的这条别再当成指令
  await registerThreadForMessage(d.message_id, item.orig); // 发给原会话的消息若形成话题，后续跟随
  item.status = 'sent';
  saveState();
  outcome(draftId, item, edited ? 'send_edited' : 'send');
  const promise = fromSend(item.draft, { card: draftId, session: item.session, to: item.orig.chat_id, toName: item.orig.sender_name, message_id: d.message_id });
  if (promise) appendCommit(promise); // 话里答应了还没做的事：记账、卡上挂着、到点提醒
  refreshCard(draftId);
  log('sent', `→ ${item.orig.sender_name} ${item.orig.message_id}`);
  // 草稿里说要发的文件跟着发（lark-cli 只认当前目录下的相对路径）
  const sentFiles = [];
  for (const f of via === 'web' ? [] : item.files || []) {
    const fa = ['im', '+messages-reply', '--as', 'user', '--message-id', item.orig.message_id, '--file', path.basename(f)];
    if (item.orig.chat_type !== 'p2p') fa.push('--reply-in-thread');
    try { const r = await lark(fa, false, path.dirname(f)); state.seen[r.message_id] = Date.now(); sentFiles.push(f); }
    catch (e) { log('ERR file', f, e.message); botReply(draftId, `⚠️ 文字已发，文件没发出去：${f}（${e.message.slice(0, 120)}）`).catch(() => {}); }
  }
  recordEvent('sent', { orig: item.orig, text: item.draft, files: sentFiles, used_memories: item.used_memories || [], message_id: d.message_id });
  learn(item, `这条已经发出，最终发给对方的是：${item.draft}`, { resume: true }).catch((e) => log('ERR learn', e.message));
  if (item.ui && via !== 'web' && !sentFiles.length) return; // 卡片已经改成「已发送」
  return botReply(draftId, `✅ 已用你的身份回复 ${item.orig.sender_name}${via === 'web' ? '（外部会话，用网页版飞书发的）' : ''}${sentFiles.length ? `，附件 ${sentFiles.length} 个` : ''}`
    + (via === 'web' && item.files?.length ? `；附件网页版还不会发，要你手动发：${item.files.join('、')}` : ''));
}

// ---------- 办事：原话交给起草会话，在 Orca 终端里续跑（可围观、可插话）；发消息只能走 bin/fr ----------
const busySessions = new Set(); // 同一个会话同一时间只跑一轮

async function work(item, draftId, text, intro) {
  if (!claim(item, 'working')) return; // 先占住，防重复
  saveState();
  outcome(draftId, item, 'work');
  refreshCard(draftId, text);
  try { await runWork(item, draftId, text, (rf) => workPrompt(text, rf, intro, recentSends(), openCommitments(readCommits(), { session: item.session }))); }
  catch (e) { item.status = 'pending'; saveState(); throw e; }
}

// authText：授权这轮发消息的那句我的原话（程序写进 FR_CTX，fr 按它校验）
// 最近 24 小时 fr 以我身份发出的（所有会话），给办事的 Claude 看，免得两个会话重复通知同一个人
const recentSends = () => recentEvents().filter((e) => e.kind === 'fr-sent' && Date.now() - Date.parse(e.ts) < 86400_000).slice(-12)
  .map((e) => `${new Date(Date.parse(e.ts) + 8 * 3600_000).toISOString().slice(11, 16)} 给${e.toName}：${cut(e.text, 80)}`);

async function runWork(item, replyTo, authText, promptFor, { followup = null } = {}) {
  if (busySessions.has(item.session)) throw new Error('这件事上一轮还在办，稍等');
  const id = `${replyTo}-${Date.now()}`;
  const reportFile = `${RUNS}/${id}.report.json`, ctxFile = `${RUNS}/${id}.ctx.json`, promptFile = `${RUNS}/${id}.prompt.md`;
  const cwd = item.cwd || WORK_DIR;
  fs.writeFileSync(ctxFile, JSON.stringify({ card: replyTo, session: item.session, cwd, authText, orig: item.orig, draft: item.draft || '' }));
  fs.writeFileSync(promptFile, promptFor(reportFile)); // 名字已经在拼模板时填好（commands.mjs 的 owner）
  busySessions.add(item.session);
  try {
    item.work = { reportFile, startedAt: Date.now(), replyTo, followup, ...(await startWork(item, ctxFile, promptFile, `${RUNS}/${id}.log`, reportFile)) };
    saveState();
  } catch (e) { busySessions.delete(item.session); throw e; } // 起不来别把这件事一直占着
  log('work', `start ${item.orig.sender_name} ${replyTo}`);
  return waitReport(item, replyTo);
}

// 起一轮办事进程：有 Orca（装了、开着）就开它的终端；没有或开终端失败就后台跑，过程写日志。返回 item.work 里要记的 terminal / pid / log
async function startWork(item, ctxFile, promptFile, logFile, reportFile) {
  const cwd = item.cwd || WORK_DIR; // 会话按目录存，得回到起草时的目录才能 --resume
  const how = { repo: REPO, where: cwd === WORKSPACE ? REPO : WORK_DIR, cwd, session: item.session, promptFile, ctxFile, claude: CLAUDE, deny: EXEC_DENY, // 不许绕过 fr 直接发
    title: workTitle(item.orig), prompt: fs.readFileSync(promptFile, 'utf8'), env: process.env, home: DIR };
  const { inOrca, terminal, pid } = await launchWork({ how, orca: await launcherFor(run, ORCA), run, log,
    startHeadless: (l) => startHeadless(l, logFile, reportFile, item.session) });
  if (inOrca) recordEvent('cost', { what: 'work', usd: null, session: item.session }); // 终端里交互式跑，拿不到费用
  return inOrca ? { terminal, pid: null, log: null } : { terminal: null, pid, log: logFile };
}

// 后台办事：脱离本进程（助手重启也不断），stdout/stderr 进日志。起不来马上补一份「受阻」报告；进程退出后没写报告的，由 waitReport 判断（先看是不是接口报错能重开）
function startHeadless(l, logFile, reportFile, session) {
  const fd = fs.openSync(logFile, 'a');
  try {
    const p = spawn(l.cmd, l.args, { cwd: l.cwd, env: l.env, detached: true, stdio: ['ignore', fd, fd] });
    p.on('error', (e) => {
      log('ERR work-spawn', e.message);
      if (!fs.existsSync(reportFile)) fs.writeFileSync(reportFile, JSON.stringify({ state: 'blocked', did: `后台办事起不来（${e.message}）。过程日志：${logFile}` }));
    });
    p.on('exit', () => workCost(logFile, session));
    p.unref();
    return p.pid;
  } finally { fs.closeSync(fd); }
}
const workCost = (logFile, session) => { try { workCostOnce(logFile, (usd) => recordEvent('cost', { what: 'work', usd, session })); } catch (e) { log('ERR work-cost', e.message); } };
// 后台办事的进程没了、也没写报告（崩了、被杀、或者助手重启过退出回调没了）：记费用，补一份受阻报告
function headlessGone(work, session) {
  if (!work.pid || alive(work.pid)) return;
  workCost(work.log, session);
  if (!fs.existsSync(work.reportFile)) fs.writeFileSync(work.reportFile, JSON.stringify({ state: 'blocked', did: `后台办事的进程退出了，没写报告。过程日志：${work.log}` }));
}

// 这轮会话最后是接口报错（从这轮开始、或上次重开之后算）
function sessionApiError(item) {
  const f = path.join(os.homedir(), '.claude', 'projects', projectDir(item.cwd || WORK_DIR), `${item.session}.jsonl`);
  try { return apiError(fs.readFileSync(f, 'utf8'), item.work.retriedAt || item.work.startedAt); } catch { return null; }
}

// 接口报错断了：关掉旧终端，新起一轮 --resume 同一个会话接着办（授权、报告文件都沿用这轮的）
async function retryWork(item, replyTo, err) {
  const n = item.work.retries = (item.work.retries || 0) + 1;
  log('work', `接口报错，第 ${n} 次重开 ${item.orig.sender_name} ${replyTo}：${cut(err.text, 80)}`);
  if (item.work.terminal) await run(ORCA, ['terminal', 'close', '--terminal', item.work.terminal, '--tab', '--json']);
  const base = item.work.reportFile.replace('.report.json', '');
  const promptFile = `${base}.retry${n}.prompt.md`;
  fs.writeFileSync(promptFile, retryPrompt(cut(err.text, 120), item.work.reportFile));
  item.work.retriedAt = Date.now();
  Object.assign(item.work, await startWork(item, `${base}.ctx.json`, promptFile, `${base}.retry${n}.log`, item.work.reportFile));
  saveState();
  botReply(replyTo, `⚠️ 接口报错断了（${cut(err.text, 80)}），已经接着办了（第 ${n} 次重开）`).catch(() => {});
}

// 这轮办完就关终端：监听靠本程序扫草稿群，会话存在本地，再说话会新开终端 --resume。等 Claude 收完最后一句再关，免得会话记录截断
function closeWhenIdle(terminal) {
  if (!terminal) return;
  run(ORCA, ['terminal', 'wait', '--terminal', terminal, '--for', 'tui-idle', '--timeout-ms', '120000', '--json'], { timeout: 130_000 })
    .then(() => run(ORCA, ['terminal', 'close', '--terminal', terminal, '--tab', '--json']))
    .then((r) => r.code !== 0 && log('ERR close-term', (r.err || r.out).slice(0, 200)));
}

// fr 的真实回执（已发 / 没发出 / 结果未知），报告卡上的「已发」只信这个
const recentEvents = () => fs.readdirSync(EVENTS).filter((f) => f.endsWith('.jsonl')).sort().slice(-2).flatMap((f) => jsonl(`${EVENTS}/${f}`));
const cardReceipts = (card, since) => recentEvents().filter((e) => e.card === card && String(e.kind).startsWith('fr-') && Date.parse(e.ts) >= since);

async function waitReport(item, replyTo) {
  const { reportFile, startedAt } = item.work;
  try {
    while (Date.now() - (item.work.retriedAt || startedAt) < EXEC_TIMEOUT_MS) {
      await sleep(10_000);
      let rep;
      try { rep = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch {
        // 还没报告：会话要是接口报错停了，马上重开接着办；重开不了 / 重开也没用就马上说，不干等一小时
        const err = sessionApiError(item);
        if (!err) { if (item.work.pid) headlessGone(item.work, item.session); continue; } // 后台进程没了又不是接口报错：补受阻报告，下一轮读到
        const retried = err.retry && (item.work.retries || 0) < MAX_RETRIES
          && await retryWork(item, replyTo, err).then(() => true, (e) => { log('ERR retry', e.message); return false; });
        if (retried) continue;
        log('work', `接口报错停了 ${item.orig.sender_name} ${replyTo}：${cut(err.text, 80)}`);
        item.status = 'pending';
        delete item.work;
        saveState();
        return botReply(replyTo, `❌ 接口报错断了：${cut(err.text, 120)}。${err.retry ? '自动重开没成功' : '这种错重开也一样'}，这轮先停了，什么都没再做；要重来在这张卡下说「接着办」`);
      }
      const receipts = cardReceipts(replyTo, startedAt);
      // 跟进：确认他这条是在回等的那件事才算用掉；不相关就继续等（这条照样出卡）
      if (item.work.followup && rep.related !== false) appendFollowup({ op: 'fired', id: item.work.followup });
      if (rep.did?.trim() && !isVerified({ ok: true, verification: rep.verification })) rep.did += '（没给验证记录）';
      log('work', `done ${item.orig.sender_name} 发 ${receipts.filter((x) => x.kind === 'fr-sent').length} 条 ${replyTo}`);
      recordEvent('work', { orig: item.orig, report: rep, receipts: receipts.length });
      // 承诺：这轮兑现了的（有验证、也告诉了对方）关掉；我说不做了的关掉；这轮新答应的记上
      const verified = isVerified({ ok: true, verification: rep.verification });
      for (const r of openCommitments(readCommits(), { session: item.session })) {
        const told = receipts.some((x) => x.kind === 'fr-sent' && (x.to === r.to || x.toName === r.toName));
        if ((rep.kept || []).includes(r.id) && verified && told) appendCommit({ op: 'kept', id: r.id, at: Date.now() });
        else if ((rep.dropped || []).includes(r.id)) appendCommit({ op: 'dropped', id: r.id, at: Date.now() });
      }
      const fresh = receipts.filter((x) => x.kind === 'fr-sent').map((x) => fromSend(x.text, { card: null, session: item.session, to: x.to, toName: x.toName, message_id: x.message_id })).filter(Boolean);
      const view = { type: 'report', orig: item.orig, rep, receipts, session: item.session, log: item.work.log };
      const d = await botReplyCard(replyTo, renderView(view, { pending: [...pendingOf({ session: item.session }), ...fresh.map((r) => `${r.what}（对${r.toName}）`)] }));
      for (const r of fresh) appendCommit({ ...r, card: d.message_id });
      closeWhenIdle(item.work.terminal);
      // 报告卡也是一张能接着说话的卡：有拟回复就能「发」，说别的继续交给同一个会话
      // 没有拟回复也没要我定的：直接收起（我在下面说话会重新打开）
      const decide = !!(rep.ask?.trim() || rep.options?.length);
      const next = state.items[d.message_id] = { orig: item.orig, kind: rep.draft?.trim() ? 'answer' : 'report', draft: rep.draft || '', files: [],
        session: item.session, cwd: item.cwd, used_memories: item.used_memories || [], status: rep.draft?.trim() || decide ? 'pending' : 'handled', createdAt: Date.now(), ui: 'card',
        ask: rep.ask || '', options: rep.options || [], draft_after: rep.draft_after || '', verified, view };
      item.status = 'superseded';
      refreshCard(replyTo, '办完了，结果在下面这张卡');
      delete item.work;
      const queued = item.queued || [];
      delete item.queued;
      saveState();
      if (receipts.some((x) => x.kind === 'fr-sent')) {
        learn(item, `这轮办完了：${rep.did || ''}。发出去的：${receipts.map((x) => `给${x.toName}：${x.text}`).join('；')}`).catch((e) => log('ERR learn', e.message));
      }
      busySessions.delete(item.session);
      // 办的时候我又说的话、或者等的人回了：接着在新卡上处理
      const says = queued.filter((q) => q.kind === 'say').map((q) => q.text);
      for (const q of queued.filter((q) => q.kind === 'wake')) await wake(q.f, q.m).catch((e) => log('ERR wake', e.message));
      if (says.length) handleCommand(next, d.message_id, says.join('\n')).catch((e) => log('ERR cmd', e.message));
      return;
    }
    const where = item.work.log ? `看过程日志 ${item.work.log}` : '去 Orca 终端看看';
    item.status = 'pending';
    delete item.work;
    saveState();
    return botReply(replyTo, `⌛ 这轮一小时没出结果，${where}；要重来就再说一遍`);
  } finally {
    busySessions.delete(item.session);
  }
}

// ---------- 跟进：等的人回了 → 叫醒原会话接着办，授权还是我当初那句话 ----------
const readFollowups = () => jsonl(FOLLOWUPS);
const appendFollowup = (r) => fs.appendFileSync(FOLLOWUPS, JSON.stringify({ at: Date.now(), ...r }) + '\n');

async function wake(f, m) {
  const busy = Object.values(state.items).find((it) => it.session === f.session && it.status === 'working');
  if (busy) { (busy.queued ||= []).push({ kind: 'wake', f, m }); saveState(); return; } // 这件事正在办：办完再叫
  // 接在这件事最新的那张卡上
  const [cardId, item] = Object.entries(state.items).filter(([, it]) => it.session === f.session).sort((a, b) => b[1].createdAt - a[1].createdAt)[0]
    || [f.card, state.items[f.card] = { orig: f.orig, session: f.session, cwd: f.cwd, kind: 'report', draft: '', createdAt: Date.now() }];
  item.status = 'working';
  saveState();
  log('wake', `${f.watch.name} 回了 → ${cardId}`);
  // 授权看来源：我原话要求的跟进沿用那句话；Claude 自己挂的（或旧记录）这一轮没有发送授权，fr send 会被拒，回复出卡
  const authText = f.auth === 'said' ? f.authText : '';
  try { await runWork(item, cardId, authText, (rf) => wakePrompt(f, m, rf, recentSends()), { followup: f.id }); }
  catch (e) { item.status = 'pending'; saveState(); log('ERR wake', e.message); alert(`跟进没能叫醒：${e.message}`, 'wake'); }
}

// 等太久没回：提醒我一次
function checkExpiredFollowups() {
  const log_ = readFollowups();
  const closed = new Set(log_.filter((r) => ['fired', 'expired'].includes(r.op)).map((r) => r.id));
  const doneCards = new Set(log_.filter((r) => r.op === 'done').map((r) => r.card));
  for (const f of log_.filter((r) => r.op === 'add' && r.until <= Date.now() && !closed.has(r.id) && !doneCards.has(r.card))) {
    appendFollowup({ op: 'expired', id: f.id });
    botReply(f.card, `⌛ 等 ${f.watch.name} 回复到期了还没回（约定：${f.then}），要催一下还是算了？`).catch(() => {});
  }
}

// ---------- 沉淀：事件 + 记忆 ----------
function recordEvent(kind, payload) {
  fs.appendFileSync(`${EVENTS}/${new Date().toISOString().slice(0, 7)}.jsonl`, JSON.stringify({ ts: new Date().toISOString(), kind, ...payload }) + '\n');
}

// 闭环后抽记忆：resume=true 续上起草会话（有完整上下文）；否则单独起一个只看这件事的会话
async function learn(item, what, { resume = false } = {}) {
  const o = item.orig;
  const ask = `${what}

只列以后用得上的新信息（人物新事实 / 口径 / 可复用步骤 / 未完事项），已经在【已知信息】或记忆库里的不要重复；没有就返回空数组，别凑。
发送人 ${o.sender_name}（open_id ${o.sender_id}）：【已知信息】里没有他本人的单人人物卡，就新建一条 person（title 以姓名开头，entities 写 ["${o.sender_name}","${o.sender_id}"]，一人一条，写他是谁、找我做什么）；有的话只在有新信息时追加。
sources 写「${o.chat_name || '私聊 ' + o.sender_name}#${o.message_id}」；observed 写今天日期；价格计费、权限白名单、生产操作配方、对外承诺 review=pending，其余 auto。全部中文；key 可以原样记（写清是谁的、做什么用、什么时候给的），但不准外传给别人，除非${cfg.name}明确允许。`;
  const args = ['-p', resume ? ask : `原消息：${o.sender_name}（${o.chat_name || '私聊'} ${o.create_time}）：${o.content}\n\n${ask}`,
    '--output-format', 'json', '--json-schema', LEARN_SCHEMA, ...DRAFT_PERMS, '--max-turns', '3'];
  if (resume) args.push('--resume', item.session);
  const r = await run(CLAUDE, args, { cwd: resume ? item.cwd || WORK_DIR : WORKSPACE, timeout: CLAUDE_TIMEOUT_MS });
  const j = JSON.parse(r.out);
  recordEvent('cost', { what: 'learn', usd: j.total_cost_usd ?? null, session: j.session_id });
  const mems = j.structured_output?.memories || [];
  log('learn', `${o.sender_name} ${mems.length} 条 cost=$${j.total_cost_usd?.toFixed(2)}`);
  if (!mems.length) return;
  const file = `${RUNS}/learn-${o.message_id}-${Date.now()}.json`;
  fs.writeFileSync(file, JSON.stringify(mems));
  const a = await run(MEM, ['add', file, '--message', `闭环：${o.sender_name}`]);
  log('learn', (a.out || a.err).split('\n')[0]);
}

// ---------- 处理队列 ----------
const inflight = new Set(); // 正在起草的「会话·人·话题」
let enqueue = (m) => { if (!state.queue.some((x) => x.message_id === m.message_id)) state.queue.push(m); };
let pumping = true; // --once 只看候选，不处理
function pump() {
  if (!pumping) return;
  for (const batch of nextBatches(state.queue, inflight)) { // 同一个人在同一会话的连发合成一批，一次起草
    if (inflight.size >= MAX_PARALLEL) break;
    const key = burstKey(batch[0]);
    inflight.add(key);
    processBatch(batch).then(() => true, (e) => { log('ERR process', batch.at(-1).message_id, e.message); return false; }).then((ok) => {
      inflight.delete(key);
      for (const m of batch) {
        const r = settle(state, m.message_id, ok); // 失败留着稍后重试，连续 3 次才放弃
        if (r === 'drop') alert(`这条连续 3 次没处理成功，放弃了：${m.sender?.name}「${cut(m.content || '', 60)}」`, 'drop');
      }
      saveState();
      pump();
    });
  }
}

// 起草一批（同一人的连发，按最后一条回复）：上下文 + 预取 + Claude。force=true 时不检查是否已回复、不跳过纯确认（--dry 用）
async function draftFor(msgs, { force = false } = {}) {
  const m = msgs.at(-1);
  const orig = {
    message_id: m.message_id, chat_id: m.chat_id, chat_type: m.chat_type, chat_name: m.chat_name, thread_id: m.thread_id || null,
    sender_id: m.sender?.id, sender_name: m.sender?.name || m.sender?.id, create_time: m.create_time, content: msgs.map((x) => x.content || '').join('\n'), link: m.message_app_link,
    ...(msgs.length > 1 ? { burst: msgs.map((x) => x.message_id) } : {}),
  };
  log('process', `${orig.sender_name} @ ${orig.chat_name || 'p2p'}${msgs.length > 1 ? `（${msgs.length} 条连发）` : ''}: ${cut(orig.content.replace(/\s+/g, ' '), 80)}`); // 正文压成一行，日志好读、报告好脱敏
  if (!force && await alreadyReplied(m)) return log('skip', '已回复过', m.message_id);
  const ctx = await gatherContext(m);
  if (!force && skipAck(msgs, ctx.msgs, ME)) return log('skip', '纯确认', m.message_id);
  if (!force) react(m.message_id);
  const t0 = Date.now();
  const recent = ctx.text.split('\n').slice(-4, -1).join(' '); // 当前消息之前的几条，关键词常在前文
  const pre = await prefetch({ ...orig, recent }, { run, now: parseBJ(orig.create_time) + 60_000, bins: { mem: MEM, lark: LARK, orca: await launcherFor(run, ORCA) }, me: ME, ignore: [cfg.name], home: DIR }); // 只看这条消息之前我说过的
  log('prefetch', `${Date.now() - t0}ms 记忆 ${pre.memoryPaths.length} 条`);
  const prompt = `飞书上有一条需要处理的消息。

发送人：${orig.sender_name}
会话：${orig.chat_name ? `群「${orig.chat_name}」` : '私聊'}
时间：${orig.create_time}
message_id：${orig.message_id}　chat_id：${orig.chat_id}${orig.thread_id ? `　thread_id：${orig.thread_id}` : ''}

消息内容${msgs.length > 1 ? `（他连发了 ${msgs.length} 条，合起来看，回复挂在最后一条上）` : ''}：
${orig.content}

会话上下文（时间正序）：
${ctx.text}

【已知信息】（程序预取，先看这里，能答就不要再查）
${pre.text}`;
  return { orig, res: await askClaude(prompt), firstContact: pre.text.includes('（记忆里没有这个人）') };
}

async function processBatch(msgs) {
  const todo = msgs.filter((m) => shouldDraft(m, state));
  if (!todo.length) return log('skip', '已有草稿', msgs.at(-1).message_id);
  const d = await draftFor(todo);
  if (!d) return;
  if (d.res.kind === 'skip') return log('skip', d.res.summary, d.orig.message_id);
  if (await alreadyReplied(todo.at(-1))) return log('skip', '处理期间已回复', d.orig.message_id);
  // 影子期：放手的话这条会怎么发（Claude 提议，硬规则只往严里改）
  const reasons = holds(d.res, { commands: sessionCommands(d.res.cwd, d.res.session), firstContact: d.firstContact,
    leader: LEADERS.includes(d.orig.sender_name), external: externalChats().has(d.orig.chat_id) });
  d.res.shadow = { category: d.res.category || '其他', proposed: d.res.send_tier, tier: finalTier(d.res, reasons), reasons };
  await postDraft({ orig: d.orig }, d.res);
}

// 待处理的卡：我已经在原会话亲自回了 → 收起（卡上点个 ✅，不再轮询它的话题），并记下「草稿 vs 我实际怎么回的」给每日记忆用
async function closeHandled() {
  // 急的承诺（说了「现在 / 马上」）30 分钟还没做：在那张卡下提醒一次
  for (const r of dueReminders(readCommits())) {
    appendCommit({ op: 'reminded', id: r.id, at: Date.now() });
    if (r.card) botReply(r.card, `⏳ ${Math.round((Date.now() - r.at) / 60_000)} 分钟前答应了${r.toName}「${r.what}」，还没做。点卡上的「去做」，或者在卡下说「不做了」`).catch((e) => log('ERR remind', e.message));
  }
  const sent = sentIds(recentEvents());
  let n = 0;
  for (const [id, it] of Object.entries(state.items)) {
    if (it.status !== 'pending' || !it.orig || it.orig.chat_id === DRAFT_CHAT || Date.now() - it.createdAt > 3 * 86400_000) continue;
    let mine;
    try { mine = handledBy(it.orig, await laterMessages(it.orig), ME, sent, minuteBJ(it.createdAt)); } catch (e) { log('ERR close', e.message); continue; }
    if (!mine.length || it.status !== 'pending') continue; // 查的时候我可能刚在卡下说了话
    it.status = 'handled';
    n++;
    recordEvent('manual-reply', { card: id, orig: it.orig, draft: it.draft || '', actual: mine.slice(0, 3).map((x) => x.content) }); // 私聊里之后我说的都算，只留最先的几条
    outcome(id, it, 'self');
    if (it.ui) { refreshCard(id, `你回的：${cut(mine[0].content, 120)}`); continue; }
    lark(['im', 'reactions', 'create', '--as', 'bot', '--params', JSON.stringify({ message_id: id }), '--data', JSON.stringify({ reaction_type: { emoji_type: 'DONE' } })], true)
      .catch((e) => log('ERR react', e.message));
  }
  if (n) { saveState(); log('handled', `${n} 张卡已在原会话回过，收起`); }
}

// 外部会话（以我身份发不了、走过网页版或手动发的）：放手发也要等我
const externalChats = () => new Set([
  ...recentEvents().filter((e) => e.kind === 'manual' || e.via === 'web').map((e) => e.orig?.chat_id || (String(e.to).startsWith('oc_') ? e.to : null)),
  ...Object.values(state.items).filter((it) => it.status === 'manual').map((it) => it.orig?.chat_id)].filter(Boolean));

// ---------- 卡片按钮：机器人应用的长连接收点击回调（一个应用只能有一个进程在收） ----------
const clicksSeen = new Set();
const clickLog = clickWatch();
function listenClicks() {
  const p = spawn(LARK, ['event', 'consume', 'card.action.trigger', '--as', 'bot'], { env: BOT_ENV, cwd: DIR, stdio: ['pipe', 'pipe', 'pipe'] }); // stdin 不关：关了它就退出
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onClick(line); }
  });
  p.stderr.on('data', (d) => { const t = clickLog.stderr(d); if (t) log('clicks', t); });
  p.on('error', (e) => log('ERR clicks', e.message));
  p.on('close', (code) => { const { delay, line } = clickLog.exit(code); if (line) log('clicks', line); setTimeout(listenClicks, delay); });
}

// 点「发送」：发卡上输入框里的（我可能改过）；「不发」：跳过；「按我说的办」：吩咐交给起草会话，没写吩咐就是照卡上办
async function onClick(line) {
  let ev; try { ev = JSON.parse(line); } catch { return; }
  const c = parseClick(ev, ME_BOT);
  if (!c || clicksSeen.has(c.id)) return;
  clicksSeen.add(c.id);
  const item = state.items[c.card];
  if (!item) return; // 预览卡、老卡
  log('click', `${c.action} ${item.orig.sender_name} ${c.card}`);
  try {
    if (item.status === 'working') { if (c.note) { (item.queued ||= []).push({ kind: 'say', text: c.note }); saveState(); } return; }
    if (c.action === 'keep') { // 答应了还没做的：交给原会话去做，做完告诉对方
      const open = openCommitments(readCommits(), { session: item.session });
      if (!open.length) return refreshCard(c.card);
      item.status = 'pending';
      return await work(item, c.card, `去做之前答应的：${open.map((r) => r.what).join('；')}；做完告诉${[...new Set(open.map((r) => r.toName))].join('、')}`);
    }
    if (item.status === 'handled') item.status = 'pending'; // 收起的卡，我又点了：接着办
    if (item.status !== 'pending') return refreshCard(c.card);
    const draft = c.draft.trim(), edited = !!draft && draft !== (item.draft || '').trim();
    if (edited) item.draft = draft;
    if (c.action === 'skip') return await handleCommand(item, c.card, '不');
    if (c.action === 'send') return await guardedSend(item, c.card, { edited });
    if (c.action === 'send_anyway') return await sendReply(item, c.card, { edited }); // 我自己办：照发，承诺记账
    if (c.action === 'approve') {
      if (!c.selected.length) return await botReply(c.card, '先勾选要做的，再点「同意所选，做完再回他」');
      const after = c.draft_after.trim() || item.draft_after || '';
      const { authText, intro } = approvePrompt(item.options || [], c.selected, after, item.orig.sender_name);
      item.approval = { selected: c.selected, draft_after: after, at: Date.now() };
      return await work(item, c.card, authText, intro);
    }
    // 有要我定的事时，吩咐为空不等于「全照卡上办」（会把没勾的也做了）
    if (!c.note && (item.options?.length || item.ask?.trim() || item.kind === 'action')) return await botReply(c.card, '写一句吩咐，或者勾选后点「同意所选，做完再回他」');
    // 吩咐是授权原话（fr 按它校验）；改过的拟发送一起告诉它，但不算授权
    const text = c.note || '照卡上的拟回复发给他';
    return await work(item, c.card, text, `${cfg.name}在草稿卡片上点了「按我说的办」，吩咐：「${text}」${edited ? `\n他把拟发送改成了：「${draft}」` : ''}`);
  } catch (e) { log('ERR click', e.message); botReply(c.card, `❌ ${e.message}`).catch(() => {}); }
}

// ---------- 记忆日报卡：「1 3 确认，2 删，5 结」 ----------
const readDigest = (id) => { try { return JSON.parse(fs.readFileSync(`${DIGESTS}/${id}.json`, 'utf8')); } catch { return null; } };
const recentDigests = () => (fs.existsSync(DIGESTS) ? fs.readdirSync(DIGESTS) : [])
  .filter((f) => f.endsWith('.json') && Date.now() - fs.statSync(`${DIGESTS}/${f}`).mtimeMs < 3 * 86400_000).map((f) => f.slice(0, -5));

async function handleReview(cardId, dg, x) {
  const r = parseReview(x.content, dg.items.filter((i) => !i.done));
  if (!r) return botReply(cardId, '没看懂。这样回：「1 3 确认，2 删，5 结」——确认 / 删 用于待确认的条目，结 用于到期的事；也可以「全部确认」');
  const ok = { accept: 0, reject: 0, close: 0 }, errs = [];
  for (const verb of ['accept', 'reject']) for (const it of r[verb]) {
    const a = await run(MEM, [verb, it.path]);
    if (a.code === 0) { it.done = true; ok[verb]++; } else errs.push(`${it.n}（${cut((a.err || a.out).trim(), 60)}）`);
  }
  if (r.close.length) {
    const today = minuteBJ(Date.now()).slice(0, 10);
    const file = `${RUNS}/close-${x.message_id}.json`;
    fs.writeFileSync(file, JSON.stringify(r.close.map((it) => ({ type: 'open', title: it.title, entities: [], scope: '', content: `${today} 已结（${cfg.name}在记忆日报里确认）`,
      sources: [`草稿群#${x.message_id}`], observed: today, confidence: 'high', review: 'auto', status: 'done', target: it.path }))));
    const a = await run(MEM, ['add', file, '--message', `日报卡：结案 ${r.close.length} 条`]);
    if (a.code === 0) { r.close.forEach((it) => (it.done = true)); ok.close = r.close.length; } else errs.push(`结案失败（${cut((a.err || a.out).trim(), 60)}）`);
  }
  fs.writeFileSync(`${DIGESTS}/${cardId}.json`, JSON.stringify(dg, null, 1));
  log('review', JSON.stringify(ok));
  return botReply(cardId, `✅ 确认 ${ok.accept}、删除 ${ok.reject}、结案 ${ok.close}${r.bad.length ? `；这些编号不对或类型不符：${r.bad.join('、')}` : ''}${errs.length ? `；没做成：${errs.join('；')}` : ''}`);
}

// ---------- 主循环 ----------
async function loop(name, fn, ms) {
  let fails = 0;
  for (;;) {
    try { await fn(); fails = 0; } catch (e) {
      log(`ERR ${name}`, e.message);
      // 授权问题马上提醒；其他错误连续 5 轮才提醒（10-23 草稿群轮询报错一个多小时，我只能从「怎么不回了」发现）
      const auth = /authorization|token|auth/i.test(e.message);
      if (auth || ++fails === 5) await alert(`${name} 连续出错：${e.message}`, auth ? 'auth' : name);
    }
    await sleep(ms);
  }
}

if (process.argv.includes('--once')) {
  // 只扫一次收件箱并打印候选，不跑 Claude
  pumping = false;
  enqueue = (m) => log('candidate', `${m.sender?.name} @ ${m.chat_name || 'p2p'} ${m.create_time}: ${cut(m.content, 100)}`);
  await pollInbox();
  process.exit(0);
}
const dryId = process.argv.indexOf('--dry');
const idArg = (i, flag) => { const v = process.argv[i + 1]; if (!/^om_/.test(v || '')) { console.error(`用法：node assistant.mjs ${flag} om_xxx（飞书消息的 message_id）`); process.exit(2); } return v; };
if (dryId > -1) {
  // 只起草打印，不发卡片、不改状态（回放历史消息看效果/成本）
  const d = await lark(['im', '+messages-mget', '--as', 'user', '--message-ids', idArg(dryId, '--dry'), '--no-reactions']);
  if (!d.messages?.length) { console.error(`查不到这条消息：${process.argv[dryId + 1]}`); process.exit(2); }
  const r = await draftFor([d.messages[0]], { force: true });
  console.log(JSON.stringify(r.res, null, 1));
  process.exit(0);
}
const testId = process.argv.indexOf('--test');
if (testId > -1) {
  // 对指定 message_id 走一遍完整流程（会往草稿群发）
  const d = await lark(['im', '+messages-mget', '--as', 'user', '--message-ids', idArg(testId, '--test'), '--no-reactions']);
  if (!d.messages?.length) { console.error(`查不到这条消息：${process.argv[testId + 1]}`); process.exit(2); }
  await processBatch([d.messages[0]]);
  process.exit(0);
}

log('start', `poll=${POLL_MS / 1000}s confirm=${CONFIRM_MS / 1000}s`);
// 重启前没等完的办事接着等
for (const [id, it] of Object.entries(state.items)) if (it.status === 'working' && it.work) { busySessions.add(it.session); waitReport(it, id).catch((e) => log('ERR work', e.message)); }
if (state.queue.length) { log('queue', `恢复 ${state.queue.length} 条待起草`); pump(); }
loop('inbox', pollInbox, POLL_MS);
loop('confirm', pollConfirm, CONFIRM_MS);
listenClicks();
loop('close', closeHandled, CLOSE_MS);
