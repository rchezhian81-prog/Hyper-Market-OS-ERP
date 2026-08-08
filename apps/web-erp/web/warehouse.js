// Warehouse supervisor — the view layer (M09 / OA-9). It renders the oversight the box served and
// holds NO rule of its own; every derivation (occupancy, exceptions) lives in the tested session model
// (`apps/web-erp/src/warehouse-supervisor-session.ts`), attached as `window.warehouseSupervisorSession`
// and built from the SAME `warehouse` data the handheld reads — so the floor and the office cannot
// disagree.
//
// ── What this file exists to hold ───────────────────────────────────────────
//
// **"I have not been told" is not "all clear".** The session answers `known: false` for stock and
// exceptions when the box was never sent the bin contents; this screen shows that plainly rather than
// an empty, healthy-looking warehouse — the same rule the manager's day close holds (P-08).
//
// Every word is English and Tamil, keyed to the session's `WAREHOUSE_EXCEPTION_KINDS`; a completeness
// tripwire fails the build if either language lacks one.
// NOTE: the Tamil below is pending a native-speaker review before go-live (OWNER-ACTION OA-10).

const el = (id) => document.getElementById(id);

const WORDS = {
  en: {
    staleShell: 'No connection to the store computer. This page is what it was last told, at',
    sample: "Sample data — this is not the shop's own warehouse.",
    who: 'Warehouse supervisor',
    binsHeading: 'Bins', binsLead: 'Configuration and how full each bin is.',
    colBin: 'Bin', colZone: 'Zone', colKind: 'Kind', colCapacity: 'Capacity', colUsed: 'Used', colFree: 'Free', colFull: 'Full',
    pickable: 'pickable', holding: 'holding',
    stockHeading: 'Stock in the bins', colProduct: 'Product', colBatch: 'Batch', colQty: 'Quantity',
    exHeading: 'Exceptions', exNone: 'No exceptions — the warehouse is in order.',
    notKnownStock: 'The store box has not been sent the current bin contents, so stock cannot be shown. This is not an empty warehouse — it is one this office has not been told about yet.',
    notKnownEx: 'The store box has not been sent the current bin contents, so exceptions cannot be checked. Not knowing is not the same as none.',
    // exception kinds, keyed to WAREHOUSE_EXCEPTION_KINDS
    negative_stock: 'Impossible negative stock', over_capacity: 'Bin over capacity', recalled_in_pickable_bin: 'Recalled stock in a pickable bin',
    // approvals
    apprHeading: 'Approvals waiting on you',
    apprNotKnown: 'The store box has not sent the pending approvals, or who the supervisor is. Not knowing is not the same as none.',
    apprEmpty: 'No approvals are waiting.',
    approve: 'Approve', reject: 'Reject', cancel: 'Cancel', from: 'from', noValue: 'no value',
    reasonApprove: 'Why are you approving this?', reasonReject: 'Why are you rejecting this?',
    // blocked reasons (why a row is not actionable by this supervisor)
    own_request: 'Your own request — someone else must decide it', out_of_scope: 'Outside your branch', exceeds_authority: 'Above your approval limit — escalate',
    // approve reason codes (packages/approvals APPROVE_REASONS)
    within_policy: 'Within policy', checked_with_supplier: 'Checked with the supplier', checked_the_stock: 'Checked the stock', owner_instructed: 'Owner instructed',
    // reject reason codes (packages/approvals REJECT_REASONS)
    price_looks_wrong: 'The price looks wrong', not_enough_evidence: 'Not enough evidence', against_policy: 'Against policy', ask_the_owner_first: 'Ask the owner first',
    // outcomes
    decidedApproved: 'Approved and queued to sync', decidedRejected: 'Rejected and queued to sync', decideRefused: 'Could not record the decision',
    // supervisor actions — transfer planning & task assignment
    actionsHeading: 'Plan work',
    transferHeading: 'Propose a transfer', lFrom: 'From location', lTo: 'To location', lProduct: 'Product', lQty: 'Quantity', lCost: 'Unit cost (₹)', doTransfer: 'Propose transfer',
    taskHeading: 'Assign a task', lKind: 'Task', lAssignee: 'Assign to', lTproduct: 'Product (optional)', lBin: 'Bin (optional)', doTask: 'Assign task',
    // task kinds, keyed to WAREHOUSE_TASK_KINDS
    put_away: 'Put away', count: 'Count', bin_to_bin: 'Move bin to bin', replenish: 'Replenish',
    transferQueued: 'Transfer proposed and queued to sync', taskQueued: 'Task assigned and queued to sync', actionRefused: 'Could not do that',
  },
  ta: {
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
    sample: 'மாதிரி தரவு — இது கடையின் சொந்தக் கிடங்கு அல்ல.',
    who: 'கிடங்கு மேற்பார்வையாளர்',
    binsHeading: 'இடங்கள்', binsLead: 'அமைப்பு மற்றும் ஒவ்வொரு இடமும் எவ்வளவு நிரம்பியுள்ளது.',
    colBin: 'இடம்', colZone: 'மண்டலம்', colKind: 'வகை', colCapacity: 'கொள்ளளவு', colUsed: 'பயன்பட்டது', colFree: 'மீதம்', colFull: 'நிரம்பியது',
    pickable: 'எடுக்கும்', holding: 'சேமிப்பு',
    stockHeading: 'இடங்களில் உள்ள சரக்கு', colProduct: 'பொருள்', colBatch: 'தொகுதி', colQty: 'அளவு',
    exHeading: 'விதிவிலக்குகள்', exNone: 'விதிவிலக்குகள் இல்லை — கிடங்கு ஒழுங்காக உள்ளது.',
    notKnownStock: 'கடை கணினி தற்போதைய இட உள்ளடக்கத்தை அனுப்பவில்லை, எனவே சரக்கைக் காட்ட முடியாது. இது காலி கிடங்கு அல்ல — இந்த அலுவலகத்திற்கு இன்னும் தெரிவிக்கப்படவில்லை.',
    notKnownEx: 'கடை கணினி தற்போதைய இட உள்ளடக்கத்தை அனுப்பவில்லை, எனவே விதிவிலக்குகளைச் சரிபார்க்க முடியாது. தெரியாதது என்பது இல்லை என்பது அல்ல.',
    negative_stock: 'சாத்தியமற்ற எதிர்மறை சரக்கு', over_capacity: 'இடம் கொள்ளளவைத் தாண்டியது', recalled_in_pickable_bin: 'எடுக்கும் இடத்தில் திரும்பப் பெற்ற சரக்கு',
    apprHeading: 'உங்கள் ஒப்புதலுக்குக் காத்திருப்பவை',
    apprNotKnown: 'கடை கணினி நிலுவையிலுள்ள ஒப்புதல்களையோ, மேற்பார்வையாளர் யார் என்பதையோ அனுப்பவில்லை. தெரியாதது என்பது இல்லை என்பது அல்ல.',
    apprEmpty: 'ஒப்புதல்கள் எதுவும் காத்திருக்கவில்லை.',
    approve: 'ஒப்புதல்', reject: 'நிராகரி', cancel: 'ரத்து', from: 'கேட்டவர்', noValue: 'மதிப்பு இல்லை',
    reasonApprove: 'ஏன் ஒப்புதல் அளிக்கிறீர்கள்?', reasonReject: 'ஏன் நிராகரிக்கிறீர்கள்?',
    own_request: 'உங்கள் சொந்த கோரிக்கை — வேறு ஒருவர் முடிவு செய்ய வேண்டும்', out_of_scope: 'உங்கள் கிளைக்கு வெளியே', exceeds_authority: 'உங்கள் ஒப்புதல் வரம்பைத் தாண்டியது — மேலிடத்திற்கு அனுப்பவும்',
    within_policy: 'கொள்கையின்படி', checked_with_supplier: 'சப்ளையருடன் சரிபார்க்கப்பட்டது', checked_the_stock: 'சரக்கு சரிபார்க்கப்பட்டது', owner_instructed: 'உரிமையாளர் அறிவுறுத்தினார்',
    price_looks_wrong: 'விலை தவறாகத் தெரிகிறது', not_enough_evidence: 'போதிய ஆதாரம் இல்லை', against_policy: 'கொள்கைக்கு எதிரானது', ask_the_owner_first: 'முதலில் உரிமையாளரிடம் கேளுங்கள்',
    decidedApproved: 'ஒப்புதல் அளித்து அனுப்பக் காத்திருக்கிறது', decidedRejected: 'நிராகரித்து அனுப்பக் காத்திருக்கிறது', decideRefused: 'முடிவைப் பதிவு செய்ய முடியவில்லை',
    actionsHeading: 'வேலை திட்டமிடு',
    transferHeading: 'இடமாற்றத்தை முன்மொழி', lFrom: 'எந்த இடத்திலிருந்து', lTo: 'எந்த இடத்திற்கு', lProduct: 'பொருள்', lQty: 'அளவு', lCost: 'ஓரலகு விலை (₹)', doTransfer: 'இடமாற்றத்தை முன்மொழி',
    taskHeading: 'பணியை ஒதுக்கு', lKind: 'பணி', lAssignee: 'யாருக்கு', lTproduct: 'பொருள் (விருப்பம்)', lBin: 'இடம் (விருப்பம்)', doTask: 'பணியை ஒதுக்கு',
    put_away: 'அடுக்கி வை', count: 'எண்ணிக்கை', bin_to_bin: 'இடத்திலிருந்து இடத்திற்கு நகர்த்து', replenish: 'நிரப்பு',
    transferQueued: 'இடமாற்றம் முன்மொழியப்பட்டு அனுப்பக் காத்திருக்கிறது', taskQueued: 'பணி ஒதுக்கப்பட்டு அனுப்பக் காத்திருக்கிறது', actionRefused: 'அதைச் செய்ய முடியவில்லை',
  },
};

