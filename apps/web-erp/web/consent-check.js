// Check consent (U6 · M16-FR-02 · crm-service.md "check a customer's consent state (≤2)") — the read-only page that answers,
// by a customer's NAME, whether the shop may message them. The session (apps/web-erp/src/consent-check-session.ts, in the
// bundle as window.consentCheck) does every call and carries head office's own send-time rule; this page lays out what it is
// told on the shared office parts (window.sreOffice: table, state, chips, fields). Two interactions: type a few letters
// (the matches appear with their marketing state as you type), choose one (every record, by purpose). Nothing is written.
// Every word this page adds has a Tamil twin; head office's own sentences (the evidence as typed) stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.consentCheck ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, names: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const both = (k) => ({ en: api.words('en', k), ta: api.words('ta', k) });
const office = () => window.sreOffice ?? null;
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
const shopTime = (at) => (!at ? '' : window.sreShopDay?.dateTimeOf(at) ?? at);

let directory = null; let directoryOutcome = null; // head office's customer directory, read once
let matches = null; // the rows the typed letters match
let states = new Map(); // customerRef → consent state (or outcome), for the rows shown
let picked = null; let pickedState = null; let pickedOutcome = null;
let fields = null;

document.addEventListener('sre:chrome', () => { buildForm(); paint(); });

function stateOr(host, outcome) { const o = office(); if (o !== null) o.state(host, o.stateOf(outcome), { title: api.outcomeWords(lang, outcome) }); }
const verdictTone = (v) => (v === 'may_send' ? 'ok' : v === 'must_not_send' ? 'error' : 'idle');
const verdictChip = (o, v) => o.chip(verdictTone(v), t(v));
const nameOf = (c) => (c.name === null ? t('noName') : c.name);

function buildForm() {
  const o = office();
  if (o === null || fields !== null || typeof o.field !== 'function') return;
  fields = { text: o.field({ id: 'f-text', label: both('find'), type: 'text', hint: both('findHint') }) };
  $('find-fields').replaceChildren(fields.text);
  $('f-text').setAttribute('autocomplete', 'off');
  $('f-text').addEventListener('input', () => { void show(); });
}

