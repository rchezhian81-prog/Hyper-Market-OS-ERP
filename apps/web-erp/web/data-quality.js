// Data quality suggestions inbox — the view layer (A08, API-13). Every rule lives in the TESTED session model
// (apps/web-erp/src/data-quality-inbox-session.ts), attached as window.dataQualityInboxSession, built on
// packages/ui over the tested buildDataQualityWorklist engine. This file only draws what the session hands it:
// the OPEN suggestions to look at (each with the real product, what to check, and — for a steward — a "not a
// problem" button with a reason box), then the DISMISSED ones set aside (each with who/why and a "bring back"
// button). Setting aside is a HUMAN decision that runs ONLY on an explicit click, never on load; on success
// the worklist is re-read (a GET) so the server-re-derived list moves the row. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Data quality', lead: 'Sample suggestions. Connect the store computer to see the helper’s findings for your own products.', langName: 'தமிழ்',
      openHeading: 'To look at', dismissedHeading: 'Set aside', openCount: 'to look at', dismissedCount: 'set aside',
      affectsLabel: 'Affects', dismissedByLabel: 'Set aside by', reasonLabel: 'Reason', allClear: 'Nothing to look at — your product list is clean.',
      dismissBtn: 'Not a problem', reopenBtn: 'Bring back', reasonPlaceholder: 'Why is this not a problem?',
      dismissRecorded: 'Set aside.', dismissRefused: 'Could not save — a short reason is needed.', dismissLostLink: 'No connection — not saved. Try again.',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'தரக் கட்டுப்பாடு', lead: 'மாதிரிப் பரிந்துரைகள். உங்கள் சொந்தப் பொருட்களுக்கான கண்டுபிடிப்புகளைப் பார்க்க கடை கணினியை இணைக்கவும்.', langName: 'English',
      openHeading: 'பார்க்க வேண்டியவை', dismissedHeading: 'ஒதுக்கப்பட்டவை', openCount: 'பார்க்க வேண்டியவை', dismissedCount: 'ஒதுக்கப்பட்டவை',
      affectsLabel: 'பாதிக்கிறது', dismissedByLabel: 'ஒதுக்கியவர்', reasonLabel: 'காரணம்', allClear: 'பார்க்க எதுவும் இல்லை — உங்கள் பொருள் பட்டியல் சுத்தமாக உள்ளது.',
      dismissBtn: 'சிக்கல் இல்லை', reopenBtn: 'மீண்டும் கொண்டுவா', reasonPlaceholder: 'இது ஏன் சிக்கல் இல்லை?',
      dismissRecorded: 'ஒதுக்கப்பட்டது.', dismissRefused: 'சேமிக்க முடியவில்லை — ஒரு சிறு காரணம் தேவை.', dismissLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const openRow = (l) => ({
    findingId: 'sample-barcode', kind: 'missing_barcode', needsAttention: true,
    headline: l === 'ta' ? '"தூள் அவல்" பார்கோடு இல்லை' : '"Loose Poha" has no barcode',
    detail: l === 'ta' ? 'ஒவ்வொரு விற்பனையிலும் கைமுறையாகத் தேட வேண்டும் — பார்கோடு சேர்க்கவும்.' : 'A cashier must search for it by hand on every sale — assign its barcode.',
    affects: ['Loose Poha (SKU-NOSCAN)'],
    status: { tone: 'degraded', icon: '▦', label: l === 'ta' ? 'பார்கோடு இல்லை' : 'No barcode — cannot be scanned', announcement: 'Loose Poha', needsAttention: true },
  });
  const mappingRow = (l) => ({
    findingId: 'sample-mapping', kind: 'suspicious_mapping', needsAttention: true,
    headline: l === 'ta' ? '"acme-foods" இறக்குமதிகள் "hsn" நெடுவரிசையில் தொடர்ந்து தோல்வி' : 'Imports from "acme-foods" keep failing on the "hsn" column',
    detail: l === 'ta' ? 'இந்தச் சப்ளையரின் "hsn" குறியீடுகளை நாம் அடையாளம் காணவில்லை — அவர்களுடன் ஒரு குறியீட்டுப் பட்டியலை ஒப்புக்கொள்ளுங்கள்.' : 'We do not recognise this supplier’s "hsn" codes — agree a code list with them.',
    affects: ['acme-foods — "hsn" column'],
    status: { tone: 'degraded', icon: '⇄', label: l === 'ta' ? 'சப்ளையர் கோப்பு ஒரு நெடுவரிசையில் தொடர்ந்து தோல்வி' : 'Supplier file keeps failing on a column', announcement: 'acme-foods', needsAttention: true },
  });
  const dismissedRow = (l) => ({
    findingId: 'sample-dup', kind: 'suspected_duplicate', needsAttention: false,
    headline: l === 'ta' ? 'நகல் போல் தெரிந்தது' : 'Looked like a duplicate', detail: '', affects: ['Aashirvaad Atta 5kg (SKU-ATTA-1)'],
    dismissedBy: 'manager', dismissedReason: l === 'ta' ? 'வெவ்வேறு அளவுகள்' : 'genuinely different pack sizes',
    status: { tone: 'idle', icon: '✓', label: l === 'ta' ? 'ஒதுக்கப்பட்டது — சிக்கல் இல்லை' : 'Set aside — not a problem', announcement: 'set aside', needsAttention: false },
  });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      agentActive: true, open: [openRow(l), mappingRow(l)], dismissed: [dismissedRow(l)], openCount: 2, dismissedCount: 1, nobodyNamed: false, mayDismiss: true,
    }),
    dismiss: async () => 'lost_link',
    reopen: async () => 'lost_link',
    presentDismissResult: (l, outcome) => ({ tone: outcome === 'recorded' ? 'ok' : 'degraded', icon: outcome === 'recorded' ? '✓' : '⚠', label: '', announcement: '', needsAttention: outcome !== 'recorded' }),
  };
}

