// Reports — the view layer. Every rule lives in the TESTED session model
// (`apps/web-erp/src/reporting-session.ts`), attached as `window.reportingSession`.
//
// ── The decision this screen is built around ────────────────────────────────
//
// **The reports this shop cannot run have a tab of their own, as prominent as the ones it can.**
// A reporting screen listing only what works looks finished: somebody asks for shrinkage, finds
// nothing, and concludes either that the shop has none or that the software forgot. Neither
// reading can be corrected by anybody looking at the screen.
//
// So every report D13 names is listed, and one that cannot be produced says which fact the shop is
// not recording — in the shop's own words, because the person reading it is the person who can
// decide to start recording it.
//
// ── And the two that follow ─────────────────────────────────────────────────
//
// **No number without the moment it was true.** The as-at sits under every figure, and a stale one
// is coloured AND says so in words — colour alone is unreadable to one man in twelve, and this is a
// screen people quote from.
//
// **A figure that cannot be computed says why, in the space where the number would have been.** It
// is never a zero and never a blank.
//
// No `prompt`, `confirm` or `alert`; the banner does not fade.

const el = (id) => document.getElementById(id);

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    staleShell: 'No connection to the store computer. This page is what it was last told, at',
    title: 'Reports',
    reports: 'Reports', cannotRun: 'Cannot be run yet', whatNext: 'What to record next',
    reportsLead: 'Everything this shop can report on today. Every number says when it was true.',
    blockedLead: 'These are listed on purpose. Each one says why: either the shop is not recording a fact yet, or this version of the software cannot work it out yet. Running them and showing nought would be worse than not offering them.',
    backlogLead: 'Start recording these and the reports beside them start working. Ordered by how many each one unlocks on its own.',
    rowsTitle: 'The rows behind these figures', noRows: 'No rows behind this one.',
    exportIt: 'Write this out to a file',
    exportNote: 'The file carries its own column list, and personal data is removed unless you are allowed to see it.',
    back: 'Back to the list', run: 'Run',
    notAvailable: 'Not available', unlocks: 'reports start working',
    nothingBlocked: 'Every report this shop needs can be run.',
    nothingToRecord: 'Nothing else needs recording — every report works.',
    nothingYouCanDo: 'Nothing else you record will unlock a report in this version. The ones still listed as unavailable are waiting on us, not on the shop.',
    noReports: 'This screen has not been told what this shop records, so it can run nothing.',
    live: 'current', lagging: 'a few minutes behind, catching up',
    stale: 'too old to make a decision on',
    lastSpoke: 'Head office last spoke to this shop', neverSpoke: 'Head office has never sent anything to this shop',
    minutesAgo: 'minutes ago', asAt: 'as at',
    exported: 'File written', exportedNote: 'rows, with the column list beside them.',
    ok: 'OK', read: 'Please read this',
    sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
    title: 'அறிக்கைகள்',
    reports: 'அறிக்கைகள்', cannotRun: 'இன்னும் இயக்க முடியாதவை', whatNext: 'அடுத்து என்ன பதிவு செய்ய வேண்டும்',
    reportsLead: 'இன்று இந்தக் கடை என்ன அறிக்கை தர முடியும். ஒவ்வொரு எண்ணும் அது எப்போது உண்மையாக இருந்தது என்று சொல்லும்.',
    blockedLead: 'இவை வேண்டுமென்றே பட்டியலிடப்பட்டுள்ளன. ஒவ்வொன்றும் காரணத்தைச் சொல்கிறது: கடை ஒரு தகவலைப் பதிவு செய்யவில்லை, அல்லது இந்தப் பதிப்பால் இன்னும் அதைக் கணக்கிட முடியவில்லை. பூஜ்ஜியம் காட்டுவது இதைவிட மோசம்.',
    backlogLead: 'இவற்றைப் பதிவு செய்யத் தொடங்கினால் பக்கத்தில் உள்ள அறிக்கைகள் வேலை செய்யத் தொடங்கும். ஒவ்வொன்றும் தனியாக எத்தனை அறிக்கைகளைத் திறக்கிறது என்ற வரிசையில்.',
    rowsTitle: 'இந்த எண்களுக்குப் பின்னால் உள்ள வரிகள்', noRows: 'இதற்குப் பின்னால் வரிகள் இல்லை.',
    exportIt: 'இதை ஒரு கோப்பாக எழுது',
    exportNote: 'கோப்பு அதன் சொந்த நெடுவரிசைப் பட்டியலைக் கொண்டு வரும். அனுமதி இல்லாவிட்டால் தனிப்பட்ட தகவல் நீக்கப்படும்.',
    back: 'பட்டியலுக்குத் திரும்பு', run: 'இயக்கு',
    notAvailable: 'கிடைக்கவில்லை', unlocks: 'அறிக்கைகள் வேலை செய்யத் தொடங்கும்',
    nothingBlocked: 'இந்தக் கடைக்குத் தேவையான எல்லா அறிக்கைகளையும் இயக்க முடியும்.',
    nothingToRecord: 'வேறு எதுவும் பதிவு செய்யத் தேவையில்லை — எல்லா அறிக்கைகளும் வேலை செய்கின்றன.',
    nothingYouCanDo: 'நீங்கள் வேறு எதைப் பதிவு செய்தாலும் இந்தப் பதிப்பில் புதிய அறிக்கை திறக்காது. இன்னும் கிடைக்காதவை எங்களை நம்பியுள்ளன, கடையை அல்ல.',
    noReports: 'இந்தக் கடை என்ன பதிவு செய்கிறது என்று இந்தத் திரைக்குத் தெரியவில்லை. எனவே எதையும் இயக்க முடியாது.',
    live: 'தற்போதையது', lagging: 'சில நிமிடங்கள் பின்தங்கியுள்ளது, பிடிக்கிறது',
    stale: 'முடிவு எடுக்க முடியாத அளவுக்குப் பழையது',
    lastSpoke: 'தலைமை அலுவலகம் கடைசியாகப் பேசியது', neverSpoke: 'தலைமை அலுவலகம் இந்தக் கடைக்கு இதுவரை எதுவும் அனுப்பவில்லை',
    minutesAgo: 'நிமிடங்களுக்கு முன்', asAt: 'இந்த நேரத்தில்',
    exported: 'கோப்பு எழுதப்பட்டது', exportedNote: 'வரிகள், நெடுவரிசைப் பட்டியலுடன்.',
    ok: 'சரி', read: 'இதைப் படிக்கவும்',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** Why a report could not be run — one entry per `RunRefusal`, in both languages. */
