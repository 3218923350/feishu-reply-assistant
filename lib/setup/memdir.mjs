// 新的记忆目录：各类型一个子目录（含 inbox 待确认），git 仓库只在本机、不配远端（mem add 每次提交一次，方便回看和撤销）
import fs from 'node:fs';
import path from 'node:path';
import { TYPE_DIRS } from '../memory/store.mjs';

export async function initMemoryDir(dir, run) {
  let created = false;
  for (const d of Object.values(TYPE_DIRS).flatMap((t) => [t, path.join('inbox', t)])) {
    const p = path.join(dir, d);
    if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, '.gitkeep'), ''); created = true; }
  }
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) { fs.writeFileSync(ignore, '.mem-index.sqlite*\n.mem.lock/\n'); created = true; }
  const top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']); // 放在别的仓库里面时也要自己 init，别把记忆提交进那个仓库
  if (top.code !== 0 || fs.realpathSync(top.out.trim()) !== fs.realpathSync(dir)) {
    await run('git', ['init', '-q', dir]);
    await run('git', ['-C', dir, 'add', '-A']);
    await run('git', ['-C', dir, 'commit', '-q', '-m', '初始化记忆库']);
    created = true;
  }
  return { created };
}