/** The matches as a register: the person, the number, the segment, the marketing state per channel, and "Open the records". */
function paintMatches() {
  const o = office();
  $('matches-table').replaceChildren();
  if (directoryOutcome !== null && may.names) { $('f-status').textContent = api.outcomeWords(lang, directoryOutcome); stateOr($('matches-table'), directoryOutcome); return; }
  if (matches === null) { $('f-status').textContent = ''; return; }
  $('f-status').textContent = '';
  if (o === null) return;
  if (matches.length === 0) { o.state($('matches-table'), 'noMatch', { title: t('noMatch'), detail: t('noMatchDetail') }); return; }
  const marketingOf = (c) => { const s = states.get(c.customerRef); return s === undefined || s.result !== 'ok' ? null : s.value.marketing; };
  o.table($('matches-table'), {
    id: 'matches', label: both('matchesH'), rows: matches, pageSize: 10, search: false,
    rowKey: (c) => c.customerRef, rowData: (c) => ({ customer: c.customerRef }),
    columns: [
      { key: 'name', label: both('nameCol'), sort: 'text', value: nameOf },
      { key: 'customerRef', label: both('number'), sort: 'text' },
      { key: 'segment', label: both('segment'), value: (c) => c.segment },
      { key: 'marketing', label: both('marketing'), value: (c) => { const m = marketingOf(c); return m === null ? t('reading') : m.map((x) => `${t(`ch_${x.channel}`)}: ${t(x.verdict)}`).join(' · '); },
        render: (c) => { const m = marketingOf(c); const w = document.createElement('span'); w.className = 'sre-chips'; w.dataset.customer = c.customerRef;
          if (m === null) { const s = states.get(c.customerRef); w.textContent = s === undefined ? t('reading') : api.outcomeWords(lang, s); return w; }
          for (const x of m) { const chip = verdictChip(o, x.verdict); chip.dataset.channel = x.channel; chip.prepend(document.createTextNode(`${t(`ch_${x.channel}`)} `)); w.append(chip); } return w; } },
      { key: 'open', label: both('openRecords'), sort: false, render: (c) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn sre-btn-quiet'; b.dataset.open = c.customerRef; b.textContent = t('openRecords'); b.addEventListener('click', () => { void open(c); }); return b; } },
    ],
  });
}

/** Every record for the chosen customer, one register per purpose: the channel, the state, how it was captured, when. */
function paintRecords() {
  const o = office();
  $('purposes').replaceChildren();
  if (picked === null) return;
  $('records-facts').replaceChildren(...[`${t('nameCol')}: ${nameOf(picked)} · ${t('number')}: ${picked.customerRef}`].map((line) => { const s = document.createElement('span'); s.textContent = line; return s; }));
  if (pickedOutcome !== null) { $('records-status').textContent = api.outcomeWords(lang, pickedOutcome); stateOr($('purposes'), pickedOutcome); return; }
  if (pickedState === null) { $('records-status').textContent = t('reading'); if (o !== null) o.state($('purposes'), 'loading'); return; }
  $('records-status').textContent = `${pickedState.records} ${t('records')}`;
  if (o === null) return;
  if (pickedState.records === 0) { o.state($('purposes'), 'empty', { title: t('noRecords'), detail: t('noRecordsDetail') }); return; }
  $('purposes').replaceChildren(...api.purposes.map((purpose) => {
    const sec = document.createElement('section'); sec.className = 'group'; sec.id = `purpose-${purpose}`; sec.dataset.purpose = purpose; sec.setAttribute('aria-labelledby', `purpose-${purpose}-h`);
    const h = document.createElement('h4'); h.id = `purpose-${purpose}-h`; h.textContent = t(`purpose_${purpose}`); sec.append(h);
    const host = document.createElement('div'); sec.append(host);
    o.table(host, {
      id: `consent-${purpose}`, label: { en: api.words('en', `purpose_${purpose}`), ta: api.words('ta', `purpose_${purpose}`) }, rows: pickedState[purpose], pageSize: 10, search: false, count: false,
      rowKey: (x) => x.channel, rowData: (x) => ({ channel: x.channel, verdict: x.verdict }),
      columns: [
        { key: 'channel', label: both('channel'), value: (x) => t(`ch_${x.channel}`) },
        { key: 'verdict', label: both('verdictCol'), value: (x) => t(x.verdict), render: (x) => verdictChip(o, x.verdict) },
        { key: 'evidence', label: both('evidence'), value: (x) => x.evidence ?? null, render: (x) => { if (x.evidence === undefined) return null; const s = document.createElement('span'); s.lang = 'en'; s.textContent = x.evidence; return s; } },
        { key: 'at', label: both('when'), value: (x) => (x.at === undefined ? null : shopTime(x.at)) },
      ],
    });
    return sec;
  }));
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['find-h', 'matchesH'], ['f-show-text', 'show'], ['records-h', 'recordsH'], ['records-lead', 'recordsLead'], ['back-text', 'back'], ['english-note', 'headOfficeEnglish']]) { const n = $(id); if (n) n.textContent = t(key); }
  $('f-note').textContent = may.names ? '' : t('directoryOff');
  if (fields !== null) { const f = $('f-text')?.closest('.sre-field'); const lab = f?.querySelector('.sre-field-label'); if (lab) lab.textContent = t('find'); const hint = f?.querySelector('.sre-field-hint'); if (hint) hint.textContent = t('findHint'); }
  paintMatches(); paintRecords();
}

/** Read the consent of every row shown (at most a page), so the state is beside the name without a second interaction. */
async function readStates(rows) {
  await Promise.all(rows.slice(0, 10).map(async (c) => { if (!states.has(c.customerRef)) { states.set(c.customerRef, await session.consent(c.customerRef)); paintMatches(); } }));
}

async function show(event) {
  event?.preventDefault();
  const q = ($('f-text')?.value ?? '').trim();
  if (q.length < 2) { matches = null; $('f-status').textContent = event ? t('typeMore') : ''; paintMatches(); return; }
  if (may.names) {
    if (directory === null && directoryOutcome === null) { $('f-status').textContent = t('reading'); const out = await session.customers(); if (out.result === 'ok') { directory = out.value; } else { directoryOutcome = out; } }
    if (directory === null) { paintMatches(); return; }
    matches = api.match(q, directory);
  } else {
    // no directory for this role: the typed text is the customer's number, checked as it is (said on the page)
    matches = [{ customerRef: q, name: null, segment: t('byNumber') }];
  }
  paintMatches();
  await readStates(matches);
}

async function open(c) {
  picked = c; pickedState = null; pickedOutcome = null;
  $('records').hidden = false; paint(); $('records').scrollIntoView({ block: 'start' });
  const held = states.get(c.customerRef);
  const out = held ?? await session.consent(c.customerRef);
  if (out.result === 'ok') { pickedState = out.value; } else { pickedOutcome = out; }
  paintRecords();
}
function close() { picked = null; $('records').hidden = true; paint(); $('find').scrollIntoView({ block: 'start' }); }

for (const [id, name] of [['f-show', 'search'], ['back', 'rotate-ccw']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('find-form').addEventListener('submit', (e) => { void show(e); });
$('back').addEventListener('click', close);
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else $('find').hidden = false;
