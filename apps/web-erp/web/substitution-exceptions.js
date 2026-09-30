// Delivery-substitution exception inbox — the view layer (M19-FR-01, Item 2, API-07). Every rule lives in the
// TESTED session model (apps/web-erp/src/substitution-exception-inbox-session.ts), attached as
// window.substitutionExceptionInboxSession, built on packages/ui over the tested ownedWorklist. This file only
// draws what the session hands it: the UNRESOLVED exceptions (biggest money first, each with its kind, the queue
// that owns it, who holds it, its age and SLA), a CLAIM button on each open row, and a "work what you hold" form
// (resolve with a reason code + the words, or release back). Every act is a HUMAN decision that runs ONLY on an
// explicit click, never on load; on success the worklist is re-read (a GET). No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Delivery exceptions', langName: 'தமிழ்',
      lead: 'Sample exceptions. Connect the store computer to see the open delivery exceptions for your own shop.',
      openHeading: 'To work', openCount: 'to work', breachedCount: 'past their SLA', atRiskLabel: 'Money at stake', allClear: 'No open delivery exceptions — nothing outstanding.', queuesHeading: 'By queue',
      orderLabel: 'Order', lineLabel: 'Line', queueLabel: 'Queue', heldByLabel: 'Held by', heldByYou: 'you', inQueue: 'in the queue', ageLabel: 'Age', minutes: 'min', proposedByLabel: 'Proposed by',
      claimBtn: 'Claim', workHeading: 'Work an exception you hold', whichLabel: 'Which exception', reasonCodeLabel: 'Reason code', reasonCodePlaceholder: 'e.g. REFUNDED / COLLECTED',
      detailLabel: 'What you did (this is the record)', detailPlaceholder: 'What was done, and why this closes it?', resolveBtn: 'Resolve', releaseBtn: 'Release back to the queue', nothingHeld: 'You hold nothing — claim an exception above to work it.',
      sampleData: 'Sample data — this is not your shop.', nobodyNamed: '' },
    ta: { title: 'டெலிவரி விதிவிலக்குகள்', langName: 'English',
      lead: 'மாதிரி விதிவிலக்குகள். உங்கள் கடையின் திறந்த டெலிவரி விதிவிலக்குகளைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      openHeading: 'கையாள வேண்டியவை', openCount: 'கையாள வேண்டியவை', breachedCount: 'SLA கடந்தவை', atRiskLabel: 'ஆபத்தில் உள்ள தொகை', allClear: 'திறந்த டெலிவரி விதிவிலக்குகள் இல்லை — நிலுவையில் எதுவும் இல்லை.', queuesHeading: 'வரிசை வாரியாக',
      orderLabel: 'ஆர்டர்', lineLabel: 'வரி', queueLabel: 'வரிசை', heldByLabel: 'வைத்திருப்பவர்', heldByYou: 'நீங்கள்', inQueue: 'வரிசையில்', ageLabel: 'வயது', minutes: 'நிமி', proposedByLabel: 'முன்மொழிந்தவர்',
      claimBtn: 'கோரு', workHeading: 'நீங்கள் வைத்திருக்கும் விதிவிலக்கைக் கையாளுங்கள்', whichLabel: 'எந்த விதிவிலக்கு', reasonCodeLabel: 'காரணக் குறியீடு', reasonCodePlaceholder: 'எ.கா. REFUNDED / COLLECTED',
      detailLabel: 'நீங்கள் செய்தது (இதுவே பதிவு)', detailPlaceholder: 'என்ன செய்யப்பட்டது, ஏன் இது முடிகிறது?', resolveBtn: 'தீர்', releaseBtn: 'வரிசைக்குத் திருப்பி விடு', nothingHeld: 'நீங்கள் எதையும் வைத்திருக்கவில்லை — கையாள மேலே ஒரு விதிவிலக்கைக் கோருங்கள்.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', nobodyNamed: '' },
  };
  const sampleRow = (l) => ({
    exceptionId: 'sample-ord-1:line-1:refund_due', orderId: 'ORD-1', lineId: 'L1', kind: 'refund_due',
    kindLabel: l === 'ta' ? 'திருப்பித் தர வேண்டியது' : 'Refund due', amount: '₹125.00', amountMinor: 12500,
    detail: l === 'ta' ? 'மாற்றுப் பொருள் விலை குறைவு — ₹125 திருப்பித் தர வேண்டும்' : 'Substitute cheaper than ordered — ₹125 to refund',
    queue: 'finance_recon_queue', queueLabel: l === 'ta' ? 'நிதி சரிபார்ப்பு' : 'Finance reconciliation', state: 'open', heldBy: null, mine: false,
    ageMinutes: 45, dueAt: '', breached: false, proposedBy: 'picker-1', reasonCode: 'SUB-REFUND-DUE',
    status: { tone: 'degraded', icon: '⚠', label: l === 'ta' ? 'திறந்தது' : 'Open', announcement: 'open', needsAttention: true }, needsAttention: true, offer: 'claim',
  });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      rows: [sampleRow(l)], openCount: 1, breachedCount: 0, atRisk: '₹125.00', atRiskMinor: 12500,
      queues: [{ queue: 'finance_recon_queue', label: l === 'ta' ? 'நிதி சரிபார்ப்பு' : 'Finance reconciliation', count: 1 }],
      held: [], nobodyNamed: false, mayWork: true,
    }),
    claim: async () => 'lost_link',
    release: async () => 'lost_link',
    resolve: async () => 'lost_link',
    presentActionResult: (l, action, result) => ({ tone: result === 'done' ? 'ok' : result === 'lost_link' ? 'degraded' : 'error', icon: result === 'done' ? '✓' : result === 'lost_link' ? '⚠' : '✕', label: '', announcement: '', needsAttention: result !== 'done' }),
  };
}