const TASK_KINDS = ['put_away', 'count', 'bin_to_bin', 'replenish'];

const APPROVE_CODES = ['within_policy', 'checked_with_supplier', 'checked_the_stock', 'owner_instructed'];
const REJECT_CODES = ['price_looks_wrong', 'not_enough_evidence', 'against_policy', 'ask_the_owner_first'];
const inr = (minor) => '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const decided = new Set(); // request ids decided this session, so a row is not offered twice
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key] ?? key;

const real = window.warehouseSupervisorSession;
const data = window.warehouseSupervisorData;

function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = String(text);
  return td;
}
function headRow(keys) {
  const tr = document.createElement('tr');
  for (const k of keys) { const th = document.createElement('th'); th.textContent = t(k); tr.append(th); }
  return tr;
}

function renderBins() {
  const host = el('bins');
  host.textContent = '';
  if (real === undefined) return;
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.append(headRow(['colBin', 'colZone', 'colKind', 'colCapacity', 'colUsed', 'colFree', 'colFull']));
  table.append(thead);
  const tbody = document.createElement('tbody');
  for (const b of real.bins()) {
    const tr = document.createElement('tr');
    const over = b.usedMinor !== null && b.usedMinor > b.capacityMinor;
    if (over) tr.className = 'over';
    tr.append(
      cell(b.binId), cell(b.zone ?? '—'), cell(b.pickable ? t('pickable') : t('holding')),
      cell(b.capacityMinor, 'num'),
      cell(b.usedMinor === null ? '—' : b.usedMinor, 'num'),
      cell(b.freeMinor === null ? '—' : b.freeMinor, 'num'),
      cell(b.pctFull === null ? '—' : `${b.pctFull}%`, 'num'),
    );
    tbody.append(tr);
  }
  table.append(tbody);
  host.append(table);
}

