// Data import & export console — the view layer (M30, API-03, ADR-0024). Every rule lives in the TESTED session model
// (apps/web-erp/src/data-io-session.ts), attached as window.dataIoSession. This file only draws what the session
// hands it: the EXPORT panel (domains, which columns are sensitive, an Export button, the recent-exports log)
// and the IMPORT panel (template, file, Check → preview; a name and a reason, then Ask for approval; then Load it,
// once a DIFFERENT person has approved it on their Approvals page; and the uploader's own requests with where each
// stands). Every write — export, ask, load — runs ONLY on an explicit click, never on load; reading the uploader's
// own requests is a GET. No prompt/confirm/alert. No approver's name is ever typed here.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Import & export', langName: 'தமிழ்', lead: 'Sample view. Connect the store computer to work with your own data.',
      exportHeading: 'Take data out', exportLead: 'Every export is logged; sensitive columns are hidden unless you may see them.', exportBtn: 'Export', sensitiveTag: 'sensitive', noExport: 'You do not have permission to export data.',
      recentHeading: 'Recent exports', recentEmpty: 'No exports yet.', rowsLabel: 'rows', redactedLabel: 'hidden columns',
      importHeading: 'Bring data in', importLead: 'Check a file, ask for approval, and load it once a second person (not you) approves it.', templateLabel: 'What are you loading', fileLabel: 'The file', filePlaceholder: 'sku,name,price', totalLabel: 'Declared total (paise)', validateBtn: 'Check the file',
      jobLabel: 'A name for this load', whyLabel: 'Why this load is needed', whyPlaceholder: 'For example: September price list.', askBtn: 'Ask for approval', commitBtn: 'Load it', noImport: 'You do not have permission to import data.',
      previewValid: 'ready to load', previewErrors: 'rows with a problem', previewReady: 'This file is ready.', previewNotReady: 'This file is not ready — fix the problems and check again.',
      requestsHeading: 'Your requests to load', requestsEmpty: 'You have not asked for any load to be approved.', requestsLostLink: 'Could not read your requests just now — no connection.', requestIdLabel: 'Request', askedAtLabel: 'Asked',
      sampleData: 'Sample data — this is not your shop.', nobodyNamed: '',
    },
    ta: {
      title: 'இறக்குமதி & ஏற்றுமதி', langName: 'English', lead: 'மாதிரிக் காட்சி. உங்கள் சொந்தத் தரவுடன் வேலை செய்ய கடை கணினியை இணைக்கவும்.',
      exportHeading: 'தரவை வெளியே எடு', exportLead: 'ஒவ்வொரு ஏற்றுமதியும் பதிவு செய்யப்படும்; உணர்திறன் நெடுவரிசைகள் அனுமதி இருந்தால் மட்டுமே காட்டப்படும்.', exportBtn: 'ஏற்றுமதி', sensitiveTag: 'உணர்திறன்', noExport: 'ஏற்றுமதி செய்ய அனுமதி இல்லை.',
      recentHeading: 'சமீபத்திய ஏற்றுமதிகள்', recentEmpty: 'இதுவரை இல்லை.', rowsLabel: 'வரிசைகள்', redactedLabel: 'மறைக்கப்பட்டவை',
      importHeading: 'தரவை உள்ளே கொண்டு வா', importLead: 'கோப்பைச் சரிபார்த்து, அனுமதி கேட்டு, இரண்டாம் நபர் (நீங்கள் அல்ல) அனுமதித்ததும் ஏற்றுங்கள்.', templateLabel: 'எதை ஏற்றுகிறீர்கள்', fileLabel: 'கோப்பு', filePlaceholder: 'sku,name,price', totalLabel: 'அறிவிக்கப்பட்ட மொத்தம் (பைசா)', validateBtn: 'கோப்பைச் சரிபார்',
      jobLabel: 'இந்த ஏற்றத்திற்கு ஒரு பெயர்', whyLabel: 'இந்த ஏற்றம் ஏன் தேவை', whyPlaceholder: 'உதாரணம்: செப்டம்பர் விலைப் பட்டியல்.', askBtn: 'அனுமதி கேள்', commitBtn: 'ஏற்று', noImport: 'இறக்குமதி செய்ய அனுமதி இல்லை.',
      previewValid: 'ஏற்றத் தயார்', previewErrors: 'சிக்கல் உள்ள வரிசைகள்', previewReady: 'கோப்பு தயார்.', previewNotReady: 'தயாராக இல்லை — சிக்கல்களைச் சரிசெய்து மீண்டும் சரிபார்க்கவும்.',
      requestsHeading: 'ஏற்றுவதற்கான உங்கள் கோரிக்கைகள்', requestsEmpty: 'எந்த ஏற்றத்திற்கும் நீங்கள் அனுமதி கேட்கவில்லை.', requestsLostLink: 'உங்கள் கோரிக்கைகளை இப்போது படிக்க முடியவில்லை — இணைப்பு இல்லை.', requestIdLabel: 'கோரிக்கை', askedAtLabel: 'கேட்டது',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', nobodyNamed: '',
    },
  };
  const NO_LINK = {
    en: 'No connection — nothing was sent. This is a sample view.',
    ta: 'இணைப்பு இல்லை — எதுவும் அனுப்பப்படவில்லை. இது மாதிரிக் காட்சி.',
  };
  const tone = (r, ok) => ({ tone: r === ok ? 'ok' : r === 'lost_link' ? 'degraded' : 'error', icon: r === ok ? '✓' : r === 'lost_link' ? '⚠' : '✕', label: '', announcement: '', needsAttention: r !== ok });
  const noLink = (l) => ({ tone: 'degraded', icon: '⚠', label: NO_LINK[l] ?? NO_LINK.en, announcement: NO_LINK[l] ?? NO_LINK.en, needsAttention: true });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    exportPanel: () => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false }, mayExport: true,
      domains: [{ domain: 'products', columns: [{ name: 'sku', sensitive: false }, { name: 'cost', sensitive: true }], sensitiveCount: 1 }],
      recent: [{ domain: 'products', userId: 'demo', at: '', rowCount: 120, redactedColumns: ['cost'] }],
    }),
    importPanel: () => ({ mayImport: true, mayCommit: true, templates: [{ id: 'products-basic', label: 'Products (SKU, name, price)', financial: false }], nobodyNamed: false }),
    runExport: async () => 'lost_link',
    validate: async () => 'lost_link',
    askForApproval: async () => ({ kind: 'lost_link' }),
    commit: async () => ({ kind: 'lost_link' }),
    importRequests: async (l) => ({
      state: 'read',
      rows: [{
        requestId: 'sample-areq-1', jobId: 'sept-prices', summary: 'Load 120 rows (Products (SKU, name, price)) as "sept-prices"',
        reason: l === 'ta' ? 'செப்டம்பர் விலைப் பட்டியல்' : 'September price list', askedAt: '',
        status: { tone: 'degraded', icon: '…', label: l === 'ta' ? 'இரண்டாம் நபருக்காகக் காத்திருக்கிறது' : 'Waiting for a second person', announcement: '', needsAttention: true },
      }],
    }),
    presentExportResult: (l, r) => tone(r, 'exported'),
    presentValidateResult: (l, r) => tone(r, '__never__'),
    presentAskOutcome: (l) => noLink(l),
    presentLoadOutcome: (l) => noLink(l),
  };
}

