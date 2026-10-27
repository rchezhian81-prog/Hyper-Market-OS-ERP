// Supplier portal — the view layer (M24-FR-01, API-03, §35, P-03, P-04). Every rule lives in the TESTED session
// model (apps/supplier-app/src/supplier-portal-session.ts), attached as window.supplierPortalSession by the
// bundle, built on packages/ui + packages/a11y. This file only DRAWS what the session hands it: what the
// supplier sent (waiting-on-us first, then processed) and its statement (the money we owe it, disputed shown
// separately) — each row a tone AND an icon AND a word, never colour alone. It changes nothing but ONE thing: the
// "Delivery update" form (OB-362) for one of the supplier's OWN open orders, which the bundle sends
// (window.supplierPortal.sendDeliveryUpdate — this file issues no write verb itself) — and, since OB-389, the "Top-up
// proposal" form for the supplier's OWN vendor-managed items at one store (window.supplierPortal.sendTopUpProposal),
// which waits for a buyer and orders nothing. Refresh re-reads the feeds (GETs).
// Offline the screen keeps its view and the stale strip says the page is what it was last shown; an update not sent is
// said so. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). Renders a
 *  calm all-clear so the screen is never blank offline. */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Your account with SRE', langName: 'தமிழ்',
      lead: 'Sample supplier portal. Sign in to see your own account.',
      refresh: 'Refresh', asOfLabel: 'As of',
      sentHeading: 'What you have sent us', sentNone: 'You have not sent us anything yet.',
      statementHeading: 'Your statement',
      sampleData: 'Sample data — this is not your account.', staleShell: 'No connection. This page is what you were last shown, at',
    },
    ta: {
      title: 'SRE உடன் உங்கள் கணக்கு', langName: 'English',
      lead: 'மாதிரி சப்ளையர் போர்ட்டல். உங்கள் கணக்கைப் பார்க்க உள்நுழையவும்.',
      refresh: 'புதுப்பி', asOfLabel: 'நிலவரம்',
      sentHeading: 'நீங்கள் அனுப்பியவை', sentNone: 'நீங்கள் இன்னும் எதையும் அனுப்பவில்லை.',
      statementHeading: 'உங்கள் அறிக்கை',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கணக்கு அல்ல.', staleShell: 'இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகக் காட்டப்பட்டது:',
    },
  };
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: () => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      awaiting: [], processed: [], statement: null, statementInaccessible: false, awaitingCount: 0, notIdentified: false, anyAttention: false,
    }),
  };
}

let session = window.supplierPortalSession ?? sampleSession();
const t = (key) => session.text(lang, key);

