// Document templates — the view layer (M01-FR-02, API-01, §28). Every rule lives in the TESTED session model
// (apps/web-erp/src/document-templates-session.ts), attached as window.documentTemplatesSession, built on
// packages/ui over the tested @sre/org template engine. This file only draws what the session hands it: the
// register (each kind's version in force — nothing in force is a warning), the chosen kind's versions with their
// state, and the draft form; then the three acts — DRAFT, APPROVE, PUBLISH — which run ONLY on an explicit click,
// never on load; on success the kind is re-read (a GET). No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Document templates', langName: 'தமிழ்',
      lead: 'Sample templates. Connect the store computer to see and change your own.',
      kindLabel: 'Document kind', loadBtn: 'Show the versions', registerHeading: 'In force now', versionsHeading: 'Versions', draftHeading: 'Draft the next version',
      inForce: 'in force', versionsCount: 'versions', headerLabel: 'Header lines (the store name first)', footerLabel: 'Footer lines', termsLabel: 'Standing terms (optional)',
      languageLabel: 'Language', paperLabel: 'Paper (receipts only)', noteLabel: 'What changed and why', limitsHint: 'At most 8 header lines, 6 footer lines, 20 terms lines; 64 characters a line.',
      draftBtn: 'Save as a draft', approveBtn: 'Approve', publishBtn: 'Publish', authoredByLabel: 'Drafted by', approvedByLabel: 'Approved by', publishedByLabel: 'Published by', noteHeading: 'Note', noVersions: 'No versions yet for this kind.',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'ஆவண வார்ப்புருக்கள்', langName: 'English',
      lead: 'மாதிரி வார்ப்புருக்கள். உங்களுடையதைப் பார்க்கவும் மாற்றவும் கடை கணினியை இணைக்கவும்.',
      kindLabel: 'ஆவண வகை', loadBtn: 'பதிப்புகளைக் காட்டு', registerHeading: 'இப்போது நடைமுறையில்', versionsHeading: 'பதிப்புகள்', draftHeading: 'அடுத்த பதிப்பை வரைவு செய்',
      inForce: 'நடைமுறையில்', versionsCount: 'பதிப்புகள்', headerLabel: 'தலைப்பு வரிகள்', footerLabel: 'அடிக்குறிப்பு வரிகள்', termsLabel: 'நிலையான நிபந்தனைகள்',
      languageLabel: 'மொழி', paperLabel: 'காகிதம்', noteLabel: 'என்ன மாறியது, ஏன்', limitsHint: 'அதிகபட்சம் 8 தலைப்பு வரிகள், 6 அடிக்குறிப்பு வரிகள், 20 நிபந்தனை வரிகள்; ஒரு வரிக்கு 64 எழுத்துகள்.',
      draftBtn: 'வரைவாகச் சேமி', approveBtn: 'ஒப்புதல்', publishBtn: 'வெளியிடு', authoredByLabel: 'வரைவு செய்தவர்', approvedByLabel: 'ஒப்புதல் அளித்தவர்', publishedByLabel: 'வெளியிட்டவர்', noteHeading: 'குறிப்பு', noVersions: 'இந்த வகைக்கு இன்னும் பதிப்புகள் இல்லை.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const ok = (label) => ({ tone: 'ok', icon: '✓', label, announcement: label, needsAttention: false });
  const version = (l) => ({
    kind: 'receipt', version: 1, state: 'published', header: ['SRE Hyper Market', 'GSTIN: 33ABCDE1234F1Z5'], footer: ['Thank you — please visit again'], terms: [],
    language: 'en_ta', languageLabel: l === 'ta' ? 'ஆங்கிலம் மற்றும் தமிழ்' : 'English and Tamil', paperFormat: 'thermal-80', note: 'first bill layout',
    authoredBy: 'owner', authoredAt: '2026-09-01T09:00:00Z', approvedBy: 'admin', publishedBy: 'owner', supersededBy: null,
    status: ok(l === 'ta' ? 'நடைமுறையில்' : 'In force'), mayApprove: false, approveWithheldWhy: null, mayPublish: false,
  });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: ok(''),
      kinds: [{ kind: 'receipt', kindLabel: l === 'ta' ? 'ரசீது' : 'Receipt', currentVersion: 1, versions: 1, status: ok(l === 'ta' ? 'v1 நடைமுறையில்' : 'v1 in force') }],
      chosenKind: 'receipt', chosenKindLabel: l === 'ta' ? 'ரசீது' : 'Receipt', versions: [version(l)], inForce: version(l), nobodyNamed: false, mayWrite: false,
      kindOptions: [{ kind: 'receipt', label: l === 'ta' ? 'ரசீது' : 'Receipt' }, { kind: 'invoice', label: l === 'ta' ? 'விலைப்பட்டியல்' : 'Invoice' }],
      languageOptions: [{ language: 'en', label: 'English' }, { language: 'ta', label: 'Tamil' }, { language: 'en_ta', label: 'English and Tamil' }],
      limits: { headerLines: 8, footerLines: 6, termsLines: 20, lineChars: 64 },
    }),
    draft: async () => ({ result: 'lost_link' }),
    approve: async () => ({ result: 'lost_link' }),
    publish: async () => ({ result: 'lost_link' }),
    presentActResult: () => ({ tone: 'degraded', icon: '⚠', label: 'No connection — not saved.', announcement: '', needsAttention: true }),
  };
}