let session = window.dataIoSession ?? sampleSession();
const t = (key) => session.text(lang, key);
/** The uploader's own requests, as last read (a GET). Kept so a language switch repaints them without a new read. */
let lastRequests = null;

/** The days chosen for each dated domain (SF-10), kept across a repaint so a refresh never resets them. */
const periodChosen = new Map();

function line(text, cls) { const s = document.createElement('small'); if (cls) s.className = cls; s.textContent = text; return s; }

function paintExport() {
  const view = session.exportPanel(lang);
  el('export-heading').textContent = t('exportHeading');
  el('export-lead').textContent = t('exportLead');
  el('recent-heading').textContent = t('recentHeading');

  const locked = el('export-locked');
  locked.hidden = view.mayExport;
  locked.textContent = view.mayExport ? '' : t('noExport');
  el('export-domains').hidden = !view.mayExport;

  el('export-domains').replaceChildren(...view.domains.map((d) => {
    const li = document.createElement('li'); li.className = 'row';
    const what = document.createElement('span'); what.className = 'what';
    const name = document.createElement('strong'); name.textContent = d.domain;
    if (d.sensitiveCount > 0) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = `${d.sensitiveCount} ${t('sensitiveTag')}`; name.append(tag); }
    what.append(name, line(d.columns.map((c) => c.name).join(', ')));
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'act small export-btn'; btn.textContent = t('exportBtn'); btn.dataset.domain = d.domain;
    if (d.period) {
      // A dated domain (attendance): From / To, defaulting to the last 7 days ending yesterday in the shop's calendar.
      const chosen = periodChosen.get(d.domain) ?? { from: d.period.defaultFrom, to: d.period.defaultTo };
      periodChosen.set(d.domain, chosen);
      const span = document.createElement('div'); span.className = 'period';
      const field = (key, cls) => {
        const wrap = document.createElement('div');
        const id = `period-${cls}-${d.domain}`;
        const lab = document.createElement('label'); lab.htmlFor = id; lab.textContent = t(key === 'from' ? 'periodFrom' : 'periodTo');
        const input = document.createElement('input'); input.type = 'date'; input.id = id; input.className = `period-${cls}`; input.value = chosen[key];
        input.addEventListener('change', () => { chosen[key] = input.value; });
        wrap.append(lab, input);
        return wrap;
      };
      span.append(field('from', 'from'), field('to', 'to'));
      what.append(line(d.period.hint, 'hint'), span);
      btn.addEventListener('click', () => { void runPeriodExport(d.domain); });
    } else {
      btn.addEventListener('click', () => { void runExport(d.domain); });
    }
    li.append(what, btn);
    return li;
  }));

  const recent = el('recent-exports');
  if (view.recent.length === 0) { recent.replaceChildren(); const li = document.createElement('li'); li.className = 'row'; li.append(line(t('recentEmpty'))); recent.append(li); }
  else recent.replaceChildren(...view.recent.map((e) => {
    const li = document.createElement('li'); li.className = 'row';
    const what = document.createElement('span'); what.className = 'what';
    const name = document.createElement('strong'); name.textContent = `${e.domain} — ${e.rowCount} ${t('rowsLabel')}`;
    what.append(name, line(`${e.userId} · ${e.at}${e.redactedColumns.length > 0 ? ` · ${e.redactedColumns.length} ${t('redactedLabel')}` : ''}`));
    li.append(what);
    return li;
  }));
}

