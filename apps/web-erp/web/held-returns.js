// Returned goods to decide — the view (WF-11 · M13-FR-02 · PF-14 · M28-FR-01 · P-08). Reads the held units live from
// head office (GET /v1/returns/held-stock/worklist) and sends one person's decision on one unit (POST …/decisions/:id).
// Head office decides whether it stands — permission, quality hold, the loss's value, evidence and a second person for
// a big loss — and this page shows exactly what it answered, never its own guess. A decision id is minted once per
// unit and re-used if the answer is lost, so a retry never records twice. No prompt/confirm/alert; nothing on a timer.

// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never this device's.
/** OB-31: a held quantity (the unit's smallest step) as a person reads it — 2500 of a kg product reads "2.500 kg". */
const qtyText = (n, uom) => (window.sreQuantity?.label ? window.sreQuantity.label(n, uom ?? '') : `${n} ${uom ?? ''}`.trim());
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? '';
const el = (id) => document.getElementById(id);
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    title: 'Returned goods to decide', langName: 'தமிழ்',
    lead: 'Each unit a customer returned that could not go back on the shelf. Decide what happens to it: back on sale, write off, back to the supplier, or out for repair.',
    waiting: 'waiting for a decision', noneWaiting: 'Nothing is waiting — every returned unit has been decided.',
    openHeading: 'Waiting for a decision', doneHeading: 'Decided',
    held: 'Held', atRepair: 'Out for repair', restocked: 'Back on sale', writtenOff: 'Written off', returnedToSupplier: 'Back to the supplier',
    returnLabel: 'Return', batchLabel: 'Batch', noBatch: 'no batch', conditionLabel: 'Condition', placeLabel: 'Place', noPlace: 'not named', sinceLabel: 'Held since', byLabel: 'by',
    decisionLabel: 'Decision', restock: 'Put back on sale', writeOff: 'Write off', toSupplier: 'Return to supplier', repair: 'Send for repair',
    reasonLabel: 'Reason', supplierLabel: 'Supplier', supplierRefLabel: 'Supplier reference', evidenceLabel: 'Photo or witness reference', approvalLabel: 'Approval id (big loss)',
    record: 'Record decision', recorded: 'Recorded', refused: 'Not recorded', unreachable: 'Head office could not be reached. Nothing was recorded — try again.',
    // U1 · OB-626: the consequence-and-confirm sheet before a unit is written off or sent back
    confirmWriteOffTitle: 'Write off {product} × {qty} as {reason}',
    confirmWriteOffDetail: 'The unit leaves stock as a loss in the books; head office values it. A big loss needs the approval named on the form. A write-off is never undone — a mistake is corrected by a new entry.',
    confirmReturnTitle: 'Send {product} × {qty} back to supplier {supplier}',
    confirmReturnDetail: 'The unit leaves stock and is set against the supplier. A return cannot be taken back from this screen.',
    confirmAuthority: 'In your name. Head office refuses it if your role may not decide held goods.',
    confirmWriteOffLabel: 'Write it off', confirmReturnLabel: 'Send it back', confirmUnavailable: 'The confirm step could not open, so nothing was sent. Reload the page and try again.',
    cannotRead: 'The list could not be read from head office. Nothing here is current.', needReason: 'Give a reason first.',
    valueLabel: 'Loss value', approvedByLabel: 'approved by',
    wasteReasonLabel: 'Why it is lost', noteLabel: 'Note (your own words)', needWasteReason: 'Choose why it is lost from the list first.',
    expiry: 'Past its date', damage: 'Damaged', shrinkage: 'Missing (shrinkage)', preparation: 'Lost in preparation', customer_return: 'Customer return, not saleable', recall: 'Recalled',
  },
  ta: {
    title: 'முடிவு தேவைப்படும் திரும்பிய பொருட்கள்', langName: 'English',
    lead: 'அடுக்கில் மீண்டும் வைக்க முடியாத, வாடிக்கையாளர் திருப்பிய ஒவ்வொரு பொருளும். என்ன செய்வது என்று முடிவு செய்யுங்கள்: மீண்டும் விற்பனைக்கு, தள்ளுபடி, சப்ளையருக்குத் திருப்புதல், அல்லது பழுதுபார்ப்பு.',
    waiting: 'முடிவுக்குக் காத்திருக்கின்றன', noneWaiting: 'எதுவும் காத்திருக்கவில்லை — திரும்பிய ஒவ்வொரு பொருளுக்கும் முடிவு எடுக்கப்பட்டது.',
    openHeading: 'முடிவுக்குக் காத்திருப்பவை', doneHeading: 'முடிவு எடுக்கப்பட்டவை',
    held: 'நிறுத்தப்பட்டது', atRepair: 'பழுதுபார்ப்பில்', restocked: 'மீண்டும் விற்பனைக்கு', writtenOff: 'தள்ளுபடி செய்யப்பட்டது', returnedToSupplier: 'சப்ளையருக்குத் திருப்பப்பட்டது',
    returnLabel: 'திருப்பம்', batchLabel: 'தொகுதி', noBatch: 'தொகுதி இல்லை', conditionLabel: 'நிலை', placeLabel: 'இடம்', noPlace: 'குறிப்பிடப்படவில்லை', sinceLabel: 'முதல்', byLabel: 'மூலம்',
    decisionLabel: 'முடிவு', restock: 'மீண்டும் விற்பனைக்கு வை', writeOff: 'தள்ளுபடி செய்', toSupplier: 'சப்ளையருக்குத் திருப்பு', repair: 'பழுதுபார்க்க அனுப்பு',
    reasonLabel: 'காரணம்', supplierLabel: 'சப்ளையர்', supplierRefLabel: 'சப்ளையர் குறிப்பு', evidenceLabel: 'புகைப்படம் அல்லது சாட்சி குறிப்பு', approvalLabel: 'ஒப்புதல் எண் (பெரிய இழப்பு)',
    record: 'முடிவைப் பதிவு செய்', recorded: 'பதிவு செய்யப்பட்டது', refused: 'பதிவு செய்யப்படவில்லை', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் பதிவு செய்யப்படவில்லை — மீண்டும் முயலவும்.',
    confirmWriteOffTitle: '{product} × {qty} — {reason} எனக் கழித்து எழுதப்படும்',
    confirmWriteOffDetail: 'அந்த அலகு இழப்பாகக் கணக்கிலிருந்து வெளியேறும்; தலைமை அலுவலகம் அதன் மதிப்பைக் கணக்கிடும். பெரிய இழப்புக்குப் படிவத்தில் குறிப்பிட்ட அனுமதி தேவை. கழித்து எழுதியதைத் திரும்பப் பெற முடியாது — தவறு புதிய பதிவால் திருத்தப்படும்.',
    confirmReturnTitle: '{product} × {qty} — விநியோகஸ்தர் {supplier}க்குத் திருப்பி அனுப்பப்படும்',
    confirmReturnDetail: 'அந்த அலகு சரக்கிலிருந்து வெளியேறி விநியோகஸ்தர் கணக்கில் வைக்கப்படும். இந்தத் திரையில் திருப்பலைத் திரும்பப் பெற முடியாது.',
    confirmAuthority: 'உங்கள் பெயரில். நிறுத்தி வைத்த சரக்கை முடிவு செய்யும் உரிமை உங்கள் பங்கிற்கு இல்லையெனில் தலைமை அலுவலகம் மறுக்கும்.',
    confirmWriteOffLabel: 'கழித்து எழுது', confirmReturnLabel: 'திருப்பி அனுப்பு', confirmUnavailable: 'உறுதிப்படுத்தும் திரையைத் திறக்க முடியவில்லை, எனவே எதுவும் அனுப்பப்படவில்லை. பக்கத்தைப் புதுப்பித்து மீண்டும் முயற்சிக்கவும்.',
    cannotRead: 'தலைமை அலுவலகத்திலிருந்து பட்டியலைப் படிக்க முடியவில்லை. இங்குள்ளவை தற்போதையவை அல்ல.', needReason: 'முதலில் காரணம் கொடுங்கள்.',
    valueLabel: 'இழப்பு மதிப்பு', approvedByLabel: 'ஒப்புதல் அளித்தவர்',
    wasteReasonLabel: 'ஏன் இழப்பு', noteLabel: 'குறிப்பு (உங்கள் சொற்களில்)', needWasteReason: 'முதலில் பட்டியலிலிருந்து இழப்புக் காரணத்தைத் தேர்ந்தெடுக்கவும்.',
    expiry: 'காலாவதியானது', damage: 'சேதமடைந்தது', shrinkage: 'காணாமல் போனது', preparation: 'தயாரிப்பில் வீணானது', customer_return: 'வாடிக்கையாளர் திருப்பியது, விற்க முடியாது', recall: 'திரும்பப் பெறப்பட்டது',
  },
};
const t = (key) => WORDS[lang]?.[key] ?? WORDS.en[key] ?? key;
const STATE_WORD = { held: 'held', at_repair: 'atRepair', restocked: 'restocked', written_off: 'writtenOff', returned_to_supplier: 'returnedToSupplier' };
const DECISION_WORD = { restock: 'restock', write_off: 'writeOff', return_to_supplier: 'toSupplier', repair: 'repair' };
// NEW-7 (D-5 · OB-159): a write-off's reason is one of the closed six — chosen, never typed; the typed words become the note.
const WASTE_REASONS = ['expiry', 'damage', 'shrinkage', 'preparation', 'customer_return', 'recall'];
const rupees = (minor) => `₹${(minor / 100).toFixed(2)}`;

