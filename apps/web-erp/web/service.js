// The service desk — the view layer. Every rule lives in the TESTED session model
// (`apps/web-erp/src/service-session.ts`), attached as `window.serviceSession`.
//
// ── The decision this screen is built around ────────────────────────────────
//
// **The bill decides what can come back, not the person at the desk.** Each line shows what was
// bought, what has already been returned and what is left — and a line with nothing left is shown
// greyed out with the reason, never hidden. Hiding it would leave the agent unable to answer the
// only question the customer is going to ask: *why not?*
//
// ── The one that matters more than it looks ─────────────────────────────────
//
// **A card refund is not a refund yet.** The provider has to move the money and offline nobody has
// even asked. So the screen never says "refunded" for a card — it says the bank has been told and
// it takes a few working days. Saying "refunded" makes the shop responsible for a promise it has
// not kept, and the customer comes back angry in three days with a receipt that agrees with them.
//
// No `prompt`, `confirm` or `alert`; the banner does not fade.

const el = (id) => document.getElementById(id);

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Rupees typed by a person → integer paise. Never a float in the money itself. */
function paise(text) {
  const cleaned = String(text ?? '').replace(/[^0-9.]/g, '');
  if (cleaned === '') return null;
  const [rupees, fraction = ''] = cleaned.split('.');
  const padded = (fraction + '00').slice(0, 2);
  return Number(rupees || '0') * 100 + Number(padded);
}

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    staleShell: 'No connection to the store computer. This page is what it was last told, at',
    title: 'Service desk',
    takeBack: 'Take something back', cases: 'Complaints and enquiries',
    returnLead: "Find the bill first. The shop's own record decides what can come back and what has already been returned.",
    casesLead: 'Worst first. Each one says how long it has been and what was promised.',
    receiptLabel: 'Receipt number', find: 'Find the bill',
    billTitle: 'This bill', linesTitle: 'What can come back',
    reasonLabel: 'Why is it coming back?', refundLabel: 'Refund amount',
    tenderLabel: 'Give it back as', putThrough: 'Put the return through',
    putNote: "The shop's record is written first. Nothing here waits on the internet.",
    reportTitle: 'How the desk is doing',
    sold: 'bought', returned: 'already returned', left: 'can still come back',
    nothingLeft: 'All of this has already been returned. Giving it back again would be a second refund for the same goods.',
    billAge: 'days ago', windowIs: 'this shop takes returns for', days: 'days',
    paid: 'paid', refundedAlready: 'already refunded', leftToRefund: 'left to refund',
    overReturned: 'More has come back on this bill than was ever bought. Do not give anything else back — a manager needs to look at this first.',
    noCases: 'Nothing waiting.',
    defaultsWarning: 'This shop has never set its own service targets, so the times below are the software’s starting figures, not anything you have agreed.',
    ok: 'OK', read: 'Please read this', done: 'Done',
    nobodyNamed: 'This store box has not been told who is on the desk. Nothing can be put through — a refund has to carry the name of the person who gave it.',
    sampleData: 'Sample data — this is not your shop.',
    firstReply: 'first reply', resolve: 'resolve',
    casesN: 'cases', resolvedN: 'resolved', breachedN: 'late', noCsat: 'nobody has rated us yet',
  },
  ta: {
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
    title: 'சேவை மையம்',
    takeBack: 'பொருளைத் திரும்பப் பெறு', cases: 'புகார்களும் விசாரணைகளும்',
    returnLead: 'முதலில் ரசீதைக் கண்டறியவும். எது திரும்ப வர முடியும், எது ஏற்கனவே திரும்பியது என்பதை கடையின் சொந்தப் பதிவே தீர்மானிக்கும்.',
    casesLead: 'மோசமானது முதலில். ஒவ்வொன்றும் எவ்வளவு நேரம் ஆனது, என்ன வாக்குறுதி என்று சொல்கிறது.',
    receiptLabel: 'ரசீது எண்', find: 'ரசீதைக் கண்டறி',
    billTitle: 'இந்த ரசீது', linesTitle: 'எது திரும்ப வர முடியும்',
    reasonLabel: 'ஏன் திரும்ப வருகிறது?', refundLabel: 'திரும்பத் தரும் தொகை',
    tenderLabel: 'எப்படித் திரும்பத் தருவது', putThrough: 'திரும்பப் பெறுதலைப் பதிவு செய்',
    putNote: 'கடையின் பதிவு முதலில் எழுதப்படும். இங்கு எதுவும் இணையத்திற்காகக் காத்திருக்காது.',
    reportTitle: 'சேவை மையம் எப்படிச் செயல்படுகிறது',
    sold: 'வாங்கியது', returned: 'ஏற்கனவே திரும்பியது', left: 'இன்னும் திரும்ப வர முடியும்',
    nothingLeft: 'இதில் எல்லாம் ஏற்கனவே திரும்பி விட்டது. மீண்டும் தருவது ஒரே பொருளுக்கு இரண்டாவது முறை பணம் தருவதாகும்.',
    billAge: 'நாட்களுக்கு முன்', windowIs: 'இந்தக் கடை திரும்பப் பெறும் காலம்', days: 'நாட்கள்',
    paid: 'செலுத்தியது', refundedAlready: 'ஏற்கனவே திரும்பத் தரப்பட்டது', leftToRefund: 'இன்னும் திரும்பத் தரலாம்',
    overReturned: 'இந்த ரசீதில் வாங்கியதை விட அதிகமாகத் திரும்பி வந்துள்ளது. வேறு எதையும் திரும்பத் தர வேண்டாம் — முதலில் மேலாளர் பார்க்க வேண்டும்.',
    noCases: 'எதுவும் காத்திருக்கவில்லை.',
    defaultsWarning: 'இந்தக் கடை தனது சொந்த சேவை இலக்குகளை இதுவரை நிர்ணயிக்கவில்லை. கீழே உள்ள நேரங்கள் மென்பொருளின் தொடக்க எண்கள், நீங்கள் ஒப்புக்கொண்டவை அல்ல.',
    ok: 'சரி', read: 'இதைப் படிக்கவும்', done: 'முடிந்தது',
    nobodyNamed: 'சேவை மையத்தில் யார் இருக்கிறார்கள் என்று இந்தக் கடைப் பெட்டிக்குத் தெரியவில்லை. எதையும் பதிவு செய்ய முடியாது — திரும்பத் தரும் பணம் அதைக் கொடுத்தவரின் பெயரைச் சுமக்க வேண்டும்.',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    firstReply: 'முதல் பதில்', resolve: 'தீர்வு',
    casesN: 'வழக்குகள்', resolvedN: 'தீர்க்கப்பட்டது', breachedN: 'தாமதம்', noCsat: 'இதுவரை யாரும் மதிப்பிடவில்லை',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** Why a bill could not be found or used — one entry per `LookupRefusal`, both languages. */
const LOOKUP_REFUSAL_WORDS = {
  no_such_receipt: {
    en: 'No bill on this store computer carries that number.',
    ta: 'அந்த எண்ணைக் கொண்ட ரசீது இந்தக் கடைக் கணினியில் இல்லை.',
  },
  outside_the_return_window: {
    en: 'This bill is older than the shop takes returns for.',
    ta: 'இந்தக் கடை திரும்பப் பெறும் காலத்தை விட இந்த ரசீது பழையது.',
  },
  nothing_left_to_return: {
    en: 'Everything on this bill has already been returned.',
    ta: 'இந்த ரசீதில் உள்ள அனைத்தும் ஏற்கனவே திரும்பி விட்டன.',
  },
};

/** Why a return could not be put through — one entry per `RefundRefusal`, both languages. */
const REFUND_REFUSAL_WORDS = {
  nobody_is_named_at_this_desk: {
    en: 'This store computer has not been told who is on the desk.',
    ta: 'சேவை மையத்தில் யார் இருக்கிறார்கள் என்று இந்தக் கடைக் கணினிக்குத் தெரியவில்லை.',
  },
  no_such_receipt: {
    en: 'No bill on this store computer carries that number.',
    ta: 'அந்த எண்ணைக் கொண்ட ரசீது இந்தக் கடைக் கணினியில் இல்லை.',
  },
  outside_the_return_window: {
    en: 'This bill is older than the shop takes returns for.',
    ta: 'இந்தக் கடை திரும்பப் பெறும் காலத்தை விட இந்த ரசீது பழையது.',
  },
  nothing_selected: {
    en: 'Nothing has been chosen to come back.',
    ta: 'திரும்பப் பெற எதுவும் தேர்ந்தெடுக்கப்படவில்லை.',
  },
  more_than_was_sold: {
    en: 'More is being returned than was bought on this bill. Some of it has already come back.',
    ta: 'இந்த ரசீதில் வாங்கியதை விட அதிகமாகத் திரும்பத் தரப்படுகிறது. அதில் சில ஏற்கனவே திரும்பி விட்டன.',
  },
  more_than_was_paid: {
    en: 'The refund is more than is left of what was paid on this bill.',
    ta: 'இந்த ரசீதில் செலுத்தியதில் மீதமுள்ளதை விட திரும்பத் தரும் தொகை அதிகம்.',
  },
  needs_a_reason: {
    en: 'A return needs a reason.',
    ta: 'திரும்பப் பெறுவதற்கு ஒரு காரணம் தேவை.',
  },
  needs_a_second_person: {
    en: 'This refund needs a different person to approve it. The one giving it cannot be the one approving it.',
    ta: 'இதை வேறு ஒருவர் அனுமதிக்க வேண்டும். கொடுப்பவரே அனுமதிப்பவராக இருக்க முடியாது.',
  },
  no_receipt_over_the_cap: {
    en: 'A return with no receipt is capped in this shop, and this one is above the cap.',
    ta: 'ரசீது இல்லாமல் திரும்பப் பெறுவதற்கு இந்தக் கடையில் வரம்பு உண்டு. இது அதற்கு மேல் உள்ளது.',
  },
};

/** How an SLA is doing — one entry per `SlaStatus`, both languages. */
const SLA_WORDS = {
  within: { en: 'inside the promised time', ta: 'வாக்குறுதி நேரத்திற்குள்' },
  at_risk: { en: 'running out of time', ta: 'நேரம் முடியப் போகிறது' },
  breached: { en: 'past the promised time', ta: 'வாக்குறுதி நேரம் தாண்டியது' },
  met: { en: 'finished in time', ta: 'நேரத்தில் முடிந்தது' },
};

/** Why goods came back. The desk picks from this list; it never types its own. */
const REASONS = {
  damaged: { en: 'Damaged', ta: 'சேதமடைந்தது' },
  faulty: { en: 'Faulty', ta: 'கோளாறு' },
  expired: { en: 'Out of date', ta: 'காலாவதி' },
  wrong_item: { en: 'Wrong item', ta: 'தவறான பொருள்' },
  not_needed: { en: 'Changed their mind', ta: 'மனம் மாறியது' },
};

/** Where the goods go. The wrong answer here puts damaged stock back on the shelf. */
const DISPOSITIONS = {
  resell: { en: 'Back on the shelf', ta: 'மீண்டும் அலமாரிக்கு' },
  quarantine: { en: 'Hold for checking', ta: 'சோதனைக்காக வைத்திரு' },
  damaged: { en: 'Damaged — not for sale', ta: 'சேதம் — விற்பனைக்கு அல்ல' },
  scrap: { en: 'Throw away', ta: 'தூக்கி எறி' },
};

const TENDERS = {
  cash: { en: 'Cash', ta: 'ரொக்கம்' },
  store_credit: { en: 'Store credit', ta: 'கடை வரவு' },
  card: { en: 'Back to the card', ta: 'அட்டைக்குத் திரும்ப' },
  upi: { en: 'Back by UPI', ta: 'UPI மூலம் திரும்ப' },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/** A stand-in with the same surface as the bundled session, announced whenever it is in use. */
function sampleSession() {
  return {
    lookUp: () => ({ ok: false, refusal: 'no_such_receipt', detail: 'this is sample data' }),
    refund: () => ({ ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'this is sample data' }),
    caseList: () => [],
    compensate: () => ({ granted: false, outcome: 'no_such_case', detail: 'this is sample data' }),
    useDraft: () => ({ sent: false, why: 'this is sample data' }),
    report: () => ({ cases: 0, resolved: 0, breached: 0, breachedValue: [], firstResponseBreached: 0, csatHundredths: 'no_responses', responseRateBps: 'not_meaningful', detail: 'this is sample data' }),
  };
}

const real = window.serviceSession;
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

// ── Navigation ──────────────────────────────────────────────────────────────

const VIEWS = ['return', 'cases'];

function show(name) {
  for (const view of VIEWS) el(`view-${view}`).hidden = view !== name;
  for (const tab of VIEWS) el(`tab-${tab}`).setAttribute('aria-current', tab === name ? 'page' : 'false');
}
for (const name of VIEWS) el(`tab-${name}`).addEventListener('click', () => { show(name); });

// ── Finding the bill ────────────────────────────────────────────────────────

/** The bill currently on screen, and how much of each line the desk has chosen. */
let open = null;
const chosen = new Map();

function findBill() {
  const number = el('receipt').value.trim();
  chosen.clear();
  const outcome = session.lookUp(number);
  if (!outcome.ok) {
    open = null;
    el('found').hidden = true;
    tell(t('read'), `${words(LOOKUP_REFUSAL_WORDS, outcome.refusal)} ${outcome.detail}`);
    return;
  }
  open = outcome.receipt;
  el('found').hidden = false;
  renderBill();
}
el('find').addEventListener('click', findBill);

function renderBill() {
  if (open === null) return;
  const bill = el('bill');
  bill.replaceChildren();

  const total = document.createElement('span');
  total.className = 'big';
  total.textContent = inr(open.sale.totalMinor);
  const when = document.createElement('small');
  when.textContent = `${open.sale.number} · ${open.ageDays} ${t('billAge')} · ${t('windowIs')} ${open.windowDays} ${t('days')}`;
  const money = document.createElement('small');
  // What is LEFT, beside what was paid. A bill part-refunded yesterday must not read as
  // fully refundable today.
  money.textContent = `${t('paid')} ${inr(open.sale.totalMinor)} · ${t('refundedAlready')} ${inr(open.alreadyRefundedMinor)} · ${t('leftToRefund')} ${inr(open.refundableMinor)}`;
  bill.append(total, when, money);

  // Should be impossible; loud rather than hidden, because it means a return went against the
  // wrong bill or the same goods were refunded twice before the register existed.
  const over = el('overreturned');
  over.hidden = open.overReturned.length === 0;
  over.textContent = open.overReturned.length === 0 ? '' : t('overReturned');

  el('lines').replaceChildren(...open.lines.map(lineRow));
}

function lineRow(line) {
  const spent = line.returnableMinor === 0;
  const row = document.createElement('div');
  row.className = `row ${spent ? 'spent' : ''}`;

  const what = document.createElement('span');
  what.className = 'what';
  const name = document.createElement('strong');
  name.textContent = line.productId;
  const sub = document.createElement('small');
  // Never hidden when spent — the agent has to be able to answer "why not?".
  sub.textContent = spent
    ? t('nothingLeft')
    : `${t('sold')} ${line.soldMinor} · ${t('returned')} ${line.alreadyReturnedMinor} · ${t('left')} ${line.returnableMinor}`;
  what.append(name, sub);
  row.append(what);

  if (!spent) {
    const box = document.createElement('span');
    box.className = 'qty';

    const qty = document.createElement('input');
    qty.type = 'text';
    qty.inputMode = 'numeric';
    qty.id = `qty-${line.productId}`;
    qty.setAttribute('aria-label', `${line.productId} quantity`);
    qty.value = '0';

    const where = document.createElement('select');
    where.id = `where-${line.productId}`;
    where.setAttribute('aria-label', `${line.productId} disposition`);
    for (const key of Object.keys(DISPOSITIONS)) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = words(DISPOSITIONS, key);
      where.append(option);
    }

    const remember = () => {
      const n = Number(qty.value.replace(/[^0-9]/g, '') || '0');
      if (n <= 0) chosen.delete(line.productId);
      else chosen.set(line.productId, { quantityMinor: n, disposition: where.value });
    };
    qty.addEventListener('input', remember);
    where.addEventListener('change', remember);

    box.append(qty, where);
    row.append(box);
  }
  return row;
}

// ── Putting it through ──────────────────────────────────────────────────────

el('put-through').addEventListener('click', () => {
  if (open === null) return;
  const refundMinor = paise(el('refund').value);
  if (refundMinor === null) {
    tell(t('read'), words(REFUND_REFUSAL_WORDS, 'more_than_was_paid'));
    return;
  }
  const outcome = session.refund({
    returnId: `RT-${open.sale.saleId}-${chosen.size}-${refundMinor}`,
    number: `RTN-${open.sale.number}`,
    receiptNumber: open.sale.number,
    reasonCode: el('reason').value,
    lines: [...chosen.entries()].map(([productId, line]) => ({ productId, ...line })),
    refundMinor,
    refundTender: el('tender').value,
  });

  if (!outcome.ok) {
    tell(t('read'), `${words(REFUND_REFUSAL_WORDS, outcome.refusal)} ${outcome.detail}`);
    return;
  }
  // The TRUE state of the money, from the model. Never "refunded" for a card.
  tell(t('done'), outcome.tellTheCustomer, true);
  chosen.clear();
  el('refund').value = '';
  findBill();
});

// ── Cases ───────────────────────────────────────────────────────────────────

function renderCases() {
  const list = session.caseList();

  const warning = el('defaults-warning');
  // Said out loud: a desk running on the product's starting figures believes it has agreed
  // targets it has never agreed, and finds out when one is quoted back at it.
  warning.hidden = !(list.length > 0 && list[0].targetsAreDefaults);
  warning.textContent = warning.hidden ? '' : t('defaultsWarning');

  el('case-list').replaceChildren(...(list.length === 0
    ? [emptyLine(t('noCases'))]
    : list.map((view) => {
      const row = document.createElement('div');
      row.className = `row ${view.resolution.status}`;
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = view.serviceCase.summary;
      const sub = document.createElement('small');
      // Words as well as the colour on the border, and BOTH promises: a desk that resolves
      // everything in time while nobody replies for two days is failing in the way people notice.
      sub.textContent = `${t('firstReply')}: ${words(SLA_WORDS, view.firstResponse.status)}`
        + ` · ${t('resolve')}: ${words(SLA_WORDS, view.resolution.status)}`;
      what.append(name, sub);
      row.append(what);
      return row;
    })));

  const report = session.report();
  const box = el('service-report');
  box.replaceChildren();
  const head = document.createElement('span');
  head.className = 'big';
  head.textContent = `${report.cases} ${t('casesN')}`;
  const detail = document.createElement('small');
  detail.textContent = `${report.resolved} ${t('resolvedN')} · ${report.breached} ${t('breachedN')}`;
  const csat = document.createElement('small');
  // Never a bare average: 4.8 from six replies out of four hundred cases is six people.
  csat.textContent = report.csatHundredths === 'no_responses'
    ? t('noCsat')
    : `${(report.csatHundredths / 100).toFixed(2)} · ${report.responseRateBps === 'not_meaningful' ? '' : `${(report.responseRateBps / 100).toFixed(1)}%`}`;
  box.append(head, detail, csat);
}

function emptyLine(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

// ── Language and chrome ─────────────────────────────────────────────────────

function fill(select, map) {
  const held = select.value;
  select.replaceChildren(...Object.keys(map).map((key) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = words(map, key);
    return option;
  }));
  if (held !== '') select.value = held;
}

function paintChrome() {
  el('who').firstChild.textContent = `${t('title')} `;
  el('whoami').textContent = window.serviceData?.userId ?? '';
  el('tab-return').textContent = t('takeBack');
  el('tab-cases').textContent = t('cases');
  el('return-title').textContent = t('takeBack');
  el('return-lead').textContent = t('returnLead');
  el('receipt-label').textContent = t('receiptLabel');
  el('find').textContent = t('find');
  el('bill-title').textContent = t('billTitle');
  el('lines-title').textContent = t('linesTitle');
  el('reason-label').textContent = t('reasonLabel');
  el('refund-label').textContent = t('refundLabel');
  el('tender-label').textContent = t('tenderLabel');
  el('put-through').textContent = t('putThrough');
  el('put-note').textContent = t('putNote');
  el('cases-title').textContent = t('cases');
  el('cases-lead').textContent = t('casesLead');
  el('report-title').textContent = t('reportTitle');
  el('sample').textContent = t('sampleData');

  fill(el('reason'), REASONS);
  fill(el('tender'), TENDERS);

  // Nobody named, nothing can be committed — said at the top rather than discovered on refusal.
  const nobody = el('nobody');
  nobody.hidden = window.serviceData?.userId !== undefined;
  nobody.textContent = nobody.hidden ? '' : t('nobodyNamed');

  renderBill();
  renderCases();
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
paintChrome();
show('return');

// ── The shell's own honesty about where this page came from ─────────────────

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