function renderStock() {
  const host = el('stock');
  host.textContent = '';
  if (real === undefined) return;
  const stock = real.stock();
  if (!stock.known) {
    const p = document.createElement('p'); p.className = 'notknown'; p.textContent = t('notKnownStock'); host.append(p);
    return;
  }
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.append(headRow(['colBin', 'colProduct', 'colBatch', 'colQty']));
  table.append(thead);
  const tbody = document.createElement('tbody');
  for (const r of stock.rows) {
    const tr = document.createElement('tr');
    tr.append(cell(r.binId), cell(r.productId), cell(r.batchId ?? '—'), cell(r.quantityMinor, 'num'));
    tbody.append(tr);
  }
  table.append(tbody);
  host.append(table);
}

function renderExceptions() {
  const host = el('exceptions');
  host.textContent = '';
  if (real === undefined) return;
  const ex = real.exceptions();
  if (!ex.known) {
    const p = document.createElement('p'); p.className = 'notknown'; p.textContent = t('notKnownEx'); host.append(p);
    return;
  }
  if (ex.rows.length === 0) {
    const p = document.createElement('p'); p.className = 'ex-empty'; p.textContent = t('exNone'); host.append(p);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'ex';
  for (const e of ex.rows) {
    const row = document.createElement('div');
    row.className = `row ${e.kind}`;
    const k = document.createElement('div'); k.className = 'kind'; k.textContent = t(e.kind);
    const d = document.createElement('div'); d.className = 'detail'; d.textContent = e.detail;
    row.append(k, d);
    wrap.append(row);
  }
  host.append(wrap);
}

function renderApprovals() {
  const host = el('approvals');
  host.textContent = '';
  if (real === undefined) return;
  const q = real.approvalQueue();
  if (!q.known) {
    const p = document.createElement('p'); p.className = 'notknown'; p.textContent = t('apprNotKnown'); host.append(p);
    return;
  }
  const rows = q.rows.filter((r) => !decided.has(r.request.id));
  if (rows.length === 0) {
    const p = document.createElement('p'); p.className = 'ex-empty'; p.textContent = t('apprEmpty'); host.append(p);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'appr';
  for (const row of rows) {
    const box = document.createElement('div');
    box.className = 'row';
    const subject = document.createElement('div');
    subject.className = 'subject';
    const val = row.request.value ? inr(row.request.value.minor) : t('noValue');
    subject.textContent = `${row.request.subjectType.replace(/_/g, ' ')} · ${val} · ${t('from')} ${row.request.requestedBy}`;
    box.append(subject);
    if (row.actionable) {
      const buttons = document.createElement('div');
      buttons.className = 'buttons';
      const approve = document.createElement('button'); approve.className = 'approve'; approve.type = 'button'; approve.textContent = t('approve');
      approve.addEventListener('click', () => openReason(row.request.id, 'approved'));
      const reject = document.createElement('button'); reject.className = 'reject'; reject.type = 'button'; reject.textContent = t('reject');
      reject.addEventListener('click', () => openReason(row.request.id, 'rejected'));
      buttons.append(approve, reject);
      box.append(buttons);
    } else {
      const blocked = document.createElement('div');
      blocked.className = 'blocked';
      blocked.textContent = t(row.blockedReason);
      box.append(blocked);
    }
    wrap.append(box);
  }
  host.append(wrap);
}

// ── Deciding an approval — a reason is chosen on-screen, never typed, never a prompt ──────────
function openReason(requestId, decision) {
  el('reason-title').textContent = decision === 'approved' ? t('reasonApprove') : t('reasonReject');
  const choices = el('reason-choices');
  choices.textContent = '';
  for (const code of decision === 'approved' ? APPROVE_CODES : REJECT_CODES) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = t(code);
    b.addEventListener('click', () => { el('reason-sheet').hidden = true; submit(requestId, decision, code); });
    choices.append(b);
  }
  el('reason-sheet').hidden = false;
}
el('reason-cancel').addEventListener('click', () => { el('reason-sheet').hidden = true; });

function submit(requestId, decision, reasonCode) {
  const outbox = window.warehouseSupervisorOutbox;
  const out = real.decide({ requestId, decision, reasonCode, decidedAt: new Date().toISOString() }, outbox);
  if (out && out.ok) {
    decided.add(requestId);
    toast(decision === 'approved' ? t('decidedApproved') : t('decidedRejected'), false);
  } else {
    toast(`${t('decideRefused')}: ${out ? out.refusal : 'no_outbox'}`, true);
  }
  render();
}

let toastTimer = null;
function toast(text, bad) {
  const strip = el('toast');
  strip.className = 'toast' + (bad ? ' bad' : '');
  strip.textContent = text;
  strip.hidden = false;
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { strip.hidden = true; }, 4000);
}

