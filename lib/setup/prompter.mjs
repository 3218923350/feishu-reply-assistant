// setup 的提问：readline 只在问的时候开着。起交互子进程（lark-cli config init / auth login、install.sh、coldstart.sh）前先关掉，
// 不然终端一直处在 readline 的 raw 模式，子进程里的 read 按回车没反应、也不回显
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

export function makePrompter({ input = process.stdin, output = process.stdout } = {}) {
  let rl = null;
  const open = () => (rl ||= createInterface({ input, output }));
  const close = () => { if (rl) { rl.close(); rl = null; } };
  const ask = async (q, def = '') => ((await open().question(`${q}${def ? `（默认 ${def}）` : ''}：`)).trim() || def);
  const yes = async (q, def = true) => { const a = (await open().question(`${q} [${def ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase(); return a ? a.startsWith('y') : def; };
  const interactive = (cmd, args, env = process.env) => { close(); return spawnSync(cmd, args, { stdio: 'inherit', env }).status === 0; };
  return { ask, yes, interactive, close };
}
