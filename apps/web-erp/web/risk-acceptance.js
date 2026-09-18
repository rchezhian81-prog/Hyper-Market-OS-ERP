// Risk-acceptance / compliance-gates — the view layer (M34-FR-04, API-11). Every rule lives in the TESTED
// session model (apps/web-erp/src/risk-acceptance-session.ts), attached as window.riskAcceptanceSession, built
// on packages/ui. This file only draws what the session hands it: the gates blocked by an open critical risk
// (each with the gate, the risk, its owner and why it blocks), then an "accept a risk" form. Accepting is a
// HUMAN decision that runs ONLY on an explicit click, never on load; on success the worklist is re-read (a GET)
// so the accepted risk's blocked gates drop off. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Risk acceptance', langName: 'தமிழ்',
      lead: 'Sample blocked gates. Connect the store computer to see your own compliance gates.',
      openHeading: 'Blocking a gate', blockedCount: 'gates blocked', gatesLabel: 'Blocked gates', allClear: 'No gates blocked — every gate can pass.',
      gateLabel: 'Gate', riskLabel: 'Risk', ownerLabel: 'Risk owner', reasonLabel: 'Why it blocks',
      acceptHeading: 'Accept a risk', riskChoiceLabel: 'Which risk', rationaleLabel: 'Why you are accepting it (this is the record)',
      rationalePlaceholder: 'Why is the business knowingly carrying this risk?', acceptBtn: 'Accept the risk',
      acceptRecorded: 'Risk accepted.', acceptRefused: 'Could not accept — check the reason and your permission.', acceptLostLink: 'No connection — not saved. Try again.',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'இடர் ஏற்பு', langName: 'English',
      lead: 'மாதிரி தடுக்கப்பட்ட வாயில்கள். உங்கள் இணக்க வாயில்களைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      openHeading: 'ஒரு வாயிலைத் தடுக்கிறது', blockedCount: 'வாயில்கள் தடுக்கப்பட்டன', gatesLabel: 'தடுக்கப்பட்ட வாயில்கள்', allClear: 'தடுக்கப்பட்ட வாயில்கள் இல்லை — எல்லா வாயில்களும் கடக்கலாம்.',
      gateLabel: 'வாயில்', riskLabel: 'இடர்', ownerLabel: 'இடர் உரிமையாளர்', reasonLabel: 'ஏன் தடுக்கிறது',
      acceptHeading: 'ஒரு இடரை ஏற்று', riskChoiceLabel: 'எந்த இடர்', rationaleLabel: 'நீங்கள் ஏன் ஏற்கிறீர்கள் (இதுவே பதிவு)',
      rationalePlaceholder: 'இந்த இடரை வணிகம் ஏன் அறிந்தே சுமக்கிறது?', acceptBtn: 'இடரை ஏற்று',
      acceptRecorded: 'இடர் ஏற்கப்பட்டது.', acceptRefused: 'ஏற்க முடியவில்லை — காரணத்தையும் அனுமதியையும் சரிபார்க்கவும்.', acceptLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const sampleRow = (l) => ({
    gate: 'QG-04', riskId: 'sample-risk-1', title: l === 'ta' ? 'குறியாக்கம் இல்லாத காப்புப்பிரதிகள்' : 'Unencrypted backups',
    severity: l === 'ta' ? 'தீவிரம்' : 'Critical', ownerUserId: 'seclead', reason: l === 'ta' ? 'திறந்த தீவிர இடர்' : 'open critical risk on this gate', needsAttention: true,
    status: { tone: 'degraded', icon: '⚠', label: l === 'ta' ? 'தீவிரம்' : 'Critical', announcement: 'critical', needsAttention: true },
  });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      blocked: [sampleRow(l)], blockedCount: 1,
      risks: [{ riskId: 'sample-risk-1', label: (l === 'ta' ? 'குறியாக்கம் இல்லாத காப்புப்பிரதிகள்' : 'Unencrypted backups') + ' (sample-risk-1)' }],
      nobodyNamed: false, mayManage: true,
    }),
    accept: async () => 'lost_link',
    presentAcceptResult: (l, result) => ({ tone: result === 'accepted' ? 'ok' : result === 'lost_link' ? 'degraded' : 'error', icon: result === 'accepted' ? '✓' : result === 'lost_link' ? '⚠' : '✕', label: '', announcement: '', needsAttention: result !== 'accepted' }),
  };
}

let session = window.riskAcceptanceSession ?? sampleSession();
const t = (key) => session.text(lang, key);

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = r.title;
  const gate = document.createElement('span'); gate.className = 'gate'; gate.textContent = r.gate;
  head.append(headline, gate);

  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);

  const facts = document.createElement('div'); facts.className = 'facts';
  const owner = document.createElement('span'); owner.textContent = `${t('ownerLabel')}: ${r.ownerUserId}`;
  const reason = document.createElement('span'); reason.textContent = `${t('reasonLabel')}: ${r.reason}`;
  facts.append(owner, reason);

  li.append(head, status, facts);
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.riskAcceptanceData?.userId ?? '';
  el('lang').textContent = t('langName');

  el('open-count').textContent = view.blockedCount === 0 ? t('allClear') : `${view.blockedCount} ${t('blockedCount')}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('open-heading').hidden = view.blocked.length === 0;
  el('open-heading').textContent = t('openHeading');
  el('rows').replaceChildren(...view.blocked.map((r) => rowNode(r)));

  // The accept form — only for a compliance owner who holds compliance.risk.manage, and only when there is a
  // risk to accept.
  const accepter = el('accepter');
  const canAccept = view.mayManage && view.risks.length > 0 && !view.nobodyNamed;
  accepter.hidden = !canAccept;
  if (canAccept) {
    el('accept-heading').textContent = t('acceptHeading');
    el('accept-risk-label').textContent = t('riskChoiceLabel');
    el('accept-rationale-label').textContent = t('rationaleLabel');
    el('accept-rationale').setAttribute('aria-label', t('rationaleLabel'));
    el('accept-rationale').placeholder = t('rationalePlaceholder');
    el('accept').textContent = t('acceptBtn');
    el('accept-risk').replaceChildren(...view.risks.map((rk) => {
      const o = document.createElement('option'); o.value = rk.riskId; o.textContent = rk.label; return o;
    }));
  }

  const state = el('state');
  if (view.blocked.length === 0) {
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

// The accepter's decision — a HUMAN write that runs ONLY on this explicit click, never on load. On success the
// worklist is re-read (a GET) so the accepted risk's blocked gates drop off. The server records the acceptance
// in the caller's own name and enforces the name+reason rule; the screen never fabricates the reason.
el('accept').addEventListener('click', () => {
  void (async () => {
    const riskId = el('accept-risk').value;
    const rationale = el('accept-rationale').value;
    const result = await session.accept(riskId, rationale);
    paintResult(session.presentAcceptResult(lang, result));
    if (result === 'accepted') { el('accept-rationale').value = ''; await refresh(); }
  })();
});
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.riskAcceptanceSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live blocked-gates worklist (a GET — read-only). Offline or refused, the screen keeps its current
// view and the stale strip already says the page is what the box last told it.
async function refresh() {
  const api = window.riskAcceptance;
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
