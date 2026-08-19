// Products waiting to publish — the view layer (ADR-0013 slice 4). Every rule lives in the TESTED session
// model (apps/web-erp/src/product-publish-review-session.ts), attached as window.productPublishReviewSession,
// built on packages/ui + the tested classifier/delivery engines. This file only draws what the session hands
// it: the queued publishes, the ones needing a person first, each with a status that is never a bare colour
// (an icon + a word ride with it). Publishing is a SEPARATE action — the button calls session.deliver(), which
// sends only the READY items as the signed-in operator; nothing publishes on load. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Products to publish', lead: 'Sample queue. Connect the store computer to see your own products waiting to publish.', langName: 'தமிழ்',
      readyCount: 'ready to publish', attentionCount: 'need a person', allClear: 'Nothing is waiting — the catalogue is up to date.',
      deliverBtn: 'Publish the ready ones', deliverNone: 'Nothing is ready to publish',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'வெளியிட வேண்டிய பொருட்கள்', lead: 'மாதிரி வரிசை. உங்கள் சொந்தப் பொருட்களைப் பார்க்க கடை கணினியை இணைக்கவும்.', langName: 'English',
      readyCount: 'வெளியிட தயார்', attentionCount: 'ஒருவர் தேவை', allClear: 'எதுவும் காத்திருக்கவில்லை — பட்டியல் புதுப்பித்த நிலையில் உள்ளது.',
      deliverBtn: 'தயாராக உள்ளவற்றை வெளியிடு', deliverNone: 'வெளியிட எதுவும் தயாராக இல்லை',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const row = (by, when, tone, icon, statusLabel, state, needsAttention, detail) => ({
    key: `${by}-${when}`, createdBy: by, createdAt: when, tenantId: 't', state, needsAttention,
    deliverable: state === 'ready', detail: detail ?? '',
    status: { tone, icon, label: statusLabel, announcement: `${by}: ${statusLabel}`, needsAttention },
  });
  const rows = (l) => l === 'ta'
    ? [row('கடை உரிமையாளர்', '2026-08-18T06:00', 'degraded', '⚠', 'அதிகாரம் உள்ளவர் தேவை', 'approval_required', true, 'அதிகாரம் உள்ள ஒருவருக்கு அனுப்பப்பட்டுள்ளது.'), row('கடை உரிமையாளர்', '2026-08-18T07:00', 'ok', '✓', 'வெளியிட தயார்', 'ready', false, '')]
    : [row('shop owner', '2026-08-18T06:00', 'degraded', '⚠', 'Needs someone with authority', 'approval_required', true, 'Routed to someone who holds the authority.'), row('shop owner', '2026-08-18T07:00', 'ok', '✓', 'Ready to publish', 'ready', false, '')];
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => {
      const r = rows(l);
      return {
        screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
        rows: r, counts: {}, readyCount: r.filter((x) => x.deliverable).length,
        attentionCount: r.filter((x) => x.needsAttention).length, total: r.length, nobodyNamed: false,
      };
    },
    presentDeliveryReport: (l, report) => ({ tone: 'ok', icon: '✓', label: `${report.delivered.length} published`, announcement: '', needsAttention: false }),
    deliver: async () => ({ delivered: [], held: [], refused: [], skipped: [] }),
  };
}

const real = window.productPublishReviewSession;
const session = real ?? sampleSession();
const t = (key) => session.text(lang, key);

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const by = document.createElement('span'); by.className = 'by'; by.textContent = r.createdBy;
  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);
  head.append(by, status);
  li.append(head);

  const when = document.createElement('div'); when.className = 'when'; when.textContent = r.createdAt;
  li.append(when);

  if (r.detail) { const d = document.createElement('p'); d.className = 'detail'; d.textContent = r.detail; li.append(d); }
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.productPublishReviewData?.userId ?? '';
  el('lang').textContent = t('langName');

  el('ready-count').textContent = view.readyCount === 0 ? '' : `${view.readyCount} ${t('readyCount')}`;
  el('attention-count').textContent = view.attentionCount === 0
    ? (view.total === 0 ? t('allClear') : '')
    : `${view.attentionCount} ${t('attentionCount')}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('rows').replaceChildren(...view.rows.map(rowNode));

  const state = el('state');
  if (view.rows.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
  } else {
    state.hidden = true;
  }

  // The deliver button appears only when something is actually ready — never a button that does nothing.
  const deliver = el('deliver');
  deliver.hidden = view.total === 0;
  deliver.disabled = view.readyCount === 0;
  deliver.textContent = view.readyCount === 0 ? t('deliverNone') : t('deliverBtn');
}

function paintResult(presentation) {
  const result = el('result');
  result.hidden = false;
  result.className = `result tone-${presentation.tone}`;
  el('result-icon').textContent = presentation.icon;
  el('result-text').textContent = presentation.label;
  result.setAttribute('aria-label', presentation.announcement || presentation.label);
}

let delivering = false;
el('deliver').addEventListener('click', async () => {
  if (delivering) return; // one publish at a time — a double-click cannot double-send (the outbox dedupes too)
  delivering = true;
  el('deliver').disabled = true;
  try {
    const report = await session.deliver();
    paintResult(session.presentDeliveryReport(lang, report));
  } finally {
    delivering = false;
    paint(); // re-classify: acknowledged items drop off, held ones stay, refused ones show as refused
  }
});

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = real !== undefined;
el('sample').textContent = t('sampleData');
paint();

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
