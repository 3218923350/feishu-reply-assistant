// 草稿群里我的话 → 要做什么。代码只认整句「发」「不」两个快捷词，其余原话交给起草时那个 Claude 会话去理解和办

const SEND = /^(发|发送|发吧|ok|好|👍)$/i;
const DISMISS = /^(不|不发|不用|跳过|忽略|算了)$/;

export function route(item, text) {
  const raw = String(text || '').replace(/@\S+/g, '').trim(); // 「@codex 发」也算「发」
  const t = raw.replace(/\s+/g, '');
  // 只有现成的回复草稿才直接发；待执行卡上的草稿是「做完后」的话，交给 Claude 结合上下文判断
  if (SEND.test(t) && item.kind !== 'action' && item.draft?.trim()) return { do: 'send' };
  if (DISMISS.test(t)) return { do: 'dismiss' };
  return { do: 'work', text: raw };
}

// 在卡片的话题里回复：飞书不带 reply_to，按话题归到这张卡
// since：只认这轮拉取窗口里的话（create_time 是北京时间、精确到分，所以宽一分钟）；不然 seen 过期后话题里的老吩咐会被当成新的再办一遍
export const threadReplies = (msgs, cardId, me, since = 0) =>
  msgs.filter((m) => m.message_id !== cardId && m.sender?.id === me && (!since || Date.parse(`${m.create_time.replace(' ', 'T')}:00+08:00`) + 60_000 > since))
    .map((m) => ({ ...m, reply_to: cardId }));

// lark-cli 批量接口一次最多 50 个 id
export const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export function claim(item, status) {
  if (item.status !== 'pending') return false;
  item.status = status;
  return true;
}

export const isVerified = (r) => r?.ok === true && typeof r.verification === 'string' && r.verification.trim().length >= 8;

// 办事提示词里称呼我用 owner.name（启动时设成配置里的名字；测试里保持占位符）。在拼模板时就填好，别事后整段替换：对方消息里写的 {{...}} 不该被展开
export const owner = { name: '{{name}}' };

