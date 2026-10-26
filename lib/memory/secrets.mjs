// 识别 key、token、密码、私钥：fr 外发前用它拦（记忆库允许放 key，不再写盘脱敏）。公司专有的 key 前缀由配置给（secret_prefixes）
const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk[-_][A-Za-z0-9_-]{12,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
  /"(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)"\s*:\s*"[^"]*"/gi, // JSON
  /\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)\s*=\s*\S+/g, // 环境变量
  /[?&](?:access_token|token|api_?key|key|secret|signature|sig)=[^&\s]+/gi, // URL 参数
  /(?:password|passwd|密码|口令)\s*[:：=]\s*\S+/gi,
  /AKIA[0-9A-Z]{16}/g,
  /\b(?:AKLT|LTAI)[A-Za-z0-9]{12,}/g, // 火山 / 阿里云 AK
  /(?:access[ _-]?key(?:[ _-]?(?:id|secret))?|secret[ _-]?(?:access[ _-]?)?key)\s*[:：=]\s*[A-Za-z0-9+/=_-]{12,}/gi, // 「Access Key ID:xxx」
  /sshpass\s+-p\s+\S+/g,
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redact(text, { prefixes = [] } = {}) {
  let hits = 0;
  const ps = prefixes.map((p) => String(p).replace(/[-_]+$/, '')).filter(Boolean); // 配置里写成 abc_ / abc- 也认
  const extra = ps.length ? [new RegExp(`\\b(?:${ps.map(esc).join('|')})[-_][A-Za-z0-9_-]{12,}`, 'g')] : [];
  for (const re of [...PATTERNS, ...extra]) text = text.replace(re, () => (hits++, '«已脱敏»'));
  return { text, hits };
}
