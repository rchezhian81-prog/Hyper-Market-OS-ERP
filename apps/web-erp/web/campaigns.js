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

// U1 · G3: a button greyed for a role says why beside it (words, `title` and `aria-describedby`), never a mute grey.
const WHY_DISABLED = { role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' } };
function whyDisabled(btn, why) {
  if (!btn || btn.tagName !== 'BUTTON') return;
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : (WHY_DISABLED[why]?.[tongue] ?? why);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
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
      const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn sre-btn-quiet approve';
      const i = icon('circle-check'); if (i !== null) b.append(i);
      b.append(text('span', t('approve'))); b.disabled = !may.words;
      whyDisabled(b, may.words ? '' : 'role');
      b.addEventListener('click', () => { void approveWords(v); });
      li.append(b);
    }
    return li;
  }));
  options($('template'), approved().map((v) => v.templateId), (id) => { const v = approved().find((x) => x.templateId === id); return `${id} · ${v.channel}`; });
}

const CAP_NOT_READ = { en: 'Not read yet — the cap is read from head office when the audience is found.', ta: 'இன்னும் படிக்கப்படவில்லை — பார்வையாளர்கள் கண்டறியப்படும்போது வரம்பு தலைமை அலுவலகத்திலிருந்து படிக்கப்படும்.' };
function paintCap() {
  if (cap === undefined) { $('cap').dataset.state = 'not_read'; $('cap').textContent = `○ ${CAP_NOT_READ[lang]}`; return; } // a state line, never an empty panel
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
    const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn switch';
    const i = icon(j.on ? 'pause' : 'check'); if (i !== null) b.append(i);
    b.append(text('span', j.on ? t('switchOff') : t('switchOn'))); b.disabled = !may.send;
    whyDisabled(b, may.send ? '' : 'role');
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
  whyDisabled($('show-words'), may.templates ? '' : 'role');
  for (const id of ['draft', 'template-id', 'template-channel', 'template-body']) $(id).disabled = !may.words;
  whyDisabled($('draft'), may.words ? '' : 'role');
  for (const id of ['find-audience']) $(id).disabled = !may.audience;
  whyDisabled($('find-audience'), may.audience ? '' : 'role');
  for (const id of ['plan', 'send', 'run-journeys', 'value', 'campaign-id']) $(id).disabled = !may.send;
  for (const id of ['plan', 'send', 'run-journeys']) whyDisabled($(id), may.send ? '' : 'role');
  for (const id of ['show-status', 'status-id', 'show-journeys']) $(id).disabled = !may.read;
  for (const id of ['show-status', 'show-journeys']) whyDisabled($(id), may.read ? '' : 'role');
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
// OB-694: messages leave the shop only after the shared confirm sheet (the chrome's) says how many customers, which campaign,
// and in whose name — and the person confirms. Go back sends nothing. The plan's count is the figure; with no plan the sheet
// says so and head office decides.
const office = () => (window.sreOffice && typeof window.sreOffice.confirm === 'function' ? Promise.resolve(window.sreOffice) : new Promise((resolve) => document.addEventListener('sre:chrome', () => resolve(window.sreOffice), { once: true })));
const CONFIRM = {
  en: { title: '{n} customers will be messaged now, campaign {id}', titleNoPlan: 'Campaign {id} will be sent now to everyone its plan allows', detail: 'Every message goes out through the shop\'s SMS provider and counts against its cost; a sent message cannot be recalled. Customers who have not said yes are never messaged.', authority: 'In your name. The words were approved by a second person; head office refuses words nobody approved.', label: 'Send the campaign' },
  ta: { title: '{n} வாடிக்கையாளர்களுக்கு இப்போது செய்தி அனுப்பப்படும், பிரச்சாரம் {id}', titleNoPlan: 'பிரச்சாரம் {id} அதன் திட்டம் அனுமதிக்கும் அனைவருக்கும் இப்போது அனுப்பப்படும்', detail: 'ஒவ்வொரு செய்தியும் கடையின் எஸ்எம்எஸ் வழங்குநர் வழியாகச் சென்று அதன் செலவில் சேரும்; அனுப்பிய செய்தியைத் திரும்பப் பெற முடியாது. ஒப்புக்கொள்ளாத வாடிக்கையாளர்களுக்கு ஒருபோதும் அனுப்பப்படாது.', authority: 'உங்கள் பெயரில். வார்த்தைகளை இரண்டாவது நபர் அனுமதித்தார்; யாரும் அனுமதிக்காத வார்த்தைகளைத் தலைமை அலுவலகம் மறுக்கும்.', label: 'பிரச்சாரத்தை அனுப்பு' },
};
const fillIn = (text, values) => Object.entries(values).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(String(v)), text);
function sendSheet() {
  const values = { n: plan === null ? '' : String(plan.sendToCount), id: $('campaign-id').value.trim() || '—' };
  const key = plan === null ? 'titleNoPlan' : 'title';
  const pair = (k) => ({ en: fillIn(CONFIRM.en[k], values), ta: fillIn(CONFIRM.ta[k], values) });
  return { title: pair(key), detail: pair('detail'), authority: pair('authority'), confirmLabel: pair('label'), tone: 'primary' };
}
async function send() {
  if (!(await (await office()).confirm(sendSheet())).ok) return;
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
// ── Round 4d (M21-FR-02): what the campaign brought in — head office's worked-out figures, as the shared summary cards ──
let results = null;
const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
function paintResults() {
  for (const [id, k] of [['results-h', 'resultsH'], ['results-lead', 'resultsLead'], ['l-results-id', 'campaignK'], ['l-results-window', 'windowK'], ['l-results-control', 'controlK'], ['show-results-text', 'showResults']]) $(id).textContent = t(k);
  const o = window.sreOffice ?? null;
  if (o === null) return;
  if (results === null) { $('results-cards').replaceChildren(); return; }
  const r = results; const words = (k) => ({ en: api.words('en', k), ta: api.words('ta', k) });
  const cards = o.cards($('results-cards'), [
    { label: words('resSent'), value: r.sent, note: `${t('resNotSent')}: ${r.notSent.waiting + r.notSent.withheld + r.notSent.deadLettered + r.notSent.failedReported} (${t('resFailed')}: ${r.notSent.failedReported})` },
    { label: words('resConverted'), value: r.converted, note: `${t('resConversion')} ${pct(r.conversionBps)}` },
    { label: words('resRevenue'), value: api.rupees(r.attributedRevenueMinor) },
    { label: words('resMargin'), value: r.attributedMarginMinor === null ? null : api.rupees(r.attributedMarginMinor), note: r.attributedMarginMinor === null ? words('resMarginNotKnown') : undefined },
    { label: words('resControl'), value: r.controlConversionBps === 'no_control_group' ? null : pct(r.controlConversionBps), note: r.controlConversionBps === 'no_control_group' ? words('resNoControl') : `${r.upliftBps === 'not_meaningful' ? '' : (r.upliftBps / 100).toFixed(2)} ${t('resUplift')}`, tone: r.controlConversionBps === 'no_control_group' ? 'pending' : undefined },
  ]);
  cards.dataset.campaign = r.campaignId;
}
async function showResults() {
  $('results-say').className = 'status'; $('results-say').textContent = '';
  const out = await session.attribution($('results-id').value, $('results-window').value, $('results-control').value);
  if (out.result !== 'ok') { results = null; bad('results-say', out); paintResults(); return; }
  results = out.value; paintResults();
}
$('show-results').addEventListener('click', () => { void showResults(); });
document.addEventListener('sre:chrome', () => paintResults());
$('show-journeys').addEventListener('click', () => { void showJourneys(); });
$('run-journeys').addEventListener('click', () => { void runJourneys(); });
$('template').addEventListener('change', () => { audience = null; plan = null; paintAudience(); paintPlan(); });
$('segment').addEventListener('change', () => { audience = null; plan = null; paintAudience(); paintPlan(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintResults(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = `⚠ ${t('cannotRead')}`; }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
