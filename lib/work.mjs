import fs from 'node:fs';

// 办事怎么起：有 Orca 就开它的终端跑（可围观、可插话）；没有就后台跑 claude -p，过程写日志。两种都 --resume 起草时的会话，发消息只能走 fr
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// home：数据目录（FRA_HOME）。Orca 终端用的是 Orca 自己的环境，不带过去 fr / mem 就会读默认位置的配置
export function workLaunch({ orca, repo, where, cwd, session, promptFile, ctxFile, claude, deny, title, prompt, env, home = env.FRA_HOME }) {
  if (orca) {
    const cmd = `cd ${shq(cwd)} && export PATH=${shq(`${repo}/bin`)}:"$PATH" FR_CTX=${shq(ctxFile)}${home ? ` FRA_HOME=${shq(home)}` : ''} CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 && `
      + `${shq(claude)} --resume ${shq(session)} --dangerously-skip-permissions --disallowedTools ${deny.map(shq).join(' ')} -- "$(cat ${shq(promptFile)})"`;
    return { via: 'orca', cmd: orca, args: ['terminal', 'create', '--worktree', `path:${where}`, '--title', title, '--command', cmd, '--json'] };
  }
  return { via: 'spawn', cmd: claude, cwd,
    args: ['--resume', session, '--dangerously-skip-permissions', '--disallowedTools', ...deny, '--output-format', 'stream-json', '--verbose', '-p', prompt],
    env: { ...env, PATH: `${repo}/bin:${env.PATH || ''}`, FR_CTX: ctxFile, CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1', ...(home ? { FRA_HOME: home } : {}) } };
}

// 后台办事的进程还在不在（助手重启后靠它判断：进程没了、报告也没写 → 补一份受阻报告）
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// 进程退出后记一次这轮的费用：退出回调和重启后的轮询都可能调到，用标记文件保证只记一次
export function workCostOnce(logFile, record) {
  const mark = `${logFile}.cost`;
  if (fs.existsSync(mark)) return;
  let text = '';
  try { text = fs.readFileSync(logFile, 'utf8'); } catch {}
  const usd = costFromStream(text);
  fs.writeFileSync(mark, String(usd));
  record(usd);
}

// 后台跑的日志（stream-json）：最后一行 result 里有这轮花了多少钱
export function costFromStream(text) {
  for (const l of String(text).trim().split('\n').reverse()) {
    try { const j = JSON.parse(l); if (j.type === 'result') return j.total_cost_usd ?? null; } catch {}
  }
  return null;
}

// 起一轮办事：Orca 能用就开终端；没有、或者开终端失败，就后台跑（startHeadless 返回 pid）
export async function launchWork({ how, orca, run, startHeadless, log }) {
  if (orca) {
    const l = workLaunch({ ...how, orca });
    const r = await run(l.cmd, l.args);
    if (r.code === 0) {
      let terminal = null;
      try { terminal = JSON.parse(r.out).result.terminal.handle; } catch { log('ERR term-handle', String(r.out).slice(0, 200)); }
      return { inOrca: true, terminal, pid: null };
    }
    log('ERR orca-term', `开终端失败，改后台跑：${(r.err || r.out || '').slice(0, 200)}`);
  }
  return { inOrca: false, terminal: null, pid: startHeadless(workLaunch({ ...how, orca: null })) };
}

// ---------- 回收办完没退的办事进程 ----------
// Orca 里的办事是交互式 claude，写完报告也不会自己退；关终端的路（closeWhenIdle、retryWork）助手中途重启、Orca 重启、close 失败都会漏，
// 一个空闲进程占几百 MB（10-27 实测漏了 32 个、约 8.6GB）。按进程扫兜底：只认助手自己起的办事进程
//（`claude --resume <会话> --dangerously-skip-permissions --disallowedTools <EXEC_DENY 原样>`），会话是助手的、这会儿不在办、最后一句对话够久了才收

// ps -axww -o pid=,args= 的输出 → 助手办事进程 [{ pid, session }]。deny：EXEC_DENY；argv 里空格分开，规则本身带空格，所以按整串前缀比
export function workProcs(psOut, deny) {
  const tail = ['--dangerously-skip-permissions', '--disallowedTools', ...deny].join(' ');
  const out = [];
  for (const l of String(psOut).split('\n')) {
    const m = l.match(/^\s*(\d+)\s+(\S*\/)?claude --resume ([0-9a-f-]{36}) (.*)$/);
    if (m && m[4].startsWith(tail)) out.push({ pid: Number(m[1]), session: m[3] });
  }
  return out;
}

// 会话记录里最后一句对话的时间（ms）。不能看文件 mtime：空闲进程也一直在往里写记账行（cost-state 等）
export function lastTalkAt(jsonl) {
  let t = 0;
  for (const l of String(jsonl).split('\n')) {
    if (!l.includes('"timestamp"')) continue;
    try { const j = JSON.parse(l); if (j.type === 'user' || j.type === 'assistant') t = Math.max(t, Date.parse(j.timestamp) || 0); } catch {}
  }
  return t;
}

// 要收的：会话在助手的卡片里、不在办、最后一句对话早于 idleMs。lastTalk 拿不到（0）不收
export const staleWork = (procs, { known, busy, lastTalk, now = Date.now(), idleMs = 30 * 60_000 }) =>
  procs.filter((p) => known.has(p.session) && !busy.has(p.session) && (() => { const t = lastTalk(p.session); return t > 0 && now - t > idleMs; })());