// 办事：我的原话交给起草会话。发消息只能用 fr（授权、收件人范围、去重由 fr 把关）
export function workPrompt(text, reportFile, intro = `${owner.name}刚在草稿卡片下说：「${text}」`, recent = [], commitments = []) {
  return `${intro}

现在进入办事阶段：理解他的意思，然后去办（可以做写操作、跑命令、查线上）。起草时「先别对外发」的约定到此为止，现在可以发。

- 以${owner.name}身份发飞书消息只能用 fr（不要直接用 lark-cli 发）：
  fr send --to <orig|人名|ou_xxx|oc_xxx> --text "<正文>" --why "<他这句话里授权这次发送的原文片段>" [--file 绝对路径]
  orig = 回原消息（在话题里就回在话题里）。只能发给原会话 / 原发送人，或他这句话里点了名的人或群；--why 必须照抄他原话里的片段。
  他只是让你改稿、没说要发，就别发，把新稿写进报告的 draft。fr 退出码 2 = 不在授权范围或参数不对（别绕，先问他）；3 = 外部会话，网页版飞书也没发成（已放剪贴板；外部会话 fr 会自动走网页版，成功就是 0）；4 = 结果未知（别重发）。
- 要等别人回复再接着做：fr wait --for <人名> --then "<他回了之后具体做什么>" [--why "<${owner.name}原话里要求跟进的片段>"] [--until 2d]。${owner.name}这句话里要求了跟进（比如「等他改好了 我们复测没问题再回复一遍」）才带 --why，被叫醒后可以在他原话范围内接着办和发；他没要求、是你觉得该等，就不带 --why，被叫醒后只能查，回复会出卡等他确认。整件事办完用 fr done。
${recent.length ? `- 最近 24 小时已经以${owner.name}身份发出的消息（别的会话发的也在内）：同一件事别重复发，要补充就说明是补充：\n${recent.map((r) => `  - ${r}`).join('\n')}\n` : ''}- 本机的 key 都可以用来办事（环境变量、配置文件、记忆里的，以及别人在飞书里发给${owner.name}的都行，比如拿环境变量里的 key 复测），尽量用变量引用，别把明文打到输出里。但 key / 密码 / token 不准外传给别人：飞书消息、附件、文档、发到第三方都算，除非${owner.name}这句话里明确让发——那就 fr send 加 --secret-ok "<他原话里让发的片段>"；他没明说，就把要发的内容写进报告 draft，他看了会回「发」。
${commitments.length ? `- 之前以${owner.name}身份答应过、还没做的（做完、验证过、也告诉了对方，就把 id 写进报告的 kept）：\n${commitments.map((c) => `  - [${c.id}] ${c.what}（对${c.toName}）`).join('\n')}\n` : ''}- 发出去的内容要像${owner.name}本人：中文、口语、2–5 句、不用 markdown、群里不要重复 @ 对方、不确定的不要编。
- 涉及钱 / 价格 / 排期 / 对外承诺、收件人不确定、他的话有两种读法：先别做，在报告的 ask 里问他。
- 有「测试 / 复测通过后再改线上」这类步骤（改 uat / prod 配置、切流量、下线旧服务）：只做到测试结论，线上改动写进 ask 让他定。
- 说「做完了」就要有验证（实际跑过的命令和关键输出），写进 verification。
- 最后用 Write 把报告写到 ${reportFile}，只有一个 JSON 对象（全部中文，写给${owner.name}看：他要能看懂你依据什么、做了什么；不要重复已经用 fr 发出去的正文，程序会单独列）：
  {"state": "decide|done|partial|blocked（只查清、等他定 = decide；全做完 = done；做了一部分 = partial；卡住了 = blocked）", "did": "按顺序写这一轮查了哪些信息（看了哪些消息 / 文件 / 记忆 / 日志、跑了哪些命令）、看到了什么（关键结果和数字）、做了什么改动、结论，没查清的也写；不凑字也别省，800 字以内", "verification": "验证命令和关键输出，没有就空", "waiting": "在等什么（没有就空）", "ask": "要他定的事，一两句说清背景（没有就空）", "options": [{"id": "短英文 id", "label": "一件要他批的独立操作，写清对象和环境", "cost": "代价 / 费用影响，没有就空", "group": "互斥方案填同一个组名，独立的事留空"}], "draft": "还没发、要他确认的拟回复（没有就空）", "draft_after": "有 options 时：他批了、你做完验证过才发的话（没有就空）", "kept": ["这一轮兑现了的承诺 id"], "dropped": ["${owner.name}说不做了、你已经给对方发了更正的承诺 id"]}
- draft 只说已经查实、已经做完的事：要他批的操作写成 options，做完才能说的话写进 draft_after；不要在 draft 里答应还没批准的事（比如「我现在把 X 摘掉，弄完告诉你」），程序会拦。
- 写完这个文件这一轮就结束，不用等他。`;
}

// 外部群：飞书不允许应用以我身份发（230027），只能我手动发
// 办事会话（Claude Code 的 jsonl）在 since 之后最后一条是接口报错：Claude Code 自己重试完才写这条，这一轮就停了，不会再自己动。
// 断流、服务端错这类重开一轮就好；提示太长、安全拦截、登录失败重开也一样，不重开
export function apiError(jsonl, since) {
  let last = null;
  for (const l of jsonl.split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (['user', 'assistant'].includes(j.type) && Date.parse(j.timestamp) >= since) last = j;
  }
  if (!last?.isApiErrorMessage) return null;
  const text = (last.message?.content || []).map((c) => c.text || '').join('').trim();
  return { error: last.error, text, retry: !['invalid_request', 'authentication_failed'].includes(last.error) };
}

export const retryPrompt = (err, reportFile) => `上一轮办到一半接口报错断了（${err}）。接着把这件事办完：先看看已经做到哪一步、哪些已经用 fr 发过（发过的不要重发），没做完的接着做，最后照原来的要求把报告写到 ${reportFile}。`;

