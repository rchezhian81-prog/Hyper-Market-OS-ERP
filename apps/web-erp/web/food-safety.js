// Food-safety checks — the page over head office's D-6 register (OB-154). It holds no rule: the session
// (apps/web-erp/src/store-ops-session.ts, in the bundle as window.storeOps) reads today's checks and records one in the
// signed-in person's session, refuses only blank or malformed input before a POST, and hands every refusal back in head
// office's words. Nothing is written on open; after each record the board is read again. Every word has a Tamil twin.

// OB-607: a time of day is the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopTimeOf = (value) => window.sreShopDay?.timeOf(value) ?? '';
const $ = (id) => document.getElementById(id);
const api = window.storeOps ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, readChecks: false, recordChecks: false };

let lang = 'en';
const t = (k, slots) => (api === null ? k : api.words(lang, k, slots));
const when = (iso) => (typeof iso === 'string' ? shopTimeOf(iso) : '');
let board = null;

function say(el, out, good) {
  el.className = `status ${out.result === 'ok' ? 'good' : 'err'}`;
  el.textContent = out.result === 'ok' ? good : api.outcomeWords(lang, out);
}

function field(labelText, control) {
  const label = document.createElement('label');
  const span = document.createElement('span'); span.textContent = labelText;
  label.append(span, control);
  return label;
}

/** The record form for one check: the reading, each item pass/fail, and the corrective action. */
function recordForm(check, slotDueAt) {
  const form = document.createElement('form');
  form.className = 'record';
  const parts = [];
  let delivery = null;
  if (check.kind === 'receiving') {
    delivery = document.createElement('input'); delivery.className = 'delivery'; delivery.autocomplete = 'off';
    parts.push(field(t('fsDelivery'), delivery));
  }
  const reading = document.createElement('input'); reading.className = 'reading'; reading.inputMode = 'decimal'; reading.autocomplete = 'off';
  if (check.kind === 'temperature' || check.minTenthsC !== undefined) parts.push(field(t('fsReading'), reading));
  const results = {};
  for (const item of check.items) {
    const select = document.createElement('select'); select.className = 'item'; select.dataset.item = item.itemId;
    for (const [v, k] of [['', null], ['pass', 'fsPass'], ['fail', 'fsFail']]) { const o = document.createElement('option'); o.value = v; o.textContent = k === null ? '—' : t(k); select.append(o); }
    results[item.itemId] = select;
    parts.push(field(item.label, select));
  }
  const action = document.createElement('textarea'); action.className = 'action';
  parts.push(field(t('fsAction'), action));
  const button = document.createElement('button'); button.type = 'submit'; button.className = 'save'; button.textContent = t('fsSave');
  const status = document.createElement('p'); status.className = 'status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  form.append(...parts, button, status);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    const itemResults = {};
    for (const [id, select] of Object.entries(results)) itemResults[id] = select.value;
    const out = await session.recordCheck(check, {
      checkId: check.checkId, ...(slotDueAt === undefined ? {} : { slotDueAt }), ...(delivery === null ? {} : { subjectRef: delivery.value }),
      readingC: reading.value, itemResults, correctiveAction: action.value,
    });
    button.disabled = false;
    say(status, out, t('fsSaved'));
    if (out.result === 'ok') { say($('page-status'), out, t('fsSaved')); await load(); }
  });
  return form;
}

