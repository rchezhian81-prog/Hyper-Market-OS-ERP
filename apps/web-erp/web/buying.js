// Buyer's screen — the view layer. Every rule lives in the TESTED session model
// (`apps/web-erp/src/buying-session.ts`), attached as `window.buyingSession`.
//
// ── What this screen is actually for ────────────────────────────────────────
//
// Audit finding A-03: somebody retypes an eighty-line supplier invoice into a computer every week.
// The whole product here is **seeing what is wrong before anything is written** — so the preview,
// not the save button, is the biggest thing on the page.
//
// ── The two figures that must agree, and why they are side by side ──────────
//
// The buyer types the total off the **bottom of the supplier's paper**, and the file's own lines are
// summed against it. That figure is the only thing in this flow that does not come from the file,
// which is exactly why it can catch a line the file is missing — every remaining line can be
// perfect and only the total notices.
//
// So the two are shown next to each other, large, and the one that is wrong is coloured. A single
// "does not reconcile" line at the bottom of a form is a message people learn to click past.
//
// ── And what it never does ──────────────────────────────────────────────────
//
// **It writes nothing until the model says the file is clean and somebody else has approved it.**
// Not a partial save — seventy-seven of eighty lines written is an invoice matching no piece of
// paper anywhere. The save button does not exist on the page until the preview says it may.
//
// No `prompt`, `confirm` or `alert`; the banner does not fade.

