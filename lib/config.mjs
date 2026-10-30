// 配置：$FRA_HOME/config.json（身份、草稿群、记忆目录……）+ $FRA_HOME/about-me.md（关于我）。import 时不读任何文件
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class ConfigError extends Error {}

export const fraHome = (env = process.env, home = os.homedir()) => path.resolve(env.FRA_HOME || path.join(home, '.feishu-reply-assistant'));
const expand = (p, home) => p.replace(/^~(?=\/|$)/, home);
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const strs = (x) => Array.isArray(x) && x.every((v) => typeof v === 'string');
const REQUIRED = ['name', 'open_id', 'draft_chat_id'];

export function loadConfig({ env = process.env, home = os.homedir() } = {}) {
  const dir = fraHome(env, home), file = path.join(dir, 'config.json');
  const fail = (why) => { throw new ConfigError(`配置有问题（${file}）：${why}。先跑 bin/fra setup，或照 templates/config.example.json 改。`); };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { fail('文件不存在'); }
  let c;
  try { c = JSON.parse(raw); } catch (e) { fail(`不是合法的 JSON（${e.message}）`); }
  if (!isObj(c)) fail('最外层要是一个对象 { ... }');
  const missing = REQUIRED.filter((k) => !c[k]);
  if (missing.length) fail(`缺 ${missing.join('、')}`);
  // 形状不对的给人话，别让 TypeError / SyntaxError 冒到用户面前，也别静默用错（bot_env 写成字符串会被拆成一堆数字键）
  for (const k of ['name', 'open_id', 'draft_chat_id', 'bot_open_id', 'messenger_url', 'memory_dir', 'legacy_work_dir', 'launchd_label']) {
    if (c[k] != null && typeof c[k] !== 'string') fail(`${k} 要写成字符串`);
  }
  if (c.launchd_label != null && !/^[A-Za-z0-9._-]+$/.test(c.launchd_label)) fail('launchd_label 只能用字母、数字和 . _ -');
  if (c.auto_react != null && typeof c.auto_react !== 'boolean') fail('auto_react 要写成 true 或 false');
  if (c.auto_send != null && typeof c.auto_send !== 'boolean') fail('auto_send 要写成 true 或 false');
  if (c.auto_signature != null && typeof c.auto_signature !== 'string') fail('auto_signature 要写成字符串');
  if (c.task_list_id != null && typeof c.task_list_id !== 'string') fail('task_list_id 要写成字符串');
  if (c.desktop_send != null && typeof c.desktop_send !== 'boolean') fail('desktop_send 要写成 true 或 false');
  if (c.desktop_model != null && typeof c.desktop_model !== 'string') fail('desktop_model 要写成字符串');
  if (c.leaders != null && !strs(c.leaders)) fail('leaders 要写成 ["姓名", ...]');
  if (c.secret_prefixes != null && !strs(c.secret_prefixes)) fail('secret_prefixes 要写成 ["前缀", ...]');
  if (c.bot_env != null && !(isObj(c.bot_env) && Object.values(c.bot_env).every((v) => typeof v === 'string'))) fail('bot_env 要写成 { "环境变量名": "值" }');
  if (c.aliases != null && !(Array.isArray(c.aliases) && c.aliases.every((a) => strs(a) && a.length === 2))) fail('aliases 要写成 [["正则", "记忆里的写法"], ...]');
  const aliases = (c.aliases || []).map(([re, to], i) => { try { return [new RegExp(re, 'i'), to]; } catch { return fail(`aliases 第 ${i + 1} 条的正则「${re}」不合法`); } });
  const abs = (p) => (p ? path.resolve(dir, expand(p, home)) : null); // 相对路径按 FRA_HOME 解析，不随 cwd 变
  let aboutMe = '';
  try { aboutMe = fs.readFileSync(path.join(dir, 'about-me.md'), 'utf8'); } catch {}
  return {
    home: dir, name: c.name, openId: c.open_id, botOpenId: c.bot_open_id || c.open_id, draftChatId: c.draft_chat_id,
    leaders: c.leaders || [],
    botEnv: expandBotEnv(c.bot_env, home),
    messengerUrl: c.messenger_url || null,
    memoryDir: abs(c.memory_dir) || path.join(dir, 'memory'),
    aliases,
    secretPrefixes: c.secret_prefixes || [],
    legacyWorkDir: abs(c.legacy_work_dir),
    launchdLabel: c.launchd_label || 'com.feishu-reply-assistant',
    autoReact: c.auto_react !== false, // 不写就是点
    autoSend: c.auto_send === true, // 不写就是不发：草稿全等你点
    desktopSend: c.desktop_send === true, // 外部会话网页版发不成时，操作飞书桌面客户端发（先脚本，不行再 Codex）
    desktopModel: c.desktop_model || '', // 桌面代发兜底时 Codex 用的模型；不写用 Codex 自己的默认
    taskListId: c.task_list_id || null, // 「加入任务」建的飞书任务放进这个清单；不写就只指给你
    autoSignature: (c.auto_signature ?? '（{{name}}的助手代回）').replaceAll('{{name}}', () => c.name), // 不等你确认发出去的，结尾加这一行
    aboutMe,
  };
}

// 提示词模板：{{name}} → 我的名字，{{about_me}} → 关于我（没写就提示去写）
export const fill = (text, cfg) => String(text)
  .replaceAll('{{name}}', () => cfg.name) // 用函数：替换文本里的 $& $` 之类原样保留
  .replaceAll('{{about_me}}', () => (cfg.aboutMe?.trim() ? cfg.aboutMe
    : `（还没写「关于我」：在 ${path.join(cfg.home, 'about-me.md')} 里写你是谁、负责什么、常用仓库和目录）`));

// 配置里 bot_env 的值展开 ~（setup 里配置还没写完时也要用）
export const expandBotEnv = (raw, home = os.homedir()) => Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [k, expand(v, home)]));

// 草稿群里发卡片、收按钮回调用的机器人：配置里的 bot_env 合进环境变量（单应用时为空，和用户身份同一个 lark-cli 配置）
export const botEnv = (cfg, env = process.env) => ({ ...env, ...cfg.botEnv });

// 外部命令从 PATH 找；测试可以用环境变量换成假的
export const BIN = (env = process.env) => ({ lark: env.FRA_LARK || 'lark-cli', claude: env.FRA_CLAUDE || 'claude', codex: env.FRA_CODEX || 'codex' });
