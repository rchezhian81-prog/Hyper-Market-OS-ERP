// Approval rules — the page over head office's money limits, escalation waits and price-check size (OB-290 · OB-291 ·
// OB-292 · M02-FR-02/03 · §28). The session (apps/web-erp/src/approval-rules-session.ts, in the bundle as
// window.approvalRules) asks head office; this page shows the three rules, lets a person ASK for a change with a reason,
// and APPLY a change the owner approved — each on an explicit click. A role with no figure reads "Not set". Every word
// has a Tamil twin; every state shows an icon AND words.

const $ = (id) => document.getElementById(id);
const api = window.approvalRules ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, propose: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let rules = null;

const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
for (const [id, name] of [['read', 'search'], ['limits-ask', 'send'], ['waits-ask', 'send'], ['price-ask', 'send']]) { const i = icon(name); if (i !== null) $(id).prepend(i, ' '); }

function say(id, out) { $(id).className = 'status err'; $(id).textContent = api.outcomeWords(lang, out); }
function good(id, words) { $(id).className = 'status good'; $(id).textContent = `✓ ${words}`; }
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

function meta(rule) {
  if (rule.source !== 'changed') return `${t('version')} 0 · ${t('decided')}`;
  const held = rule.heldAtLastKnownGood ? ` · ⚠ ${t('held')} ${rule.heldAtLastKnownGood.why}` : '';
  return `${t('version')} ${rule.version} · ${t('changedBy')} ${rule.changedBy} · ${rule.changedAt ?? ''}${held}`;
}

function roleIds() {
  const shown = [...(api?.rolesShown ?? [])];
  for (const r of Object.keys(rules.limits.value.byRole)) if (!shown.includes(r)) shown.push(r);
  return shown;
}

function paintLimits() {
  $('limits-head').replaceChildren(text('th', t('role')), ...api.kinds.map((k) => text('th', t(`k_${k}`))));
  $('limits-body').replaceChildren(...roleIds().map((roleId) => {
    const tr = document.createElement('tr');
    tr.dataset.role = roleId;
    tr.append(text('th', t(`r_${roleId}`) === `r_${roleId}` ? roleId : t(`r_${roleId}`)));
    for (const k of api.kinds) {
      const td = document.createElement('td');
      const v = rules.limits.value.byRole[roleId]?.[k];
      const now = text('span', `${v === undefined ? '○' : v === null ? '∞' : '✓'} ${api.limitWords(lang, v)}`, 'now');
      now.dataset.kind = k;
      if (roleId === 'owner') { td.append(now); tr.append(td); continue; }
      const input = document.createElement('input');
      input.inputMode = 'decimal'; input.autocomplete = 'off';
      input.id = `limit-${roleId}-${k}`; input.dataset.role = roleId; input.dataset.kind = k;
      input.setAttribute('aria-label', `${roleId} ${t(`k_${k}`)}`);
      input.value = v === undefined || v === null ? '' : String(v / 100);
      input.disabled = !may.propose;
      td.append(input, now);
      tr.append(td);
    }
    return tr;
  }));
}

function paintWaits() {
  $('waits-form').replaceChildren(...api.kinds.map((k) => {
    const label = document.createElement('label');
    label.htmlFor = `wait-${k}`;
    const input = document.createElement('input');
    input.id = `wait-${k}`; input.inputMode = 'numeric'; input.autocomplete = 'off';
    input.value = String(rules.waits.value[k]); input.disabled = !may.propose;
    const now = text('span', `⏱ ${api.waitWords(lang, rules.waits.value[k])}`, 'now');
    now.dataset.kind = k;
    label.append(text('span', `${t(`k_${k}`)} (${t('minutes')})`), input, now);
    return label;
  }));
}

