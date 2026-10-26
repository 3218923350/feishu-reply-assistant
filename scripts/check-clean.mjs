#!/usr/bin/env -S node --no-warnings
// 发布前清理检查：会发布的文件里不能有个人 / 公司内部信息。黑名单放在仓库外（$FRA_HOME/clean-blocklist.txt，一行一个词，# 开头是注释），
// 放在仓库里的话，黑名单本身就把这些词带出去了。通用规则（真实 open_id / chat_id / app id、本机路径、图片和表格、key）写在这里。
// 用法：node scripts/check-clean.mjs        检查，有命中退出 1
//       node scripts/check-clean.mjs --list 只打印会发布的文件清单
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redact } from '../lib/memory/secrets.mjs';
import { fraHome, loadConfig } from '../lib/config.mjs';

const RULES = [/ou_[0-9a-f]{32}/, /oc_[0-9a-f]{32}/, /cli_[0-9a-f]{16}/, /\/Users\/[A-Za-z0-9._-]+\//];
const BINARY = /\.(png|jpe?g|gif|pdf|xlsx?|csv)$/i;

// files: [{ path, text }] → 命中 [{ file, line, term }]
export function scanFiles(files, { blocklist = [], prefixes = [] } = {}) {
  const hits = [];
  const words = blocklist.map((w) => w.toLowerCase());
  for (const f of files) {
    if (BINARY.test(f.path)) { hits.push({ file: f.path, line: 0, term: '图片 / 表格文件' }); continue; }
    f.text.split('\n').forEach((l, i) => {
      const low = l.toLowerCase();
      const term = words.find((w) => low.includes(w)) || RULES.map((re) => l.match(re)?.[0]).find(Boolean)
        || (!f.path.startsWith('test/') && redact(l, { prefixes }).hits ? '疑似 key' : null); // 测试里故意放了假 key
      if (term) hits.push({ file: f.path, line: i + 1, term });
    });
  }
  return hits;
}

// 会发布的文件：跟踪的 + 没被忽略的新文件，再去掉 .gitignore 里的（被跟踪的 docs/design/ 也去掉）
export function publishable(dir) {
  const git = (args, input) => spawnSync('git', ['-C', dir, ...args], { input, encoding: 'utf8' });
  const all = git(['ls-files', '-co', '--exclude-standard']).stdout.split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(dir, f)));
  const ignored = new Set(git(['check-ignore', '--no-index', '--stdin'], all.join('\n')).stdout.split('\n').filter(Boolean));
  return all.filter((f) => !ignored.has(f));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = publishable(repo);
  if (process.argv.includes('--list')) { console.log(files.join('\n')); process.exit(0); }
  const listFile = path.join(fraHome(), 'clean-blocklist.txt');
  let blocklist = [];
  try { blocklist = fs.readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')); }
  catch { console.log(`没有黑名单（${listFile}），只查通用规则`); }
  let prefixes = [];
  try { prefixes = loadConfig().secretPrefixes; } catch {}
  const hits = scanFiles(files.map((f) => ({ path: f, text: BINARY.test(f) ? '' : fs.readFileSync(path.join(repo, f), 'utf8') })), { blocklist, prefixes });
  for (const h of hits) console.log(`${h.file}:${h.line}: ${h.term}`);
  if (hits.length) { console.log(`\n${hits.length} 处命中，改掉再发布`); process.exit(1); }
  console.log(`干净：${files.length} 个文件`);
}
