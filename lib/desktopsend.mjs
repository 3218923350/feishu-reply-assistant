// 外部会话的另一条路：操作本机已登录的飞书桌面客户端替我发（网页版没登录、页面脚本跑不通时用）。
// 先跑确定性的脚本（feishu-desktop.swift：按名字打开会话、核对、粘贴、回车，十几秒、不花钱）；脚本不行再交给 Codex 看着界面想办法。
// 都要「辅助功能」权限：助手是 launchd 起的，没有这个权限，所以放进 Orca 终端里跑（Orca 有）。发没发出去一律用 lark-cli 在会话里核对
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as runProc } from './run.mjs';
import { confirmSent, webSend, withLock } from './websend.mjs';

export const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'feishu-desktop.swift');
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const HELPER_CMD = process.env.FRA_DESKTOP_HELPER || `swift ${sh(HELPER)}`; // 跑脚本的命令；测试里换成假的，别去动真的飞书
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const desktopPrompt = ({ name, group, chatId, textFile, helper = HELPER_CMD, why = '' }) => `你在替我在 Mac 上已登录的飞书桌面客户端（Lark.app，bundle id com.electron.lark，进程名 Feishu）里发一条消息。只做这一件事，别的什么都不要动。

- 目标会话：${group ? '群' : '和这个人的私聊'}「${name}」（chat_id ${chatId}，可以用 lark-cli --as user 只读核对，不许用 lark-cli 发消息）
- 要发的正文：文件 ${textFile} 的完整内容，一字不改

有现成脚本，先用它：
- ${helper} state —— 当前会话名（输入框空的时候写着「发送给 会话名」）和输入框内容
- ${helper} open ${sh(name)} —— ⌘K 搜索、点标题正好对上的那一行
- ${helper} send ${sh(name)} ${textFile} —— 核对会话和空输入框 → 粘贴 → 核对内容 → 回车一次
${why ? `刚才脚本失败了：${why}。先想清楚为什么（比如会话在飞书里显示的名字不一样、搜索结果长得不一样），再决定怎么做。\n` : ''}脚本不够用就自己写 Swift Accessibility / osascript 读界面、点元素；按键用 System Events（osascript -e 'tell application "System Events" to key code 36'）。不要截图（你看不了图片，截图还会把请求撑爆），靠辅助功能树读界面。
规则：打开后核对输入框写着「发送给 ${name}」；输入框里原来有没发出的内容就停下不动；只按一次发送；发完不再输入或点击任何东西；任何一步拿不准就不要发。

最后一行只输出一个 JSON：{"sent": true} 或 {"sent": false, "why": "没发的原因"}。`;

// 最后一行的 JSON；没有就当没发（真发了的话 lark-cli 核对会认出来）
export function parseDesktop(out) {
  const line = String(out || '').trim().split('\n').reverse().find((l) => /^\s*\{.*"(sent|ok)"/.test(l));
  try { return JSON.parse(line); } catch { return { sent: false, ok: false, why: `没拿到结果：${String(out || '').trim().slice(-120)}` }; }
}

// 跑一段要辅助功能权限的 shell：本进程有权限就直接跑，没有就开一个 Orca 终端跑完自己退出。返回输出文本
let trusted = null;
export async function axShell(script, { run = runProc, orca, repo, timeout, dir, axTrusted }) {
  if (axTrusted !== undefined) trusted = axTrusted; // 测试里指定
  const file = path.join(dir, `step-${Date.now()}.sh`), out = `${file}.out`, done = `${file}.done`;
  fs.writeFileSync(file, `${script} > ${sh(out)} 2>&1\necho $? > ${sh(done)}\n`);
  if (trusted === null) trusted = /"ok":true/.test((await run('bash', ['-c', `${HELPER_CMD} state`], { timeout: 60_000 })).out);
  if (trusted || !orca) await run('bash', [file], { timeout });
  else {
    const r = await run(orca, ['terminal', 'create', '--worktree', `path:${repo}`, '--title', '飞书客户端代发', '--command', `bash ${sh(file)}; exit`, '--json'], { timeout: 60_000 });
    let handle = null; try { handle = JSON.parse(r.out).result.terminal.handle; } catch {}
    const t0 = Date.now();
    while (!fs.existsSync(done) && Date.now() - t0 < timeout) await sleep(1000);
    if (!fs.existsSync(done) && handle) await run(orca, ['terminal', 'close', '--terminal', handle, '--tab', '--json']);
  }
  try { return fs.readFileSync(out, 'utf8'); } catch { return ''; }
}

// { ok: true, message_id, how } | { ok: false, why } | { ok: false, unknown: true, why }，和 webSend 一样。
// codex 不给就只跑脚本；model：Codex 用哪个模型（不写用它自己配置的默认）
export function desktopSend({ name, group, chatId, text, codex, lark, me, orca, repo, model = '', pollMs = 3000, run = runProc, timeout = 8 * 60_000, axTrusted,
  lock = path.join(os.tmpdir(), 'fra-desktopsend.lock') }) {
  return withLock(lock, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-desktop-'));
    const textFile = path.join(dir, 'text.txt');
    fs.writeFileSync(textFile, text);
    const ax = (script, t) => axShell(script, { run, orca, repo, timeout: t, dir, axTrusted });
    const check = async (said, how) => {
      const id = await confirmSent({ run, lark, chatId, me, text, pollMs, tries: said ? 8 : 2 }); // 说没发也看一眼：其实发了也算
      if (id) return { ok: true, message_id: id, how };
      return said ? { ok: false, unknown: true, why: `${how}说发了，但在会话里没核对到这条消息` } : null;
    };
    try {
      const s = parseDesktop(await ax(`${HELPER_CMD} open ${sh(name)} && ${HELPER_CMD} send ${sh(name)} ${sh(textFile)}`, 120_000));
      const a = await check(s.ok && s.pressed, '脚本');
      if (a) return a;
      if (!codex) return { ok: false, why: `桌面客户端：${s.why || '没发'}` };
      const outFile = path.join(dir, 'codex.txt');
      await ax(`${sh(codex)} exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --ephemeral ${model ? `-m ${sh(model)} ` : ''}-C ${sh(dir)} -o ${sh(outFile)} ${sh(desktopPrompt({ name, group, chatId, textFile, why: s.why }))} < /dev/null`, timeout);
      let out = ''; try { out = fs.readFileSync(outFile, 'utf8'); } catch {}
      const c = parseDesktop(out);
      return (await check(c.sent, 'Codex')) || { ok: false, why: `桌面客户端：脚本 ${s.why || '没发'}；Codex ${c.why || '没发'}` };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, { staleMs: timeout + 5 * 60_000, waitS: 900, busy: '飞书桌面客户端正被另一次发送占着' });
}

// 外部会话发一条：先网页版（快），确定没发出去再走桌面客户端。web / desktop 传 null 就跳过那条路，webWhy 是跳过的原因
// 返回 { ok, message_id, via } | { ok: false, unknown, why, via } | { ok: false, why }；senders：测试里换成假的
export async function sendExternal({ web, webWhy = '', desktop, onDesktop, senders = { web: webSend, desktop: desktopSend } }) {
  const w = web ? await senders.web(web) : { ok: false, why: webWhy };
  if (w.ok || w.unknown || !desktop) return { ...w, via: 'web' };
  await onDesktop?.(w.why);
  const d = await senders.desktop(desktop);
  return d.ok || d.unknown ? { ...d, via: 'desktop' } : { ok: false, why: [w.why && `网页版：${w.why}`, d.why].filter(Boolean).join('；') };
}