function paintAsked() {
  $('asked').replaceChildren(...rules.asked.map((c) => {
    const tone = c.status === 'approved' ? 'ok' : c.status === 'waiting' ? 'degraded' : c.status === 'used' ? 'ok' : 'error';
    const mark = { waiting: '⏳', approved: '✓', rejected: '✗', expired: '⌛', used: '✓' }[c.status] ?? '•';
    const li = document.createElement('li');
    li.className = `row tone-${tone}`;
    li.dataset.request = c.requestId; li.dataset.rule = c.rule; li.dataset.status = c.status;
    li.append(text('strong', `${mark} ${t(c.rule === 'limits' ? 'limitsH' : c.rule === 'escalation-waits' ? 'waitsH' : 'priceH')} — ${t(`st_${c.status}`)}`));
    li.append(text('span', `“${c.details.reason}”`, 'meta'));
    if (c.decidedBy) li.append(text('span', `${t(c.status === 'rejected' ? 'rejectedByK' : 'approvedByK')}: ${c.decidedBy}${c.decisionReason ? ` — “${c.decisionReason}”` : ''}`, 'meta'));
    if (c.status === 'approved' && may.propose) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'apply';
      const i = icon('badge-check'); if (i !== null) b.append(i, ' ');
      b.append(text('span', t('apply')));
      b.addEventListener('click', () => { void apply(c); });
      li.append(b);
    }
    return li;
  }));
  $('asked-section').hidden = rules.asked.length === 0;
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['read-text', rules === null ? 'read' : 'refresh'], ['limits-h', 'limitsH'], ['limits-lead', 'limitsLead'], ['waits-h', 'waitsH'], ['waits-lead', 'waitsLead'], ['price-h', 'priceH'], ['price-lead', 'priceLead'], ['price-percent-l', 'percentL'], ['price-amount-l', 'amountL'], ['limits-reason-l', 'reasonL'], ['waits-reason-l', 'reasonL'], ['price-reason-l', 'reasonL'], ['limits-ask-text', 'ask'], ['waits-ask-text', 'ask'], ['price-ask-text', 'ask'], ['asked-h', 'askedH']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.approvalRulesData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('read').disabled = !may.read;
  for (const b of document.querySelectorAll('[data-propose]')) b.hidden = !may.propose;
  const shown = rules !== null;
  for (const id of ['limits-section', 'waits-section', 'price-section']) $(id).hidden = !shown;
  if (!shown) { $('asked-section').hidden = true; return; }
  $('limits-meta').textContent = meta(rules.limits);
  $('waits-meta').textContent = meta(rules.waits);
  $('price-meta').textContent = `${meta(rules.priceCheck)} · ${(rules.priceCheck.value.percentBps / 100).toFixed(2)}% · ${api.limitWords(lang, rules.priceCheck.value.amountMinor)}`;
  paintLimits();
  paintWaits();
  if ($('price-percent').dataset.painted !== String(rules.priceCheck.version)) {
    $('price-percent').value = String(rules.priceCheck.value.percentBps / 100);
    $('price-amount').value = String(rules.priceCheck.value.amountMinor / 100);
    $('price-percent').dataset.painted = String(rules.priceCheck.version);
  }
  $('price-percent').disabled = !may.propose; $('price-amount').disabled = !may.propose;
  paintAsked();
}

async function show() {
  const out = await session.read();
  if (out.result === 'ok') { rules = out.value; $('page-status').className = 'status'; $('page-status').textContent = may.propose ? '' : t('cannotPropose'); } else { say('page-status', out); }
  paint();
}

async function ask(rule, statusId, value, reasonId) {
  if (value === 'invalid') return;
  const current = rule === 'limits' ? rules.limits : rule === 'escalation-waits' ? rules.waits : rules.priceCheck;
  const out = await session.ask(rule, value, $(reasonId).value, current);
  if (out.result !== 'ok') { say(statusId, out); return; }
  $(reasonId).value = '';
  await show();
  good(statusId, t('asked'));
}

function limitsValue() {
  const typed = {};
  for (const input of document.querySelectorAll('#limits-body input')) { (typed[input.dataset.role] ??= {})[input.dataset.kind] = input.value; }
  const v = api.limitsFromForm(rules.limits.value, typed);
  if (v === 'invalid') { $('limits-status').className = 'status err'; $('limits-status').textContent = t('notMoney'); }
  return v;
}
function waitsValue() {
  const out = {};
  for (const k of api.kinds) {
    const n = Number($(`wait-${k}`).value.trim());
    if (!Number.isInteger(n) || n < 1) { $('waits-status').className = 'status err'; $('waits-status').textContent = t('notMinutes'); return 'invalid'; }
    out[k] = n;
  }
  return out;
}
function priceValue() {
  const pct = Number($('price-percent').value.trim());
  const amount = api.paiseFromRupees($('price-amount').value);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) { $('price-status').className = 'status err'; $('price-status').textContent = t('notPercent'); return 'invalid'; }
  if (amount === 'invalid' || amount === undefined || amount < 1) { $('price-status').className = 'status err'; $('price-status').textContent = t('notMoney'); return 'invalid'; }
  return { percentBps: Math.round(pct * 100), amountMinor: amount };
}

async function apply(change) {
  const out = await session.apply(change);
  if (out.result !== 'ok') { say('asked-status', out); return; }
  await show();
  good('asked-status', t('applied'));
}

$('read').addEventListener('click', () => { void show(); });
$('limits-ask').addEventListener('click', () => { void ask('limits', 'limits-status', limitsValue(), 'limits-reason'); });
$('waits-ask').addEventListener('click', () => { void ask('escalation-waits', 'waits-status', waitsValue(), 'waits-reason'); });
$('price-ask').addEventListener('click', () => { void ask('price-check', 'price-status', priceValue(), 'price-reason'); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
