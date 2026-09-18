// Cash-office over/short sign-off — the view layer (M14-FR-02, API-05). Every rule lives in the TESTED session
// model (apps/web-erp/src/cash-office-session.ts), attached as window.cashOfficeSession, built on packages/ui.
// This file only draws what the session hands it: the OPEN over/shorts (biggest first, each marked Over/Short
// with the till, who counted it and the cashier's reason), then a "sign off" form (shift, coded finding, note).
// Signing off is a HUMAN decision that runs ONLY on an explicit click, never on load; on success the worklist is
// re-read (a GET) so the signed-off row drops off. A reviewer may not sign off their own drawer (§28). No
// prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Over / short sign-off', langName: 'தமிழ்',
      lead: 'Sample over/shorts. Connect the store computer to account for your own shop’s drawers.',
      openHeading: 'To account for', openCount: 'to account for', exposureLabel: 'Net over/short', allClear: 'No over/shorts to account for — every drawer is signed off.',
      tillLabel: 'Till', cashierLabel: 'Counted by', dayLabel: 'Trading day', reasonLabel: 'Cashier’s reason', yourDrawer: 'You counted this drawer — someone else must sign it off.',
      signHeading: 'Sign off an over/short', shiftLabel: 'Which shift', dispositionLabel: 'Your finding', noteLabel: 'Note (optional)',
      notePlaceholder: 'Anything the finding does not already say.', signBtn: 'Sign it off',
      signRecorded: 'Signed off.', signRefused: 'Could not sign off — a different person must sign it, with a finding; or you do not have permission.', signLostLink: 'No connection — not saved. Try again.',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'கூடுதல் / குறைவு கையொப்பம்', langName: 'English',
      lead: 'மாதிரி கூடுதல்/குறைவுகள். உங்கள் கடையின் பணப்பெட்டிகளுக்கு விளக்கம் அளிக்க கடை கணினியை இணைக்கவும்.',
      openHeading: 'விளக்கம் அளிக்க வேண்டியவை', openCount: 'விளக்கம் அளிக்க', exposureLabel: 'நிகர கூடுதல்/குறைவு', allClear: 'விளக்கம் அளிக்க கூடுதல்/குறைவு இல்லை — எல்லா பணப்பெட்டிகளும் கையொப்பமிடப்பட்டன.',
      tillLabel: 'பணப்பெட்டி', cashierLabel: 'எண்ணியவர்', dayLabel: 'வர்த்தக நாள்', reasonLabel: 'காசாளர் காரணம்', yourDrawer: 'இந்தப் பணப்பெட்டியை நீங்கள் எண்ணினீர்கள் — வேறொருவர் கையொப்பமிட வேண்டும்.',
      signHeading: 'ஒரு கூடுதல்/குறைவைக் கையொப்பமிடு', shiftLabel: 'எந்த ஷிப்ட்', dispositionLabel: 'உங்கள் கண்டுபிடிப்பு', noteLabel: 'குறிப்பு (விருப்பம்)',
      notePlaceholder: 'கண்டுபிடிப்பு சொல்லாதது ஏதேனும் இருந்தால்.', signBtn: 'கையொப்பமிடு',
      signRecorded: 'கையொப்பமிடப்பட்டது.', signRefused: 'கையொப்பமிட முடியவில்லை — வேறொருவர் ஒரு கண்டுபிடிப்புடன் கையொப்பமிட வேண்டும்; அல்லது உங்களுக்கு அனுமதி இல்லை.', signLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const sampleRow = (l) => ({
    shiftId: 'sample-till-3', tillId: 'till-3', cashierId: 'cashier', tradingDay: '2026-09-17',
    direction: l === 'ta' ? 'குறைவு' : 'Short', amount: '₹1,200.00', varianceMinor: -120000,
    reasonCode: 'gave_wrong_change', isOwnDrawer: false, needsAttention: true,
    status: { tone: 'degraded', icon: '⚠', label: l === 'ta' ? 'குறைவு' : 'Short', announcement: 'short', needsAttention: true },
  });
  const DISPOSITIONS = [
    { value: 'miscount', label: { en: 'Miscount at the drawer', ta: 'பணப்பெட்டியில் தவறான எண்ணிக்கை' } },
    { value: 'change_error', label: { en: 'Change / keying error', ta: 'சில்லறை / உள்ளீட்டுப் பிழை' } },
    { value: 'banking_variance', label: { en: 'Banking / float variance', ta: 'வங்கி / மிதப்பு வேறுபாடு' } },
    { value: 'unexplained', label: { en: 'Unexplained — needs follow-up', ta: 'விளக்கமில்லை — தொடர் நடவடிக்கை தேவை' } },
    { value: 'theft_suspected', label: { en: 'Suspected theft', ta: 'திருட்டு சந்தேகம்' } },
  ];
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      open: [sampleRow(l)], openCount: 1, totalVariance: '-₹1,200.00', totalVarianceMinor: -120000, nobodyNamed: false, mayReview: true,
    }),
    dispositionOptions: (l) => DISPOSITIONS.map((d) => ({ value: d.value, label: d.label[l] ?? d.label.en })),
    signOff: async () => 'lost_link',
    presentSignOffResult: (l, result) => ({ tone: result === 'signed' ? 'ok' : result === 'lost_link' ? 'degraded' : 'error', icon: result === 'signed' ? '✓' : result === 'lost_link' ? '⚠' : '✕', label: '', announcement: '', needsAttention: result !== 'signed' }),
  };
}

