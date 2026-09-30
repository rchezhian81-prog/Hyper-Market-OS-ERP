// Floor indents — the view layer (SP-8b · F08 · WF-06 · WF-07 · M09-FR-03 · M08-FR-02 · §28 · §31 · P-01 · P-03 · P-08).
// Every rule lives in the TESTED session model (apps/web-erp/src/indents-session.ts), attached as window.indentsSession,
// built on packages/ui. This file only draws what the session hands it: the register (needing a person first, four
// figures per line), the raise form, the approve control, the count-in control and the "Saved on this screen" list. RAISE
// and COUNT IN are written to the durable device queue by the session before it returns ok — this file never fetches;
// the relay (window.indentsRelay) hands the queue to the store computer after every save and when the page regains the
// network or the reader's attention. APPROVE goes through the session's online port. No prompt/confirm/alert; no timer.

const el = (id) => document.getElementById(id);
let lang = 'en';

/**
 * The five shared device states in both languages — the same words as the manager's, the buyer's and the handhelds'
 * screens (`packages/sync/src/device-relay` DEVICE_ITEM_STATES).
 */
const STATE_WORDS = {
  saved_here: { en: 'Saved on this device — not yet with the store computer', ta: 'இந்தக் கருவியில் சேமிக்கப்பட்டது — கடை கணினிக்கு இன்னும் செல்லவில்லை' },
  retrying: { en: 'Saved on this device — the store computer could not be reached, trying again', ta: 'இந்தக் கருவியில் சேமிக்கப்பட்டது — கடை கணினியை அடைய முடியவில்லை, மீண்டும் முயற்சிக்கிறது' },
  handed_to_box: { en: 'With the store computer — it will send this to head office', ta: 'கடை கணினியிடம் உள்ளது — அது இதை தலைமை அலுவலகத்திற்கு அனுப்பும்' },
  posted: { en: 'Posted at head office', ta: 'தலைமை அலுவலகத்தில் பதிவாகியது' },
  refused: { en: 'Refused — a person must look at this', ta: 'மறுக்கப்பட்டது — ஒருவர் இதைப் பார்க்க வேண்டும்' },
};
const words = (table, key) => table[key]?.[lang] ?? table[key]?.en ?? key;

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). It renders one
 *  closed indent so the screen is never blank offline, and offers no write (nothing to write to). */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Floor indents', langName: 'தமிழ்', lead: 'Sample indents. Connect the store computer to see your own shop’s.',
      registerHeading: 'Indents', asOfLabel: 'As of', refresh: 'Refresh', summaryIndents: 'indents', summaryNeedAttention: 'need a person',
      summaryOnTrolley: 'on the trolley', summaryOwed: 'still owed', unitsWord: 'units', requestedByLabel: 'Asked by', approvedByLabel: 'Approved by',
      colRequested: 'Asked', colAllocated: 'Allocated', colIssued: 'Issued', colReceived: 'On the shelf', colOnTrolley: 'On the trolley', colShort: 'Short', colOwed: 'Still owed',
      issueLabel: 'Issue', issuedByLabel: 'issued by', issueInTransit: 'on the trolley', issueReceived: 'counted in',
      savedHeading: 'Saved on this screen', savedLead: '', savedKindRequest: 'Indent', savedKindReceipt: 'Count-in', linesWord: 'lines',
      sampleData: 'Sample data — this is not your shop.', },
    ta: {
      title: 'தளக் கோரிக்கைகள்', langName: 'English', lead: 'மாதிரிக் கோரிக்கைகள். உங்கள் கடையினவற்றைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      registerHeading: 'கோரிக்கைகள்', asOfLabel: 'நிலவரம்', refresh: 'புதுப்பி', summaryIndents: 'கோரிக்கைகள்', summaryNeedAttention: 'ஒருவரின் கவனம் தேவை',
      summaryOnTrolley: 'தள்ளுவண்டியில்', summaryOwed: 'இன்னும் தர வேண்டியது', unitsWord: 'அலகுகள்', requestedByLabel: 'கேட்டவர்', approvedByLabel: 'ஒப்புதல் அளித்தவர்',
      colRequested: 'கேட்டது', colAllocated: 'ஒதுக்கியது', colIssued: 'வழங்கியது', colReceived: 'அடுக்கில்', colOnTrolley: 'தள்ளுவண்டியில்', colShort: 'குறைவு', colOwed: 'இன்னும் தர வேண்டியது',
      issueLabel: 'வழங்கல்', issuedByLabel: 'வழங்கியவர்', issueInTransit: 'தள்ளுவண்டியில்', issueReceived: 'எண்ணி வாங்கப்பட்டது',
      savedHeading: 'இந்தத் திரையில் சேமிக்கப்பட்டவை', savedLead: '', savedKindRequest: 'கோரிக்கை', savedKindReceipt: 'எண்ணி வாங்கல்', linesWord: 'வரிகள்',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', },
  };
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      asOf: null,
      indents: [{
        status: { tone: 'ok', icon: '✓', label: l === 'ta' ? 'அடுக்கில் உள்ளது' : 'On the shelf', announcement: 'on the shelf', needsAttention: false },
        indentId: 'IND-SAMPLE', state: 'received', stateLabel: l === 'ta' ? 'பெறப்பட்டது' : 'Received', requestedBy: '—', requestedAt: '', approvedBy: '—', reason: null,
        needsAttention: false, flags: [], issues: [], canApproveHere: false, ownAsk: false, receivableIssues: [],
        lines: [{ productId: 'RICE-5', uom: 'EA', requestedMinor: 10, allocatedMinor: 10, issuedMinor: 10, receivedMinor: 10, inTransitMinor: 0, shortfallMinor: 0, outstandingMinor: 0 }],
      }],
      count: 1, needingAttentionCount: 0, inTransitMinor: 0, outstandingMinor: 0, canRequest: false, canApprove: false, canReceive: false, approvable: [], receivable: [], products: [], nobodyNamed: false,
    }),
    raise: () => ({ ok: false, refusal: 'not_permitted' }),
    receive: () => ({ ok: false, refusal: 'not_permitted' }),
    approve: async () => ({ outcome: 'no_link' }),
    presentApproveOutcome: () => ({ tone: 'degraded', icon: '⚠', label: '', announcement: '', needsAttention: true }),
    raiseRefusalWords: () => '', receiveRefusalWords: () => '',
    savedWork: () => [], handedKeys: () => [], noteBoxStatus: () => {},
  };
}

