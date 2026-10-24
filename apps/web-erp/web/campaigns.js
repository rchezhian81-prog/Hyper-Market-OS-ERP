// Campaigns — plan, approve, send and follow a campaign, and the customer journeys (M21-FR-01 · M21-FR-02).
// The session (apps/web-erp/src/campaigns-session.ts, in the bundle as window.campaigns) asks head office; this page shows
// its answers. Words are drafted by one person and approved by another; who matches but has not said yes is COUNTED, never
// hidden; nothing is sent until a person clicks Send. Every state is an icon AND words; every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.campaigns ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, send: false, words: false, templates: false, audience: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let templates = null;
let cap = undefined;
let audience = null;
let plan = null;
let status = null;
let journeys = null;

const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
for (const [id, name] of [['show-words', 'book-open'], ['draft', 'file-text'], ['find-audience', 'users'], ['plan', 'shield-check'], ['send', 'send'], ['show-status', 'activity'], ['show-journeys', 'repeat'], ['run-journeys', 'refresh-cw']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }

function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function bad(where, out) { $(where).className = 'status err'; $(where).textContent = `⚠ ${api.outcomeWords(lang, out)}`; }
function good(where, words) { $(where).className = 'status good'; $(where).textContent = `✓ ${words}`; }
const approved = () => (templates === null ? [] : api.approved(templates));
const chosenTemplate = () => approved().find((v) => v.templateId === $('template').value);

function options(select, values, label) {
  const keep = select.value;
  select.replaceChildren(...values.map((v) => { const o = document.createElement('option'); o.value = v; o.textContent = label(v); return o; }));
  if (values.includes(keep)) select.value = keep;
}

function paintWords() {
  if (templates === null) { $('words').replaceChildren(); return; }
  $('words').replaceChildren(...templates.map((v) => {
    const li = document.createElement('li'); li.className = `row tone-${v.state === 'approved' ? 'ok' : 'degraded'}`; li.dataset.template = v.templateId; li.dataset.version = String(v.version); li.dataset.state = v.state;
    li.append(text('strong', `${v.state === 'approved' ? '✓' : v.state === 'withdrawn' ? '✕' : '⏱'} ${v.templateId} v${v.version} · ${v.channel} — ${t(v.state)}`));
    li.append(text('span', v.body, 'facts'));
    li.append(text('span', `${t('draftedBy')} ${v.draftedBy}${v.approvedBy ? ` · ${t('approvedBy')} ${v.approvedBy}` : ''}`, 'facts'));
    if (v.state === 'draft') {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet approve';
      const i = icon('circle-check'); if (i !== null) b.append(i);
      b.append(text('span', t('approve'))); b.disabled = !may.words;
      b.addEventListener('click', () => { void approveWords(v); });
      li.append(b);
    }
    return li;
  }));
  options($('template'), approved().map((v) => v.templateId), (id) => { const v = approved().find((x) => x.templateId === id); return `${id} · ${v.channel}`; });
}

function paintCap() {
  if (cap === undefined) { $('cap').textContent = ''; return; }
  $('cap').dataset.state = cap.policy === null ? 'not_set' : 'set';
  $('cap').textContent = cap.policy === null ? `⚠ ${t('capNotSet')}` : `✓ ${cap.detail}`;
}

function paintAudience() {
  if (audience === null) { $('audience').textContent = ''; return; }
  $('audience').textContent = `${audience.customerRefs.length} ${t('reach')} · ${audience.excludedForConsent} ${t('notContactable')}`;
}

function paintPlan() {
  if (plan === null) { $('plan-out').replaceChildren(); return; }
  const li = document.createElement('li'); li.className = `row tone-${plan.blocked ? 'degraded' : 'ok'}`; li.dataset.campaign = plan.campaignId;
  li.append(text('strong', `${plan.blocked ? '⚠' : '✓'} ${t('campaignK')} ${plan.campaignId}: ${plan.sendToCount} ${t('willSend')} · ${plan.excludedCount} ${t('excluded')}`, 'plan-count'));
  for (const [reason, n] of Object.entries(plan.excludedByReason ?? {})) li.append(text('span', `○ ${n} — ${t(`why_${reason}`)}`, `facts reason reason-${reason}`));
  if (plan.blocked) li.append(text('span', `${t('blocked')} ${plan.detail}`, 'facts'));
  $('plan-out').replaceChildren(li);
}

function paintStatus() {
  if (status === null) { $('status-out').replaceChildren(); return; }
  const x = status.totals;
  const li = document.createElement('li'); li.className = 'row'; li.dataset.campaign = status.campaignId;
  li.append(text('strong', `${t('campaignK')} ${status.campaignId}`));
  for (const [k, v, cls] of [['queuedK', x.queued, 'queued'], ['pendingK', x.pending, 'pending'], ['sentK', x.sent, 'sent'], ['withheldK', x.withheld, 'withheld'], ['deadK', x.deadLettered, 'dead']]) li.append(text('span', `${t(k)}: ${v}`, `facts total-${cls}`));
  $('status-out').replaceChildren(li);
}

function paintJourneys() {
  if (journeys === null) { $('journeys').replaceChildren(); return; }
  $('journeys').replaceChildren(...journeys.map((j) => {
    const li = document.createElement('li'); li.className = `row tone-${j.on ? 'ok' : 'degraded'}`; li.dataset.journey = j.kind; li.dataset.on = String(j.on);
    li.append(text('strong', `${j.on ? '●' : '○'} ${t(`j_${j.kind}`)} — ${j.on ? t('on') : t('off')}${j.on ? ` · ${j.templateId} · ${j.channel}` : ''}`));
    li.append(text('span', `${j.eligibleCount} ${t('eligibleK')}`, 'facts eligible'));
    const held = j.outcomes.filter((o) => o.outcome !== 'queued').length;
    li.append(text('span', `${t('queuedK')}: ${j.outcomes.length - held} · ${t('heldBack')}: ${held}`, 'facts outcomes'));
    for (const o of j.outcomes.slice(0, 5)) li.append(text('span', `${o.outcome === 'queued' ? '✓' : '○'} ${o.customerRef} — ${o.outcome === 'queued' ? t('queuedK') : `${t('heldBack')} (${t(`why_${o.code}`)})`}`, 'facts'));
    const form = document.createElement('div'); form.className = 'row-form';
    const label = document.createElement('label'); const reason = document.createElement('input'); reason.className = 'reason'; reason.autocomplete = 'off'; reason.maxLength = 300;
    label.append(text('span', t('reason')), reason);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet switch';
    const i = icon(j.on ? 'pause' : 'check'); if (i !== null) b.append(i);
    b.append(text('span', j.on ? t('switchOff') : t('switchOn'))); b.disabled = !may.send;
    b.addEventListener('click', () => { void switchJourney(j, !j.on, reason.value); });
    form.append(label, b); li.append(form);
    return li;
  }));
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['words-h', 'wordsH'], ['show-words-text', 'showWords'], ['l-template-id', 'templateId'], ['l-template-channel', 'channel'], ['l-template-body', 'words'], ['draft-text', 'draft'],
    ['cap-h', 'capH'], ['plan-h', 'planH'], ['l-campaign-id', 'campaignK'], ['l-segment', 'segment'], ['l-template', 'template'], ['l-promotion', 'promotion'], ['find-audience-text', 'findAudience'], ['plan-text', 'plan'], ['l-value', 'value'], ['send-text', 'send'],
    ['status-h', 'statusH'], ['l-status-id', 'campaignK'], ['show-status-text', 'showStatus'], ['journeys-h', 'journeysH'], ['show-journeys-text', 'showJourneys'], ['run-journeys-text', 'run']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.campaignsData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  options($('segment'), [...(api?.segments ?? [])], (s) => t(`seg_${s}`));
  options($('template-channel'), [...(api?.channels ?? [])], (c) => c);
  for (const id of ['show-words']) $(id).disabled = !may.templates;
  for (const id of ['draft', 'template-id', 'template-channel', 'template-body']) $(id).disabled = !may.words;
  for (const id of ['find-audience']) $(id).disabled = !may.audience;
  for (const id of ['plan', 'send', 'run-journeys', 'value', 'campaign-id']) $(id).disabled = !may.send;
  for (const id of ['show-status', 'status-id', 'show-journeys']) $(id).disabled = !may.read;
  paintWords(); paintCap(); paintAudience(); paintPlan(); paintStatus(); paintJourneys();
}

async function showWords() {
  const out = await session.templates();
  if (out.result !== 'ok') { templates = null; bad('words-status', out); paintWords(); return; }
  templates = out.value.templates; $('words-status').className = 'status'; $('words-status').textContent = '';
  paintWords();
  if (may.read) { const c = await session.frequencyCap(); if (c.result === 'ok') { cap = c.value; paintCap(); } }
}
async function draftWords() {
  const out = await session.draftWords($('template-id').value, $('template-channel').value, $('template-body').value);
  if (out.result !== 'ok') { bad('words-status', out); return; }
  await showWords();
  good('words-status', `${out.value.template.templateId} v${out.value.template.version} — ${t('draftSaved')}`);
}
async function approveWords(v) {
  const out = await session.approveWords(v.templateId, v.version);
  if (out.result !== 'ok') { bad('words-status', out); return; }
  await showWords();
  good('words-status', `${v.templateId} v${v.version} — ${t('approvedSaved')}`);
}
async function findAudience() {
  const tpl = chosenTemplate();
  const out = await session.audience($('segment').value, tpl?.channel ?? 'sms');
  if (out.result !== 'ok') { audience = null; bad('plan-status', out); paintAudience(); return; }
  audience = out.value; plan = null; $('plan-status').className = 'status'; $('plan-status').textContent = '';
  paintAudience(); paintPlan();
}
async function planIt() {
  if ($('campaign-id').value.trim() === '') $('campaign-id').value = session.newCampaignId();
  const out = await session.plan({ campaignId: $('campaign-id').value.trim(), template: chosenTemplate(), containsPromotion: $('promotion').checked, audience: audience?.customerRefs });
  if (out.result !== 'ok') { plan = null; bad('plan-status', out); paintPlan(); return; }
  plan = out.value; $('plan-status').className = 'status'; $('plan-status').textContent = '';
  paintPlan();
}
async function send() {
  const out = await session.send({ campaignId: $('campaign-id').value.trim(), template: chosenTemplate(), containsPromotion: $('promotion').checked, plan: plan ?? undefined, value: $('value').value });
  if (out.result !== 'ok') { bad('plan-status', out); return; }
  $('plan-status').dataset.queued = String(out.value.queued);
  good('plan-status', `${out.value.queued} ${t('queuedK')} · ${out.value.alreadyQueued} ${t('alreadyK')} · ${out.value.excludedCount} ${t('excluded')}`);
  $('status-id').value = out.value.campaignId;
  await showStatus();
}
async function showStatus() {
  const out = await session.status($('status-id').value);
  if (out.result !== 'ok') { status = null; bad('status-status', out); paintStatus(); return; }
  status = out.value; $('status-status').className = 'status'; $('status-status').textContent = '';
  paintStatus();
}
async function showJourneys() {
  const out = await session.journeys();
  if (out.result !== 'ok') { journeys = null; bad('journeys-status', out); paintJourneys(); return; }
  journeys = out.value.journeys; paintJourneys();
}
async function switchJourney(j, on, reason) {
  const out = await session.switchJourney(j.kind, on, chosenTemplate(), reason);
  if (out.result !== 'ok') { bad('journeys-status', out); return; }
  await showJourneys();
  good('journeys-status', `${t(`j_${j.kind}`)} — ${on ? t('on') : t('off')}`);
}
async function runJourneys() {
  const out = await session.runJourneys();
  if (out.result !== 'ok') { bad('journeys-status', out); return; }
  await showJourneys();
  good('journeys-status', `${t('ranSay')} ${out.value.queued} · ${t('heldBack')}: ${out.value.notQueued}`);
}

$('show-words').addEventListener('click', () => { void showWords(); });
$('draft').addEventListener('click', () => { void draftWords(); });
$('find-audience').addEventListener('click', () => { void findAudience(); });
$('plan').addEventListener('click', () => { void planIt(); });
$('send').addEventListener('click', () => { void send(); });
$('show-status').addEventListener('click', () => { void showStatus(); });
$('show-journeys').addEventListener('click', () => { void showJourneys(); });
$('run-journeys').addEventListener('click', () => { void runJourneys(); });
$('template').addEventListener('change', () => { audience = null; plan = null; paintAudience(); paintPlan(); });
$('segment').addEventListener('change', () => { audience = null; plan = null; paintAudience(); paintPlan(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = `⚠ ${t('cannotRead')}`; }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