let session = window.documentTemplatesSession ?? sampleSession();
let register = null;
let kindData = null;
const t = (key) => session.text(lang, key);

function statusNode(status) {
  const s = document.createElement('span');
  s.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = status.icon;
  const label = document.createElement('span'); label.textContent = status.label;
  s.append(icon, label);
  s.setAttribute('aria-label', status.announcement || status.label);
  return s;
}

function kindNode(k) {
  const li = document.createElement('li');
  li.className = `row tone-${k.status.tone}`;
  const head = document.createElement('div'); head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = k.kindLabel;
  const value = document.createElement('span'); value.className = 'value'; value.textContent = `${k.versions} ${t('versionsCount')}`;
  head.append(headline, value);
  li.append(head, statusNode(k.status));
  return li;
}

function versionNode(v) {
  const li = document.createElement('li');
  li.className = `row tone-${v.status.tone}`;
  li.dataset.version = String(v.version);
  const head = document.createElement('div'); head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = `v${v.version}`;
  const value = document.createElement('span'); value.className = 'value'; value.textContent = `${v.languageLabel}${v.paperFormat ? ` · ${v.paperFormat}` : ''}`;
  head.append(headline, value);
  const pre = document.createElement('pre');
  pre.textContent = [...v.header, '…', ...v.footer, ...(v.terms.length ? ['—', ...v.terms] : [])].join('\n');
  const facts = document.createElement('div'); facts.className = 'facts';
  const by = document.createElement('span'); by.textContent = `${t('authoredByLabel')}: ${v.authoredBy}`;
  facts.append(by);
  if (v.approvedBy) { const a = document.createElement('span'); a.textContent = `${t('approvedByLabel')}: ${v.approvedBy}`; facts.append(a); }
  if (v.publishedBy) { const p = document.createElement('span'); p.textContent = `${t('publishedByLabel')}: ${v.publishedBy}`; facts.append(p); }
  if (v.note) { const n = document.createElement('span'); n.textContent = `${t('noteHeading')}: ${v.note}`; facts.append(n); }
  li.append(head, statusNode(v.status), pre, facts);
  // The acts — offered exactly as the session decides (a draft to a SECOND person; an approved version to publish).
  const acts = document.createElement('div'); acts.className = 'acts';
  if (v.mayApprove) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'small act'; b.dataset.act = 'approve'; b.dataset.version = String(v.version); b.textContent = t('approveBtn');
    acts.append(b);
  }
  if (v.approveWithheldWhy) { const why = document.createElement('span'); why.className = 'why'; why.textContent = v.approveWithheldWhy; acts.append(why); }
  if (v.mayPublish) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'small act'; b.dataset.act = 'publish'; b.dataset.version = String(v.version); b.textContent = t('publishBtn');
    acts.append(b);
  }
  if (acts.childElementCount > 0) li.append(acts);
  return li;
}

