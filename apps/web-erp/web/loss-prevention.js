// Loss-prevention investigations inbox — the view layer (M15-FR-04, API-05). Every rule lives in the TESTED
// session model (apps/web-erp/src/loss-prevention-inbox-session.ts), attached as window.lossPreventionInboxSession,
// built on packages/ui over the tested buildOpenCaseWorklist. This file only draws what the session hands it: the
// OPEN investigations (biggest money at stake first, each with the subject reference — never a name — the value,
// evidence count and who it is assigned to), then a "close a case" form. Closing is a HUMAN decision that runs
// ONLY on an explicit click, never on load; on success the worklist is re-read (a GET) so the closed case drops
// off. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Investigations', langName: 'தமிழ்',
      lead: 'Sample investigations. Connect the store computer to see the open cases for your own shop.',
      openHeading: 'To investigate', openCount: 'to investigate', exposureLabel: 'Total at stake', allClear: 'No open investigations — nothing outstanding.',
      subjectLabel: 'Subject', valueLabel: 'Value at stake', evidenceLabel: 'Evidence on file', assignedLabel: 'Assigned to',
      closeHeading: 'Close an investigation', caseLabel: 'Which case', outcomeLabel: 'Outcome', noteLabel: 'What you concluded (this is the record)',
      notePlaceholder: 'What did you find, and why this outcome?', closeBtn: 'Close the case',
      closeRecorded: 'Case closed.', closeRefused: 'Could not close — check the outcome, note and your permission.', closeLostLink: 'No connection — not saved. Try again.',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'விசாரணைகள்', langName: 'English',
      lead: 'மாதிரி விசாரணைகள். உங்கள் கடையின் திறந்த வழக்குகளைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      openHeading: 'விசாரிக்க வேண்டியவை', openCount: 'விசாரிக்க வேண்டியவை', exposureLabel: 'மொத்த ஆபத்து', allClear: 'திறந்த விசாரணைகள் இல்லை — நிலுவையில் எதுவும் இல்லை.',
      subjectLabel: 'பொருள்', valueLabel: 'ஆபத்தில் உள்ள மதிப்பு', evidenceLabel: 'கோப்பில் ஆதாரம்', assignedLabel: 'ஒப்படைக்கப்பட்டவர்',
      closeHeading: 'ஒரு விசாரணையை மூடு', caseLabel: 'எந்த வழக்கு', outcomeLabel: 'முடிவு', noteLabel: 'நீங்கள் முடிவு செய்தது (இதுவே பதிவு)',
      notePlaceholder: 'என்ன கண்டீர்கள், ஏன் இந்த முடிவு?', closeBtn: 'வழக்கை மூடு',
      closeRecorded: 'வழக்கு மூடப்பட்டது.', closeRefused: 'மூட முடியவில்லை — முடிவு, குறிப்பு, அனுமதியைச் சரிபார்க்கவும்.', closeLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const sampleRow = (l) => ({
    caseId: 'sample-till-3', subjectRef: 'SUBJ-till-3', needsAttention: true,
    summary: l === 'ta' ? 'பணப்பெட்டி 3 மூடும்போது ₹1,200 குறைவு' : 'Till 3 came up ₹1,200 short at close',
    value: '₹1,200.00', valueMinor: 120000, assignedTo: 'manager', raisedFromRef: 'shift-close:till-3', openedBy: 'system', openedAt: '', evidenceCount: 0,
    status: { tone: 'degraded', icon: '⚠', label: l === 'ta' ? 'திறந்தது' : 'Open', announcement: 'open', needsAttention: true },
  });
  const OUTCOMES = [
    { value: 'proven', label: { en: 'Proven', ta: 'நிரூபிக்கப்பட்டது' } },
    { value: 'unfounded', label: { en: 'Unfounded', ta: 'ஆதாரமற்றது' } },
    { value: 'inconclusive', label: { en: 'Inconclusive', ta: 'முடிவில்லாதது' } },
    { value: 'process_failure', label: { en: 'A process failed (not a person)', ta: 'ஒரு செயல்முறை தோல்வி (நபர் அல்ல)' } },
    { value: 'referred_to_police', label: { en: 'Referred to the police', ta: 'காவல்துறைக்கு அனுப்பப்பட்டது' } },
  ];
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      open: [sampleRow(l)], openCount: 1, totalValue: '₹1,200.00', totalValueMinor: 120000, nobodyNamed: false, mayManage: true,
    }),
    outcomeOptions: (l) => OUTCOMES.map((o) => ({ value: o.value, label: o.label[l] ?? o.label.en })),
    close: async () => 'lost_link',
    presentCloseResult: (l, outcome) => ({ tone: outcome === 'closed' ? 'ok' : outcome === 'lost_link' ? 'degraded' : 'error', icon: outcome === 'closed' ? '✓' : outcome === 'lost_link' ? '⚠' : '✕', label: '', announcement: '', needsAttention: outcome !== 'closed' }),
  };
}