function paintImport() {
  const view = session.importPanel();
  el('import-heading').textContent = t('importHeading');
  el('import-lead').textContent = t('importLead');
  el('nobody').hidden = !view.nobodyNamed;
  el('nobody').textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  const locked = el('import-locked');
  locked.hidden = view.mayImport;
  locked.textContent = view.mayImport ? '' : t('noImport');
  el('import-form').hidden = !view.mayImport;
  if (!view.mayImport) return;

  el('template-label').textContent = t('templateLabel');
  el('file-label').textContent = t('fileLabel');
  el('import-file').setAttribute('aria-label', t('fileLabel'));
  el('import-file').placeholder = t('filePlaceholder');
  el('total-label').textContent = t('totalLabel');
  el('import-total').setAttribute('aria-label', t('totalLabel'));
  el('validate').textContent = t('validateBtn');
  el('job-label').textContent = t('jobLabel');
  el('import-job').setAttribute('aria-label', t('jobLabel'));
  el('why-label').textContent = t('whyLabel');
  el('import-why').setAttribute('aria-label', t('whyLabel'));
  el('import-why').placeholder = t('whyPlaceholder');
  el('ask').textContent = t('askBtn');
  el('commit').textContent = t('commitBtn');
  const chosen = el('import-template').value;
  el('import-template').replaceChildren(...view.templates.map((tpl) => { const o = document.createElement('option'); o.value = tpl.id; o.textContent = tpl.label; return o; }));
  if (chosen && view.templates.some((tpl) => tpl.id === chosen)) el('import-template').value = chosen;
  paintRequests();
}

/** The uploader's own load requests, with where each stands (waiting / approved until … / rejected by X: why …). */
function paintRequests() {
  const heading = el('requests-heading');
  const list = el('my-requests');
  const view = session.importPanel();
  if (!view.mayCommit || lastRequests === null) { heading.hidden = true; list.hidden = true; return; }
  heading.hidden = false; list.hidden = false;
  heading.textContent = t('requestsHeading');
  list.setAttribute('aria-label', t('requestsHeading'));
  if (lastRequests.state !== 'read' || lastRequests.rows.length === 0) {
    const li = document.createElement('li'); li.className = 'row';
    li.append(line(lastRequests.state === 'read' ? t('requestsEmpty') : t('requestsLostLink')));
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...lastRequests.rows.map((r) => {
    const li = document.createElement('li'); li.className = `row tone-${r.status.tone}`; li.dataset.requestId = r.requestId;
    const what = document.createElement('span'); what.className = 'what';
    const name = document.createElement('strong'); name.textContent = r.jobId;
    const chip = document.createElement('span'); chip.className = 'chip';
    const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
    const words = document.createElement('span'); words.textContent = r.status.label;
    chip.append(icon, words);
    chip.setAttribute('aria-label', r.status.announcement || r.status.label);
    what.append(name, chip, line(r.summary), line(`${t('askedAtLabel')}: ${r.askedAt || '—'} · ${t('requestIdLabel')}: ${r.requestId}`));
    li.append(what);
    return li;
  }));
}