let items = [];
let readFailed = false;
/** One decision id per unit, kept until head office answers — a retry after a lost answer is the same decision. */
const pendingIds = new Map();

function field(labelKey, control) {
  const label = document.createElement('label');
  const span = document.createElement('span'); span.textContent = t(labelKey);
  label.append(span, control);
  return label;
}

function decisionForm(item) {
  const form = document.createElement('form');
  form.className = 'decide';
  const select = document.createElement('select'); select.className = 'decision'; select.name = 'decision';
  for (const d of item.state === 'at_repair' ? ['restock', 'write_off', 'return_to_supplier'] : ['restock', 'write_off', 'return_to_supplier', 'repair']) {
    const o = document.createElement('option'); o.value = d; o.textContent = t(DECISION_WORD[d]); select.append(o);
  }
  const reason = document.createElement('input'); reason.className = 'reason'; reason.name = 'reasonCode'; reason.autocomplete = 'off';
  const wasteReason = document.createElement('select'); wasteReason.className = 'waste-reason'; wasteReason.name = 'wasteReason';
  const none = document.createElement('option'); none.value = ''; none.textContent = '—'; wasteReason.append(none);
  for (const r of WASTE_REASONS) { const o = document.createElement('option'); o.value = r; o.textContent = t(r); wasteReason.append(o); }
  const supplier = document.createElement('input'); supplier.className = 'supplier'; supplier.name = 'supplierId'; supplier.autocomplete = 'off';
  const supplierRef = document.createElement('input'); supplierRef.className = 'supplier-ref'; supplierRef.name = 'supplierRef'; supplierRef.autocomplete = 'off';
  const evidence = document.createElement('input'); evidence.className = 'evidence'; evidence.name = 'evidenceRef'; evidence.autocomplete = 'off';
  const approval = document.createElement('input'); approval.className = 'approval'; approval.name = 'approvalId'; approval.autocomplete = 'off';
  const supplierField = field('supplierLabel', supplier);
  const supplierRefField = field('supplierRefLabel', supplierRef);
  const evidenceField = field('evidenceLabel', evidence);
  const approvalField = field('approvalLabel', approval);
  const wasteReasonField = field('wasteReasonLabel', wasteReason);
  const reasonField = field('reasonLabel', reason);
  const sync = () => {
    wasteReasonField.hidden = select.value !== 'write_off';
    reasonField.querySelector('span').textContent = t(select.value === 'write_off' ? 'noteLabel' : 'reasonLabel');
    supplierField.hidden = select.value !== 'return_to_supplier';
    supplierRefField.hidden = select.value !== 'return_to_supplier';
    evidenceField.hidden = select.value !== 'write_off';
    approvalField.hidden = select.value !== 'write_off';
  };
  select.addEventListener('change', sync);
  const button = document.createElement('button'); button.type = 'submit'; button.className = 'act record sre-btn sre-btn-primary'; button.textContent = t('record');
  form.append(field('decisionLabel', select), wasteReasonField, reasonField, supplierField, supplierRefField, evidenceField, approvalField, button);
  sync();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = { decision: select.value, wasteReason: wasteReason.value, reasonCode: reason.value.trim(), supplierId: supplier.value.trim(), supplierRef: supplierRef.value.trim(), evidenceRef: evidence.value.trim(), approvalId: approval.value.trim() };
    void (async () => {
      // U1 · OB-626: a write-off or a return to the supplier moves stock — the consequence-and-confirm sheet first; Go back
      // sends nothing. Restock and repair keep the goods and need no sheet.
      if (values.decision === 'write_off' || values.decision === 'return_to_supplier') {
        if (values.decision === 'write_off' && values.wasteReason === '') { tell(false, t('needWasteReason')); return; }
        if (values.decision !== 'write_off' && values.reasonCode === '') { tell(false, t('needReason')); return; }
        const off = values.decision === 'write_off';
        const sub = (l, key) => String(WORDS[l][key]).replace('{product}', item.productId).replace('{qty}', qtyText(item.quantityMinor, item.uom)).replace('{reason}', WORDS[l][values.wasteReason] ?? values.wasteReason).replace('{supplier}', values.supplierId);
        const answer = await confirmFirst({
          title: { en: sub('en', off ? 'confirmWriteOffTitle' : 'confirmReturnTitle'), ta: sub('ta', off ? 'confirmWriteOffTitle' : 'confirmReturnTitle') },
          detail: { en: sub('en', off ? 'confirmWriteOffDetail' : 'confirmReturnDetail'), ta: sub('ta', off ? 'confirmWriteOffDetail' : 'confirmReturnDetail') },
          authority: { en: WORDS.en.confirmAuthority, ta: WORDS.ta.confirmAuthority },
          confirmLabel: { en: WORDS.en[off ? 'confirmWriteOffLabel' : 'confirmReturnLabel'], ta: WORDS.ta[off ? 'confirmWriteOffLabel' : 'confirmReturnLabel'] }, tone: off ? 'danger' : 'primary',
        });
        if (answer === 'unavailable') { tell(false, t('confirmUnavailable')); return; }
        if (answer === null) return;
      }
      await send(item, values, button);
    })();
  });
  return form;
}