let session = window.indentsSession ?? sampleSession();
const t = (key) => session.text(lang, key);

// ── the register ────────────────────────────────────────────────────────────

function linesTable(lines) {
  const table = document.createElement('table');
  table.className = 'lines';
  const head = document.createElement('tr');
  for (const [key, n] of [['raiseProductLabel', false], ['colRequested', true], ['colAllocated', true], ['colIssued', true], ['colOnTrolley', true], ['colReceived', true], ['colShort', true], ['colOwed', true]]) {
    const th = document.createElement('th'); if (n) th.className = 'n'; th.textContent = key === 'raiseProductLabel' ? '' : t(key); head.append(th);
  }
  table.append(head);
  for (const l of lines) {
    const tr = document.createElement('tr');
    tr.dataset.productId = l.productId;
    const cells = [l.productId, l.requestedMinor, l.allocatedMinor, l.issuedMinor, l.inTransitMinor, l.receivedMinor, l.shortfallMinor, l.outstandingMinor];
    cells.forEach((v, i) => { const td = document.createElement('td'); if (i > 0) td.className = 'n'; td.textContent = String(v); tr.append(td); });
    table.append(tr);
  }
  return table;
}

/** One indent row. Every row reads as a state — a tone AND an icon AND a word (colour is never alone). */
function indentNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;
  li.dataset.indentId = r.indentId;
  li.dataset.state = r.state;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span');
  headline.className = 'headline';
  headline.textContent = r.indentId;
  const st = document.createElement('span'); st.className = 'st'; st.textContent = r.stateLabel; headline.append(st);
  head.append(headline);
  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);
  head.append(status);
  li.append(head);

  const facts = document.createElement('div');
  facts.className = 'facts';
  const fact = (text) => { const s = document.createElement('span'); s.textContent = text; facts.append(s); };
  if (r.requestedAt) fact(new Date(r.requestedAt).toLocaleString());
  fact(`${t('requestedByLabel')}: ${r.requestedBy}` + (r.ownAsk ? ` — ${t('approveOwnAsk')}` : ''));
  if (r.approvedBy) fact(`${t('approvedByLabel')}: ${r.approvedBy}`);
  if (r.reason) fact(r.reason);
  li.append(facts);

  const wrap = document.createElement('div');
  wrap.className = 'lines-wrap';
  wrap.append(linesTable(r.lines));
  li.append(wrap);

  if (r.issues.length > 0) {
    const issues = document.createElement('ul');
    issues.className = 'issues';
    for (const i of r.issues) {
      const item = document.createElement('li');
      item.dataset.issueId = i.issueId;
      item.dataset.state = i.state;
      item.textContent = `${t('issueLabel')} ${i.issueId} · ${i.lines.map((l) => `${l.productId} × ${l.quantityMinor}`).join(', ')} · ${t('issuedByLabel')} ${i.issuedBy} · ${i.state === 'in_transit' ? t('issueInTransit') : t('issueReceived')}`;
      issues.append(item);
    }
    li.append(issues);
  }
  if (r.flags.length > 0) {
    const flags = document.createElement('ul');
    flags.className = 'flags';
    for (const f of r.flags) { const item = document.createElement('li'); item.dataset.flag = f.flag; item.textContent = f.label; flags.append(item); }
    li.append(flags);
  }
  return li;
}