function paint() {
  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.dataIoData?.userId ?? '';
  el('lang').textContent = t('langName');
  paintExport();
  paintImport();
}

function paintResult(id, presentation) {
  const box = el(id);
  if (!box) return;
  box.hidden = false;
  box.className = `result tone-${presentation.tone}`;
  el(`${id}-icon`).textContent = presentation.icon;
  el(`${id}-text`).textContent = presentation.label;
  box.setAttribute('aria-label', presentation.announcement || presentation.label);
}

function declaredTotal() {
  const raw = el('import-total').value.trim();
  if (raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

function renderPreview(preview) {
  const box = el('preview');
  box.hidden = false;
  box.className = `preview ${preview.commitReady ? 'ready' : 'notready'}`;
  box.replaceChildren();
  box.append(line(`${preview.validCount} ${t('previewValid')} · ${preview.errorRowCount} ${t('previewErrors')}`));
  for (const e of preview.errors.slice(0, 20)) box.append(line(`line ${e.line}: ${e.column} — ${e.message}`, 'errline'));
  box.append(line(preview.commitReady ? t('previewReady') : t('previewNotReady')));
}

/** What the import form currently says — the same four facts the approval and the load are bound to. */
function importInput() {
  return {
    templateId: el('import-template').value, text: el('import-file').value,
    jobId: el('import-job').value, declaredTotalMinor: declaredTotal(),
  };
}

/** Keep a write button from being pressed twice while its request is in flight. */
async function busy(id, work) {
  const btn = el(id);
  btn.disabled = true;
  try { await work(); } finally { btn.disabled = false; }
}

// The writes — export, ask for approval, load — each run ONLY from an explicit click, never on load. Checking a file
// is a read (it writes nothing) and also runs only on its click.
async function runExport(domain) {
  const r = await session.runExport(domain);
  paintResult('export-result', session.presentExportResult(lang, r));
  if (r === 'exported') await refresh();
}

// SF-10: a dated export sends the chosen days; head office decides whether the period is allowed and the page says
// its answer in plain words — the rows taken and what was hidden, or why nothing was taken.
async function runPeriodExport(domain) {
  if (typeof session.runPeriodExport !== 'function') return;
  const chosen = periodChosen.get(domain) ?? { from: '', to: '' };
  const r = await session.runPeriodExport(domain, { from: chosen.from, to: chosen.to });
  if (r.kind === 'exported') await refresh();
  paintResult('export-result', session.presentExportReply(lang, domain, r));
}

el('validate').addEventListener('click', () => {
  void (async () => {
    const r = await session.validate(el('import-template').value, el('import-file').value, declaredTotal());
    if (r === 'refused' || r === 'lost_link') { paintResult('validate-result', session.presentValidateResult(lang, r)); el('preview').hidden = true; return; }
    el('validate-result').hidden = true;
    renderPreview(r.preview);
  })();
});

// Ask for approval — the uploader's OWN request, in their own session, for this job and this exact file.
el('ask').addEventListener('click', () => {
  void busy('ask', async () => {
    const outcome = await session.askForApproval(lang, { ...importInput(), why: el('import-why').value });
    paintResult('ask-result', session.presentAskOutcome(lang, outcome));
    el('commit-result').hidden = true;
    if (outcome.kind === 'asked') { el('import-why').value = ''; await readRequests(); }
  });
});

// Load it — names the uploader's own APPROVED request for this job and file; never a typed approver.
el('commit').addEventListener('click', () => {
  void busy('commit', async () => {
    const outcome = await session.commit(importInput());
    paintResult('commit-result', session.presentLoadOutcome(lang, outcome));
    if (outcome.kind === 'committed') {
      el('import-file').value = ''; el('import-job').value = ''; el('import-why').value = ''; el('preview').hidden = true; el('ask-result').hidden = true;
    }
    if (outcome.kind !== 'lost_link') await readRequests();
  });
});

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang;
  void (async () => { paint(); await readRequests(); })();
});

el('sample').hidden = window.dataIoSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

/** Read the uploader's own load requests (a GET — read only) and draw them. */
async function readRequests() {
  if (typeof session.importRequests !== 'function') return;
  const view = await session.importRequests(lang);
  lastRequests = view.state === 'not_allowed' ? null : view;
  paintRequests();
}

// Read the export catalogue + log live (GETs — read-only). Offline it keeps the current view.
async function refresh() {
  const api = window.dataIo;
  if (!api || typeof api.refresh !== 'function') return;
  const live = await api.refresh();
  if (live) { session = api.present(live); paint(); }
}
void readRequests();
refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the screen still opens; it just will not be there without a network */ });
}