function rowNode(item, open) {
  const li = document.createElement('li');
  li.className = `row tone-${open ? 'degraded' : 'ok'}`;
  li.dataset.heldId = item.heldId;
  const head = document.createElement('div'); head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline';
  headline.textContent = `${item.productId} × ${qtyText(item.quantityMinor, item.uom)}`;
  // U1 · L: the state as a chip from the one icon set — the tone's shape AND the word, never a character or colour alone.
  const stateLabel = t(STATE_WORD[item.state] ?? 'held');
  const state = window.sreIcon && typeof window.sreIcon.chip === 'function'
    ? window.sreIcon.chip({ tone: open ? 'degraded' : 'ok', label: stateLabel })
    : Object.assign(document.createElement('span'), { className: 'sre-chip', textContent: stateLabel });
  state.classList.add('state');
  head.append(headline, state);
  const facts = document.createElement('div'); facts.className = 'facts';
  const fact = (text) => { const s = document.createElement('span'); s.textContent = text; facts.append(s); };
  fact(`${t('returnLabel')}: ${item.returnId}`);
  fact(`${t('batchLabel')}: ${item.batchId ?? t('noBatch')}`);
  if (item.condition) fact(`${t('conditionLabel')}: ${item.condition}`);
  fact(`${t('placeLabel')}: ${item.locationId ?? t('noPlace')}`);
  fact(`${t('sinceLabel')}: ${shopWhen(item.heldAt)}`);
  for (const d of item.decisions) {
    const extra = d.valueMinor === undefined ? '' : ` · ${t('valueLabel')} ${rupees(d.valueMinor)}${d.approvedBy ? ` · ${t('approvedByLabel')} ${d.approvedBy}` : ''}`;
    const why = d.decision === 'write_off' && WASTE_REASONS.includes(d.reasonCode) ? t(d.reasonCode) : d.reasonCode;
    fact(`${t(DECISION_WORD[d.decision])} ${t('byLabel')} ${d.decidedBy} (${why}${d.note ? ` — ${d.note}` : ''})${extra}`);
  }
  li.append(head, facts);
  if (open) li.append(decisionForm(item));
  return li;
}