// ── the raise form (lines are gathered on the page; the session validates and queues on Save) ───────────────

let raiseLines = [];

function renderRaiseLines() {
  el('raise-lines-heading').hidden = raiseLines.length === 0;
  el('raise-lines-heading').textContent = t('raiseLinesHeading');
  el('raise-lines').replaceChildren(...raiseLines.map((l, index) => {
    const li = document.createElement('li');
    li.dataset.productId = l.productId;
    const what = document.createElement('span'); what.textContent = `${l.productId} × ${l.quantityMinor} ${l.uom || ''}`.trim();
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'minor'; remove.textContent = t('raiseRemove');
    remove.addEventListener('click', () => { raiseLines = raiseLines.filter((_, i) => i !== index); renderRaiseLines(); });
    li.append(what, remove);
    return li;
  }));
}

function paintRaiser(view) {
  const raiser = el('raiser');
  el('no-request').hidden = true;
  if (!view.canRequest) {
    raiser.hidden = true;
    if (view.indents.length > 0 && !view.nobodyNamed && window.indentsSession !== undefined) { el('no-request').hidden = false; el('no-request').textContent = t('noRequest'); }
    return;
  }
  raiser.hidden = false;
  el('raise-heading').textContent = t('raiseHeading');
  el('raise-product-label').textContent = t('raiseProductLabel');
  el('raise-qty-label').textContent = t('raiseQtyLabel');
  el('raise-uom-label').textContent = t('raiseUomLabel');
  el('raise-add').textContent = t('raiseAddLine');
  el('raise-reason-label').textContent = t('raiseReasonLabel');
  el('raise-reason').placeholder = t('raiseReasonPlaceholder');
  el('raise').textContent = t('raiseBtn');
  el('products').replaceChildren(...view.products.map((p) => { const o = document.createElement('option'); o.value = p.productId; o.label = `${p.name} (${p.uom})`; return o; }));
  renderRaiseLines();
}

// ── approve ─────────────────────────────────────────────────────────────────

function paintApprover(view) {
  const approver = el('approver');
  el('no-approve').hidden = true;
  if (!view.canApprove) {
    approver.hidden = true;
    if (view.indents.length > 0 && !view.nobodyNamed && window.indentsSession !== undefined) { el('no-approve').hidden = false; el('no-approve').textContent = t('noApprove'); }
    return;
  }
  approver.hidden = false;
  el('approve-heading').textContent = t('approveHeading');
  el('approve-indent-label').textContent = t('approveChoiceLabel');
  el('approve-reason-label').textContent = t('approveReasonLabel');
  el('approve-reason').placeholder = t('approveReasonPlaceholder');
  el('approve').textContent = t('approveBtn');
  const select = el('approve-indent');
  const chosen = select.value;
  select.replaceChildren(...view.approvable.map((i) => {
    const opt = document.createElement('option'); opt.value = i.indentId;
    opt.textContent = `${i.indentId} · ${i.lines.map((l) => `${l.productId} × ${l.requestedMinor}`).join(', ')} · ${t('requestedByLabel')} ${i.requestedBy}`;
    return opt;
  }));
  if (chosen && view.approvable.some((i) => i.indentId === chosen)) select.value = chosen;
  const none = view.approvable.length === 0;
  el('approve-none').hidden = !none;
  el('approve-none').textContent = none ? t('approveNoneWaiting') : '';
  el('approve-fields').hidden = none;
  el('approve').hidden = none;
}

// ── count in (receive) ──────────────────────────────────────────────────────

let receivable = [];

