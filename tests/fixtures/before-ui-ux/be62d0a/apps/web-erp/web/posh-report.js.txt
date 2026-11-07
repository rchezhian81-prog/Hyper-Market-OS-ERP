// The Internal Committee's annual report — the owner's view (R2 addendum C20 · OB-154 "A" · OB-157 "A"). Reads, live from
// head office, which ended years' reports are due or overdue (GET /v1/hr/posh/annual-report-status) and the COUNTS of a
// report the committee has made (GET /v1/hr/posh/annual-reports/:year), and records that a year's report was filed with
// the District Officer (POST /v1/hr/posh/annual-reports/:year/filing). Head office decides whether a filing stands — the
// report must exist, a year is filed once — and this page shows exactly what it answered. It never shows a complaint, a
// name or a summary: the register is the committee's alone. No prompt/confirm/alert; nothing on a timer.

const el = (id) => document.getElementById(id);
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    title: 'Committee annual report', langName: 'தமிழ்',
    lead: 'The Internal Committee\'s report to the District Officer is due by 31 January for the year before. This page shows only whether each year\'s report is due, overdue or filed, and its counts — never a complaint.',
    waiting: 'report(s) not filed', nothingDue: 'Nothing is due — every year that has ended is recorded as filed.',
    openHeading: 'Not filed yet', doneHeading: 'Filed',
    due: 'Due', overdue: 'Overdue', filed: 'Filed',
    yearLabel: 'Report for', dueByLabel: 'Due by', daysLeft: 'day(s) left', daysLate: 'day(s) overdue',
    notGenerated: 'The committee has not made this report yet', generated: 'The committee has made this report',
    received: 'Received', disposed: 'Disposed of', stillOpen: 'Still open at year end',
    filedOnLabel: 'Date filed', referenceLabel: 'District Officer\'s acknowledgement', record: 'Record as filed',
    filedOn: 'Filed on', onTime: 'on time', late: 'late',
    recorded: 'Recorded as filed', refused: 'Not recorded', needReference: 'Enter the acknowledgement reference and the date first.',
    unreachable: 'Head office could not be reached. Nothing was recorded — try again.',
    cannotRead: 'The report status could not be read from head office. Nothing here is current.',
  },
  ta: {
    title: 'குழு ஆண்டு அறிக்கை', langName: 'English',
    lead: 'உள் குழுவின் அறிக்கை முந்தைய ஆண்டுக்காக ஜனவரி 31-க்குள் மாவட்ட அலுவலருக்குச் செல்ல வேண்டும். ஒவ்வொரு ஆண்டின் அறிக்கையும் நிலுவையா, தாமதமா, சமர்ப்பிக்கப்பட்டதா என்பதையும் அதன் எண்ணிக்கைகளையும் மட்டுமே இந்தப் பக்கம் காட்டும் — எந்தப் புகாரையும் அல்ல.',
    waiting: 'அறிக்கை(கள்) சமர்ப்பிக்கப்படவில்லை', nothingDue: 'எதுவும் நிலுவையில் இல்லை — முடிந்த ஒவ்வொரு ஆண்டும் சமர்ப்பிக்கப்பட்டதாகப் பதிவாகியுள்ளது.',
    openHeading: 'இன்னும் சமர்ப்பிக்கப்படவில்லை', doneHeading: 'சமர்ப்பிக்கப்பட்டவை',
    due: 'நிலுவை', overdue: 'தாமதம்', filed: 'சமர்ப்பிக்கப்பட்டது',
    yearLabel: 'ஆண்டு', dueByLabel: 'கடைசி நாள்', daysLeft: 'நாள்(கள்) உள்ளன', daysLate: 'நாள்(கள்) தாமதம்',
    notGenerated: 'குழு இந்த அறிக்கையை இன்னும் தயாரிக்கவில்லை', generated: 'குழு இந்த அறிக்கையைத் தயாரித்துள்ளது',
    received: 'பெறப்பட்டவை', disposed: 'முடிக்கப்பட்டவை', stillOpen: 'ஆண்டு இறுதியில் நிலுவையில்',
    filedOnLabel: 'சமர்ப்பித்த நாள்', referenceLabel: 'மாவட்ட அலுவலரின் ஒப்புகை எண்', record: 'சமர்ப்பித்ததாகப் பதிவு செய்',
    filedOn: 'சமர்ப்பித்த நாள்', onTime: 'உரிய நேரத்தில்', late: 'தாமதமாக',
    recorded: 'சமர்ப்பித்ததாகப் பதிவு செய்யப்பட்டது', refused: 'பதிவு செய்யப்படவில்லை', needReference: 'முதலில் ஒப்புகை எண்ணையும் நாளையும் உள்ளிடுங்கள்.',
    unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் பதிவு செய்யப்படவில்லை — மீண்டும் முயலவும்.',
    cannotRead: 'அறிக்கை நிலையைத் தலைமை அலுவலகத்திலிருந்து படிக்க முடியவில்லை. இங்குள்ளவை தற்போதையவை அல்ல.',
  },
};
const t = (key) => WORDS[lang]?.[key] ?? WORDS.en[key] ?? key;
// OB-606 (M01-FR-02): the SHOP's today (its zone, as the store computer told the page) — never this device's own date, and
// never the UTC date of the moment. '' when the bundle is not here to say (the date is then the person's to write).
const today = () => (window.sreShopDay === undefined ? '' : window.sreShopDay.today());

let exceptions = [];
let filed = [];
/** The counts of each generated report, by year — counts only, never a name. */
const counts = new Map();
let readFailed = false;
/** One filing key per year, kept only while head office's answer is lost — a retry is then the same filing, never two. */
const pendingKeys = new Map();

