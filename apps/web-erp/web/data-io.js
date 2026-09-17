// Data import & export console — the view layer (M30, API-03). Every rule lives in the TESTED session model
// (apps/web-erp/src/data-io-session.ts), attached as window.dataIoSession. This file only draws what the session
// hands it: the EXPORT panel (domains, which columns are sensitive, an Export button, the recent-exports log)
// and the IMPORT panel (template, file, Check → preview, then Load with a separate approver). Every write —
// export, validate, commit — runs ONLY on an explicit click, never on load. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Import & export', langName: 'தமிழ்', lead: 'Sample view. Connect the store computer to work with your own data.',
      exportHeading: 'Take data out', exportLead: 'Every export is logged; sensitive columns are hidden unless you may see them.', exportBtn: 'Export', sensitiveTag: 'sensitive', noExport: 'You do not have permission to export data.',
      recentHeading: 'Recent exports', recentEmpty: 'No exports yet.', rowsLabel: 'rows', redactedLabel: 'hidden columns',
      importHeading: 'Bring data in', importLead: 'Check a file, then a second person approves and loads it.', templateLabel: 'What are you loading', fileLabel: 'The file', filePlaceholder: 'sku,name,price', totalLabel: 'Declared total (paise)', validateBtn: 'Check the file',
      jobLabel: 'A name for this load', approverLabel: 'Approved by (not you)', commitBtn: 'Load it', noImport: 'You do not have permission to import data.',
      previewValid: 'ready to load', previewErrors: 'rows with a problem', previewReady: 'This file is ready.', previewNotReady: 'This file is not ready — fix the problems and check again.',
      exported: 'Exported.', exportRefused: 'Could not export.', exportLostLink: 'No connection — try again.',
      validateRefused: 'Could not check.', validateLostLink: 'No connection — try again.',
      committed: 'Loaded.', commitRefused: 'Could not load — a second person (not you) must approve it.', commitLostLink: 'No connection — try again.',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '',
    },
    ta: {
      title: 'இறக்குமதி & ஏற்றுமதி', langName: 'English', lead: 'மாதிரிக் காட்சி. உங்கள் சொந்தத் தரவுடன் வேலை செய்ய கடை கணினியை இணைக்கவும்.',
      exportHeading: 'தரவை வெளியே எடு', exportLead: 'ஒவ்வொரு ஏற்றுமதியும் பதிவு செய்யப்படும்; உணர்திறன் நெடுவரிசைகள் அனுமதி இருந்தால் மட்டுமே காட்டப்படும்.', exportBtn: 'ஏற்றுமதி', sensitiveTag: 'உணர்திறன்', noExport: 'ஏற்றுமதி செய்ய அனுமதி இல்லை.',
      recentHeading: 'சமீபத்திய ஏற்றுமதிகள்', recentEmpty: 'இதுவரை இல்லை.', rowsLabel: 'வரிசைகள்', redactedLabel: 'மறைக்கப்பட்டவை',
      importHeading: 'தரவை உள்ளே கொண்டு வா', importLead: 'கோப்பைச் சரிபார்த்து, இரண்டாம் நபர் அனுமதித்து ஏற்றுவார்.', templateLabel: 'எதை ஏற்றுகிறீர்கள்', fileLabel: 'கோப்பு', filePlaceholder: 'sku,name,price', totalLabel: 'அறிவிக்கப்பட்ட மொத்தம் (பைசா)', validateBtn: 'கோப்பைச் சரிபார்',
      jobLabel: 'இந்த ஏற்றத்திற்கு ஒரு பெயர்', approverLabel: 'அனுமதித்தவர் (நீங்கள் அல்ல)', commitBtn: 'ஏற்று', noImport: 'இறக்குமதி செய்ய அனுமதி இல்லை.',
      previewValid: 'ஏற்றத் தயார்', previewErrors: 'சிக்கல் உள்ள வரிசைகள்', previewReady: 'கோப்பு தயார்.', previewNotReady: 'தயாராக இல்லை — சிக்கல்களைச் சரிசெய்து மீண்டும் சரிபார்க்கவும்.',
      exported: 'ஏற்றுமதி செய்யப்பட்டது.', exportRefused: 'ஏற்றுமதி செய்ய முடியவில்லை.', exportLostLink: 'இணைப்பு இல்லை — மீண்டும் முயற்சிக்கவும்.',
      validateRefused: 'சரிபார்க்க முடியவில்லை.', validateLostLink: 'இணைப்பு இல்லை — மீண்டும் முயற்சிக்கவும்.',
      committed: 'ஏற்றப்பட்டது.', commitRefused: 'ஏற்ற முடியவில்லை — இரண்டாம் நபர் (நீங்கள் அல்ல) அனுமதிக்க வேண்டும்.', commitLostLink: 'இணைப்பு இல்லை — மீண்டும் முயற்சிக்கவும்.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '',
    },
  };
  const tone = (r, ok) => ({ tone: r === ok ? 'ok' : r === 'lost_link' ? 'degraded' : 'error', icon: r === ok ? '✓' : r === 'lost_link' ? '⚠' : '✕', label: '', announcement: '', needsAttention: r !== ok });
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
    commit: async () => 'lost_link',
    presentExportResult: (l, r) => tone(r, 'exported'),
    presentValidateResult: (l, r) => tone(r, '__never__'),
    presentCommitResult: (l, r) => tone(r, 'committed'),
  };
}

let session = window.dataIoSession ?? sampleSession();
const t = (key) => session.text(lang, key);

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
    btn.addEventListener('click', () => { void runExport(d.domain); });
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
  el('approver-label').textContent = t('approverLabel');
  el('import-approver').setAttribute('aria-label', t('approverLabel'));
  el('commit').textContent = t('commitBtn');
  el('import-template').replaceChildren(...view.templates.map((tpl) => { const o = document.createElement('option'); o.value = tpl.id; o.textContent = tpl.label; return o; }));
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

// The three writes — export, validate, commit — each run ONLY from an explicit click, never on load.
async function runExport(domain) {
  const r = await session.runExport(domain);
  paintResult('export-result', session.presentExportResult(lang, r));
  if (r === 'exported') await refresh();
}

el('validate').addEventListener('click', () => {
  void (async () => {
    const r = await session.validate(el('import-template').value, el('import-file').value, declaredTotal());
    if (r === 'refused' || r === 'lost_link') { paintResult('validate-result', session.presentValidateResult(lang, r)); el('preview').hidden = true; return; }
    el('validate-result').hidden = true;
    renderPreview(r);
  })();
});

el('commit').addEventListener('click', () => {
  void (async () => {
    const r = await session.commit({
      templateId: el('import-template').value, text: el('import-file').value,
      jobId: el('import-job').value, approver: el('import-approver').value, declaredTotalMinor: declaredTotal(),
    });
    paintResult('commit-result', session.presentCommitResult(lang, r));
    if (r === 'committed') { el('import-file').value = ''; el('import-job').value = ''; el('import-approver').value = ''; el('preview').hidden = true; }
  })();
});

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.dataIoSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the export catalogue + log live (GETs — read-only). Offline it keeps the current view.
async function refresh() {
  const api = window.dataIo;
  if (!api || typeof api.refresh !== 'function') return;
  const live = await api.refresh();
  if (live) { session = api.present(live); paint(); }
}
refresh();

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
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the screen still opens; it just will not be there without a network */ });
}