function renderReceiveLines() {
  const choice = receivable.find((r) => `${r.indentId}|${r.issue.issueId}` === el('receive-issue').value);
  el('receive-counted-heading').textContent = t('receiveCountedLabel');
  el('receive-lines').replaceChildren(...(choice === undefined ? [] : choice.issue.lines.map((l) => {
    const li = document.createElement('li');
    li.dataset.productId = l.productId;
    li.dataset.batchId = l.batchId ?? '';
    const label = document.createElement('label');
    const inputId = `count-${l.productId}-${l.batchId ?? 'none'}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    label.htmlFor = inputId;
    label.textContent = `${l.productId}${l.batchId ? ` · ${l.batchId}` : ''} (${t('colIssued')} ${l.quantityMinor})`;
    const input = document.createElement('input'); input.id = inputId; input.type = 'text'; input.inputMode = 'numeric'; input.value = String(l.quantityMinor); input.className = 'counted';
    li.append(label, input);
    return li;
  })));
}

function paintReceiver(view) {
  const receiver = el('receiver');
  el('no-receive').hidden = true;
  if (!view.canReceive) {
    receiver.hidden = true;
    if (view.indents.length > 0 && !view.nobodyNamed && window.indentsSession !== undefined) { el('no-receive').hidden = false; el('no-receive').textContent = t('noReceive'); }
    return;
  }
  receiver.hidden = false;
  receivable = view.receivable;
  el('receive-heading').textContent = t('receiveHeading');
  el('receive-issue-label').textContent = t('receiveChoiceLabel');
  el('receive').textContent = t('receiveBtn');
  const select = el('receive-issue');
  const chosen = select.value;
  select.replaceChildren(...receivable.map((r) => {
    const opt = document.createElement('option'); opt.value = `${r.indentId}|${r.issue.issueId}`;
    opt.textContent = `${r.indentId} · ${t('issueLabel')} ${r.issue.issueId} · ${r.issue.lines.map((l) => `${l.productId} × ${l.quantityMinor}`).join(', ')} · ${t('issuedByLabel')} ${r.issue.issuedBy}`;
    return opt;
  }));
  if (chosen && receivable.some((r) => `${r.indentId}|${r.issue.issueId}` === chosen)) select.value = chosen;
  const none = receivable.length === 0;
  el('receive-none').hidden = !none;
  el('receive-none').textContent = none ? t('receiveNoneOnTrolley') : '';
  el('receive-fields').hidden = none;
  el('receive').hidden = none;
  renderReceiveLines();
}

// ── saved on this screen ────────────────────────────────────────────────────

function renderSaved() {
  const saved = typeof session.savedWork === 'function' ? session.savedWork() : [];
  el('saved-heading').hidden = saved.length === 0;
  el('saved-lead').hidden = saved.length === 0;
  el('saved-heading').textContent = t('savedHeading');
  el('saved-lead').textContent = t('savedLead');
  el('saved').replaceChildren(...saved.map((w) => {
    const li = document.createElement('li');
    li.className = 'saved';
    li.dataset.state = w.state;
    li.dataset.id = w.id;
    li.dataset.kind = w.kind;
    const what = document.createElement('div'); what.className = 'what'; what.textContent = `${t(w.kind === 'request' ? 'savedKindRequest' : 'savedKindReceipt')} ${w.what}`;
    const detail = document.createElement('div'); detail.className = 'detail'; detail.textContent = w.detail;
    const pill = document.createElement('div'); pill.className = `pill ${w.state}`; pill.textContent = words(STATE_WORDS, w.state);
    li.append(what, detail, pill);
    if (w.reason) { const why = document.createElement('div'); why.className = 'why'; why.textContent = w.reason; li.append(why); }
    return li;
  }));
}

function paintResult(presentation) {
  const result = el('result');
  result.hidden = false;
  result.className = `result tone-${presentation.tone}`;
  el('result-icon').textContent = presentation.icon;
  el('result-text').textContent = presentation.label;
  result.setAttribute('aria-label', presentation.announcement || presentation.label);
}
const tell = (tone, text) => paintResult({ tone, icon: tone === 'ok' ? '✓' : tone === 'error' ? '✕' : '⚠', label: text, announcement: text });

function paint() {
  const view = session.view(lang);
  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.indentsData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('refresh').textContent = t('refresh');
  el('asof').textContent = view.asOf ? `${t('asOfLabel')}: ${new Date(view.asOf).toLocaleString()}` : '';

  const state = el('state');
  if (view.indents.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
    state.setAttribute('aria-label', view.screenState.announcement || view.screenState.label);
    el('summary').hidden = true;
    el('list-heading').hidden = true;
    el('rows').replaceChildren();
  } else {
    state.hidden = true;
    el('summary').hidden = false;
    el('summary').textContent = `${view.count} ${t('summaryIndents')} · ${view.needingAttentionCount} ${t('summaryNeedAttention')} · ${view.inTransitMinor} ${t('unitsWord')} ${t('summaryOnTrolley')} · ${view.outstandingMinor} ${t('unitsWord')} ${t('summaryOwed')}`;
    el('list-heading').hidden = false;
    el('list-heading').textContent = t('registerHeading');
    el('rows').replaceChildren(...view.indents.map((r) => indentNode(r)));
  }
  paintRaiser(view);
  paintApprover(view);
  paintReceiver(view);
  renderSaved();
}

// ── the writes: each on an explicit click, never on load ────────────────────

el('raise-add').addEventListener('click', () => {
  const productId = el('raise-product').value.trim();
  const quantityMinor = el('raise-qty').value.trim();
  const uom = el('raise-uom').value.trim();
  if (productId === '' || !/^\d+$/.test(quantityMinor) || Number(quantityMinor) <= 0) { tell('error', session.raiseRefusalWords(lang, 'bad_line')); return; }
  if (raiseLines.some((l) => l.productId === productId)) { tell('error', session.raiseRefusalWords(lang, 'duplicate_product')); return; }
  raiseLines = [...raiseLines, { productId, quantityMinor, uom }];
  el('raise-product').value = ''; el('raise-qty').value = ''; el('raise-uom').value = '';
  renderRaiseLines();
});

// RAISE — queued on the durable device queue by the session BEFORE it returns ok; nothing is sent from here. Then the
// relay hands the queue to the store computer, and the "Saved on this screen" list says where it has got to.
el('raise').addEventListener('click', () => {
  const outcome = session.raise({ lines: raiseLines, reason: el('raise-reason').value });
  if (!outcome.ok) { tell('error', session.raiseRefusalWords(lang, outcome.refusal)); return; }
  raiseLines = [];
  el('raise-reason').value = '';
  renderRaiseLines();
  tell('ok', t('raiseSaved'));
  renderSaved();
  void syncToBox();
});

// APPROVE — an online write under the reader's session; the session refuses the requester before anything is sent (§28).
el('approve').addEventListener('click', () => {
  void (async () => {
    const outcome = await session.approve(el('approve-indent').value, el('approve-reason').value);
    paintResult(session.presentApproveOutcome(lang, outcome));
    if (outcome.outcome === 'approved' || outcome.outcome === 'already_approved') { el('approve-reason').value = ''; await refresh(); }
  })();
});

el('receive-issue').addEventListener('change', renderReceiveLines);

// COUNT IN — queued durably like the ask; the session refuses the issuer before anything is saved (§28).
el('receive').addEventListener('click', () => {
  const [indentId, issueId] = el('receive-issue').value.split('|');
  const counted = [...el('receive-lines').querySelectorAll('li')].map((li) => ({
    productId: li.dataset.productId, batchId: li.dataset.batchId === '' ? null : li.dataset.batchId, quantityMinor: li.querySelector('input.counted').value,
  }));
  const outcome = session.receive({ indentId: indentId ?? '', issueId: issueId ?? '', counted });
  if (!outcome.ok) { tell('error', session.receiveRefusalWords(lang, outcome.refusal)); return; }
  tell('ok', t('receiveSaved'));
  paint();
  void syncToBox();
});

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

el('sample').hidden = window.indentsSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live register (a GET — read-only). Offline or refused, the screen keeps its current view and the stale strip
// already says the page is what the box last told it. The live session becomes THE session — on the page and on the
// window — so what is shown and what is asked agree.
async function refresh() {
  const api = window.indents;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data) { session = api.present(data); window.indentsSession = session; paint(); }
}
el('refresh').addEventListener('click', () => { void refresh(); });
refresh();

/**
 * Hand this screen's saved asks and counts to the store computer and learn where they have got to (SP-2 / SP-7a). The
 * relay is the composition root's (`window.indentsRelay`), present only when the box told this screen where its socket
 * is. Called after every save and when the page regains the network or the reader's attention — no timer.
 */
async function syncToBox() {
  const relay = window.indentsRelay;
  if (!relay) return;
  try { await relay.syncNow(); } catch { /* the queue is untouched; the state words say "saved on this device" */ }
  renderSaved();
}
for (const moment of ['online', 'focus', 'pageshow']) window.addEventListener(moment, () => { void syncToBox(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncToBox(); });
void syncToBox();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