function field(labelKey, control) {
  const label = document.createElement('label');
  const span = document.createElement('span'); span.textContent = t(labelKey);
  label.append(span, control);
  return label;
}

function countFacts(facts, year) {
  const c = counts.get(year);
  if (c === undefined) return;
  const fact = (text) => { const s = document.createElement('span'); s.className = 'count'; s.textContent = text; facts.append(s); };
  fact(`${t('received')}: ${c.receivedInYear}`);
  fact(`${t('disposed')}: ${c.disposedInYear}`);
  fact(`${t('stillOpen')}: ${c.pendingAtEnd}`);
}

function filingForm(year) {
  const form = document.createElement('form');
  form.className = 'file';
  const on = document.createElement('input'); on.type = 'date'; on.className = 'filed-on'; on.name = 'filedOn'; on.value = today();
  const ref = document.createElement('input'); ref.className = 'reference'; ref.name = 'reference'; ref.autocomplete = 'off';
  const button = document.createElement('button'); button.type = 'submit'; button.className = 'act record'; button.textContent = t('record');
  form.append(field('filedOnLabel', on), field('referenceLabel', ref), button);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void send(year, { filedOn: on.value.trim(), reference: ref.value.trim() }, button);
  });
  return form;
}

function openRow(x) {
  const li = document.createElement('li');
  li.className = `row tone-${x.state === 'overdue' ? 'error' : 'degraded'}`;
  li.dataset.year = String(x.year);
  const head = document.createElement('div'); head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = `${t('yearLabel')} ${x.year}`;
  const state = document.createElement('span'); state.className = 'state';
  const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true'); icon.textContent = x.state === 'overdue' ? '⛔' : '⚠';
  const word = document.createElement('span'); word.className = 'word';
  word.textContent = `${t(x.state)} — ${x.state === 'overdue' ? `${-x.daysToDue} ${t('daysLate')}` : `${x.daysToDue} ${t('daysLeft')}`}`;
  state.append(icon, word);
  head.append(headline, state);
  const facts = document.createElement('div'); facts.className = 'facts';
  const fact = (text) => { const s = document.createElement('span'); s.textContent = text; facts.append(s); };
  fact(`${t('dueByLabel')}: ${x.dueBy}`);
  fact(x.generated ? t('generated') : t('notGenerated'));
  countFacts(facts, x.year);
  li.append(head, facts, filingForm(x.year));
  return li;
}

function doneRow(f) {
  const li = document.createElement('li');
  li.className = 'row tone-ok';
  li.dataset.year = String(f.year);
  const head = document.createElement('div'); head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = `${t('yearLabel')} ${f.year}`;
  const state = document.createElement('span'); state.className = 'state';
  const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true'); icon.textContent = '✓';
  const word = document.createElement('span'); word.className = 'word'; word.textContent = `${t('filed')} — ${f.onTime ? t('onTime') : t('late')}`;
  state.append(icon, word);
  head.append(headline, state);
  const facts = document.createElement('div'); facts.className = 'facts';
  const s = document.createElement('span'); s.textContent = `${t('filedOn')}: ${f.filedOn}`; facts.append(s);
  countFacts(facts, f.year);
  li.append(head, facts);
  return li;
}

function paint() {
  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('lang').textContent = t('langName');
  el('whoami').textContent = window.poshReportData?.userId ?? '';
  el('summary').textContent = readFailed ? '' : exceptions.length === 0 ? t('nothingDue') : `${exceptions.length} ${t('waiting')}`;
  const state = el('state');
  state.hidden = !readFailed;
  state.textContent = readFailed ? t('cannotRead') : '';
  el('open-heading').hidden = exceptions.length === 0; el('open-heading').textContent = t('openHeading');
  el('done-heading').hidden = filed.length === 0; el('done-heading').textContent = t('doneHeading');
  el('rows').replaceChildren(...exceptions.map(openRow));
  el('done-rows').replaceChildren(...filed.map(doneRow));
}

function tell(ok, text) {
  const r = el('result');
  r.hidden = false;
  r.className = `result tone-${ok ? 'ok' : 'error'}`;
  r.textContent = text;
}

async function refresh() {
  try {
    const res = await fetch('/v1/hr/posh/annual-report-status', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    exceptions = Array.isArray(body.exceptions) ? body.exceptions : [];
    filed = Array.isArray(body.filed) ? body.filed : [];
    readFailed = false;
    // The counts of every report the committee has made — counts only.
    const years = [...exceptions.filter((x) => x.generated).map((x) => x.year), ...filed.map((f) => f.year)];
    for (const year of years) {
      const r = await fetch(`/v1/hr/posh/annual-reports/${year}`, { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) { const b = await r.json(); if (b.report) counts.set(year, b.report); }
    }
  } catch {
    readFailed = true;
  }
  paint();
}

async function send(year, values, button) {
  if (values.reference === '' || values.filedOn === '') { tell(false, t('needReference')); return; }
  const key = pendingKeys.get(year) ?? `posh-filing-${year}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  pendingKeys.set(year, key);
  button.disabled = true;
  try {
    const res = await fetch(`/v1/hr/posh/annual-reports/${year}/filing`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(values),
    });
    const answer = await res.json().catch(() => ({}));
    // Answered: recorded or refused, the key is done with — a new attempt is a new filing request.
    pendingKeys.delete(year);
    if (res.ok) tell(true, `${t('recorded')}: ${year} — ${answer.onTime ? t('onTime') : t('late')}`);
    else tell(false, `${t('refused')}: ${answer?.error?.whatHappened ?? res.status} ${answer?.error?.nextSafeAction ?? ''}`.trim());
  } catch {
    tell(false, t('unreachable'));
  } finally {
    button.disabled = false;
  }
  await refresh();
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
void refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
