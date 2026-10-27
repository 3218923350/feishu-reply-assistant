// 草稿群的交互卡（Card 2.0）：原消息一块、拟发送是能直接改的输入框、按钮点了就办；查证过程收进折叠。用户写的内容一律 plain_text，不当标签解析
const pt = (content) => ({ tag: 'plain_text', content: String(content ?? '') });
const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const text = (s, extra = {}) => ({ tag: 'div', text: { ...pt(s), ...extra } });
const block = (bg, elements) => ({ tag: 'column_set', flex_mode: 'none', background_style: bg,
  columns: [{ tag: 'column', width: 'weighted', weight: 1, padding: '8px 12px 8px 12px', vertical_spacing: '4px', elements }] });
const tag = (content, color) => ({ tag: 'text_tag', text: pt(content), color });
const card = (header, elements, summary) => ({ schema: '2.0', config: { width_mode: 'default', summary: { content: cut(summary, 60) } }, header,
  body: { direction: 'vertical', padding: '12px 12px 16px 12px', vertical_spacing: '12px', elements } });
const head = (o) => `${o.sender_name}${o.chat_name ? ` · ${o.chat_name}` : ' · 私聊'}`;

// 原消息：时间灰字 + 正文 + 打开原消息
const quote = (o) => block('grey-50', [
  text(`${o.create_time || ''}  ${cut(o.content, 300)}`, { lines: 6 }),
  ...(o.link ? [{ tag: 'markdown', content: `[打开原消息](${o.link})`, text_size: 'notation' }] : []),
]);