let session = window.cashOfficeSession ?? sampleSession();
const t = (key) => session.text(lang, key);

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = `${r.direction} — ${r.tillId}`;
  const value = document.createElement('span'); value.className = 'value'; value.textContent = r.amount;
  head.append(headline, value);

  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);

  const facts = document.createElement('div'); facts.className = 'facts';
  const cby = document.createElement('span'); cby.textContent = `${t('cashierLabel')}: ${r.cashierId}`;
  const day = document.createElement('span'); day.textContent = `${t('dayLabel')}: ${r.tradingDay}`;
  facts.append(cby, day);
  if (r.reasonCode) { const rc = document.createElement('span'); rc.textContent = `${t('reasonLabel')}: ${r.reasonCode}`; facts.append(rc); }

  li.append(head, status, facts);
  if (r.isOwnDrawer) { const own = document.createElement('div'); own.className = 'own'; own.textContent = t('yourDrawer'); li.append(own); }
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.cashOfficeData?.userId ?? '';
  el('lang').textContent = t('langName');

  el('open-count').textContent = view.openCount === 0 ? t('allClear') : `${view.openCount} ${t('openCount')}`;
  el('exposure').textContent = view.openCount === 0 ? '' : `${t('exposureLabel')}: ${view.totalVariance}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('open-heading').hidden = view.open.length === 0;
  el('open-heading').textContent = t('openHeading');
  el('rows').replaceChildren(...view.open.map((r) => rowNode(r)));

  // The sign-off form — only for a reviewer who holds till.overshort.review, and only when there is a row to
  // sign off. A drawer the reviewer counted is still listed (so nothing is hidden), but signing it is refused
  // by the session (§28) — the result strip says so.
  const signer = el('signer');
  const canSign = view.mayReview && view.open.length > 0 && !view.nobodyNamed;
  signer.hidden = !canSign;
  if (canSign) {
    el('sign-heading').textContent = t('signHeading');
    el('sign-shift-label').textContent = t('shiftLabel');
    el('sign-disposition-label').textContent = t('dispositionLabel');
    el('sign-note-label').textContent = t('noteLabel');
    el('sign-note').setAttribute('aria-label', t('noteLabel'));
    el('sign-note').placeholder = t('notePlaceholder');
    el('sign').textContent = t('signBtn');
    el('sign-shift').replaceChildren(...view.open.map((r) => {
      const o = document.createElement('option'); o.value = r.shiftId; o.textContent = `${r.direction} ${r.amount} — ${r.tillId} (${r.tradingDay})`; return o;
    }));
    el('sign-disposition').replaceChildren(...session.dispositionOptions(lang).map((opt) => {
      const o = document.createElement('option'); o.value = opt.value; o.textContent = opt.label; return o;
    }));
  }

  const state = el('state');
  if (view.open.length === 0) {
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

// The reviewer's sign-off — a HUMAN write that runs ONLY on this explicit click, never on load. On success the
// worklist is re-read (a GET) so the signed-off row drops off. The server enforces §28 (reviewer ≠ cashier);
// the screen refuses an own-drawer sign-off locally too and never sends a self-review.
el('sign').addEventListener('click', () => {
  void (async () => {
    const shiftId = el('sign-shift').value;
    const disposition = el('sign-disposition').value;
    const note = el('sign-note').value;
    const result = await session.signOff(shiftId, disposition, note);
    paintResult(session.presentSignOffResult(lang, result));
    if (result === 'signed') { el('sign-note').value = ''; await refresh(); }
  })();
});
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.cashOfficeSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live worklist (a GET — read-only). Offline or refused, the screen keeps its current view and the
// stale strip already says the page is what the box last told it.
async function refresh() {
  const api = window.cashOffice;
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
