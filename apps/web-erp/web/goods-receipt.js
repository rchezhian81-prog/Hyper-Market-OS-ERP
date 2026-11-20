// Goods receipt review — the view layer (M07-FR-02/03, API-04, P-03, P-08). Every rule lives in the TESTED
// session model (apps/web-erp/src/goods-receipt-session.ts), attached as window.goodsReceiptSession, built on
// packages/ui. This file only draws what the session hands it: deliveries needing a second person first (§28),
// then the ones with a valued difference from the order (worst money first), then the clean ones — each with its
// discrepancies named and valued. It captures and approves nothing (receiving is captured on the handheld). Its ONE
// write (Batch 2), on an explicit click, goes through the session's online port: a held line a second person disposed
// of as a RETURN has physically gone back to the supplier. Refresh re-reads the list live (a GET); offline the screen
// keeps its view and the stale strip says so. No prompt/confirm/alert.
// OB-204: a return above the e-way-bill limit shows where its e-way bill stands and, for a reader holding the
// stock-movement right, a Dispatch button beside it — an online write under the reader's session. A refusal is said in
// plain words and the return stays undispatched; with no connection the screen says it needs one. Only once head office
// has recorded the dispatch is the return offered as "gone back".
// R9-A · OB-534: each delivery with a line no supplier bill is matched to yet offers "Match the bill" (the supplier bill
// number, then the button) to a reader holding the bill-match right — never to the person who received the goods (the screen
// says someone else matches it). The bill matched is shown afterwards, line by line. An online write; offline it says so.

// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? '';
const el = (id) => document.getElementById(id);
let lang = 'en';

/** Money in exact minor units → the shop's own display. */
function money(minor, currency) {
  const sym = currency === 'INR' ? '₹' : `${currency} `;
  return sym + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// OB-773 (pilot audit B-2): quantities are NOT divided here. Head office keeps each line in its own unit's smallest steps
// (OB-31: a count for pieces, grams for kg) and the tested session says them for a person ("10 units", "2.5 kg").
/** The session's words for a quantity; an older session without them gets the plain count of pieces. */
function qtyWords(r, which) {
  const said = r[`${which}Quantity`];
  return typeof said === 'string' ? said : `${Number(r[`${which}Minor`] ?? 0).toLocaleString('en-IN')} ${t('unitsWord')}`;
}

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). It renders
 *  one clean delivery so the screen is never blank offline. */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Goods receipt review', langName: 'தமிழ்',
      lead: 'Sample deliveries. Connect the store computer to see your own shop’s receipts.',
      listHeading: 'Deliveries', asOfLabel: 'As of', refresh: 'Refresh',
      summaryDeliveries: 'deliveries', summaryNeedApproval: 'need a second person',
      receivedByLabel: 'Received by', warehouseLabel: 'Store/warehouse', noPo: 'No purchase order',
      sellableLabel: 'Became sellable', quarantinedLabel: 'Held back', rejectedLabel: 'Refused',
      discrepancyValueLabel: 'Value of the difference', unitsWord: 'units',
      sampleData: 'Sample data — this is not your shop.', },
    ta: {
      title: 'சரக்கு பெறுதல் மதிப்பாய்வு', langName: 'English',
      lead: 'மாதிரி டெலிவரிகள். உங்கள் கடையின் பெறுதல்களைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      listHeading: 'டெலிவரிகள்', asOfLabel: 'நிலவரம்', refresh: 'புதுப்பி',
      summaryDeliveries: 'டெலிவரிகள்', summaryNeedApproval: 'இரண்டாம் நபர் தேவை',
      receivedByLabel: 'பெற்றவர்', warehouseLabel: 'கடை/கிடங்கு', noPo: 'கொள்முதல் ஆர்டர் இல்லை',
      sellableLabel: 'விற்பனைக்கு ஆனது', quarantinedLabel: 'தடுத்து வைக்கப்பட்டது', rejectedLabel: 'மறுக்கப்பட்டது',
      discrepancyValueLabel: 'வேறுபாட்டின் மதிப்பு', unitsWord: 'அலகுகள்',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', },
  };
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      asOf: null,
      receipts: [{
        status: { tone: 'ok', icon: '✓', label: l === 'ta' ? 'ஆர்டர் செய்தபடி பெறப்பட்டது' : 'Received as ordered', announcement: 'received clean', needsAttention: false },
        grnId: 'sample', number: 'GRN-SAMPLE', poId: 'PO-1', warehouseId: 'W1', receivedBy: '—', receivedAt: '',
        needsApproval: false, discrepancyValueMinor: 0, currency: 'INR',
        sellableMinor: 100, quarantinedMinor: 0, rejectedMinor: 0, discrepancies: [], returnLines: [], costNotKnown: [], valueIncomplete: false,
      }],
      count: 1, needingApprovalCount: 0, nobodyNamed: false, canRecordReturn: false, awaitingReturn: [],
    }),
    recordReturn: async () => ({ outcome: 'no_link' }),
    dispatchReturn: async () => ({ outcome: 'no_link' }),
    presentDispatchOutcome: () => ({ tone: 'degraded', icon: '⚠', label: '', announcement: '', needsAttention: true }),
    presentReturnOutcome: () => ({ tone: 'degraded', icon: '⚠', label: '', announcement: '', needsAttention: true }),
  };
}