/** One submission row: kind headline, a state (icon+word, never colour alone), and language-neutral facts. */
function submissionNode(s) {
  const li = document.createElement('li');
  li.className = `row tone-${s.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span');
  headline.className = 'headline';
  headline.textContent = s.kindLabel;
  head.append(headline);

  const state = document.createElement('span');
  state.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = s.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = s.status.label;
  state.append(icon, slabel);
  state.setAttribute('aria-label', s.status.announcement || s.status.label);

  li.append(head, state);

  const facts = document.createElement('div');
  facts.className = 'facts';
  const ref = document.createElement('span'); ref.textContent = s.submissionId;
  const when = document.createElement('span'); when.textContent = s.receivedAt;
  facts.append(ref, when);
  li.append(facts);
  return li;
}

/** The statement panel — the named figures and the closing balance, with its reconcile status. */
function paintStatement(view) {
  const panel = el('statement');
  const inaccessible = el('statement-inaccessible');
  if (view.statement === null) {
    panel.hidden = true;
    inaccessible.hidden = !view.statementInaccessible;
    if (view.statementInaccessible) inaccessible.textContent = t('notAccessible');
    return;
  }
  inaccessible.hidden = true;
  panel.hidden = false;
  const s = view.statement;
  panel.className = `statement tone-${s.status.tone}`;
  const figs = [
    [t('openingLabel'), s.opening],
    [t('invoicedLabel'), s.invoiced],
    [t('creditedLabel'), s.credited],
    [t('debitedLabel'), s.debited],
    [t('paidLabel'), s.paid],
    [t('closingLabel'), s.closing],
    [t('disputedLabel'), s.disputed],
  ];
  const grid = document.createElement('div');
  grid.className = 'figs';
  for (const [label, value] of figs) {
    const fig = document.createElement('div'); fig.className = 'fig';
    const l = document.createElement('span'); l.className = 'f-label'; l.textContent = label;
    const v = document.createElement('span'); v.className = 'f-value'; v.textContent = value;
    fig.append(l, v); grid.append(fig);
  }
  const state = document.createElement('span');
  state.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = s.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = s.status.label;
  state.append(icon, slabel);
  state.setAttribute('aria-label', s.status.announcement || s.status.label);
  panel.replaceChildren(state, grid);
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.supplierData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('refresh').textContent = t('refresh');
  el('sent-heading').textContent = t('sentHeading');
  el('statement-heading').textContent = t('statementHeading');

  // A not-permitted screen (not a supplier login) has nothing to show: the state line stands in for everything.
  const notPermitted = view.screenState.tone === 'error' && view.awaiting.length === 0 && view.processed.length === 0 && view.statement === null && !view.statementInaccessible;
  const sections = ['sent-heading', 'awaiting', 'processed', 'sent-none', 'statement-heading', 'statement', 'statement-inaccessible'];
  const state = el('state');
  if (notPermitted) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
    state.setAttribute('aria-label', view.screenState.announcement || view.screenState.label);
    for (const id of sections) el(id).hidden = true;
    el('delivery').hidden = true;
    el('vmi').hidden = true;
    return;
  }
  state.hidden = true;
  for (const id of sections) el(id).hidden = false;

  // What you have sent us: waiting-on-us first, then processed; else the calm "none".
  el('awaiting').replaceChildren(...view.awaiting.map((s) => submissionNode(s)));
  el('processed').replaceChildren(...view.processed.map((s) => submissionNode(s)));
  const nothingSent = view.awaiting.length === 0 && view.processed.length === 0;
  el('awaiting').hidden = view.awaiting.length === 0;
  el('processed').hidden = view.processed.length === 0;
  el('sent-none').hidden = !nothingSent;
  el('sent-none').textContent = t('sentNone');

  paintStatement(view);
  paintDelivery();
  paintVmi();
  paintRebates();
}

// OB-362: the Delivery update form — the supplier's own open orders only; the bundle checks and sends it.
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
let ordersTried = false;
function paintDelivery() {
  const api = window.supplierPortal;
  const box = el('delivery');
  const feed = api && typeof api.orders === 'function' ? api.orders() : null;
  const v = session.view(lang);
  const notPermitted = v.screenState.tone === 'error' && v.awaiting.length === 0 && v.processed.length === 0 && v.statement === null && !v.statementInaccessible;
  box.hidden = window.supplierPortalSession === undefined || notPermitted;
  el('delivery-h').textContent = t('deliveryH');
  el('delivery-lead').textContent = t('deliveryLead');
  el('du-order-l').textContent = t('orderL'); el('du-status-l').textContent = t('statusL');
  el('du-expected-l').textContent = t('expectedL'); el('du-note-l').textContent = t('noteL');
  el('du-send-text').textContent = t('sendUpdate');
  const order = el('du-order');
  const keep = order.value;
  const opts = [new Option(t('chooseOrder'), '')];
  for (const o of feed?.orders ?? []) opts.push(new Option(`${o.number}${o.issuedAt ? ` · ${new Date(o.issuedAt).toLocaleDateString('en-CA')}` : ''}`, o.poId));
  order.replaceChildren(...opts);
  if ([...order.options].some((x) => x.value === keep)) order.value = keep;
  const status = el('du-status');
  const keepStatus = status.value;
  status.replaceChildren(new Option('—', ''), ...['dispatched', 'in_transit', 'delayed'].map((k) => new Option(t(`status_${k}`), k)));
  status.value = keepStatus;
  const said = el('du-said');
  const usable = feed !== null && feed.ordersKnown && feed.mayUpdate && feed.orders.length > 0;
  said.textContent = feed === null ? (ordersTried ? t('ordersUnknown') : '') : !feed.ordersKnown ? t('ordersUnknown') : !feed.mayUpdate ? t('cannotUpdate') : feed.orders.length === 0 ? t('noOpenOrders') : '';
  said.hidden = said.textContent === '';
  el('du-form').hidden = !usable;
}
async function sendDelivery() {
  const api = window.supplierPortal;
  if (!api || typeof api.sendDeliveryUpdate !== 'function') return;
  const out = await api.sendDeliveryUpdate({ poId: el('du-order').value, status: el('du-status').value, expectedOn: el('du-expected').value, note: el('du-note').value });
  const st = el('du-result');
  st.className = `status-line ${out.result === 'sent' ? 'tone-ok' : 'tone-error'}`;
  st.textContent = out.result === 'sent' ? `✓ ${t('updateSent')}` : out.result === 'invalid' ? `⚠ ${t(out.why)}` : out.result === 'refused' ? `⚠ ${t('refusedSay')} ${out.whatHappened}` : `⚠ ${t('notSent')}`;
  st.dataset.result = out.result;
  if (out.result === 'sent') { el('du-note').value = ''; await refresh(); }
}
el('du-send').addEventListener('click', () => { void sendDelivery(); });

// OB-389: the Top-up proposal form — the supplier's own VMI items at one store; the bundle checks and sends it.
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ''));
const typedQty = new Map(); // `${store}|${product}` → what the supplier typed, kept across repaints
function paintVmi() {
  const api = window.supplierPortal;
  const box = el('vmi');
  const feed = api && typeof api.vmi === 'function' ? api.vmi() : null;
  const v = session.view(lang);
  const notPermitted = v.screenState.tone === 'error' && v.awaiting.length === 0 && v.processed.length === 0 && v.statement === null && !v.statementInaccessible;
  box.hidden = window.supplierPortalSession === undefined || notPermitted;
  el('vmi-h').textContent = t('vmiH');
  el('vmi-lead').textContent = t('vmiLead');
  el('vmi-store-l').textContent = t('vmiStoreL');
  el('vmi-note-l').textContent = t('vmiNoteL');
  el('vmi-send-text').textContent = t('sendTopUp');
  const said = el('vmi-said');
  said.textContent = feed === null ? (ordersTried ? t('vmiUnknown') : '') : feed.items.length === 0 ? (feed.notSet ?? '') : !feed.mayPropose ? t('cannotPropose') : '';
  said.hidden = said.textContent === '';
  const usable = feed !== null && feed.items.length > 0 && feed.mayPropose;
  el('vmi-form').hidden = !usable;
  el('vmi-send').hidden = !usable;
  const store = el('vmi-store');
  const keep = store.value;
  const stores = [...new Set((feed?.items ?? []).map((i) => i.storeId))];
  store.replaceChildren(new Option(t('chooseStore'), ''), ...stores.map((s) => new Option(s, s)));
  if (stores.includes(keep)) store.value = keep; else if (stores.length === 1) store.value = stores[0];
  const here = usable ? feed.items.filter((i) => i.storeId === store.value) : [];
  el('vmi-items').replaceChildren(...here.map((i) => {
    const li = document.createElement('li');
    li.className = `row tone-${i.belowMinimum ? 'degraded' : 'ok'}`;
    li.dataset.product = i.productId;
    const head = document.createElement('div'); head.className = 'head';
    const name = document.createElement('span'); name.className = 'headline'; name.textContent = i.productId;
    head.append(name);
    if (i.belowMinimum) {
      const st = document.createElement('span'); st.className = 'status';
      const ic = document.createElement('span'); ic.className = 'icon'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = '⚠';
      const w = document.createElement('span'); w.textContent = t('vmiBelowMin');
      st.append(ic, w); st.setAttribute('aria-label', t('vmiBelowMin'));
      head.append(st);
    }
    const facts = document.createElement('div'); facts.className = 'facts';
    facts.textContent = fill(t('vmiItemFacts'), { min: i.minQty, max: i.maxQty, onHand: i.onHand, onOrder: i.onOrder, room: i.room, uom: i.uom });
    const label = document.createElement('label'); label.className = 'vmi-qty';
    const lw = document.createElement('span'); lw.textContent = t('vmiQtyL');
    const input = document.createElement('input');
    input.inputMode = 'numeric'; input.autocomplete = 'off'; input.dataset.product = i.productId; input.className = 'vmi-qty-input';
    input.value = typedQty.get(`${i.storeId}|${i.productId}`) ?? '';
    input.addEventListener('input', () => { typedQty.set(`${i.storeId}|${i.productId}`, input.value); });
    label.append(lw, input);
    li.append(head, facts, label);
    return li;
  }));
  const proposals = feed?.proposals ?? [];
  el('vmi-proposals-h').hidden = proposals.length === 0;
  el('vmi-proposals-h').textContent = t('vmiProposalsH');
  el('vmi-proposals').replaceChildren(...proposals.map((p) => {
    const li = document.createElement('li');
    const tone = p.status === 'accepted' ? 'ok' : p.status === 'rejected' ? 'error' : 'degraded';
    li.className = `row tone-${tone}`;
    li.dataset.proposal = p.proposalId;
    const st = document.createElement('span'); st.className = 'status';
    const ic = document.createElement('span'); ic.className = 'icon'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = p.status === 'accepted' ? '✓' : p.status === 'rejected' ? '✕' : '⏳';
    const word = t(p.status === 'accepted' ? 'vmiAccepted' : p.status === 'rejected' ? 'vmiRejected' : 'vmiAwaiting');
    const w = document.createElement('span'); w.textContent = `${word}${p.reason ? ` — ${p.reason}` : ''}`;
    st.append(ic, w); st.setAttribute('aria-label', word);
    const facts = document.createElement('div'); facts.className = 'facts';
    facts.textContent = `${p.storeId} · ${p.lines.map((l) => `${l.productId} × ${l.quantity}`).join(', ')} · ${p.proposedAt}`;
    li.append(st, facts);
    return li;
  }));
}
async function sendTopUp() {
  const api = window.supplierPortal;
  if (!api || typeof api.sendTopUpProposal !== 'function') return;
  const storeId = el('vmi-store').value;
  const quantities = {};
  for (const input of el('vmi-items').querySelectorAll('input.vmi-qty-input')) quantities[input.dataset.product] = input.value;
  const out = await api.sendTopUpProposal({ storeId, quantities, note: el('vmi-note').value });
  const st = el('vmi-result');
  st.className = `status-line ${out.result === 'sent' ? 'tone-ok' : 'tone-error'}`;
  st.textContent = out.result === 'sent' ? `✓ ${t('topUpSent')}` : out.result === 'invalid' ? `⚠ ${t(out.why)}${out.productId ? ` (${out.productId})` : ''}` : out.result === 'refused' ? `⚠ ${t('refusedSay')} ${out.whatHappened}` : `⚠ ${t('topUpNotSent')}`;
  st.dataset.result = out.result;
  if (out.result === 'sent') {
    el('vmi-note').value = '';
    for (const k of [...typedQty.keys()]) if (k.startsWith(`${storeId}|`)) typedQty.delete(k);
    await refresh();
  }
}
el('vmi-send').addEventListener('click', () => { void sendTopUp(); });

// D03-FR-03 · OB-404: the rebate claims the shop has sent this supplier — read only. A due day the shop has not set is said.
const rupeesOf = (minor) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function paintRebates() {
  const api = window.supplierPortal;
  const feed = api && typeof api.rebateClaims === 'function' ? api.rebateClaims() : null;
  const v = session.view(lang);
  const notPermitted = v.screenState.tone === 'error' && v.awaiting.length === 0 && v.processed.length === 0 && v.statement === null && !v.statementInaccessible;
  el('rebates').hidden = window.supplierPortalSession === undefined || notPermitted;
  el('rebates-h').textContent = t('rebateH');
  el('rebates-lead').textContent = t('rebateLead');
  const said = el('rebates-said');
  said.textContent = feed === null ? (ordersTried ? t('rebateUnknown') : '') : !feed.claimsKnown ? t('rebateUnknown') : feed.claims.length === 0 ? t('rebateNone') : '';
  said.hidden = said.textContent === '';
  el('rebates-rows').replaceChildren(...(feed?.claims ?? []).map((c) => {
    const li = document.createElement('li');
    const tone = c.state === 'answered' ? 'ok' : c.state === 'withdrawn' ? 'muted' : 'degraded';
    li.className = `row tone-${tone}`;
    li.dataset.claim = c.claimId; li.dataset.state = c.state;
    const st = document.createElement('span'); st.className = 'status';
    const ic = document.createElement('span'); ic.className = 'icon'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = c.state === 'answered' ? '✓' : c.state === 'withdrawn' ? '○' : '⏳';
    const w = document.createElement('span'); w.textContent = t(`rebate_${c.state}`);
    st.append(ic, w); st.setAttribute('aria-label', t(`rebate_${c.state}`));
    const facts = document.createElement('div'); facts.className = 'facts';
    facts.textContent = fill(t('rebateFacts'), { claim: c.claimId, scheme: c.schemeId, amount: rupeesOf(c.amountMinor), sent: c.sentOn, due: c.answerDueOn ?? t('rebateDueNotSet'), paid: rupeesOf(c.paidMinor), left: rupeesOf(c.leftToPayMinor) });
    li.append(st, facts);
    return li;
  }));
}
el('vmi-store').addEventListener('change', () => { paintVmi(); });
{ const i = icon('package'); if (i !== null) el('vmi-send').prepend(i); }
{ const i = icon('truck'); if (i !== null) el('du-send').prepend(i); }

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.supplierPortalSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live feeds (GETs — read-only). Offline or refused, the screen keeps its current view; the stale strip
// already says the page is what it was last shown. Nothing is written.
async function refresh() {
  const api = window.supplierPortal;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  ordersTried = true;
  if (data) { session = api.present(data); paint(); } else { paintDelivery(); paintVmi(); paintRebates(); }
}
el('refresh').addEventListener('click', () => { void refresh(); });

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
    /* the portal still opens; it just will not be there without a network */
  });
}