const el = (id) => document.getElementById(id);

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Rupees typed by a person into exact minor units. Never a float in the model. */
const toMinor = (text) => Math.round(Number(String(text).replace(/[^0-9.-]/g, '')) * 100);

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    buying: 'Buying', supplierInvoice: 'Supplier invoice', checkAgainst: 'Check against the order',
    raiseOrder: 'Raise an order',
    invoiceLead: "Paste the supplier's file, type the total printed on the paper, and see what is wrong before anything is saved.",
    invoiceNumber: 'Invoice number', supplier: 'Supplier',
    printedTotal: 'Total printed on the invoice (in rupees)', theLines: "The supplier's lines",
    checkThis: 'Check this invoice', sendForApproval: 'Send for approval and save',
    readyToSave: 'This invoice adds up and every line is good',
    notReady: 'This invoice cannot be saved yet',
    fileSays: 'The file adds up to', paperSays: 'The paper says',
    linesFound: 'line(s) read from the file',
    problemsFound: 'thing(s) to fix. Nothing has been saved.',
    doesNotAddUp: 'The lines do not add up to the total on the paper. Either a line is wrong or a line is missing — and both mean paying something other than what was agreed.',
    line: 'Line', ok: 'OK', cancel: 'Cancel', read: 'Please read this',
    needInvoiceNumber: 'Give the invoice number first.',
    needTotal: 'Type the total printed on the paper invoice first.',
    needFile: 'Paste the supplier\'s lines first.',
    whoApproves: 'Who checked this invoice?',
    whoApprovesNote: 'You cannot approve your own capture. Somebody else has to look at it.',
    saved: 'Invoice saved', savedNote: 'It can now be checked against the order.',
    comparePo: 'Purchase order number', compareInvoice: 'Invoice number', compareThem: 'Compare them',
    matchLead: 'Compare what was ordered, what arrived, and what the supplier has invoiced.',
    item: 'Item', ordered: 'Ordered', received: 'Arrived', invoiced: 'Invoiced', payable: 'May be paid',
    blocked: 'Do not pay this yet', agreed: 'These agree', withheld: 'Held back',
    poLead: 'Somebody else has to approve it before it goes to the supplier.',
    itemCode: 'Item code', howMany: 'How many', agreedPrice: 'Agreed price each (in rupees)',
    addItem: 'Add this item', raiseIt: 'Raise the order', noLinesYet: 'No items added yet.',
    needPoLine: 'Add at least one item first.', needPoFields: 'Fill in the item, how many, and the price.',
    orderRaised: 'Order raised', whoApprovesPo: 'Who approved this order?',
    sampleData: 'Sample data — this is not your shop.',
    notConnected: 'This screen has not been given anything by the store box yet.',
    remove: 'Remove', lineTotal: 'Line total', whatIsWrong: 'What is wrong',
    gapsTitle: 'This screen has not been told everything',
    noApprovers: 'This screen has not been told who may approve. Nothing can be saved until it has.',
  },
  ta: {
    buying: 'கொள்முதல்', supplierInvoice: 'சப்ளையர் இன்வாய்ஸ்', checkAgainst: 'ஆர்டருடன் சரிபார்',
    raiseOrder: 'ஆர்டர் தயாரி',
    invoiceLead: 'சப்ளையரின் கோப்பை ஒட்டவும், தாளில் அச்சிடப்பட்ட மொத்தத்தைத் தட்டச்சு செய்யவும். எதுவும் சேமிக்கப்படும் முன் என்ன தவறு என்று பாருங்கள்.',
    invoiceNumber: 'இன்வாய்ஸ் எண்', supplier: 'சப்ளையர்',
    printedTotal: 'இன்வாய்ஸில் அச்சிடப்பட்ட மொத்தம் (ரூபாயில்)', theLines: 'சப்ளையரின் வரிகள்',
    checkThis: 'இந்த இன்வாய்ஸைச் சரிபார்', sendForApproval: 'ஒப்புதலுக்கு அனுப்பி சேமி',
    readyToSave: 'இந்த இன்வாய்ஸ் சரியாகக் கூடுகிறது, எல்லா வரிகளும் நன்றாக உள்ளன',
    notReady: 'இந்த இன்வாய்ஸை இன்னும் சேமிக்க முடியாது',
    fileSays: 'கோப்பின் கூட்டுத்தொகை', paperSays: 'தாளில் உள்ளது',
    linesFound: 'வரி(கள்) கோப்பிலிருந்து படிக்கப்பட்டன',
    problemsFound: 'சரிசெய்ய வேண்டியவை. எதுவும் சேமிக்கப்படவில்லை.',
    doesNotAddUp: 'வரிகள் தாளில் உள்ள மொத்தத்துடன் பொருந்தவில்லை. ஒரு வரி தவறாக இருக்கலாம் அல்லது ஒரு வரி விடுபட்டிருக்கலாம் — இரண்டுமே ஒப்புக்கொண்டதை விட வேறு தொகை செலுத்துவதாகும்.',
    line: 'வரி', ok: 'சரி', cancel: 'ரத்து', read: 'இதைப் படிக்கவும்',
    needInvoiceNumber: 'முதலில் இன்வாய்ஸ் எண்ணைக் கொடுக்கவும்.',
    needTotal: 'முதலில் தாளில் அச்சிடப்பட்ட மொத்தத்தைத் தட்டச்சு செய்யவும்.',
    needFile: 'முதலில் சப்ளையரின் வரிகளை ஒட்டவும்.',
    whoApproves: 'இந்த இன்வாய்ஸை யார் சரிபார்த்தார்?',
    whoApprovesNote: 'உங்கள் சொந்த பதிவை நீங்களே ஒப்புதல் அளிக்க முடியாது. வேறு ஒருவர் பார்க்க வேண்டும்.',
    saved: 'இன்வாய்ஸ் சேமிக்கப்பட்டது', savedNote: 'இதை இப்போது ஆர்டருடன் சரிபார்க்கலாம்.',
    comparePo: 'கொள்முதல் ஆர்டர் எண்', compareInvoice: 'இன்வாய்ஸ் எண்', compareThem: 'ஒப்பிடு',
    matchLead: 'ஆர்டர் செய்தது, வந்தது, சப்ளையர் கேட்டது — மூன்றையும் ஒப்பிடவும்.',
    item: 'பொருள்', ordered: 'ஆர்டர்', received: 'வந்தது', invoiced: 'கேட்டது', payable: 'செலுத்தலாம்',
    blocked: 'இதை இன்னும் செலுத்த வேண்டாம்', agreed: 'இவை பொருந்துகின்றன', withheld: 'நிறுத்தி வைக்கப்பட்டது',
    poLead: 'சப்ளையருக்குச் செல்வதற்கு முன் வேறு ஒருவர் ஒப்புதல் அளிக்க வேண்டும்.',
    itemCode: 'பொருள் குறியீடு', howMany: 'எத்தனை', agreedPrice: 'ஒப்புக்கொண்ட விலை (ரூபாயில்)',
    addItem: 'இந்தப் பொருளைச் சேர்', raiseIt: 'ஆர்டரைத் தயாரி', noLinesYet: 'இன்னும் பொருட்கள் சேர்க்கப்படவில்லை.',
    needPoLine: 'குறைந்தது ஒரு பொருளையாவது சேர்க்கவும்.', needPoFields: 'பொருள், எண்ணிக்கை, விலை — எல்லாவற்றையும் நிரப்பவும்.',
    orderRaised: 'ஆர்டர் தயாரிக்கப்பட்டது', whoApprovesPo: 'இந்த ஆர்டரை யார் ஒப்புதல் அளித்தார்?',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    notConnected: 'கடை கணினியிடமிருந்து இந்தத் திரைக்கு இன்னும் எதுவும் வரவில்லை.',
    remove: 'நீக்கு', lineTotal: 'வரி மொத்தம்', whatIsWrong: 'என்ன தவறு',
    gapsTitle: 'இந்தத் திரைக்கு எல்லாத் தகவலும் வரவில்லை',
    noApprovers: 'யார் ஒப்புதல் அளிக்கலாம் என்று இந்தத் திரைக்குத் தெரியவில்லை. அது வரும் வரை எதுவும் சேமிக்க முடியாது.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** Why a capture was refused — one entry per `CaptureRefusal` in the model, in both languages. */
const REFUSAL_WORDS = {
  file_has_problems: { en: 'Some lines need fixing on the paper invoice first. Nothing has been saved.', ta: 'சில வரிகளை முதலில் சரிசெய்ய வேண்டும். எதுவும் சேமிக்கப்படவில்லை.' },
  does_not_add_up_to_the_invoice_total: { en: 'The lines do not add up to the total on the paper. Either a line is wrong or a line is missing.', ta: 'வரிகள் தாளில் உள்ள மொத்தத்துடன் பொருந்தவில்லை. ஒரு வரி தவறு அல்லது ஒரு வரி விடுபட்டுள்ளது.' },
  not_approved: { en: 'Nobody has approved this invoice yet, so nothing has been saved.', ta: 'இந்த இன்வாய்ஸை இன்னும் யாரும் ஒப்புதல் அளிக்கவில்லை. எதுவும் சேமிக்கப்படவில்லை.' },
  approved_by_the_person_who_captured_it: { en: 'You cannot approve your own capture. Somebody else has to look at it.', ta: 'உங்கள் சொந்த பதிவை நீங்களே ஒப்புதல் அளிக்க முடியாது. வேறு ஒருவர் பார்க்க வேண்டும்.' },
  nothing_to_capture: { en: 'There is nothing in this file to save.', ta: 'இந்தக் கோப்பில் சேமிக்க எதுவும் இல்லை.' },
  already_captured: { en: 'This invoice has already been saved. Saving it twice would double what this supplier is owed.', ta: 'இந்த இன்வாய்ஸ் ஏற்கனவே சேமிக்கப்பட்டுள்ளது. இரண்டு முறை சேமித்தால் சப்ளையருக்கு இரட்டிப்பாகும்.' },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/**
 * What the store box did not tell this screen — one sentence per `BuyingGap` in the entry.
 *
 * Each of these already fails toward a refusal, so nothing here is protecting against a wrong
 * answer. It is protecting against the buyer *mis-reading a right one*: "this was never ordered"
 * looks identical whether the supplier invented the line or the box was simply never sent the
 * order, and only one of those is an argument to have with a supplier.
 */
const GAP_WORDS = {
  what_this_shop_stocks: {
    en: 'It has not been told what this shop stocks, so every line will be reported as an item we do not carry.',
    ta: 'இந்தக் கடையில் என்ன பொருட்கள் உள்ளன என்று தெரியவில்லை. எனவே எல்லா வரிகளும் "நாங்கள் வைத்திருக்காத பொருள்" என்று காட்டப்படும்.',
  },
  what_was_ordered: {
    en: 'It has not been told what was ordered, so nothing can be checked against an order.',
    ta: 'என்ன ஆர்டர் செய்யப்பட்டது என்று தெரியவில்லை. எனவே ஆர்டருடன் எதையும் ஒப்பிட முடியாது.',
  },
  what_arrived: {
    en: 'It has not been told what arrived, so an invoice cannot be checked against the delivery.',
    ta: 'என்ன வந்தது என்று தெரியவில்லை. எனவே இன்வாய்ஸை வந்த பொருட்களுடன் ஒப்பிட முடியாது.',
  },
  which_invoices_are_already_saved: {
    en: 'It has not been told which invoices are already saved, so it cannot warn you about saving one twice.',
    ta: 'எந்த இன்வாய்ஸ்கள் ஏற்கனவே சேமிக்கப்பட்டுள்ளன என்று தெரியவில்லை. இரண்டு முறை சேமிப்பதைப் பற்றி எச்சரிக்க முடியாது.',
  },
  who_may_approve: {
    en: 'It has not been told who may approve, so nothing here can be saved.',
    ta: 'யார் ஒப்புதல் அளிக்கலாம் என்று தெரியவில்லை. எனவே இங்கு எதுவும் சேமிக்க முடியாது.',
  },
};

/**
 * Sample buying data with the same surface as the bundled session, so the flow is reviewable
 * before a real invoice arrives. Replaced at build time by the tested model; whenever it is in use
 * the header says so.
 */
function sampleSession() {
  return {
    previewInvoice: ({ declaredTotalMinor }) => ({
      lines: [{ productId: 'SAMPLE-1', quantity: 10, unitPriceMinor: 10_000, lineTotalMinor: 100_000 }],
      sumMinor: 100_000,
      declaredTotalMinor,
      readyToApprove: declaredTotalMinor === 100_000,
      // No line-level problems on purpose: this stand-in demonstrates the case only the control
      // total can catch — every line perfect, and the paper still says something else.
      problems: [],
      preview: { reconciles: declaredTotalMinor === 100_000 },
    }),
    captureInvoice: () => ({ ok: false, refusal: 'not_approved', detail: 'this is sample data' }),
    match: () => ({
      lines: [], payableMinor: 0, invoicedMinor: 0, withheldMinor: 0, blocked: true,
      detail: 'sample', ownerAction: 'This is sample data — nothing has been compared.',
    }),
    raisePurchaseOrder: () => { throw new Error('this is sample data'); },
  };
}

const real = window.buyingSession;
const session = real ?? sampleSession();

// ── The banner ──────────────────────────────────────────────────────────────

function tell(title, message, good = false) {
  el('banner-title').textContent = title;
  el('banner-text').textContent = message;
  el('banner').classList.toggle('good', good === true);
  el('banner').hidden = false;
  el('banner-ok').textContent = t('ok');
  el('banner-ok').focus();
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

// ── The panel ───────────────────────────────────────────────────────────────

let sheetResolve = null;

/**
 * Ask who approved something. On screen, never a browser prompt.
 *
 * An empty list is answered before the panel opens. A panel offering no names and only a Cancel
 * button is a dead end that looks like a bug; the buyer is told the box has not been given the
 * list, which is what is actually wrong and is something somebody can go and fix.
 */
function askApprover(title, note, people) {
  if (people.length === 0) {
    tell(t('read'), t('noApprovers'));
    return Promise.resolve(null);
  }
  el('sheet-title').textContent = title;
  el('sheet-note').textContent = note;
  el('sheet-cancel').textContent = t('cancel');
  el('choices').replaceChildren(...people.map((who) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = who;
    button.addEventListener('click', () => { closeSheet(who); });
    return button;
  }));
  el('sheet').hidden = false;
  return new Promise((resolve) => { sheetResolve = resolve; });
}
function closeSheet(answer) {
  el('sheet').hidden = true;
  const resolve = sheetResolve;
  sheetResolve = null;
  if (resolve) resolve(answer);
}
el('sheet-cancel').addEventListener('click', () => { closeSheet(null); });

/**
 * Who may check a capture. From the box, never invented here.
 *
 * The box has already removed the buyer from this list (§28), and the model refuses a
 * self-approval regardless — offering a name and then rejecting it would be the worse of the two.
 */
const approvers = () => window.buyingData?.approvers ?? [];

/** Everything the box did not tell this screen, named on the page rather than left to be guessed. */
function renderGaps() {
  const gaps = window.buyingGaps ?? [];
  el('gaps').hidden = gaps.length === 0;
  el('gaps-title').textContent = t('gapsTitle');
  el('gaps-list').replaceChildren(...gaps.map((gap) => {
    const item = document.createElement('li');
    item.textContent = words(GAP_WORDS, gap);
    return item;
  }));
}

// ── Navigation ──────────────────────────────────────────────────────────────

const VIEWS = ['invoice', 'match', 'po'];
for (const name of VIEWS) {
  el(`tab-${name}`).addEventListener('click', () => {
    for (const other of VIEWS) {
      el(`view-${other}`).hidden = other !== name;
      el(`tab-${other}`).setAttribute('aria-current', other === name ? 'page' : 'false');
    }
  });
}

// ── The invoice flow ────────────────────────────────────────────────────────

let lastPreview = null;

/**
 * Check the invoice. **Writes nothing.**
 *
 * The two figures that must agree are rendered side by side and large: the file's own sum, and
 * what the buyer read off the paper. A single "does not reconcile" line at the bottom of a form is
 * a message people learn to click past.
 */
el('preview').addEventListener('click', () => {
  const text = el('file-text').value.trim();
  const declared = el('declared-total').value.trim();
  if (text === '') { tell(t('read'), t('needFile')); return; }
  if (declared === '') { tell(t('read'), t('needTotal')); return; }

  let preview;
  try {
    preview = session.previewInvoice({ text, declaredTotalMinor: toMinor(declared) });
  } catch (e) {
    // A file that will not parse is said plainly. The model refuses to treat it as an empty file,
    // which would read as a quiet day rather than a supplier's invoice nobody has read.
    tell(t('read'), String(e && e.message ? e.message : e));
    return;
  }
  lastPreview = preview;
  renderPreview(preview);
});

function renderPreview(preview) {
  const verdict = el('verdict');
  verdict.hidden = false;
  verdict.className = 'verdict ' + (preview.readyToApprove ? 'ready' : 'problem');
  verdict.replaceChildren();

  const headline = document.createElement('strong');
  headline.textContent = preview.readyToApprove ? t('readyToSave') : t('notReady');

  const counts = document.createElement('span');
  counts.className = 'totals';
  counts.textContent = `${preview.lines.length} ${t('linesFound')}`
    + (preview.problems.length > 0 ? ` · ${preview.problems.length} ${t('problemsFound')}` : '');

  // The two figures, side by side. The one that is wrong is coloured — never colour alone, the
  // words above it say which is which.
  const compare = document.createElement('div');
  compare.className = 'compare';
  const off = preview.sumMinor !== preview.declaredTotalMinor;
  for (const [label, minor, isWrong] of [
    [t('fileSays'), preview.sumMinor, off],
    [t('paperSays'), preview.declaredTotalMinor, false],
  ]) {
    const box = document.createElement('div');
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'value' + (isWrong ? ' off' : '');
    v.textContent = inr(minor);
    box.append(l, v);
    compare.append(box);
  }

  verdict.append(headline, counts, compare);
  if (off) {
    const why = document.createElement('span');
    why.className = 'totals';
    why.textContent = t('doesNotAddUp');
    verdict.append(why);
  }

  // Every problem, by line number, so somebody can go and look at the paper.
  el('problems').replaceChildren(...preview.problems.map((problem) => {
    const row = document.createElement('div');
    row.className = 'problem-row';
    const where = document.createElement('span');
    where.className = 'where';
    where.textContent = `${t('line')} ${problem.line}: `;
    row.append(where, document.createTextNode(problem.message));
    return row;
  }));

  el('lines-preview').replaceChildren(linesTable(preview.lines));
  // The save button does not exist on the page until the model says the file may be saved.
  el('capture').hidden = !preview.readyToApprove;
  el('capture').textContent = t('sendForApproval');
}

function linesTable(lines) {
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const [text, cls] of [[t('item'), ''], [t('howMany'), 'amount'], [t('agreedPrice'), 'amount'], [t('lineTotal'), 'amount']]) {
    const th = document.createElement('th');
    th.textContent = text;
    if (cls) th.className = cls;
    head.append(th);
  }
  table.append(head);
  for (const line of lines) {
    const row = document.createElement('tr');
    for (const [text, cls] of [
      [line.productId, ''], [String(line.quantity), 'amount'],
      [inr(line.unitPriceMinor), 'amount'], [inr(line.lineTotalMinor), 'amount'],
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      row.append(td);
    }
    table.append(row);
  }
  return table;
}

el('capture').addEventListener('click', async () => {
  const invoiceId = el('invoice-id').value.trim();
  if (invoiceId === '') { tell(t('read'), t('needInvoiceNumber')); return; }
  if (lastPreview === null) return;

  // Separation of duties is asked for on screen, and enforced in the model — the buyer cannot be
  // in this list, and a name picked here is checked against the capture either way.
  const who = await askApprover(t('whoApproves'), t('whoApprovesNote'), approvers());
  if (who === null) return;

  const outcome = session.captureInvoice({
    invoiceId,
    supplierId: el('supplier-id').value.trim(),
    preview: lastPreview,
    approval: {
      id: `ap-${invoiceId}`, subjectType: 'supplier_invoice', subjectRef: invoiceId,
      requestedBy: window.buyingData?.buyerId ?? 'buyer', branchId: null, value: null,
      status: 'approved', decidedBy: who, reason: 'checked_with_supplier',
      decidedAt: new Date().toISOString(),
    },
  });

  if (!outcome.ok) {
    tell(t('read'), words(REFUSAL_WORDS, outcome.refusal));
    return;
  }
  tell(t('saved'), `${outcome.lines.length} × ${inr(outcome.totalMinor)} — ${t('savedNote')}`, true);
  el('capture').hidden = true;
});

// ── The three-way match ─────────────────────────────────────────────────────

el('run-match').addEventListener('click', () => {
  const result = session.match({
    poId: el('match-po').value.trim(),
    invoiceId: el('match-invoice').value.trim(),
  });

  const verdict = el('match-verdict');
  verdict.hidden = false;
  verdict.className = 'verdict ' + (result.blocked ? 'problem' : 'ready');
  verdict.replaceChildren();

  const headline = document.createElement('strong');
  headline.textContent = result.blocked ? t('blocked') : t('agreed');
  const totals = document.createElement('span');
  totals.className = 'totals';
  totals.textContent = `${t('payable')}: ${inr(result.payableMinor)}`
    + (result.withheldMinor > 0 ? ` · ${t('withheld')}: ${inr(result.withheldMinor)}` : '');
  const action = document.createElement('span');
  action.className = 'totals';
  // The model's own sentence. It already distinguishes "checked and clean" from "not checked", and
  // rewording it here would put a second, untested version of that distinction on the screen.
  action.textContent = result.ownerAction;

  verdict.append(headline, totals, action);
  el('match-lines').replaceChildren(...(result.lines.length === 0 ? [] : [matchTable(result.lines)]));
});

function matchTable(lines) {
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const [text, cls] of [[t('item'), ''], [t('payable'), 'amount'], [t('whatIsWrong'), '']]) {
    const th = document.createElement('th');
    th.textContent = text;
    if (cls) th.className = cls;
    head.append(th);
  }
  table.append(head);
  for (const line of lines) {
    const row = document.createElement('tr');
    if (line.status === 'blocked') row.className = 'blocked';
    for (const [text, cls] of [
      [line.productId, ''], [inr(line.payableMinor), 'amount'], [line.detail, ''],
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      row.append(td);
    }
    table.append(row);
  }
  return table;
}

// ── Raising a purchase order ────────────────────────────────────────────────

let poLines = [];

function renderPoLines() {
  if (poLines.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('noLinesYet');
    el('po-lines').replaceChildren(none);
    return;
  }
  el('po-lines').replaceChildren(linesTable(poLines.map((l) => ({
    productId: l.productId, quantity: l.orderedQty,
    unitPriceMinor: l.unitCostMinor, lineTotalMinor: l.unitCostMinor * l.orderedQty,
  }))));
}

el('add-po-line').addEventListener('click', () => {
  const productId = el('po-product').value.trim();
  const orderedQty = Number(el('po-qty').value);
  const unitCostMinor = toMinor(el('po-cost').value);
  if (productId === '' || !Number.isInteger(orderedQty) || orderedQty <= 0 || !Number.isFinite(unitCostMinor) || unitCostMinor <= 0) {
    tell(t('read'), t('needPoFields'));
    return;
  }
  poLines.push({ productId, orderedQty, unitCostMinor });
  el('po-product').value = '';
  el('po-qty').value = '';
  el('po-cost').value = '';
  renderPoLines();
});

el('raise-po').addEventListener('click', async () => {
  if (poLines.length === 0) { tell(t('read'), t('needPoLine')); return; }
  const who = await askApprover(t('whoApprovesPo'), t('whoApprovesNote'), approvers());
  if (who === null) return;

  const stamp = Date.now().toString(36).toUpperCase();
  try {
    const po = session.raisePurchaseOrder({
      id: `PO-${stamp}`, number: `PO-${stamp}`,
      supplierId: el('po-supplier').value.trim(),
      at: new Date().toISOString(),
      lines: poLines,
      approval: {
        id: `ap-PO-${stamp}`, subjectType: 'purchase_order', subjectRef: `PO-${stamp}`,
        requestedBy: window.buyingData?.buyerId ?? 'buyer', branchId: null, value: null,
        status: 'approved', decidedBy: who, reason: 'within_policy',
        decidedAt: new Date().toISOString(),
      },
    });
    tell(t('orderRaised'), `${po.number} · ${inr(po.total.minor)}`, true);
    poLines = [];
    renderPoLines();
  } catch (e) {
    // The engine's refusal — a blocked supplier, a self-approval — said rather than swallowed.
    tell(t('read'), String(e && e.message ? e.message : e));
  }
});

// ── Language ────────────────────────────────────────────────────────────────

function paintChrome() {
  el('who').firstChild.textContent = `${t('buying')} `;
  el('whoami').textContent = window.buyingData?.buyerId ?? '';
  el('tab-invoice').textContent = t('supplierInvoice');
  el('tab-match').textContent = t('checkAgainst');
  el('tab-po').textContent = t('raiseOrder');
  el('invoice-title').textContent = t('supplierInvoice');
  el('invoice-lead').textContent = t('invoiceLead');
  el('invoice-id-label').textContent = t('invoiceNumber');
  el('supplier-id-label').textContent = t('supplier');
  el('declared-total-label').textContent = t('printedTotal');
  el('file-text-label').textContent = t('theLines');
  el('preview').textContent = t('checkThis');
  el('capture').textContent = t('sendForApproval');
  el('match-title').textContent = t('checkAgainst');
  el('match-lead').textContent = t('matchLead');
  el('match-po-label').textContent = t('comparePo');
  el('match-invoice-label').textContent = t('compareInvoice');
  el('run-match').textContent = t('compareThem');
  el('po-title').textContent = t('raiseOrder');
  el('po-lead').textContent = t('poLead');
  el('po-supplier-label').textContent = t('supplier');
  el('po-product-label').textContent = t('itemCode');
  el('po-qty-label').textContent = t('howMany');
  el('po-cost-label').textContent = t('agreedPrice');
  el('add-po-line').textContent = t('addItem');
  el('raise-po').textContent = t('raiseIt');
  el('sample').textContent = t('sampleData');
  renderGaps();
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
  if (lastPreview !== null) renderPreview(lastPreview);
  renderPoLines();
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
paintChrome();
renderPoLines();

// Registered here as well as on the manager's shell, so whichever of the two is opened first is
// the one that caches them both. Goods-in is the worst wifi in the building (§31, P-01).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