let session = window.goodsReceiptSession ?? sampleSession();
const t = (key) => session.text(lang, key);
// D-037: a place by its name where the office's directory knows it (the id itself otherwise — never a guess).
const placeName = (id) => { const o = window.sreOffice; const key = id ?? ''; return o && typeof o.nameOf === 'function' && key !== '' ? (o.nameOf('place', key) || key) : key; };
// U1 · OB-698 (design system §1.3, §27.1): a money/stock click asks the shared consequence-and-confirm sheet first.
// `null` = the person went back (nothing is sent); 'unavailable' = the sheet could not open (said, never silent).
async function confirmFirst(spec) {
  const office = window.sreOffice;
  if (!office || typeof office.confirm !== 'function') return 'unavailable';
  const answer = await office.confirm(spec);
  return answer && answer.ok === true ? answer : null;
}


// OB-205: the register's captions, in both languages (the page's own words; the session's words are untouched).
const VIEW_WORDS = {
  en: { colId: 'Delivery', colStatus: 'Where it stands', colFacts: 'What came in', colValue: 'Difference', noDifference: 'No difference' },
  ta: { colId: 'டெலிவரி', colStatus: 'நிலை', colFacts: 'வந்தவை', colValue: 'வேறுபாடு', noDifference: 'வேறுபாடு இல்லை' },
};
const vw = (key) => VIEW_WORDS[lang]?.[key] ?? VIEW_WORDS.en[key] ?? key;

// ── Batch 20a · R5 (M07-FR-01 · §27.1): look a delivery up by GRN number, order number or supplier, and the days received ──
// The rule is the tested `receiptsMatching` (window.goodsReceiptLookup); this only keeps what was typed and says the result.
const LOOKUP_WORDS = {
  en: {
    heading: 'Look up a delivery', text: 'GRN number, order number or supplier', textHelp: 'For example GRN1/26-27/00012, PO/26-27/00040 or the supplier\'s name. Every word typed must match.',
    from: 'Received from', fromHelp: 'The first day (leave empty for no start).', to: 'Received to', toHelp: 'The last day (leave empty for no end).',
    show: 'Show', lastMonth: 'Last month', clear: 'Clear',
    showing: 'Showing {n} of {total} deliveries that match.', none: 'No delivery matches. Check the number or the supplier, or widen the dates.',
    from_not_a_day: '"Received from" is not a real date.', to_not_a_day: '"Received to" is not a real date.', from_after_to: '"Received from" is after "Received to". Swap the dates.',
    supplier: 'Supplier', order: 'Order',
  },
  ta: {
    heading: 'ஒரு டெலிவரியைத் தேடு', text: 'GRN எண், ஆர்டர் எண் அல்லது சப்ளையர்', textHelp: 'உதா: GRN1/26-27/00012, PO/26-27/00040 அல்லது சப்ளையரின் பெயர். தட்டச்சு செய்த ஒவ்வொரு சொல்லும் பொருந்த வேண்டும்.',
    from: 'பெற்ற தேதி முதல்', fromHelp: 'முதல் நாள் (தொடக்கம் இல்லையெனில் காலியாக விடவும்).', to: 'பெற்ற தேதி வரை', toHelp: 'கடைசி நாள் (முடிவு இல்லையெனில் காலியாக விடவும்).',
    show: 'காட்டு', lastMonth: 'கடந்த மாதம்', clear: 'அழி',
    showing: '{total} டெலிவரிகளில் பொருந்தும் {n} காட்டப்படுகின்றன.', none: 'எந்த டெலிவரியும் பொருந்தவில்லை. எண்ணையோ சப்ளையரையோ சரிபார்க்கவும், அல்லது தேதிகளை விரிவாக்கவும்.',
    from_not_a_day: '"பெற்ற தேதி முதல்" சரியான தேதி அல்ல.', to_not_a_day: '"பெற்ற தேதி வரை" சரியான தேதி அல்ல.', from_after_to: '"பெற்ற தேதி முதல்" என்பது "பெற்ற தேதி வரை"க்குப் பின் உள்ளது. தேதிகளை மாற்றவும்.',
    supplier: 'சப்ளையர்', order: 'ஆர்டர்',
  },
};
const lw = (key) => LOOKUP_WORDS[lang]?.[key] ?? LOOKUP_WORDS.en[key] ?? key;
/** The lookup in force (applied by Show), or null when every delivery is shown. */
let lookup = null;
const shopDayOf = (iso) => { const d = window.sreShopDay?.dateOf(iso) ?? ''; return d === '' ? null : d; };
function paintLookupWords() {
  el('lookup-heading').textContent = lw('heading');
  el('lookup-text-label').textContent = lw('text');
  el('lookup-text-help').textContent = lw('textHelp');
  el('lookup-from-label').textContent = lw('from');
  el('lookup-from-help').textContent = lw('fromHelp');
  el('lookup-to-label').textContent = lw('to');
  el('lookup-to-help').textContent = lw('toHelp');
  worded(el('lookup-show'), 'search', lw('show'));
  worded(el('lookup-last-month'), 'calendar', lw('lastMonth'));
  worded(el('lookup-clear'), 'x', lw('clear'));
}
/** The deliveries the lookup keeps (all of them when none is in force), and the line that says so. */
function lookedUp(receipts) {
  const api = window.goodsReceiptLookup;
  if (lookup === null || !api) { el('lookup-status').textContent = ''; return receipts; }
  const problem = api.problem(lookup);
  if (problem !== null) { el('lookup-status').textContent = lw(problem); return receipts; }
  const kept = api.matching(receipts, lookup, shopDayOf);
  el('lookup-status').textContent = kept.length === 0 ? lw('none') : lw('showing').replace('{n}', String(kept.length)).replace('{total}', String(receipts.length));
  return kept;
}