let session = window.substitutionExceptionInboxSession ?? sampleSession();
const t = (key) => session.text(lang, key);

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;
  li.dataset.exceptionId = r.exceptionId;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = `${r.kindLabel} — ${r.detail}`;
  const value = document.createElement('span'); value.className = 'value'; value.textContent = r.amount;
  head.append(headline, value);

  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);

  const facts = document.createElement('div'); facts.className = 'facts';
  const order = document.createElement('span'); order.textContent = `${t('orderLabel')}: ${r.orderId} · ${t('lineLabel')}: ${r.lineId}`;
  const queue = document.createElement('span'); queue.textContent = `${t('queueLabel')}: ${r.queueLabel}`;
  const held = document.createElement('span');
  held.textContent = `${t('heldByLabel')}: ${r.heldBy === null ? t('inQueue') : r.mine ? t('heldByYou') : r.heldBy}`;
  if (r.mine) held.className = 'mine';
  const age = document.createElement('span'); age.textContent = `${t('ageLabel')}: ${r.ageMinutes} ${t('minutes')}`;
  facts.append(order, queue, held, age);
  if (r.proposedBy !== null) { const p = document.createElement('span'); p.textContent = `${t('proposedByLabel')}: ${r.proposedBy}`; facts.append(p); }

  li.append(head, status, facts);

  // The one act on a row: CLAIM an open exception — offered only when the session says so, run only on the click.
  if (r.offer === 'claim') {
    const acts = document.createElement('div'); acts.className = 'acts';
    const claim = document.createElement('button'); claim.type = 'button'; claim.className = 'claim'; claim.textContent = t('claimBtn');
    claim.setAttribute('aria-label', `${t('claimBtn')}: ${r.kindLabel} ${r.amount}`);
    claim.addEventListener('click', () => { void act('claim', r.exceptionId); });
    acts.append(claim);
    li.append(acts);
  }
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.substitutionExceptionInboxData?.userId ?? '';
  el('lang').textContent = t('langName');

  el('open-count').textContent = view.openCount === 0 ? t('allClear') : `${view.openCount} ${t('openCount')}`;
  el('breached-count').textContent = view.breachedCount === 0 ? '' : `${view.breachedCount} ${t('breachedCount')}`;
  el('exposure').textContent = view.openCount === 0 ? '' : `${t('atRiskLabel')}: ${view.atRisk}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('queues-heading').hidden = view.queues.length === 0;
  el('queues-heading').textContent = t('queuesHeading');
  el('queues').replaceChildren(...view.queues.map((q) => {
    const li = document.createElement('li'); const b = document.createElement('b'); b.textContent = String(q.count);
    li.append(`${q.label}: `, b); return li;
  }));

  el('open-heading').hidden = view.rows.length === 0;
  el('open-heading').textContent = t('openHeading');
  el('rows').replaceChildren(...view.rows.map((r) => rowNode(r)));

  // The work form — only for a queue member who holds order.exception.work, and only over what they HOLD.
  const worker = el('worker');
  const canWork = view.mayWork && view.held.length > 0 && !view.nobodyNamed;
  worker.hidden = !canWork;
  el('nothing-held').hidden = !(view.mayWork && view.held.length === 0 && view.rows.length > 0 && !view.nobodyNamed);
  el('nothing-held').textContent = t('nothingHeld');
  if (canWork) {
    el('work-heading').textContent = t('workHeading');
    el('work-item-label').textContent = t('whichLabel');
    el('work-reason-label').textContent = t('reasonCodeLabel');
    el('work-reason').placeholder = t('reasonCodePlaceholder');
    el('work-reason').setAttribute('aria-label', t('reasonCodeLabel'));
    el('work-detail-label').textContent = t('detailLabel');
    el('work-detail').placeholder = t('detailPlaceholder');
    el('work-detail').setAttribute('aria-label', t('detailLabel'));
    el('resolve').textContent = t('resolveBtn');
    el('release').textContent = t('releaseBtn');
    el('work-item').replaceChildren(...view.held.map((r) => {
      const o = document.createElement('option'); o.value = r.exceptionId; o.textContent = `${r.kindLabel} — ${r.orderId}/${r.lineId} (${r.amount})`; return o;
    }));
  }

  const state = el('state');
  if (view.rows.length === 0) {
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

// The queue member's acts — HUMAN writes that run ONLY on an explicit click, never on load. On success the
// worklist is re-read (a GET) so the row's new state (held by me / gone) is the cloud's, not a client-side move.
async function act(action, exceptionId) {
  const result = action === 'claim'
    ? await session.claim(exceptionId)
    : action === 'release'
      ? await session.release(exceptionId, el('work-reason').value)
      : await session.resolve(exceptionId, el('work-reason').value, el('work-detail').value);
  paintResult(session.presentActionResult(lang, action, result));
  if (result === 'done') {
    if (action !== 'claim') { el('work-reason').value = ''; el('work-detail').value = ''; }
    await refresh();
  }
}
el('resolve').addEventListener('click', () => { void act('resolve', el('work-item').value); });
el('release').addEventListener('click', () => { void act('release', el('work-item').value); });
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

el('sample').hidden = window.substitutionExceptionInboxSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live worklist (a GET — read-only). Offline or refused, the screen keeps its current view and the
// stale strip already says the page is what the box last told it.
async function refresh() {
  const api = window.substitutionExceptionInbox;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data) { session = api.present(data); paint(); }
}
refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
