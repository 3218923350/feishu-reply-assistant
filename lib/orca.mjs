// Orca 是可选的：装了而且开着就在它的终端里办事（能看、能插话）、网页版飞书替发外部群、搜本地会话；没有就退回后台跑 / 剪贴板
import fs from 'node:fs';
import path from 'node:path';

const APP = '/Applications/Orca.app/Contents/Resources/bin/orca';

export function orcaBin(env = process.env, exists = fs.existsSync) {
  if (env.FRA_ORCA) return env.FRA_ORCA;
  for (const dir of String(env.PATH || '').split(':').filter(Boolean)) if (exists(path.join(dir, 'orca'))) return path.join(dir, 'orca');
  return exists(APP) ? APP : null;
}

// 现在能不能用：装了还得开着（orca status 报 ok）
export async function launcherFor(run, bin) {
  if (!bin) return null;
  const r = await run(bin, ['status', '--json'], { timeout: 10_000 });
  try { return r.code === 0 && JSON.parse(r.out).ok === true ? bin : null; } catch { return null; }
}