/** OB-205: a tone's shape from the one icon set (sre-icons.js), with the session's glyph only if the set is missing. */
function toneMark(holder, tone, glyph) {
  const mark = window.sreIcon && typeof window.sreIcon === 'function' ? window.sreIcon(window.sreIcon.forTone(tone), 16) : null;
  if (mark) holder.replaceChildren(mark); else holder.textContent = glyph ?? '';
}

/** A control's words with its shape in front; the words stay its whole text, so its name is unchanged. */
function worded(node, name, words) {
  const mark = window.sreIcon && typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null;
  if (!mark) { node.textContent = words; return; }
  const text = document.createElement('span'); text.textContent = words;
  node.replaceChildren(mark, text);
}

/** The summary panel: each figure large with its words under it. The text reads exactly as the one-line summary did
 *  ("4 deliveries · 1 need a second person"), so a screen reader hears the same sentence. */
function paintStats(holder, stats) {
  const nodes = [];
  stats.forEach((s, i) => {
    if (i > 0) { const sep = document.createElement('span'); sep.className = 'sr-only'; sep.textContent = ' · '; nodes.push(sep); }
    const cell = document.createElement('span'); cell.className = 'stat';
    if (s.tone) cell.dataset.tone = s.tone;
    const n = document.createElement('b'); n.className = 'n'; n.textContent = s.n;
    const l = document.createElement('span'); l.className = 'l'; l.textContent = s.words;
    cell.append(n, document.createTextNode(' '), l);
    nodes.push(cell);
  });
  holder.replaceChildren(...nodes);
}

/** A status chip: the tone's shape AND the word, the tone in data-tone (colour is never alone). */
function statusChip(status) {
  const chip = document.createElement('span');
  chip.className = 'status sre-chip';
  chip.dataset.tone = status.tone;
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); toneMark(icon, status.tone, status.icon);
  const word = document.createElement('span'); word.textContent = status.label;
  chip.append(icon, word);
  chip.setAttribute('aria-label', status.announcement || status.label);
  return chip;
}

/** One delivery row. Every row reads as a state — a tone AND an icon AND a word (colour is never alone). OB-205: the
 *  cells line up under the register's captions — the delivery, where it stands, what came in, the valued difference. */
function receiptNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const id = document.createElement('div');
  id.className = 'c-id';
  const headline = document.createElement('span');
  headline.className = 'headline';
  headline.textContent = r.number;
  id.append(headline);
  // OB-847: under the new number, the delivery's own reference it was booked as.
  // Batch 20a · R5: the order by its own number and the supplier by name, so the lookup's words are on the row.
  const orderLine = r.poId === null ? t('noPo') : `${lw('order')}: ${r.orderNumber ?? r.poId}`;
  const supplierLine = r.supplierName || r.supplierId ? `${lw('supplier')}: ${r.supplierName ?? r.supplierId}` : '';
  for (const line of [r.reference ?? '', orderLine, supplierLine, r.receivedAt ? shopWhen(r.receivedAt) : '']) {
    if (line === '') continue;
    const sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = line; id.append(sub);
  }
  li.append(id, statusChip(r.status));

  const facts = document.createElement('div');
  facts.className = 'facts';
  const fact = (text) => { const s = document.createElement('span'); s.textContent = text; facts.append(s); };
  fact(`${t('warehouseLabel')}: ${placeName(r.warehouseId)}`);
  fact(`${t('receivedByLabel')}: ${r.receivedBy}`);
  // D-037: what became sellable item by item ("Biscuits — 44 pieces"), never biscuits and oil added into one number.
  if (Array.isArray(r.sellableItems) && r.sellableItems.length > 0) {
    const s = document.createElement('span'); s.className = 'sellable-items';
    s.textContent = `${t('sellableLabel')}: ${r.sellableItems.map((i) => i.label).join(' · ')}`;
    facts.append(s);
  } else fact(`${t('sellableLabel')}: ${qtyWords(r, 'sellable')}`);
  if (r.quarantinedMinor > 0) fact(`${t('quarantinedLabel')}: ${qtyWords(r, 'quarantined')}`);
  if (r.rejectedMinor > 0) fact(`${t('rejectedLabel')}: ${qtyWords(r, 'rejected')}`);
  // OB-509: a line booked with its cost NOT KNOWN says so until its supplier bill is matched — never a ₹0 figure.
  for (const c of r.costNotKnown ?? []) {
    const s = document.createElement('span'); s.className = 'cost-not-known'; s.dataset.productId = c.productId;
    worded(s, 'circle-alert', c.label); facts.append(s);
  }
  if (r.valueIncomplete) { const s = document.createElement('span'); s.className = 'value-incomplete'; s.textContent = t('valueIncomplete'); facts.append(s); }
  li.append(facts);
  // Batch 18b · R1 (M31-FR-02): Print the GRN — an A4 page from head office's print view, printed or saved as a PDF.
  const printer = printGrnButton(r);
  if (printer !== null) li.append(printer);
  // Batch 20e · R6 (M07-FR-04): the delivery's photos and scans — how many, and the files when opened.
  const filesBtn = filesButton(r);
  if (filesBtn !== null) li.append(filesBtn);
  const filesPanel = filesBox(r);
  if (filesPanel !== null) li.append(filesPanel);
  // R9-A · OB-534: the supplier bill — matched (which bill, what cost, by whom), or the "Match the bill" button.
  if (r.billMatch && (r.billMatch.matched.length > 0 || r.billMatch.canMatch || r.billMatch.receivedByYou)) li.append(billBox(r));

  // The valued difference, right-aligned in tabular figures; a delivery with none says so in words.
  const val = document.createElement('span');
  if (r.discrepancyValueMinor > 0) {
    val.className = 'c-val';
    val.textContent = money(r.discrepancyValueMinor, r.currency);
    val.setAttribute('aria-label', `${t('discrepancyValueLabel')}: ${money(r.discrepancyValueMinor, r.currency)}`);
  } else {
    val.className = 'c-val none';
    val.textContent = vw('noDifference');
  }
  li.append(val);

  // Each difference, named and valued (P-08) — worst money first, as the session ordered them.
  if (r.discrepancies.length > 0) {
    const diffs = document.createElement('ul');
    diffs.className = 'diffs';
    for (const d of r.discrepancies) {
      const item = document.createElement('li');
      item.className = 'diff';
      const word = document.createElement('span'); word.className = 'd-word'; word.textContent = d.label;
      const val = document.createElement('span'); val.className = 'd-val';
      // OB-509: a difference on a line whose cost is not known has no value yet — said in words, never ₹0.
      val.textContent = d.valueNotKnown ? t('valueNotKnown') : money(d.valueMinor, d.currency);
      item.dataset.kind = d.kind;
      item.append(word, val);
      if (d.detail) { const det = document.createElement('span'); det.className = 'd-detail'; det.textContent = d.detail; item.append(det); }
      // OB-508: whose it is — the named buyer or store manager, or head office's reason nobody is named.
      if (d.ownerLabel) { const own = document.createElement('span'); own.className = 'd-owner'; worded(own, 'user-round', d.ownerLabel); item.append(own); }
      diffs.append(item);
    }
    li.append(diffs);
  }
  // Batch 2: the held lines disposed of as a return — waiting to go back, or gone — in words, never only a colour.
  if ((r.returnLines ?? []).length > 0) {
    const returns = document.createElement('ul');
    returns.className = 'returns';
    for (const l of r.returnLines) {
      const item = document.createElement('li');
      item.dataset.lineId = l.lineId;
      item.dataset.state = l.state;
      // OB-850: once gone back, the return's own number (RTS1/26-27/00001) beside its state.
      const word = document.createElement('span'); word.className = 'r-word'; word.textContent = l.documentNumber ? `${l.stateLabel} · ${l.documentNumber}` : l.stateLabel;
      const what = document.createElement('span'); what.textContent = `${l.productId} × ${l.quantityLabel} · ${l.valueNotKnown ? t('valueNotKnown') : money(l.valueMinor, l.currency)}`;
      const who = document.createElement('span'); who.className = 'd-detail';
      who.textContent = `${t('decidedByLabel')} ${l.decidedBy}` + (l.returnedBy ? ` · ${t('returnedByLabel')} ${l.returnedBy}` : '');
      item.append(word, what, who);
      // OB-204: above the e-way-bill limit the goods are dispatched first — where it stands, in words, and Dispatch beside it.
      if (l.dispatchState) item.append(dispatchChip(l.dispatchState));
      if (l.canDispatch) item.append(dispatcher(r, l));
      returns.append(item);
    }
    li.append(returns);
  }
  return li;
}

// ── the supplier bill matched to this delivery (R9-A · OB-534) ────────────────

