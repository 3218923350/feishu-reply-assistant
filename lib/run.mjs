// 跑子进程：起不来、超时都返回失败结果（code=null；超时的 timedOut=true），不抛异常
import { spawn } from 'node:child_process';

export function run(cmd, args, { env = process.env, cwd, timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, timedOut = false, term, kill;
    const finish = (code) => { if (done) return; done = true; clearTimeout(term); clearTimeout(kill); resolve({ code, out, err, timedOut }); };
    let p;
    try { p = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { err = e.message; return finish(null); }
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { err += e.message; finish(null); });
    p.on('close', (code) => finish(code));
    term = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, timeout);
    kill = setTimeout(() => { p.kill('SIGKILL'); finish(null); }, timeout + 5000); // SIGTERM 不理就强杀
  });
}