const button = (name, label, type) => ({ tag: 'column', width: 'auto', elements: [{ tag: 'button', name, text: pt(label), type, form_action_type: 'submit' }] });
const row = (buttons) => ({ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', columns: buttons });
const draftInput = (name, label, value) => ({ tag: 'input', name, input_type: 'multiline_text', rows: 3, auto_resize: true, max_rows: 12, width: 'fill',
  label: pt(label), default_value: value });

// 要你定的事：独立的一项一个勾选框（默认不勾），同一 group 的互斥方案合成一个下拉；勾选只是选择，点按钮提交才算同意
function optionInputs(options) {
  const out = [], groups = new Map();
  for (const x of options) if (x.group) (groups.get(x.group) || groups.set(x.group, []).get(x.group)).push(x);
  for (const [g, xs] of groups) if (xs.length < 2) groups.delete(g); // 一个组只有一项就不是「选一个」，按独立的事画勾选框
  for (const x of options) {
    const label = `${x.label}${x.cost ? `（${x.cost}）` : ''}`;
    if (!groups.has(x.group)) out.push({ tag: 'checker', name: `opt_${x.id}`, checked: false, text: pt(label) });
    else if (groups.get(x.group)?.[0] === x) out.push({ tag: 'select_static', name: `grp_${x.group}`, width: 'fill', placeholder: pt('选一个方案'),
      options: groups.get(x.group).map((y) => ({ text: pt(`${y.label}${y.cost ? `（${y.cost}）` : ''}`), value: y.id })) });
  }
  return out;
}

// 表单：[要你定的选项] + 拟发送（可改）[+ 办完发的话] + 吩咐 + 说明 + 按钮行。按钮名就是动作：approve / send / send_anyway / work / skip
// 按钮文案只用两种动词：「发」= 以我的身份把上面那句发出去，不执行任何操作；「办」= 真的去执行，可能代我发消息
function form({ draft = null, draftAfter = null, options = [], rows, note = NOTE, warning = [], afterLabel = null }) {
  return { tag: 'form', name: 'act', vertical_spacing: '8px', elements: [
    ...optionInputs(options),
    ...(draft != null ? [draftInput('draft', afterLabel ? '现在先回的话（只说查实的事，可以直接改）' : '发给他的话（可以直接改）', draft)] : []),
    ...(afterLabel ? [draftInput('draft_after', afterLabel, draftAfter || '')] : []),
    { tag: 'input', name: 'note', width: 'fill', placeholder: pt(note) },
    ...(warning.length ? [warn(warning)] : []), // 挨着按钮放，点的时候就能看到
    // 卡上同时有「发」和「办」才写这行说明（只有一种的不用分）
    ...(rows.flat().some((b) => ['send', 'send_anyway'].includes(b.elements[0].name)) ? [text(HINT, { text_size: 'notation', text_color: 'grey' })] : []),
    ...rows.map(row),
  ] };
}
const NOTE = '要它另外做什么写在这里，再点「按吩咐办」';
const HINT = '「发」只以你的身份把上面那句发出去，不执行任何操作；「办」会真的去执行，可能代你发消息';
const AFTER = '办完发给他的话（办完、验证过才发；空着就不发，结果回到草稿群）';
// 发出去的话里答应了还没做的事：拦下，换成「照发，事我自己办」
const sendButton = (warned, main = false) => warned ? button('send_anyway', '照发，事我自己办', 'default') : button('send', '发出这句', main ? 'primary_filled' : 'default');
// 有要你批的选项（或「要动手」卡上写好的要做的事）：主按钮单独一行
const decideRows = (hasDraft, warned, approve) => [[button('approve', approve, 'primary_filled')],
  [...(hasDraft ? [sendButton(warned)] : []), button('work', '按吩咐办', 'default'), button('skip', '不回，收起', 'default')]];
const warn = (phrases) => block('red-50', [text(`⚠️ 这句里写了「${phrases.join('」「')}」：事还没做就发出去，对方会等着或以为已经好了。要它去做就点上面的「办」；你自己去办就点「照发，事我自己办」，我会记下来到点提醒你。`)]);

const panel = (title, lines) => ({ tag: 'collapsible_panel', expanded: false, header: { title: pt(title) }, vertical_spacing: '6px',
  elements: lines.filter(Boolean).map((l) => text(l, { text_size: 'notation', text_color: 'grey' })) });

const KIND = { answer: ['拟回复', 'blue'], action: ['要动手', 'orange'], decision: ['要你定', 'yellow'] };
export const TIER = { auto: '直接发', countdown: '倒计时后发', hold: '等你点' };
const memName = (p) => String(p).split('/').pop().replace(/\.md(#.*)?$/, '');

export function draftCard(o, res, shadow = null, { warning = [] } = {}) {
  const [label, color] = KIND[res.kind] || KIND.answer;
  const hasDraft = !!res.draft?.trim();
  const header = { title: pt(head(o)), subtitle: pt(cut(res.summary || o.content, 60)), template: color, text_tag_list: [tag(label, color)] };
  const els = [quote(o)];
  if (res.kind === 'decision' && !hasDraft) els.push(block('yellow-50', [text(`❓ ${res.summary}`)]));
  const todo = res.kind === 'action' && res.proposed_actions?.trim();
  if (todo) els.push(block('orange-50', [text(`🔧 要做：${res.proposed_actions}`)]));
  const options = res.options || [], warned = warning.length > 0;
  const main = res.kind === 'answer' && hasDraft && !warned;
  // 要动手的卡：draft 按约定是「做完后才回的话」，主按钮直接执行上面写的要做的事，办完再发它
  const rows = options.length ? decideRows(hasDraft, warned, '办勾选的，办完再回他')
    : todo ? [[button('approve', '执行上面要做的，办完再回他', 'primary_filled')], [button('work', '按吩咐办', 'default'), button('skip', '不回，收起', 'default')]]
    : [[...(hasDraft ? [sendButton(warned, main)] : []), button('work', '按吩咐办', hasDraft ? 'default' : 'primary_filled'), button('skip', '不回，收起', 'default')]];
  els.push(todo && !options.length
    ? form({ draft: null, draftAfter: hasDraft ? res.draft : '', rows, warning, afterLabel: AFTER })
    : form({ draft: hasDraft ? res.draft : null, draftAfter: res.draft_after, options, rows, warning, afterLabel: options.length ? AFTER : null,
      note: hasDraft ? NOTE : '写你的决定或要它做什么，再点「按吩咐办」' }));
  els.push(panel('查证与依据', [
    shadow && `试运行（还没开）：以后完全放手的话，这条会${TIER[shadow.tier]}${shadow.reasons?.length ? `（${shadow.reasons.join('；')}）` : ''}`,
    res.evidence && `查了什么：${res.evidence}`,
    res.used_memories?.length && `用到的记忆：${res.used_memories.map(memName).join('、')}`,
    res.files?.length && `附件：${res.files.join('、')}`,
  ]));
  return card(header, els, `${head(o)}：${res.summary || ''}`);
}

// 报告卡标题按状态写，不再一律「办完了」（只查清、等你定的不能叫办完）
const STATE = { decide: ['查清了，待你定', 'yellow'], done: ['办完了', 'green'], partial: ['部分完成', 'orange'], blocked: ['受阻', 'red'] };
const reportState = (rep) => (STATE[rep.state] ? rep.state : rep.ask?.trim() || rep.options?.length ? 'decide' : 'done');

export function reportCard(o, rep, receipts, session, { warning = [], pending = [], log = null } = {}) {
  const sent = receipts.filter((r) => r.kind === 'fr-sent'), bad = receipts.filter((r) => r.kind !== 'fr-sent');
  const [title, color] = STATE[reportState(rep)];
  const header = { title: pt(`${title} · ${head(o)}`), subtitle: pt(cut(rep.did || rep.ask || '', 60)), template: color,
    text_tag_list: [...(sent.length ? [tag(`已发 ${sent.length}`, 'green')] : []), ...(rep.waiting?.trim() ? [tag('在等', 'neutral')] : [])] };
  const els = [];
  if (sent.length) els.push(block('green-50', sent.map((r) => text(`📤 已发给${r.toName}${r.via === 'web' ? '（网页版飞书）' : ''}：${r.text}`))));
  if (bad.length) els.push(block('red-50', bad.map((r) => text(r.kind === 'fr-manual' ? `⚠️ 没发出（外部会话，已放剪贴板）→ ${r.toName}：${r.text}`
    : `⚠️ 发给${r.toName}结果未知（超时），去会话里看一眼：${r.text}`))));
  if (rep.ask?.trim()) els.push(block('yellow-50', [text(`❓ ${rep.ask}`)]));
  if (rep.waiting?.trim()) els.push(text(`⏳ ${rep.waiting}`, { text_color: 'grey' }));
  if (pending.length) els.push(block('orange-50', pending.map((p) => text(`⏳ 答应了还没做：${p}`))));
  const hasDraft = !!rep.draft?.trim(), options = rep.options || [], warned = warning.length > 0;
  const rows = options.length ? decideRows(hasDraft, warned, '办勾选的，办完再回他') : [[
    ...(hasDraft ? [sendButton(warned, true)] : []),
    button('work', hasDraft ? '按吩咐办' : '接着办', hasDraft ? 'default' : 'primary_filled'),
    ...(hasDraft ? [button('skip', '不回，收起', 'default')] : []),
  ]];
  els.push(form({ draft: hasDraft ? rep.draft : null, draftAfter: rep.draft_after, options, rows, warning, afterLabel: options.length ? AFTER : null,
    note: hasDraft || options.length ? NOTE : '还要做什么？写了再点「接着办」' }));
  els.push(panel('做了什么', [
    rep.did && `🔧 ${rep.did}`, rep.verification && `🧪 验证：${rep.verification}`,
    session && `🖥 完整过程：会话 ${session}（终端办完就关了；接着说话会接着这个会话办）`,
    log && `📄 过程日志：${log}`,
  ]));
  return card(header, els, `${title} · ${head(o)}`);
}

// 点完 / 有了结果：收起按钮，只留结果
const OUTCOME = { 已发送: 'green', 已跳过: 'grey', 在办: 'blue', 已在原会话回: 'grey', 有新版本: 'grey', 已手动发: 'orange' };
export function closedCard(o, outcome, detail = '', { pending = [] } = {}) {
  const color = OUTCOME[outcome] || 'grey';
  const header = { title: pt(head(o)), subtitle: pt(cut(o.content, 60)), template: color, text_tag_list: [tag(outcome, color === 'grey' ? 'neutral' : color)] };
  return card(header, [quote(o), ...(detail ? [block(`${color === 'grey' ? 'grey' : color}-50`, [text(detail)])] : []),
    // 话发出去了、答应的事还没做：一直挂着，点「去办答应的事」交给原会话
    ...(pending.length ? [block('orange-50', pending.map((p) => text(`⏳ 答应了还没做：${p}`))),
      { tag: 'button', name: 'keep', text: pt('去办答应的事'), type: 'primary_filled', behaviors: [{ type: 'callback', value: { action: 'keep' } }] }] : []),
  ], `${head(o)}：${outcome}`);
}

// 按钮回调 → 要做什么。只认我点的（我在机器人应用下的 open_id）
const ACTIONS = new Set(['send', 'send_anyway', 'approve', 'work', 'skip', 'keep']);
export function parseClick(ev, me) {
  if (ev.operator_id !== me || ev.action_tag !== 'button' || !ACTIONS.has(ev.action_name)) return null;
  let f = {};
  try { f = JSON.parse(ev.form_value || '{}'); } catch {}
  const selected = [...Object.entries(f).filter(([k, v]) => k.startsWith('opt_') && v === true).map(([k]) => k.slice(4)),
    ...Object.entries(f).filter(([k, v]) => k.startsWith('grp_') && v).map(([, v]) => String(v))];
  return { card: ev.message_id, action: ev.action_name, draft: String(f.draft ?? ''), draft_after: String(f.draft_after ?? ''), note: String(f.note ?? '').trim(),
    selected, id: ev.event_id, form: f };
}

// 按钮回调长连接断了怎么记日志、多久重连：连上（ready）就复位；同样的报错（数字不算）只记一次；
// 重连从 30 秒起每次翻倍，最多 10 分钟。退出那行只在这一轮有新报错时记，免得没订阅回调时一直刷
export function clickWatch({ base = 30_000, max = 600_000 } = {}) {
  let delay = base, last = '', fresh = false;
  return {
    stderr(chunk) { // 返回要记的一行（压成一行：doctor 按行找 ready），不用记就是 null
      const t = String(chunk).trim().replace(/\s+/g, ' ').slice(0, 300);
      if (!/ready|error|exited|"ok": *false/.test(t)) return null;
      if (/\bready\b/.test(t)) { delay = base; last = ''; return t; }
      const key = t.replace(/\d+/g, '#');
      if (key === last) return null;
      last = key; fresh = true;
      return t;
    },
    exit(code) { // { delay: 多久后重连, line: 要记的一行或 null }
      const d = delay, line = fresh || !last ? `监听退出 code=${code}，${d / 1000} 秒后重连` : null;
      delay = Math.min(delay * 2, max); fresh = false;
      return { delay: d, line };
    },
  };
}
