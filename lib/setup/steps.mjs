// setup 里几个容易出错的判断，单独拿出来好测
export const isOpenId = (s) => /^ou_[A-Za-z0-9]+$/.test(String(s || ''));

// 草稿群：没配 → 建；我在群里 → 留着；查到了但我不在 → 问；查失败（限流、授权过期）→ 报错，别静默再建一个群
export function draftGroupStep({ id, list, me }) {
  if (!id) return 'create';
  if (!list?.ok) return 'error';
  return (list.data?.users || []).some((x) => [x.member_id, x.open_id, x.id].includes(me)) ? 'keep' : 'ask';
}

// 配置里已经有 open_id 就不静默换掉（这台机器的 lark-cli 可能正登录着别的账号）；不一样就标出来让人选
export const ownerIdStep = (configured, loggedIn) => ({ id: configured || loggedIn, conflict: !!configured && configured !== loggedIn });