export const isExternalDenied = (e) => /230027/.test(String(e?.message || e));
export const manualNotice = (item) => `⚠️${item.orig.chat_type === 'p2p' ? `和${item.orig.sender_name}的私聊是外部会话` : `「${item.orig.chat_name}」是外部群`}，飞书不允许程序以你的身份发（230027）。草稿已复制到剪贴板：[打开原消息](${item.orig.link}) → 粘贴 → 发送`
  + (item.files?.length ? `；附件：${item.files.join('、')}` : '') + '。';

// 跟进被叫醒：授权看来源。我原话要求的跟进（auth=said）照办事规则来；你自己挂的（auth=none 或旧记录）只能查、出卡
export function wakePrompt(f, m, reportFile, recent = []) {
  const said = f.auth === 'said';
  const intro = `你之前在等 ${f.watch.name} 回复，现在他回了（${m.create_time}）：「${m.content}」
当时打算：${f.then}`;
  const related = `先判断他这条是不是在回你等的那件事。报告 JSON 里多写一个字段 "related": true/false；false 时我会继续帮你等着，这条照常处理。`;
  if (said) return `${intro}\n授权是${owner.name}当时那句话：「${f.authText}」，他要求的跟进是「${f.why}」（fr 按这句校验）。只在这句话的范围内办和发；超出范围的写进 ask。\n${related}\n\n${workPrompt(f.authText, reportFile, '', recent)}`;
  return `${intro}
这个跟进是你自己挂的，不是${owner.name}要求的，所以这一轮：
- 可以只读查证（查记忆、查日志、查账号状态、跑只读命令）；
- 不能做写操作（开白名单、调并发、充值、改配置都不行），要做的写进报告的 ask；
- 不能用 fr 发消息（这一轮没有发送授权，fr send 会被拒）；要回他的话写进报告的 draft，${owner.name}点发送才发。
${related}
- 最后用 Write 把报告写到 ${reportFile}，只有一个 JSON 对象（全部中文，写给${owner.name}看）：
  {"related": true, "did": "查了什么、看到什么、结论", "verification": "", "waiting": "", "ask": "要他定的事（比如要不要加白名单）", "draft": "拟回复他的话"}
- 写完这个文件这一轮就结束。${recent.length ? `\n- 最近 24 小时已经以${owner.name}身份发出的消息：\n${recent.map((r) => `  - ${r}`).join('\n')}` : ''}`;
}

// 卡上点「办勾选的 / 执行上面要做的，办完再回他」：授权原话 = 勾了的那几项（fr 按它校验）；没勾的写明不要做；办完发的话交给它发。
// 办完发的话空着：只办不发（授权里不带发送那句，fr send 会被拒），结果回到草稿群
export function approvePrompt(options, selected, draftAfter, recipient) {
  const yes = options.filter((o) => selected.includes(o.id)), no = options.filter((o) => !selected.includes(o.id));
  const send = !!String(draftAfter || '').trim();
  const authText = `同意：${yes.map((o) => o.label).join('；')}${send ? `；办完把做完再回的话发给${recipient}` : ''}`;
  const intro = `${owner.name}在卡片上点了「办，办完再回他」。
勾了（照这些做）：${yes.map((o) => `${o.label}${o.cost ? `（${o.cost}）` : ''}`).join('；')}
${no.length ? `没勾：${no.map((o) => o.label).join('；')}（这些不要做，留着等他定）\n` : ''}${send ? `做完再回的话：「${draftAfter}」
做法：照勾的做 → 实际验证（命令和关键输出写进 verification）→ 用 fr send 把做完再回的话发给${recipient}（--why 引用「办完把做完再回的话发给${recipient}」）。可以按实际结果改里面的事实，但不能加新的承诺；结果和这句话对不上（没做成、只做了一部分）就别发，写进 ask。`
    : `做完再回的话他留空了：这轮不要以他身份发任何消息。照勾的做 → 实际验证（命令和关键输出写进 verification）→ 把拟回复${recipient}的话写进报告的 draft，他看了再定。`}`;
  return { authText, intro };
}