function billBox(r) {
  const box = document.createElement('div');
  box.className = 'bill-match';
  box.dataset.grnId = r.grnId;
  const head = document.createElement('span'); head.className = 'd-word'; worded(head, 'receipt-text', t('billMatchHeading')); box.append(head);
  for (const m of r.billMatch.matched) {
    const line = document.createElement('span'); line.className = 'bill-matched'; line.dataset.invoiceId = m.invoiceId;
    worded(line, 'check', m.label); box.append(line);
  }
  if (r.billMatch.receivedByYou) {
    const note = document.createElement('span'); note.className = 'bill-not-you'; worded(note, 'user-round', t('billMatchNotYou')); box.append(note);
  }
  if (r.billMatch.canMatch) {
    const id = `bill-${r.grnId}`.replace(/[^A-Za-z0-9_-]/g, '_');
    const label = document.createElement('label'); label.htmlFor = id; label.textContent = t('billMatchLabel');
    const input = document.createElement('input');
    input.id = id; input.type = 'text'; input.autocomplete = 'off'; input.className = 'sre-input bill-invoice'; input.placeholder = t('billMatchPlaceholder');
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'sre-btn sre-btn-primary bill-match-btn'; // U1 · G3: the one action on each delivery button.dataset.grnId = r.grnId;
    const word = t('billMatchBtn');
    if (window.sreIcon && typeof window.sreIcon.withWord === 'function') button.append(window.sreIcon.withWord('receipt-text', word));
    else button.textContent = word;
    button.addEventListener('click', () => {
      void (async () => {
        button.disabled = true;
        try {
          const outcome = await session.matchBill({ grnId: r.grnId, invoiceId: input.value });
          paintResult(session.presentBillMatchOutcome(lang, outcome));
          // Only a match head office recorded changes the screen; a refusal leaves the delivery exactly as it was.
          if (outcome.outcome === 'matched' || outcome.outcome === 'already_matched') { paint(); await refresh(); }
        } finally {
          button.disabled = false;
        }
      })();
    });
    box.append(label, input, button);
  }
  return box;
}

// ── dispatched under an e-way bill (OB-204) ─────────────────────────────────

/** The dispatch state as a chip: the tone's shape from the one icon set AND the word (never colour alone). */
function dispatchChip(state) {
  const chip = window.sreIcon && typeof window.sreIcon.chip === 'function'
    ? window.sreIcon.chip({ tone: state.tone, label: state.label })
    : Object.assign(document.createElement('span'), { className: 'sre-chip', textContent: state.label });
  chip.classList.add('ewb');
  chip.dataset.tone = state.tone;
  if (state.detail) chip.title = state.detail;
  return chip;
}