// ── Supervisor actions: plan a transfer, assign a task ──────────────────────
// On-screen forms; the tested session holds every rule. A minted id makes each action idempotent.
let actionSeq = 0;
const mintId = (prefix) => `${prefix}-${Date.now()}-${actionSeq++}`;

function paintActionLabels() {
  el('actions-heading').textContent = t('actionsHeading');
  el('transfer-heading').textContent = t('transferHeading');
  el('l-from').textContent = t('lFrom'); el('l-to').textContent = t('lTo'); el('l-product').textContent = t('lProduct');
  el('l-qty').textContent = t('lQty'); el('l-cost').textContent = t('lCost'); el('t-do').textContent = t('doTransfer');
  el('task-heading').textContent = t('taskHeading');
  el('l-kind').textContent = t('lKind'); el('l-assignee').textContent = t('lAssignee');
  el('l-tproduct').textContent = t('lTproduct'); el('l-bin').textContent = t('lBin'); el('k-do').textContent = t('doTask');
  const picker = el('k-kind');
  const current = picker.value;
  picker.textContent = '';
  for (const kind of TASK_KINDS) {
    const opt = document.createElement('option'); opt.value = kind; opt.textContent = t(kind); picker.append(opt);
  }
  if (current) picker.value = current;
}

el('t-do').addEventListener('click', () => {
  const rupees = Number(el('t-cost').value);
  const qty = Number(el('t-qty').value);
  const out = real.proposeTransfer({
    transferId: mintId('t'), fromLocationId: el('t-from').value.trim(), toLocationId: el('t-to').value.trim(),
    lines: [{ productId: el('t-product').value.trim(), quantityMinor: Math.round(qty), uom: 'EA', unitCostMinor: Math.round(rupees * 100), currency: 'INR' }],
  }, window.warehouseSupervisorOutbox);
  if (out && out.ok) { toast(t('transferQueued'), false); ['t-from', 't-to', 't-product', 't-qty', 't-cost'].forEach((id) => { el(id).value = ''; }); }
  else { toast(`${t('actionRefused')}: ${out ? out.refusal : 'no_outbox'}`, true); }
});