let session = window.dataQualityInboxSession ?? sampleSession();
const t = (key) => session.text(lang, key);

/** Run a steward action, show its result, and — on success — re-read the worklist so the row moves. */
async function act(run) {
  const outcome = await run();
  paintResult(session.presentDismissResult(lang, outcome));
  if (outcome === 'recorded') await refresh();
}

function rowNode(r, mayDismiss, isOpen) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = r.headline;
  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);
  head.append(headline, status);
  li.append(head);

  if (r.detail) { const d = document.createElement('p'); d.className = 'detail'; d.textContent = r.detail; li.append(d); }
  if (r.affects && r.affects.length > 0) {
    const a = document.createElement('p'); a.className = 'affects'; a.textContent = `${t('affectsLabel')}: ${r.affects.join(', ')}`; li.append(a);
  }
  if (r.dismissedReason) {
    const w = document.createElement('p'); w.className = 'why';
    w.textContent = `${t('dismissedByLabel')} ${r.dismissedBy ?? ''} — ${t('reasonLabel')}: ${r.dismissedReason}`;
    li.append(w);
  }

  // The steward's action. Only rendered for someone who holds the permission, and it runs ONLY on a click.
  if (mayDismiss && isOpen) {
    const actions = document.createElement('div'); actions.className = 'actions';
    const reason = document.createElement('input'); reason.type = 'text'; reason.className = 'reason';
    reason.setAttribute('aria-label', t('reasonPlaceholder')); reason.placeholder = t('reasonPlaceholder');
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'act dismiss'; btn.textContent = t('dismissBtn');
    btn.addEventListener('click', () => act(() => session.dismiss(r.findingId, reason.value)));
    actions.append(reason, btn);
    li.append(actions);
  } else if (mayDismiss && !isOpen) {
    const actions = document.createElement('div'); actions.className = 'actions';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'act reopen'; btn.textContent = t('reopenBtn');
    btn.addEventListener('click', () => act(() => session.reopen(r.findingId)));
    actions.append(btn);
    li.append(actions);
  }
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.dataQualityInboxData?.userId ?? '';
  el('lang').textContent = t('langName');

  el('open-count').textContent = view.openCount === 0
    ? (view.dismissedCount === 0 && view.agentActive ? t('allClear') : '')
    : `${view.openCount} ${t('openCount')}`;
  el('dismissed-count').textContent = view.dismissedCount === 0 ? '' : `${view.dismissedCount} ${t('dismissedCount')}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('open-heading').hidden = view.open.length === 0;
  el('open-heading').textContent = t('openHeading');
  el('rows').replaceChildren(...view.open.map((r) => rowNode(r, view.mayDismiss, true)));

  el('dismissed-heading').hidden = view.dismissed.length === 0;
  el('dismissed-heading').textContent = t('dismissedHeading');
  el('dismissed-rows').replaceChildren(...view.dismissed.map((r) => rowNode(r, view.mayDismiss, false)));

  const state = el('state');
  if (view.open.length === 0 && view.dismissed.length === 0) {
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

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.dataQualityInboxSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live worklist (a GET — read-only). Offline or refused, the screen keeps its current view and the
// stale strip already says the page is what the box last told it.
async function refresh() {
  const api = window.dataQualityInbox;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data) { session = api.present(data); paint(); }
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
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
