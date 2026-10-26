// bin/fra doctor：逐项检查安装状态，每项给出怎么修。只读：不起长连接（会抢走正在跑的服务的按钮回调）、不发消息
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BIN, botEnv } from '../config.mjs';
import { launcherFor, orcaBin } from '../orca.mjs';

export const MEM_MARKER = '<!-- feishu-reply-assistant:mem -->';
const json = (r) => { try { return JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { return {}; } };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const real = (f) => { try { return fs.realpathSync(f); } catch { return f; } };

// limit：只跑前几项（setup 第一步只要看基础依赖，不碰飞书、launchd）
export async function runChecks({ load, run, env = process.env, home = os.homedir(), repo, platform = process.platform, nodeVersion = process.version, uid = process.getuid(), limit = Infinity }) {
  const out = [];
  const add = (name, ok, detail = '', fix = '') => out.push({ name, ok, detail, fix });
  const { lark, claude } = BIN(env);

  add('系统是 macOS', platform === 'darwin', platform, '目前只支持 macOS');
  add('Node ≥ 24', Number(String(nodeVersion).replace(/^v/, '').split('.')[0]) >= 24, nodeVersion, '装 Node 24 或更新的版本（记忆检索要用 node:sqlite）');
  const cl = await run(claude, ['--version'], { env });
  add('Claude Code', cl.code === 0, (cl.out || cl.err).trim().split('\n')[0], '装 Claude Code 并登录（https://claude.com/claude-code），确认 claude 在 PATH 里');
  const lk = await run(lark, ['--version'], { env });
  add('lark-cli', lk.code === 0, (lk.out || lk.err).trim().split('\n')[0], '装 lark-cli 并确认在 PATH 里（见 docs/feishu-app.md）');
  if (out.length >= limit) return out.slice(0, limit);

  let cfg = null;
  try { cfg = load(); add('配置文件', true, cfg.home); } catch (e) { add('配置文件', false, e.message, '跑 bin/fra setup，或照 templates/config.example.json 写'); }
  const skip = (name) => add(name, null, '配置没读到，先修「配置文件」');
  const noStart = cfg && fs.existsSync(path.join(cfg.home, '.no-start'));

  if (!cfg) for (const n of ['关于我', '飞书用户身份', '机器人身份', '草稿群', '卡片回调', '记忆目录', '记忆检索']) skip(n);
  else {
    const template = read(path.join(repo, 'templates', 'about-me.md'));
    const untouched = !cfg.aboutMe.trim() || cfg.aboutMe.trim() === template.trim() || cfg.aboutMe.includes('下面是虚构的示例'); // setup 复制过去还没改
    add('关于我', !untouched, path.join(cfg.home, 'about-me.md'), `在 ${path.join(cfg.home, 'about-me.md')} 写你是谁、负责什么（模板里的张三是示例，要换成你自己的，并删掉开头的说明注释），照 templates/about-me.md`);
    const u = json(await run(lark, ['auth', 'status'], { env })).identities?.user;
    add('飞书用户身份', u?.status === 'ready' && u.openId === cfg.openId, u ? `${u.userName || ''} ${u.openId || ''}`.trim() : '没登录',
      u?.status !== 'ready' ? '跑 lark-cli auth login（要的权限见 docs/feishu-app.md）'
        : `配置里的 open_id 是 ${cfg.openId}，lark-cli 登录的是 ${u.openId}：改 config.json 的 open_id，或换成你自己的账号登录`);
    const benv = botEnv(cfg, env);
    const b = json(await run(lark, ['auth', 'status'], { env: benv })).identities?.bot;
    add('机器人身份', b?.available === true, b?.message || '', '机器人应用没配好：开机器人能力、发布版本；两个应用时检查 config.json 的 bot_env（见 docs/feishu-app.md）');
    const m = json(await run(lark, ['im', '+chat-members-list', '--as', 'bot', '--chat-id', cfg.draftChatId], { env: benv }));
    const users = m.data?.users || [];
    add('草稿群', users.some((x) => [x.member_id, x.open_id, x.id].includes(cfg.botOpenId)), cfg.draftChatId, // 机器人应用下的 id（open_id 按应用隔离）
      '机器人读不到草稿群或你不在群里：检查 draft_chat_id，把机器人和你自己都拉进这个群');
    // 卡片回调：只看日志（服务最近一次启动之后连上了没有）
    const lines = read(path.join(cfg.home, 'assistant.log')).split('\n');
    const lastStart = lines.map((l) => /^\S+ start\b/.test(l)).lastIndexOf(true);
    if (noStart || lastStart < 0) add('卡片回调', null, '服务没在跑');
    else add('卡片回调', lines.slice(lastStart + 1).some((l) => /^\S+ clicks .*ready/.test(l)), '看 assistant.log 最近一次启动之后',
      '按钮回调没连上：飞书开放平台里给应用订阅卡片回调 card.action.trigger、选长连接；同一个应用只能有一个进程在收');
    const top = fs.existsSync(cfg.memoryDir) ? await run('git', ['-C', cfg.memoryDir, 'rev-parse', '--show-toplevel'], { env }) : { code: 1, out: '' };
    const own = top.code === 0 && real(top.out.trim()) === real(cfg.memoryDir);
    add('记忆目录', own, cfg.memoryDir, top.code === 0 && !own ? `记忆目录在别的 git 仓库里（${top.out.trim()}），mem add 会提交进那个仓库：跑 bin/fra setup 让它自己 git init，或换个目录`
      : '跑 bin/fra setup 初始化记忆目录（会 git init），或改 config.json 的 memory_dir');
    const ms = await run(path.join(repo, 'bin', 'mem'), ['search', '测试', '--json'], { env });
    add('记忆检索', ms.code === 0, '', `bin/mem search 失败：${(ms.err || ms.out).trim().slice(0, 160)}`);
  }

  const settings = read(path.join(home, '.claude', 'settings.json'));
  add('Claude Code 记忆 hook', [repo, real(repo)].some((r) => settings.includes(`${r}/bin/mem-hook`) || settings.includes(`${r.replace(/'/g, `'\\''`)}/bin/mem-hook`)), path.join(home, '.claude', 'settings.json'),
    '跑 bin/fra setup 装 hook（每次提问自动带上记忆线索）');
  add('全局 CLAUDE.md', read(path.join(home, '.claude', 'CLAUDE.md')).includes(MEM_MARKER), path.join(home, '.claude', 'CLAUDE.md'),
    '跑 bin/fra setup 加上「先 mem search」那段说明');
  const memInPath = String(env.PATH || '').split(':').filter(Boolean).map((d) => path.join(d, 'mem')).find((f) => fs.existsSync(f));
  add('mem 命令', !!memInPath && real(memInPath) === real(path.join(repo, 'bin', 'mem')), memInPath || 'PATH 里没有 mem',
    `把 ${path.join(repo, 'bin', 'mem')} 链到 PATH 里（比如 ln -sf ${path.join(repo, 'bin', 'mem')} ~/.local/bin/mem）`);

  if (!cfg || noStart) { add('常驻服务', null, cfg ? '用 --no-start 装的，没启动' : '配置没读到'); add('每日任务', null, cfg ? '用 --no-start 装的' : '配置没读到'); }
  else {
    const svc = await run('launchctl', ['print', `gui/${uid}/${cfg.launchdLabel}`], { env });
    add('常驻服务', svc.code === 0 && /state = running/.test(svc.out), cfg.launchdLabel, '跑 ./install.sh 装上 / 重启；看 $FRA_HOME/launchd.err.log');
    const daily = await run('launchctl', ['print', `gui/${uid}/${cfg.launchdLabel}.daily`], { env });
    add('每日任务', daily.code === 0, `${cfg.launchdLabel}.daily`, '跑 ./install.sh');
  }
  const orca = await launcherFor(run, orcaBin(env));
  add('Orca（可选）', orca ? true : null, orca ? orca : '没装或没开：办事在后台跑，外部群走剪贴板');
  return out;
}