const RUN_REFUSAL_WORDS = {
  no_such_report: {
    en: 'There is no report by that name.',
    ta: 'அந்தப் பெயரில் அறிக்கை எதுவும் இல்லை.',
  },
  this_shop_does_not_record_that_yet: {
    en: 'This shop does not record what that report needs yet. Showing it as nought would be a number somebody acts on.',
    ta: 'அந்த அறிக்கைக்குத் தேவையானதை இந்தக் கடை இன்னும் பதிவு செய்யவில்லை. பூஜ்ஜியம் காட்டினால் அதை ஒருவர் நம்பி முடிவெடுப்பார்.',
  },
  // A different problem with a different owner: the shop has done its part and the software has
  // not. Saying "this shop does not record that" here would put a job on the owner's list that no
  // amount of work in the shop can ever finish.
  this_version_cannot_produce_that_yet: {
    en: 'This shop records everything that report needs. This version of the software cannot work it out yet — that is our job, not yours.',
    ta: 'அந்த அறிக்கைக்குத் தேவையான எல்லாவற்றையும் இந்தக் கடை பதிவு செய்கிறது. இந்தப் பதிப்பால் இன்னும் அதைக் கணக்கிட முடியவில்லை — அது எங்கள் வேலை, உங்களுடையது அல்ல.',
  },
};