let session = window.lossPreventionInboxSession ?? sampleSession();
const t = (key) => session.text(lang, key);

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = r.summary;
  const value = document.createElement('span'); value.className = 'value'; value.textContent = r.value;
  head.append(headline, value);

  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);

  const facts = document.createElement('div'); facts.className = 'facts';
  const subj = document.createElement('span'); subj.textContent = `${t('subjectLabel')}: ${r.subjectRef}`;
  const ev = document.createElement('span'); ev.textContent = `${t('evidenceLabel')}: ${r.evidenceCount}`;
  const asg = document.createElement('span'); asg.textContent = `${t('assignedLabel')}: ${r.assignedTo}`;
  facts.append(subj, ev, asg);

  li.append(head, status, facts);
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.lossPreventionInboxData?.userId ?? '';
  el('lang').textContent = t('langName');

  el('open-count').textContent = view.openCount === 0 ? t('allClear') : `${view.openCount} ${t('openCount')}`;
  el('exposure').textContent = view.openCount === 0 ? '' : `${t('exposureLabel')}: ${view.totalValue}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('open-heading').hidden = view.open.length === 0;
  el('open-heading').textContent = t('openHeading');
  el('rows').replaceChildren(...view.open.map((r) => rowNode(r)));

  // The close form — only for a manager who holds lp.case.manage, and only when there is a case to close.
  const closer = el('closer');
  const canClose = view.mayManage && view.open.length > 0 && !view.nobodyNamed;
  closer.hidden = !canClose;
  if (canClose) {
    el('close-heading').textContent = t('closeHeading');
    el('close-case-label').textContent = t('caseLabel');
    el('close-outcome-label').textContent = t('outcomeLabel');
    el('close-note-label').textContent = t('noteLabel');
    el('close-note').setAttribute('aria-label', t('noteLabel'));
    el('close-note').placeholder = t('notePlaceholder');
    el('close').textContent = t('closeBtn');
    el('close-case').replaceChildren(...view.open.map((r) => {
      const o = document.createElement('option'); o.value = r.caseId; o.textContent = `${r.summary} (${r.value})`; return o;
    }));
    el('close-outcome').replaceChildren(...session.outcomeOptions(lang).map((opt) => {
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

// The manager's close — a HUMAN write that runs ONLY on this explicit click, never on load. On success the
// worklist is re-read (a GET) so the closed case drops off. The server enforces §28/evidence for a "proven"
// outcome; the screen never fakes it.
el('close').addEventListener('click', () => {
  void (async () => {
    const caseId = el('close-case').value;
    const outcome = el('close-outcome').value;
    const note = el('close-note').value;
    const result = await session.close(caseId, outcome, note);
    paintResult(session.presentCloseResult(lang, result));
    if (result === 'closed') { el('close-note').value = ''; await refresh(); }
  })();
});
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.lossPreventionInboxSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live worklist (a GET — read-only). Offline or refused, the screen keeps its current view and the
// stale strip already says the page is what the box last told it.
async function refresh() {
  const api = window.lossPreventionInbox;
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