function fillSelect(select, options, value, keep) {
  const current = keep ? select.value : value;
  select.replaceChildren(...options.map((o) => { const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label; return opt; }));
  if (current && options.some((o) => o.value === current)) select.value = current;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.documentTemplatesData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('kind-label').textContent = t('kindLabel');
  el('load').textContent = t('loadBtn');
  el('register-heading').textContent = t('registerHeading');
  el('versions-heading').textContent = view.chosenKindLabel ? `${t('versionsHeading')} — ${view.chosenKindLabel}` : t('versionsHeading');
  el('draft-heading').textContent = view.chosenKindLabel ? `${t('draftHeading')} — ${view.chosenKindLabel}` : t('draftHeading');

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  const permitted = view.screenState.tone !== 'error';
  fillSelect(el('kind'), view.kindOptions.map((o) => ({ value: o.kind, label: o.label })), view.chosenKind ?? view.kindOptions[0]?.kind, true);
  fillSelect(el('language'), view.languageOptions.map((o) => ({ value: o.language, label: o.label })), 'en_ta', true);

  el('register-heading').hidden = !permitted || view.kinds.length === 0;
  el('kinds').replaceChildren(...view.kinds.map((k) => kindNode(k)));

  const chosen = permitted && view.chosenKind !== null;
  el('versions-heading').hidden = !chosen;
  el('versions').replaceChildren(...view.versions.map((v) => versionNode(v)));
  el('no-versions').hidden = !(chosen && view.versions.length === 0);
  el('no-versions').textContent = t('noVersions');

  // The draft form — only for a user who holds platform.setup.write, and only once a kind is chosen.
  const mayDraft = chosen && view.mayWrite && !view.nobodyNamed;
  el('draft-heading').hidden = !mayDraft;
  el('draft-form').hidden = !mayDraft;
  el('header-label').textContent = t('headerLabel');
  el('footer-label').textContent = t('footerLabel');
  el('terms-label').textContent = t('termsLabel');
  el('language-label').textContent = t('languageLabel');
  el('paper-label').textContent = t('paperLabel');
  el('note-label').textContent = t('noteLabel');
  el('limits').textContent = t('limitsHint');
  el('draft').textContent = t('draftBtn');
  el('paper').disabled = view.chosenKind !== 'receipt';

  const state = el('state');
  if (!permitted || (view.kinds.length === 0 && view.versions.length === 0)) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
  } else {
    state.hidden = true;
  }
}

function paintResult(presentation) {
  const result = el('result');
  if (!result) return;
  result.hidden = false;
  result.className = `result tone-${presentation.tone}`;
  el('result-icon').textContent = presentation.icon;
  el('result-text').textContent = presentation.label;
  result.setAttribute('aria-label', presentation.announcement || presentation.label);
}

const draftForm = () => ({
  header: el('header').value, footer: el('footer').value, terms: el('terms').value,
  language: el('language').value, paperFormat: el('paper').value, note: el('note').value,
});

// The setup person's acts — HUMAN writes that run ONLY on these explicit clicks, never on load. On success the
// kind is re-read (a GET) so the versions shown are the cloud's. The server re-checks the permission and §28 and
// is idempotent on each act; the screen never fakes a version.
el('draft').addEventListener('click', () => {
  void (async () => {
    const result = await session.draft(el('kind').value, draftForm());
    paintResult(session.presentActResult(lang, result));
    if (result.result === 'drafted') { el('note').value = ''; await refreshKind(); }
  })();
});
el('versions').addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('button[data-act]') : null;
  if (!button) return;
  const version = Number(button.dataset.version);
  void (async () => {
    const result = button.dataset.act === 'approve'
      ? await session.approve(el('kind').value, version)
      : await session.publish(el('kind').value, version);
    paintResult(session.presentActResult(lang, result));
    if (result.result === 'approved' || result.result === 'published') await refreshAll();
  })();
});
el('load').addEventListener('click', () => { el('result').hidden = true; void refreshKind(); });
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.documentTemplatesSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the register and the chosen kind (GETs — read-only). Offline or refused, the screen keeps its current view
// and the stale strip already says the page is what the box last told it.
async function refreshKind() {
  const api = window.documentTemplates;
  if (!api || typeof api.refreshKind !== 'function') return;
  const data = await api.refreshKind(el('kind').value);
  if (data) { kindData = data; session = api.present(register, kindData); paint(); }
}
async function refreshAll() {
  const api = window.documentTemplates;
  if (!api || typeof api.refresh !== 'function') return;
  const reg = await api.refresh();
  if (reg) { register = reg; session = api.present(register, kindData); paint(); }
  await refreshKind();
}
refreshAll();

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