function paint() {
  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('lang').textContent = t('langName');
  el('whoami').textContent = window.heldReturnsWho ?? window.heldReturnsData?.userId ?? '';
  const open = items.filter((i) => i.state === 'held' || i.state === 'at_repair');
  const done = items.filter((i) => !(i.state === 'held' || i.state === 'at_repair'));
  el('summary').textContent = readFailed ? '' : open.length === 0 ? t('noneWaiting') : `${open.length} ${t('waiting')}`;
  const state = el('state');
  state.hidden = !readFailed;
  state.textContent = readFailed ? t('cannotRead') : '';
  el('open-heading').hidden = open.length === 0; el('open-heading').textContent = t('openHeading');
  el('done-heading').hidden = done.length === 0; el('done-heading').textContent = t('doneHeading');
  el('rows').replaceChildren(...open.map((i) => rowNode(i, true)));
  el('done-rows').replaceChildren(...done.map((i) => rowNode(i, false)));
}

// U1 · OB-626 (design system §1.3, §27.1): a money/stock click asks the shared consequence-and-confirm sheet first.
// `null` = the person went back (nothing is sent); 'unavailable' = the sheet could not open (said, never silent).
async function confirmFirst(spec) {
  const office = window.sreOffice;
  if (!office || typeof office.confirm !== 'function') return 'unavailable';
  const answer = await office.confirm(spec);
  return answer && answer.ok === true ? answer : null;
}