el('k-do').addEventListener('click', () => {
  const out = real.assignTask({
    taskId: mintId('tk'), kind: el('k-kind').value, assignedTo: el('k-assignee').value.trim(),
    productId: el('k-product').value.trim() || undefined, binId: el('k-bin').value.trim() || undefined,
    at: new Date().toISOString(),
  }, window.warehouseSupervisorOutbox);
  if (out && out.ok) { toast(t('taskQueued'), false); ['k-assignee', 'k-product', 'k-bin'].forEach((id) => { el(id).value = ''; }); }
  else { toast(`${t('actionRefused')}: ${out ? out.refusal : 'no_outbox'}`, true); }
});

function render() {
  el('who').firstChild.textContent = t('who');
  el('store').textContent = (data && data.storeId) || '';
  el('bins-heading').textContent = t('binsHeading');
  el('bins-lead').textContent = t('binsLead');
  el('stock-heading').textContent = t('stockHeading');
  el('ex-heading').textContent = t('exHeading');
  el('appr-heading').textContent = t('apprHeading');
  renderBins();
  renderStock();
  renderExceptions();
  renderApprovals();
  paintActionLabels();
}

// ── Boot ────────────────────────────────────────────────────────────────────
el('sample').hidden = real !== undefined;
el('sample').textContent = t('sample');
render();

// ── Language ────────────────────────────────────────────────────────────────
el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  el('sample').textContent = t('sample');
  render();
});

// ── The shell's own honesty about where this page came from (P-08) ───────────
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