/** How current a figure is — one entry per `Staleness`, in both languages. */
const STALENESS_WORDS = {
  live: { en: 'current', ta: 'தற்போதையது' },
  lagging: { en: 'a few minutes behind, catching up', ta: 'சில நிமிடங்கள் பின்தங்கியுள்ளது' },
  stale: { en: 'too old to make a decision on', ta: 'முடிவு எடுக்க முடியாத அளவுக்குப் பழையது' },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/** A stand-in with the same surface as the bundled session, announced whenever it is in use. */
function sampleSession() {
  return {
    catalogue: () => [],
    backlog: () => [],
    freshness: () => ({ lastSyncedAt: null, asOf: '', ageSeconds: null, state: 'missing' }),
    run: () => ({ ok: false, refusal: 'no_such_report', detail: 'this is sample data', missing: [] }),
    export: () => ({ ok: false, detail: 'this is sample data' }),
  };
}

const real = window.reportingSession;
const session = real ?? sampleSession();

// ── The banner ──────────────────────────────────────────────────────────────

function tell(title, message, good = false) {
  el('banner-title').textContent = title;
  el('banner-text').textContent = message;
  el('banner').classList.toggle('good', good === true);
  el('banner').hidden = false;
  el('banner-ok').textContent = t('ok');
  el('banner-ok').focus();
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

// ── Navigation ──────────────────────────────────────────────────────────────

const VIEWS = ['reports', 'blocked', 'backlog', 'report'];
const TABS = ['reports', 'blocked', 'backlog'];

function show(name) {
  for (const view of VIEWS) el(`view-${view}`).hidden = view !== name;
  for (const tab of TABS) el(`tab-${tab}`).setAttribute('aria-current', tab === name ? 'page' : 'false');
}
for (const name of TABS) el(`tab-${name}`).addEventListener('click', () => { show(name); });
el('back').addEventListener('click', () => { show('reports'); });

// ── How current everything here is ──────────────────────────────────────────

function renderFreshness() {
  const state = session.freshness();
  const strip = el('freshness');
  strip.className = `freshness ${state.state}`;
  // A number quoted three hours after the sync stopped looks exactly like a live one, so this sits
  // at the very top of the page rather than beside any one figure.
  strip.textContent = state.ageSeconds === null
    ? t('neverSpoke')
    : `${t('lastSpoke')} ${Math.round(state.ageSeconds / 60)} ${t('minutesAgo')}`;
}

// ── The catalogue ───────────────────────────────────────────────────────────

let openReportId = null;

function renderCatalogue() {
  const all = session.catalogue();
  const ready = all.filter((e) => e.availability.available);
  const blocked = all.filter((e) => !e.availability.available);

  el('reports-list').replaceChildren(...(ready.length === 0
    ? [emptyLine(t('noReports'))]
    : ready.map((entry) => reportRow(entry, true))));

  el('blocked-list').replaceChildren(...(blocked.length === 0
    ? [emptyLine(t('nothingBlocked'))]
    : blocked.map((entry) => reportRow(entry, false))));

  const backlog = session.backlog();
  // An empty backlog means two very different things, and reading the wrong one is the kind of
  // mistake nobody on the screen can correct: either every report works, or this shop has already
  // recorded everything the reports it CAN run need, and the ones still missing are waiting on us.
  const nothingLeft = blocked.length === 0 ? t('nothingToRecord') : t('nothingYouCanDo');
  el('backlog-list').replaceChildren(...(backlog.length === 0
    ? [emptyLine(nothingLeft)]
    : backlog.map((row) => {
      const item = document.createElement('div');
      item.className = 'row blocked';
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      // The producer in the shop's own language. "no waste_events producer" tells nobody anything.
      name.textContent = row.producer.replace(/_/g, ' ');
      const sub = document.createElement('small');
      sub.textContent = `${row.unlocks} ${t('unlocks')}: ${row.reports.join(', ')}`;
      what.append(name, sub);
      item.append(what);
      return item;
    })));
}

function emptyLine(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

function reportRow(entry, ready) {
  const row = document.createElement('div');
  // Three states, not two. A report waiting on us looks different from one waiting on the shop,
  // because only one of them is something the person reading this can do anything about.
  row.className = `row ${ready ? 'ready' : entry.availability.blockedBy === 'this_version_cannot_produce_it' ? 'ours' : 'blocked'}`;

  const what = document.createElement('span');
  what.className = 'what';
  const name = document.createElement('strong');
  name.textContent = entry.report.name;
  const sub = document.createElement('small');
  // A blocked report says WHICH fact is missing, not "no data".
  sub.textContent = ready ? entry.report.answers : entry.availability.why;
  what.append(name, sub);
  row.append(what);

  if (ready) {
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = t('run');
    open.addEventListener('click', () => { openReport(entry.report.id); });
    row.append(open);
  }
  return row;
}

// ── One report ──────────────────────────────────────────────────────────────

function openReport(reportId) {
  const outcome = session.run(reportId);
  if (!outcome.ok) {
    tell(t('read'), `${words(RUN_REFUSAL_WORDS, outcome.refusal)} ${outcome.detail}`);
    return;
  }
  openReportId = reportId;
  show('report');
  renderReport(outcome);
}

function renderReport(outcome) {
  el('report-title').textContent = outcome.report.name;
  el('report-answers').textContent = outcome.report.answers;
  el('rows-title').textContent = t('rowsTitle');
  el('export').textContent = t('exportIt');
  el('export-note').textContent = t('exportNote');
  el('back').textContent = t('back');

  el('report-figures').replaceChildren(...outcome.result.figures.map(figureBox));

  if (outcome.rows.length === 0) {
    el('report-rows').replaceChildren(emptyLine(t('noRows')));
    return;
  }
  const table = document.createElement('table');
  // Every key any row carries, not just the first row's. A report where one column is absent from
  // the first bill and present on the rest would otherwise drop that column from the whole table,
  // and a table that is quietly one column narrower is one somebody reconciles against and cannot
  // explain.
  const columns = [];
  for (const row of outcome.rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  const head = document.createElement('tr');
  for (const column of columns) {
    const th = document.createElement('th');
    th.textContent = column;
    head.append(th);
  }
  table.append(head);
  for (const row of outcome.rows) {
    const tr = document.createElement('tr');
    for (const column of columns) {
      const td = document.createElement('td');
      td.textContent = row[column] ?? '';
      tr.append(td);
    }
    table.append(tr);
  }
  el('report-rows').replaceChildren(table);
}

function figureBox(f) {
  const box = document.createElement('div');
  const unavailable = f.valueMinor === undefined;
  box.className = `figure ${unavailable ? 'unavailable' : f.staleness}`;

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = f.name;

  const value = document.createElement('span');
  if (unavailable) {
    // In the space where the number would have been, so it cannot be skimmed past. Never a zero,
    // never a blank — "Waste: ₹0" is a number somebody puts in a board pack.
    value.className = 'value none';
    value.textContent = `${t('notAvailable')} — ${f.notAvailableBecause}`;
  } else {
    value.className = 'value';
    value.textContent = f.unit === 'minor_currency'
      ? inr(f.valueMinor)
      : f.unit === 'basis_points'
        ? `${(f.valueMinor / 100).toFixed(2)}%`
        : String(f.valueMinor);
  }

  const asat = document.createElement('span');
  asat.className = 'asat';
  // Words as well as the colour on the border: one man in twelve cannot tell the two apart, and
  // this is a screen people quote from.
  asat.textContent = `${t('asAt')} ${f.asAt} · ${words(STALENESS_WORDS, f.staleness)}`;

  box.append(name, value, asat);
  return box;
}

el('export').addEventListener('click', () => {
  if (openReportId === null) return;
  const result = session.export(openReportId);
  if (!('csv' in result)) { tell(t('read'), result.detail); return; }
  tell(
    t('exported'),
    `${result.audit.rowCount} ${t('exportedNote')}`
      + (result.audit.redactedColumns.length > 0 ? ` (${result.audit.redactedColumns.join(', ')})` : ''),
    true,
  );
});

// ── Language ────────────────────────────────────────────────────────────────

function paintChrome() {
  el('who').firstChild.textContent = `${t('title')} `;
  el('whoami').textContent = window.reportingData?.userId ?? '';
  el('tab-reports').textContent = t('reports');
  el('tab-blocked').textContent = t('cannotRun');
  el('tab-backlog').textContent = t('whatNext');
  el('reports-title').textContent = t('reports');
  el('reports-lead').textContent = t('reportsLead');
  el('blocked-title').textContent = t('cannotRun');
  el('blocked-lead').textContent = t('blockedLead');
  el('backlog-title').textContent = t('whatNext');
  el('backlog-lead').textContent = t('backlogLead');
  el('sample').textContent = t('sampleData');
  renderFreshness();
  renderCatalogue();
  if (openReportId !== null) {
    const outcome = session.run(openReportId);
    if (outcome.ok) renderReport(outcome);
  }
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
paintChrome();
show('reports');

// ── The shell's own honesty about where this page came from ─────────────────
//
// Worse here than on most screens: a page cached this morning shows figures stamped this morning
// and a freshness strip that agreed with them at the time. The strip below is the one that says
// the PAGE is old, which is a different fact from the numbers being old.
function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  strip.textContent = `${t('staleShell')} ${new Date(at).toLocaleString()}`;
}
paintStale();
el('lang').addEventListener('click', paintStale);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