function tell(ok, text) {
  const r = el('result');
  r.hidden = false;
  r.className = `result tone-${ok ? 'ok' : 'error'}`;
  r.textContent = text;
}

async function refresh() {
  try {
    const res = await fetch('/v1/returns/held-stock/worklist', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    items = Array.isArray(body.items) ? body.items : [];
    readFailed = false;
  } catch {
    readFailed = true;
  }
  paint();
}

async function send(item, values, button) {
  if (values.decision === 'write_off' && values.wasteReason === '') { tell(false, t('needWasteReason')); return; }
  if (values.decision !== 'write_off' && values.reasonCode === '') { tell(false, t('needReason')); return; }
  const decisionId = pendingIds.get(item.heldId) ?? `hd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  pendingIds.set(item.heldId, decisionId);
  const body = values.decision === 'write_off'
    ? { decision: values.decision, reasonCode: values.wasteReason, ...(values.reasonCode === '' ? {} : { note: values.reasonCode }) }
    : { decision: values.decision, reasonCode: values.reasonCode };
  if (values.decision === 'return_to_supplier') { body.supplierId = values.supplierId; if (values.supplierRef) body.supplierRef = values.supplierRef; }
  if (values.decision === 'write_off') { if (values.evidenceRef) body.evidenceRef = values.evidenceRef; if (values.approvalId) body.approvalId = values.approvalId; }
  button.disabled = true;
  try {
    const res = await fetch(`/v1/returns/held-stock/${encodeURIComponent(item.heldId)}/decisions/${encodeURIComponent(decisionId)}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': `${decisionId}-${values.decision}` },
      body: JSON.stringify(body),
    });
    const answer = await res.json().catch(() => ({}));
    if (res.ok) {
      pendingIds.delete(item.heldId);
      tell(true, `${t('recorded')}: ${item.productId} — ${t(STATE_WORD[answer.state] ?? 'held')}`);
    } else {
      // Head office refused: nothing was recorded. A changed decision is a new one, so the id is not kept.
      pendingIds.delete(item.heldId);
      tell(false, `${t('refused')}: ${answer?.error?.whatHappened ?? res.status} ${answer?.error?.nextSafeAction ?? ''}`.trim());
    }
  } catch {
    tell(false, t('unreachable'));
  } finally {
    button.disabled = false;
  }
  await refresh();
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
void refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