function slotRow(slot) {
  const words = api.slotWords(lang, slot);
  const li = document.createElement('li');
  li.className = `row tone-${words.tone}`;
  li.dataset.check = slot.checkId; li.dataset.slot = slot.slotDueAt; li.dataset.state = slot.state;
  const head = document.createElement('div'); head.className = 'head';
  const name = document.createElement('span'); name.className = 'headline'; name.textContent = `${slot.title} — ${when(slot.slotDueAt)}`;
  const state = document.createElement('span'); state.className = 'state'; state.setAttribute('aria-label', words.label);
  const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true'); icon.textContent = words.icon;
  const word = document.createElement('span'); word.textContent = words.label;
  state.append(icon, word); head.append(name, state);
  const facts = document.createElement('div'); facts.className = 'facts';
  facts.textContent = [slot.performedBy ? `${t('fsColWho')}: ${slot.performedBy}` : '', slot.correctiveAction ?? '', slot.escalateTo ? `${t('fsEscalated')} ${slot.escalateTo}` : ''].filter((x) => x !== '').join(' · ');
  li.append(head, facts);
  const check = (board?.checks ?? []).find((c) => c.checkId === slot.checkId);
  if (may.recordChecks && check !== undefined && (slot.state === 'due' || slot.state === 'missed')) li.append(recordForm(check, slot.slotDueAt));
  return li;
}

function paint() {
  document.title = `SRE ${t('fsTitle')}`;
  for (const [id, k] of [['title-text', 'fsTitle'], ['page-h', 'fsTitle'], ['lead', 'fsLead'], ['k-missed', 'fsMissed'], ['k-due', 'fsDue'], ['k-done', 'fsDone'], ['k-failed', 'fsFailed'], ['receiving-h', 'fsReceiving']]) $(id).textContent = t(k);
  // OB-606: the SHOP's today in words (its zone, as the store computer told the page) — never this device's own date.
  const shopDay = window.sreShopDay ?? null;
  $('today-h').textContent = shopDay === null ? '' : shopDay.dayWords(shopDay.today(), lang);
  $('today-h').dataset.day = shopDay === null ? '' : shopDay.today();
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.storeOpsData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  if (board === null) return;
  const split = api.splitToday(board);
  $('v-missed').textContent = String(split.missed.length); $('p-missed').classList.toggle('attention', split.missed.length > 0);
  $('v-due').textContent = String(split.due.length); $('p-due').classList.toggle('attention', split.due.length > 0);
  $('v-done').textContent = String(split.done.length);
  $('v-failed').textContent = String(split.failed); $('p-failed').classList.toggle('attention', split.failed > 0);
  const ordered = [...split.missed, ...split.due, ...split.done, ...split.later];
  $('rows').replaceChildren(...ordered.map(slotRow));
  $('none').hidden = ordered.length > 0; $('none').textContent = t('fsNone');
  const receiving = board.receiving ?? [];
  $('receiving-rows').replaceChildren(...receiving.map((r) => {
    const li = document.createElement('li'); li.className = `row tone-${r.outcome === 'pass' ? 'ok' : 'degraded'}`; li.dataset.record = r.recordId;
    li.textContent = `${r.subjectRef ?? ''} — ${r.outcome === 'pass' ? t('fsPass') : t('fsFail')} · ${r.performedBy} · ${when(r.performedAt)}`;
    return li;
  }));
  $('no-receiving').hidden = receiving.length > 0; $('no-receiving').textContent = t('fsNoReceiving');
  const docks = may.recordChecks ? (board.checks ?? []).filter((c) => c.kind === 'receiving' && c.active) : [];
  $('receiving-forms').replaceChildren(...docks.map((c) => {
    const li = document.createElement('li'); li.className = 'row'; li.dataset.check = c.checkId;
    const h = document.createElement('div'); h.className = 'head'; h.textContent = c.title;
    li.append(h, recordForm(c, undefined));
    return li;
  }));
}

async function load() {
  if (session === null || !may.named || !may.readChecks) return;
  const out = await session.foodSafetyToday();
  if (out.result === 'ok') board = out.value; else say($('page-status'), out, '');
  paint();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.readChecks) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }
else if (may.named && !may.recordChecks) $('page-status').textContent = t('fsReadOnly');
if (may.named && may.readChecks) { if ($('page-status').textContent === '') $('page-status').textContent = t('reading'); void load().then(() => { if ($('page-status').textContent === t('reading')) $('page-status').textContent = ''; }); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
