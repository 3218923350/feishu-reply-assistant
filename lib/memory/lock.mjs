// 仓库级写锁：回复助手、每日任务、手动 mem 同时写时排队，避免互相覆盖
import fs from 'node:fs';
import path from 'node:path';

const STALE_MS = 120_000; // 持锁进程崩了，2 分钟后视为失效

export async function withLock(root, fn, { timeoutMs = 15_000 } = {}) {
  const dir = path.join(root, '.mem.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(dir).mtimeMs > STALE_MS) { fs.rmSync(dir, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error(`记忆库正被别的进程写入（${dir}），稍后再试`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try { return await fn(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