/** Dispatch, next to the return it is for: who is taking it, and the button (a word beside the truck, never icon-only). */
function dispatcher(r, l) {
  const box = document.createElement('span');
  box.className = 'dispatcher';
  const id = `dispatch-reason-${r.grnId}-${l.lineId}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = t('dispatchReasonLabel');
  const input = document.createElement('input');
  input.id = id; input.type = 'text'; input.autocomplete = 'off'; input.className = 'sre-input dispatch-reason';
  input.placeholder = t('dispatchReasonPlaceholder');
  const button = document.createElement('button'); button.classList.add('sre-btn');
  button.type = 'button';
  button.className = 'sre-btn dispatch';
  button.dataset.grnId = r.grnId;
  button.dataset.lineId = l.lineId;
  const word = t('dispatchBtn');
  if (window.sreIcon && typeof window.sreIcon.withWord === 'function') button.append(window.sreIcon.withWord('truck', word));
  else button.textContent = word;
  button.addEventListener('click', () => {
    void (async () => {
      button.disabled = true;
      try {
        const outcome = await session.dispatchReturn({ grnId: r.grnId, lineId: l.lineId, reason: input.value });
        paintResult(session.presentDispatchOutcome(lang, outcome));
        // Only a dispatch head office recorded changes the screen; a refusal leaves the return exactly as it was.
        if (outcome.outcome === 'dispatched' || outcome.outcome === 'already_dispatched') { paint(); await refresh(); }
      } finally {
        button.disabled = false;
      }
    })();
  });
  box.append(label, input, button);
  return box;
}

// ── going back to the supplier (Batch 2) ────────────────────────────────────

function paintReturner(view) {
  const returner = el('returner');
  el('no-return').hidden = true;
  const anyWaiting = view.receipts.some((r) => (r.returnLines ?? []).some((l) => l.state === 'awaiting_return'));
  if (!view.canRecordReturn) {
    returner.hidden = true;
    if (anyWaiting && !view.nobodyNamed && window.goodsReceiptSession !== undefined) { el('no-return').hidden = false; el('no-return').textContent = t('noReturn'); }
    return;
  }
  returner.hidden = false;
  el('return-heading').textContent = t('returnsHeading');
  el('return-line-label').textContent = t('returnChoiceLabel');
  el('return-reason-label').textContent = t('returnReasonLabel');
  // OB-205: the example stays readable under the field while it is typed into, not only as a placeholder that vanishes.
  el('return-reason-help').textContent = t('returnReasonPlaceholder');
  el('return').textContent = t('returnBtn');
  const select = el('return-line');
  const chosen = select.value;
  select.replaceChildren(...view.awaitingReturn.map((a) => {
    const opt = document.createElement('option'); opt.value = `${a.grnId}|${a.line.lineId}`;
    opt.textContent = `${a.number} · ${a.line.productId} × ${a.line.quantityLabel} · ${money(a.line.valueMinor, a.line.currency)}`;
    return opt;
  }));
  if (chosen && view.awaitingReturn.some((a) => `${a.grnId}|${a.line.lineId}` === chosen)) select.value = chosen;
  const none = view.awaitingReturn.length === 0;
  el('return-none').hidden = !none;
  // OB-204: a return waiting on its dispatch is not "nothing waiting" — say what comes first.
  const waitsForDispatch = view.receipts.some((r) => (r.returnLines ?? []).some((l) => l.needsDispatch));
  el('return-none').textContent = none ? t(waitsForDispatch ? 'returnWaitsForDispatch' : 'returnNoneWaiting') : '';
  el('return-fields').hidden = none;
  el('return').hidden = none;
}

function paintResult(presentation) {
  const result = el('result');
  result.hidden = false;
  result.className = `result tone-${presentation.tone}`;
  toneMark(el('result-icon'), presentation.tone, presentation.icon);
  el('result-text').textContent = presentation.label;
  result.setAttribute('aria-label', presentation.announcement || presentation.label);
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  // OB-205: the page's one heading (the header line) speaks the reader's language too.
  el('who').firstChild.textContent = `${t('title')} `;
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.goodsReceiptData?.userId ?? '';
  el('lang').textContent = t('langName');
  worded(el('refresh'), 'refresh-cw', t('refresh'));
  el('asof').textContent = view.asOf ? `${t('asOfLabel')}: ${shopWhen(view.asOf)}` : '';
  el('col-id').textContent = vw('colId');
  el('col-status').textContent = vw('colStatus');
  el('col-facts').textContent = vw('colFacts');
  el('col-value').textContent = vw('colValue');
  paintLookupWords();
  paintReturner(view);

  // A not-permitted / nothing-yet state has no rows: show the state line rather than an empty list.
  const state = el('state');
  if (view.receipts.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    toneMark(el('state-icon'), view.screenState.tone, view.screenState.icon);
    el('state-text').textContent = view.screenState.label;
    state.setAttribute('aria-label', view.screenState.announcement || view.screenState.label);
    el('summary').hidden = true;
    el('list-heading').hidden = true;
    el('register').hidden = true;
    el('rows').replaceChildren();
    return;
  }

  state.hidden = true;
  el('register').hidden = false;
  el('summary').hidden = false;
  paintStats(el('summary'), [
    { n: String(view.count), words: t('summaryDeliveries') },
    { n: String(view.needingApprovalCount), words: t('summaryNeedApproval'), tone: view.needingApprovalCount > 0 ? 'error' : undefined },
  ]);
  el('list-heading').hidden = false;
  el('list-heading').textContent = t('listHeading');
  el('rows').replaceChildren(...lookedUp(view.receipts).map((r) => receiptNode(r)));
}

// Batch 20a · R5: Show applies the lookup; Last month fills the dates with last month's first and last day; Clear shows all.
el('lookup-show').addEventListener('click', () => {
  lookup = { text: el('lookup-text').value, from: el('lookup-from').value, to: el('lookup-to').value };
  if (lookup.text.trim() === '' && lookup.from === '' && lookup.to === '') lookup = null;
  paint();
});
el('lookup-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el('lookup-show').click(); } });
el('lookup-last-month').addEventListener('click', () => {
  const month = window.sreShopDay?.lastMonth?.() ?? '';
  if (!/^\d{4}-\d{2}$/.test(month)) return;
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  el('lookup-from').value = `${month}-01`;
  el('lookup-to').value = `${month}-${String(lastDay).padStart(2, '0')}`;
  el('lookup-show').click();
});
el('lookup-clear').addEventListener('click', () => {
  el('lookup-text').value = ''; el('lookup-from').value = ''; el('lookup-to').value = '';
  lookup = null;
  paint();
});

// GONE BACK TO THE SUPPLIER — an online write under the reader's session, on this click only; the session checks the line
// is waiting (and not one needing a count first) before anything is sent; head office decides.
el('return').addEventListener('click', () => {
  void (async () => {
    const [grnId, lineId] = el('return-line').value.split('|');
    // U1 · OB-698: the consequence-and-confirm sheet before stock goes back — Go back sends nothing.
    const chosen = el('return-line').selectedOptions[0];
    const lineWords = chosen ? chosen.textContent.trim() : `${grnId ?? ''} ${lineId ?? ''}`.trim();
    const sub = (l, key) => String(session.text(l, key)).replace('{line}', lineWords);
    // No line chosen or no reason given: the session says so in its own words, and nothing is sent — no sheet for that.
    const complete = (grnId ?? '') !== '' && (lineId ?? '') !== '' && el('return-reason').value.trim() !== '';
    const answer = !complete ? { ok: true } : await confirmFirst({ title: { en: sub('en', 'confirmReturnTitle'), ta: sub('ta', 'confirmReturnTitle') }, detail: { en: sub('en', 'confirmReturnDetail'), ta: sub('ta', 'confirmReturnDetail') }, authority: { en: sub('en', 'confirmReturnAuthority'), ta: sub('ta', 'confirmReturnAuthority') }, confirmLabel: { en: sub('en', 'confirmReturnLabel'), ta: sub('ta', 'confirmReturnLabel') }, tone: 'danger' });
    if (answer === 'unavailable') { paintResult({ tone: 'error', icon: '⚠', label: t('confirmUnavailable'), announcement: t('confirmUnavailable') }); return; }
    if (answer === null) return;
    const outcome = await session.recordReturn({ grnId: grnId ?? '', lineId: lineId ?? '', reason: el('return-reason').value });
    paintResult(session.presentReturnOutcome(lang, outcome));
    if (outcome.outcome === 'returned' || outcome.outcome === 'already_returned') { el('return-reason').value = ''; await refresh(); }
  })();
});

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

el('sample').hidden = window.goodsReceiptSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live GRN list (a GET — read-only). Offline or refused, the screen keeps its current view and the
// stale strip already says the page is what the box last told it. Nothing is written.
async function refresh() {
  const api = window.goodsReceipt;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data) { session = api.present(data); window.goodsReceiptSession = session; paint(); }
}
el('refresh').addEventListener('click', () => { void refresh(); });
refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}


// ── Batch 20e · R6 (M07-FR-04 · WF-04 · OB-907): each delivery's photos and scans ─────────────────────────────────────────
// "Photos and scans (N)" on each delivery opens its files: a small picture of each photo, Open (the full file), who attached
// it and from where; "Attached by mistake" with a reason (the file stays kept and shown, struck through); and, for a reader
// who handles this delivery's stock, "Add a photo or scan". Online under the reader's session — with no connection the page
// says so and nothing changes. The rules are the tested `receipt-attachments-review.ts` (window.receiptAttachmentsReview).
const filesApi = window.receiptAttachmentsReview;
const aw = (key, fill) => (filesApi ? filesApi.word(lang, key, fill ?? {}) : key);
const openFiles = new Set();

function filesButton(r) {
  if (!filesApi || r.grnId === 'sample') return null;
  const n = r.attachmentCount ?? 0;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sre-btn grn-files-btn';
  b.dataset.grnId = r.grnId;
  b.setAttribute('aria-expanded', openFiles.has(r.grnId) ? 'true' : 'false');
  worded(b, 'file-text', n > 0 ? aw('showFiles', { n }) : aw('showFilesNone'));
  b.addEventListener('click', () => {
    if (openFiles.has(r.grnId)) openFiles.delete(r.grnId); else openFiles.add(r.grnId);
    b.setAttribute('aria-expanded', openFiles.has(r.grnId) ? 'true' : 'false');
    const box = b.parentElement?.querySelector(`.grn-files[data-grn-id="${CSS.escape(r.grnId)}"]`);
    if (box) { box.hidden = !openFiles.has(r.grnId); if (!box.hidden) void paintFiles(box, r); }
  });
  return b;
}

function filesBox(r) {
  if (!filesApi || r.grnId === 'sample') return null;
  const box = document.createElement('div');
  box.className = 'grn-files';
  box.dataset.grnId = r.grnId;
  box.hidden = !openFiles.has(r.grnId);
  if (!box.hidden) void paintFiles(box, r);
  return box;
}

/** A blob address for a file's bytes, so the browser can open it in its own tab (a `data:` address cannot be opened there). */
function blobUrlOf(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const type = /^data:([^;]+)/.exec(head ?? '')?.[1] ?? 'application/octet-stream';
  const bin = atob(b64 ?? '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type }));
}

async function paintFiles(box, r) {
  const review = filesApi.review;
  const status = document.createElement('p'); status.className = 'grn-files-status'; status.setAttribute('role', 'status');
  const head = document.createElement('span'); head.className = 'd-word'; worded(head, 'file-text', aw('filesHeading'));
  box.replaceChildren(head, status);
  const out = await review.files(r.grnId);
  if (out.result !== 'ok') { status.textContent = out.result === 'lost_link' ? aw('needLink') : `${aw('refused')} ${out.whatHappened ?? ''}`; return; }
  const list = document.createElement('ul'); list.className = 'grn-file-list';
  if (out.value.length === 0) status.textContent = aw('none');
  for (const a of out.value) list.append(fileRow(box, r, a, status));
  box.append(list);
  if (review.mayChange) box.append(addForm(box, r, status));
  else { const note = document.createElement('p'); note.className = 'grn-files-note'; note.textContent = aw('mayNotChange'); box.append(note); }
}

function fileRow(box, r, a, status) {
  const review = filesApi.review;
  const said = review.describe(lang, a, shopWhen, (id) => id);
  const li = document.createElement('li');
  li.className = 'grn-file';
  li.dataset.attachmentId = a.attachmentId;
  li.dataset.kind = a.kind;
  if (a.mistake) li.dataset.mistake = 'true';
  const picture = document.createElement('div'); picture.className = 'thumb';
  if (a.mediaType.startsWith('image/')) {
    void review.open(r.grnId, a.attachmentId).then((o) => {
      if (o.result !== 'ok') return;
      const img = document.createElement('img'); img.src = o.value; img.alt = said.title; img.loading = 'lazy'; picture.replaceChildren(img);
    });
  } else {
    const pdf = document.createElement('span'); pdf.className = 'pdf'; pdf.textContent = 'PDF'; picture.append(pdf);
  }
  const words = document.createElement('div'); words.className = 'grn-file-words';
  const title = document.createElement(a.mistake ? 's' : 'span'); title.className = 'grn-file-title'; title.textContent = said.title;
  const detail = document.createElement('span'); detail.className = 'd-detail'; detail.textContent = said.detail;
  words.append(title, detail);
  for (const f of said.flags) { const flag = document.createElement('span'); flag.className = 'grn-file-flag'; worded(flag, 'circle-alert', f); words.append(flag); }
  if (said.mistake) { const m = document.createElement('span'); m.className = 'grn-file-mistake'; worded(m, 'circle-alert', said.mistake); words.append(m); }
  const open = document.createElement('button'); open.type = 'button'; open.className = 'sre-btn grn-file-open'; worded(open, 'file-text', aw('open'));
  open.setAttribute('aria-label', `${aw('open')} ${a.fileName}`);
  open.addEventListener('click', () => {
    void (async () => {
      const o = await review.open(r.grnId, a.attachmentId);
      if (o.result !== 'ok') { status.textContent = o.result === 'lost_link' ? aw('needLink') : `${aw('refused')} ${o.whatHappened ?? ''}`; return; }
      window.open(blobUrlOf(o.value), '_blank', 'noopener');
    })();
  });
  li.append(picture, words, open);
  if (review.mayChange && !a.mistake) {
    const id = `mistake-${a.attachmentId}`.replace(/[^A-Za-z0-9_-]/g, '_');
    const label = document.createElement('label'); label.htmlFor = id; label.textContent = aw('mistakeReason');
    const reason = document.createElement('input'); reason.id = id; reason.type = 'text'; reason.className = 'sre-input grn-file-reason'; reason.autocomplete = 'off';
    const mark = document.createElement('button'); mark.type = 'button'; mark.className = 'sre-btn grn-file-mistake-btn'; worded(mark, 'circle-alert', aw('mistake'));
    mark.addEventListener('click', () => {
      void (async () => {
        mark.disabled = true;
        try {
          const out = await review.markMistake(r.grnId, a.attachmentId, reason.value);
          if (out.result === 'invalid') { status.textContent = aw(out.why === 'needReason' ? 'mistakeNeedsReason' : 'mayNotChange'); return; }
          if (out.result !== 'ok') { status.textContent = out.result === 'lost_link' ? aw('needLink') : `${aw('refused')} ${out.whatHappened ?? ''}`; return; }
          await paintFiles(box, r);
          box.querySelector('.grn-files-status').textContent = aw('mistakeDone');
        } finally { mark.disabled = false; }
      })();
    });
    const wrap = document.createElement('div'); wrap.className = 'grn-file-mistake-form';
    wrap.append(label, reason, mark);
    li.append(wrap);
  }
  return li;
}

function addForm(box, r, status) {
  const form = document.createElement('div'); form.className = 'grn-file-add';
  const kindId = `kind-${r.grnId}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const fileId = `file-${r.grnId}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const kindLabel = document.createElement('label'); kindLabel.htmlFor = kindId; kindLabel.textContent = aw('kindLabel');
  const kind = document.createElement('select'); kind.id = kindId; kind.className = 'grn-file-kind';
  kind.replaceChildren(...filesApi.kinds(lang).map((k) => { const o = document.createElement('option'); o.value = k.kind; o.textContent = k.label; return o; }));
  const fileLabel = document.createElement('label'); fileLabel.htmlFor = fileId; fileLabel.textContent = aw('add');
  const input = document.createElement('input'); input.id = fileId; input.type = 'file'; input.className = 'grn-file-input'; input.accept = 'image/jpeg,image/png,application/pdf,image/*';
  input.addEventListener('change', () => {
    void (async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      status.textContent = aw('reading');
      const read = await filesApi.read(file);
      input.value = '';
      if (!read.ok) { status.textContent = aw(read.code); return; }
      const out = await filesApi.review.add(r.grnId, { fileName: read.fileName, mediaType: read.mediaType, contentBase64: read.contentBase64 }, kind.value);
      if (out.result === 'invalid') { status.textContent = aw(out.why === 'kind_not_known' ? 'kind_not_known' : 'mayNotChange'); return; }
      if (out.result !== 'ok') { status.textContent = out.result === 'lost_link' ? aw('needLink') : `${aw('refused')} ${out.whatHappened ?? ''}`; return; }
      await paintFiles(box, r);
      box.querySelector('.grn-files-status').textContent = out.value.alreadyRecorded ? aw('alreadyKept') : aw('added');
    })();
  });
  form.append(kindLabel, kind, fileLabel, input);
  return form;
}

// ── Batch 18b · R1 (M31-FR-02 · M07-FR-01): Print GRN ───────────────────────────────────────────────────────────────────
// The bundle's print sheet (`window.srePrint`) lays the receipt out on an A4 page — the shop and its GSTIN, the GRN number,
// the date, the supplier and its GSTIN, every line with its rate and GST rate, the total and the signature lines — and the
// browser prints it or saves it as a PDF. A copy is kept on this computer once read, so it prints again offline.
const PRINT_WORDS = { en: { print: 'Print GRN', printFor: 'Print GRN {n}' }, ta: { print: 'GRN அச்சிடு', printFor: 'GRN {n} அச்சிடு' } };
function printGrnButton(r) {
  if (!window.srePrint || r.grnId === 'sample') return null;
  const w = PRINT_WORDS[lang] ?? PRINT_WORDS.en;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sre-btn print-grn';
  b.dataset.grn = r.grnId;
  worded(b, 'file-text', w.print);
  b.setAttribute('aria-label', w.printFor.replace('{n}', r.number));
  b.addEventListener('click', () => { void window.srePrint.openPrint({ kind: 'goods_receipt', id: r.grnId }); });
  return b;
}
