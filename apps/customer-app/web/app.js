// Customer app — the view layer. It renders the basket and the privacy centre and dispatches what
// the shopper does; every rule lives in the TESTED models (`apps/customer-app/src/`), attached as
// `window.shop`.
//
// ── What this file exists to hold ───────────────────────────────────────────
//
// **1. "Sent" and "prepared" are different words, and the screen never confuses them.** This is the
// deliberate inverse of the till. At the till we commit locally and sync afterwards, because the
// money is in the drawer and the customer has gone. Here nothing has happened at all — no money has
// moved and the shop has never heard of this basket. So a basket prepared with no signal says
// *not sent yet*, in those words, and the button that would have said "order placed" is not there.
//
// **2. Withdrawing consent is the same one tap as giving it.** Section 6(6) of the DPDP Act 2023
// requires it, and it is the most common dark pattern in consumer software precisely because nobody
// builds it deliberately — it costs nothing to add a confirmation step on the way out and something
// to add one on the way in. So there is one switch per purpose, it is the same control in both
// directions, and a guardrail counts the taps.
//
// **3. Nothing is said to be deleted that has not been deleted.** Tapping "delete my information"
// raises a request; the shop has to verify it and answer by a date. The screen says that. It also
// says, **on the button before it is pressed**, that invoices and tax records survive an erasure by
// law — somebody who taps expecting everything to go and learns otherwise later has been misled
// even though every individual step was accurate.
//
// **4. No `prompt`, `confirm` or `alert`.** This is the public surface: WCAG 2.2 AA (NFR-07), real
// buttons, real labels, visible focus, and every state in words rather than colour.

const el = (id) => document.getElementById(id);

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    shop: 'Shop', basket: 'Basket', myOrder: 'My order', myInformation: 'My information',
    online: 'Online', offline: 'No connection — you can fill your basket, but not order yet',
    searchFor: 'Search for something', buyAgain: 'Buy again', noLists: 'Nothing to buy again yet.',
    nothingFound: 'Nothing matched that. Try a shorter word.',
    add: 'Add', added: 'Added to your basket', remove: 'Remove', outOfStock: 'Not available today',
    yourBasket: 'Your basket', basketEmpty: 'Your basket is empty.',
    checkBasket: 'Check my basket', thingsChanged: 'Some things have changed',
    takeWhatYouHave: 'Take what you have', whenWouldYouLike: 'When would you like it?',
    payAndPlace: 'Pay and place the order', ok: 'OK',
    notSentYet: 'Not sent yet', preparedNotSent: 'Your basket is ready but has NOT been sent, and nothing has been charged. It will go as soon as you are back online.',
    checkFirst: 'Please check your basket first, so you can see what you are paying for.',
    chooseTime: 'Please choose a time first.', pickedTime: 'Time chosen',
    noSlots: 'There are no delivery times available right now.',
    nothingToOrder: 'There is nothing in your basket to order.',
    orderTitle: 'My order', noOrderYet: 'You have not placed an order yet.',
    privacyTitle: 'My information',
    privacyLead: 'You decide what we may do with your information. You can change any of this at any time, in one tap.',
    on: 'ON', off: 'OFF', requiredPurpose: 'We have to do this to deliver the order you placed — it is not marketing, and you cannot be sent anything else with it.',
    cannotTurnOff: 'This one cannot be turned off, because we cannot deliver an order without it.',
    askUs: 'Ask us about your information',
    askUsLead: 'You do not need to phone or email anybody. Tap one and we will answer.',
    rightAccess: 'Show me what you hold about me', rightCorrection: 'Something about me is wrong — correct it',
    rightExport: 'Send me a copy of my information', rightErasure: 'Delete my information',
    erasureCaveat: 'We cannot delete everything: invoices and tax records have to be kept by law. We will tell you exactly what stays and why.',
    requestRaised: 'We have your request',
    sampleShop: 'Sample shop — these are not real prices.',
    unknownPurpose: 'That setting is not one we use.',
    priceChanged: 'Prices changed while you were deciding. Please check your basket again before paying.',
    unavailableNow: 'is not available today', shortNow: 'we only have',
    subtotal: 'Basket total', deliveryExtra: 'Delivery is worked out at checkout.',
  },
  ta: {
    shop: 'கடை', basket: 'கூடை', myOrder: 'என் ஆர்டர்', myInformation: 'என் தகவல்',
    online: 'இணைப்பில்', offline: 'இணைப்பு இல்லை — கூடையை நிரப்பலாம், ஆனால் இன்னும் ஆர்டர் செய்ய முடியாது',
    searchFor: 'ஏதாவது தேடுங்கள்', buyAgain: 'மீண்டும் வாங்கு', noLists: 'மீண்டும் வாங்க இன்னும் எதுவும் இல்லை.',
    nothingFound: 'அது எதுவும் கிடைக்கவில்லை. சிறிய வார்த்தையை முயற்சிக்கவும்.',
    add: 'சேர்', added: 'கூடையில் சேர்க்கப்பட்டது', remove: 'நீக்கு', outOfStock: 'இன்று கிடைக்கவில்லை',
    yourBasket: 'உங்கள் கூடை', basketEmpty: 'உங்கள் கூடை காலியாக உள்ளது.',
    checkBasket: 'என் கூடையைச் சரிபார்', thingsChanged: 'சில விஷயங்கள் மாறியுள்ளன',
    takeWhatYouHave: 'உள்ளதை எடுத்துக்கொள்', whenWouldYouLike: 'எப்போது வேண்டும்?',
    payAndPlace: 'பணம் செலுத்தி ஆர்டர் செய்', ok: 'சரி',
    notSentYet: 'இன்னும் அனுப்பப்படவில்லை', preparedNotSent: 'உங்கள் கூடை தயார், ஆனால் அனுப்பப்படவில்லை. எந்தப் பணமும் வசூலிக்கப்படவில்லை. இணைப்பு வந்தவுடன் அனுப்பப்படும்.',
    checkFirst: 'முதலில் கூடையைச் சரிபார்க்கவும் — எதற்குப் பணம் செலுத்துகிறீர்கள் என்று தெரியும்.',
    chooseTime: 'முதலில் ஒரு நேரத்தைத் தேர்ந்தெடுக்கவும்.', pickedTime: 'நேரம் தேர்ந்தெடுக்கப்பட்டது',
    noSlots: 'இப்போது டெலிவரி நேரம் எதுவும் இல்லை.',
    nothingToOrder: 'ஆர்டர் செய்ய கூடையில் எதுவும் இல்லை.',
    orderTitle: 'என் ஆர்டர்', noOrderYet: 'நீங்கள் இன்னும் ஆர்டர் செய்யவில்லை.',
    privacyTitle: 'என் தகவல்',
    privacyLead: 'உங்கள் தகவலை நாங்கள் என்ன செய்யலாம் என்பதை நீங்கள் முடிவு செய்கிறீர்கள். எப்போது வேண்டுமானாலும் ஒரே தட்டலில் மாற்றலாம்.',
    on: 'ஆன்', off: 'ஆஃப்', requiredPurpose: 'நீங்கள் செய்த ஆர்டரை வழங்க இது தேவை — இது விளம்பரம் அல்ல, இதனுடன் வேறு எதுவும் அனுப்பப்படாது.',
    cannotTurnOff: 'இதை அணைக்க முடியாது, ஏனெனில் இது இல்லாமல் ஆர்டரை வழங்க முடியாது.',
    askUs: 'உங்கள் தகவல் பற்றி எங்களிடம் கேளுங்கள்',
    askUsLead: 'யாருக்கும் ஃபோன் செய்யவோ மெயில் அனுப்பவோ தேவையில்லை. ஒன்றைத் தட்டுங்கள், நாங்கள் பதில் தருவோம்.',
    rightAccess: 'என்னைப் பற்றி நீங்கள் வைத்திருப்பதைக் காட்டுங்கள்', rightCorrection: 'என்னைப் பற்றிய தகவல் தவறு — சரிசெய்யுங்கள்',
    rightExport: 'என் தகவலின் நகலை அனுப்புங்கள்', rightErasure: 'என் தகவலை நீக்குங்கள்',
    erasureCaveat: 'எல்லாவற்றையும் நீக்க முடியாது: இன்வாய்ஸ் மற்றும் வரிப் பதிவுகளைச் சட்டப்படி வைத்திருக்க வேண்டும். எது இருக்கும், ஏன் என்று சரியாகச் சொல்வோம்.',
    requestRaised: 'உங்கள் கோரிக்கை எங்களிடம் உள்ளது',
    sampleShop: 'மாதிரிக் கடை — இவை உண்மையான விலைகள் அல்ல.',
    unknownPurpose: 'அந்த அமைப்பை நாங்கள் பயன்படுத்துவதில்லை.',
    priceChanged: 'நீங்கள் யோசித்துக் கொண்டிருந்தபோது விலை மாறியது. பணம் செலுத்தும் முன் கூடையை மீண்டும் சரிபார்க்கவும்.',
    unavailableNow: 'இன்று கிடைக்கவில்லை', shortNow: 'எங்களிடம் உள்ளது',
    subtotal: 'கூடை மொத்தம்', deliveryExtra: 'டெலிவரிக் கட்டணம் கடைசியில் கணக்கிடப்படும்.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** The words on each right's button. Guarded against the model's own list of rights. */
const RIGHT_WORDS = {
  access: { en: 'Show me what you hold about me', ta: 'என்னைப் பற்றி நீங்கள் வைத்திருப்பதைக் காட்டுங்கள்' },
  correction: { en: 'Something about me is wrong — correct it', ta: 'என்னைப் பற்றிய தகவல் தவறு — சரிசெய்யுங்கள்' },
  export: { en: 'Send me a copy of my information', ta: 'என் தகவலின் நகலை அனுப்புங்கள்' },
  erasure: { en: 'Delete my information', ta: 'என் தகவலை நீக்குங்கள்' },
};

/** What each consent purpose is for, said plainly. An unlabelled switch is not a choice. */
const PURPOSE_WORDS = {
  order_updates: { en: 'Tell me about the orders I place', ta: 'நான் செய்யும் ஆர்டர்கள் பற்றி சொல்லுங்கள்' },
  marketing: { en: 'Send me offers and news', ta: 'சலுகைகளும் செய்திகளும் அனுப்புங்கள்' },
  profiling: { en: 'Use what I buy to suggest things to me', ta: 'நான் வாங்குவதைப் பயன்படுத்தி எனக்குப் பரிந்துரைக்கவும்' },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/**
 * Sample shop with the same surface as the bundled model, so the layout is reviewable before a
 * real catalogue arrives. Replaced at build time by the tested model, and whenever it is in use
 * the header says so — a shopper who reads a made-up price as a real one has been misled.
 */
function sampleShop() {
  const products = [
    { productId: 'p1', name: 'Toor dal 1kg', priceMinor: 145_00, unitPriceMinor: 145_00 },
    { productId: 'p2', name: 'Idli rice 5kg', priceMinor: 385_00, unitPriceMinor: 385_00 },
    { productId: 'p3', name: 'Coconut oil 1L', priceMinor: 320_00, unitPriceMinor: 320_00 },
  ];
  let lines = [];
  let consent = [
    { purpose: 'order_updates', channel: 'sms', granted: true, required: true, tapsToGrant: 1, tapsToWithdraw: 1 },
    { purpose: 'marketing', channel: 'sms', granted: false, required: false, tapsToGrant: 1, tapsToWithdraw: 1 },
    { purpose: 'profiling', channel: 'app', granted: false, required: false, tapsToGrant: 1, tapsToWithdraw: 1 },
  ];
  const say = () => (lines.length === 0
    ? 'Your basket is empty.'
    : `${lines.length} item(s) in your basket. Prices are checked when you review.`);
  return {
    state: () => ({ stage: 'browsing', lines, tellTheCustomer: say() }),
    // The same shape the real engine returns — an array of hits, each wrapping its product. A
    // stand-in with a different shape is a stand-in that teaches the view the wrong one.
    search: (term) => products
      .filter((p) => p.name.toLowerCase().includes(term.toLowerCase()))
      .map((p) => ({ product: { productId: p.productId, name: p.name, unitPriceMinor: p.priceMinor, buyable: true }, match: 'prefix' })),
    setLine: (productId, quantityMinor) => {
      lines = [...lines.filter((l) => l.productId !== productId), ...(quantityMinor > 0 ? [{ productId, quantityMinor }] : [])];
      return { stage: 'browsing', lines, tellTheCustomer: say() };
    },
    repeat: () => ({ lines: [], droppedProductIds: [], detail: 'sample' }),
    review: () => ({ ok: true, state: { stage: 'reviewed', lines, tellTheCustomer: 'Sample basket checked.', review: { lines: [], subtotalMinor: 0, hasProblems: false, unavailable: [], shortfalls: [] } } }),
    acceptWhatIsAvailable: () => ({ ok: true, state: { stage: 'reviewed', lines, tellTheCustomer: 'sample' } }),
    slots: () => [{ slotId: 'today-evening', capacity: 5, booked: 0 }],
    chooseSlot: () => ({ ok: true, state: { stage: 'slot_booked', lines, slotId: 'today-evening', tellTheCustomer: 'Sample slot booked.' } }),
    send: () => ({ ok: true, state: { stage: 'waiting_for_signal', lines, tellTheCustomer: 'This is a sample shop, so nothing was sent.' } }),
    statusLine: () => null,
    consent: () => consent,
    setConsent: (purpose, channel, granted) => {
      const row = consent.find((c) => c.purpose === purpose && c.channel === channel);
      if (row === undefined) return { ok: false, refusal: 'unknown_purpose' };
      if (row.required && !granted) return { ok: false, refusal: 'required_for_service' };
      consent = consent.map((c) => (c === row ? { ...c, granted } : c));
      return { ok: true, granted };
    },
    rights: () => [
      { kind: 'access', partialByLaw: false }, { kind: 'correction', partialByLaw: false },
      { kind: 'export', partialByLaw: false }, { kind: 'erasure', partialByLaw: true },
    ],
    raise: (kind) => ({ request: { requestId: 'SAMPLE-1', kind }, tellTheCustomer: 'This is a sample shop, so nothing was raised.' }),
  };
}

const real = window.shop;
const shop = real ?? sampleShop();

// ── The banner ──────────────────────────────────────────────────────────────

function tell(title, message, tone = 'info') {
  el('banner-title').textContent = title;
  el('banner-text').textContent = message;
  el('banner').classList.toggle('good', tone === 'good');
  el('banner').classList.toggle('bad', tone === 'bad');
  el('banner').hidden = false;
  el('banner-ok').textContent = t('ok');
  el('banner-ok').focus();
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

// ── Connection ──────────────────────────────────────────────────────────────
//
// Ordering and payment need a connection (§31 customer row). The basket does not, and the
// difference is stated rather than left for somebody to discover at the payment step.

const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

function renderConnection() {
  const online = isOnline();
  el('conn-dot').classList.toggle('off', !online);
  el('conn-text').classList.toggle('off', !online);
  // Words as well as a dot. One man in twelve cannot tell the two colours apart.
  el('conn-text').textContent = online ? t('online') : t('offline');
}
window.addEventListener('online', () => { renderConnection(); });
window.addEventListener('offline', () => { renderConnection(); });

// ── Navigation ──────────────────────────────────────────────────────────────

const VIEWS = ['shop', 'basket', 'order', 'privacy'];
let view = 'shop';

function show(next) {
  view = next;
  for (const name of VIEWS) {
    el(`view-${name}`).hidden = name !== next;
    el(`tab-${name}`).setAttribute('aria-current', name === next ? 'page' : 'false');
  }
  render();
}
for (const name of VIEWS) el(`tab-${name}`).addEventListener('click', () => show(name));

// ── Shopping ────────────────────────────────────────────────────────────────

function qtyOf(productId) {
  return shop.state().lines.find((l) => l.productId === productId)?.quantityMinor ?? 0;
}

/** A row with a plus/minus stepper. Two taps to add a searched item (QG-02 budget of ≤2). */
function productRow(product) {
  const row = document.createElement('div');
  row.className = 'row';

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = product.name;

  const price = document.createElement('span');
  price.className = 'price';
  price.textContent = inr(product.unitPriceMinor ?? 0);

  const qty = document.createElement('div');
  qty.className = 'qty';
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.textContent = '−';
  minus.setAttribute('aria-label', `${t('remove')} ${product.name}`);
  const shown = document.createElement('span');
  shown.className = 'n';
  shown.textContent = String(qtyOf(product.productId));
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.textContent = '+';
  plus.setAttribute('aria-label', `${t('add')} ${product.name}`);

  const step = (by) => {
    const next = Math.max(0, qtyOf(product.productId) + by);
    shop.setLine(product.productId, next);
    render();
  };
  minus.addEventListener('click', () => step(-1));
  plus.addEventListener('click', () => step(1));
  qty.append(minus, shown, plus);

  row.append(name, price, qty);
  return row;
}

function renderSearch() {
  const term = el('search').value.trim();
  if (term === '') {
    el('results').replaceChildren();
    el('results-empty').hidden = true;
    return;
  }
  // `searchCatalogue` returns the hits ARRAY, and each hit wraps its product. The first version
  // of this read `result.hits`, which is `undefined` — so `?? []` made every single search report
  // "nothing matched that", for every term, including exact barcodes. Nothing threw and nothing
  // failed a test; the shop simply appeared to stock nothing. Found by driving the real path.
  const hits = shop.search(term);
  el('results-empty').hidden = hits.length > 0;
  el('results-empty').textContent = t('nothingFound');
  el('results').replaceChildren(...hits.map((hit) => productRow(hit.product ?? hit)));
}
el('search').addEventListener('input', () => { renderSearch(); });

function renderLists() {
  const lists = window.shopData?.savedLists ?? [];
  el('lists-empty').hidden = lists.length > 0;
  el('lists-empty').textContent = t('noLists');
  el('lists').replaceChildren(...lists.map((list) => {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = list.name;
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'primary';
    again.textContent = t('buyAgain');
    again.addEventListener('click', () => {
      const result = shop.repeat(list.listId);
      // The package names what it could not add back rather than dropping it quietly — a repeat
      // order that silently loses the milk is why people stop trusting the button.
      tell(t('buyAgain'), result.detail, result.droppedProductIds.length > 0 ? 'bad' : 'good');
      show('basket');
    });
    row.append(name, again);
    return row;
  }));
}

// ── The basket ──────────────────────────────────────────────────────────────

function renderBasket() {
  const state = shop.state();
  const say = el('basket-say');
  say.textContent = state.tellTheCustomer;
  // The tone comes from the stage the MODEL is in, not from this file's opinion of it.
  say.className = 'say'
    + (state.stage === 'waiting_for_signal' ? ' stop'
      : state.review?.hasProblems ? ' warn'
        : state.stage === 'sent' ? ' done' : '');

  const products = window.shopData?.products ?? [];
  el('basket-lines').replaceChildren(...state.lines.map((line) => {
    const product = products.find((p) => p.productId === line.productId)
      ?? { productId: line.productId, name: line.productId, unitPriceMinor: 0 };
    return productRow(product);
  }));

  // Problems found at review, named one by one. The customer decides — the basket is never
  // quietly reduced for them, which is how somebody finds out at the door.
  const review = state.review;
  const hasProblems = review !== undefined && review.hasProblems === true;
  el('problems').hidden = !hasProblems;
  if (hasProblems) {
    const rows = [
      ...(review.unavailable ?? []).map((l) => `${l.name ?? l.productId} — ${t('unavailableNow')}`),
      ...(review.shortfalls ?? []).map((l) => `${l.name ?? l.productId} — ${t('shortNow')} ${l.availableMinor}`),
    ];
    el('problem-lines').replaceChildren(...rows.map((text) => {
      const row = document.createElement('p');
      row.className = 'row';
      const note = document.createElement('span');
      note.className = 'note bad';
      note.textContent = text;
      row.append(note);
      return row;
    }));
  }

  el('slots').replaceChildren(...shop.slots().map((slot) => {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = slot.slotId;
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.textContent = state.slotId === slot.slotId ? t('pickedTime') : t('whenWouldYouLike');
    pick.setAttribute('aria-pressed', state.slotId === slot.slotId ? 'true' : 'false');
    pick.addEventListener('click', () => {
      const result = shop.chooseSlot(slot.slotId, new Date().toISOString());
      tell(result.ok ? t('pickedTime') : t('whenWouldYouLike'), result.state.tellTheCustomer, result.ok ? 'good' : 'bad');
      render();
    });
    row.append(name, pick);
    return row;
  }));
  if (shop.slots().length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('noSlots');
    el('slots').replaceChildren(none);
  }
}

el('review').addEventListener('click', () => {
  const result = shop.review();
  tell(t('checkBasket'), result.state.tellTheCustomer, result.state.review?.hasProblems ? 'bad' : 'good');
  render();
});

el('accept').addEventListener('click', () => {
  const result = shop.acceptWhatIsAvailable();
  tell(t('takeWhatYouHave'), result.state.tellTheCustomer, 'good');
  render();
});

/**
 * Pay and send.
 *
 * **The screen never decides whether the order got there.** `reachedTheShop` is whether the
 * connection is actually up; the model turns that into either a placed order or a basket that is
 * explicitly *not sent*. There is no branch in this file that says "order placed" on its own
 * authority, which is the whole point.
 */
el('pay').addEventListener('click', () => {
  const state = shop.state();
  if (state.lines.length === 0) { tell(t('yourBasket'), t('nothingToOrder'), 'bad'); return; }

  const result = shop.send({
    orderId: `ORD-${Date.now().toString(36).toUpperCase()}`,
    // A provider token, supplied by the payment provider's own sheet. A card number here is
    // refused by the model outright rather than redacted (hard rule #3).
    providerRef: window.shopPaymentRef ?? 'tok_pending',
    result: 'authorised',
    reachedTheShop: isOnline(),
  });

  if (!result.ok) {
    const why = result.refusedBecause === 'not_reviewed' ? t('checkFirst')
      : result.refusedBecause === 'no_slot_booked' ? t('chooseTime')
        : result.refusedBecause === 'review_is_out_of_date' ? t('priceChanged')
          : result.state.tellTheCustomer;
    tell(t('payAndPlace'), why, 'bad');
    render();
    return;
  }

  // The model's own words. "Prepared, not sent" is not a kind of placed, and rewording it here
  // would put a second, untested version of the most consequential sentence in the app.
  const prepared = result.state.stage === 'waiting_for_signal';
  tell(prepared ? t('notSentYet') : t('myOrder'), result.state.tellTheCustomer, prepared ? 'bad' : 'good');
  show('order');
});

function renderOrder() {
  const line = shop.statusLine();
  const state = shop.state();
  el('order-say').textContent = line ?? (state.stage === 'waiting_for_signal'
    ? state.tellTheCustomer
    : t('noOrderYet'));
  el('order-say').className = 'say' + (state.stage === 'waiting_for_signal' ? ' stop' : line ? ' done' : '');
}

// ── The privacy centre ──────────────────────────────────────────────────────

/**
 * One switch per purpose — and the SAME switch turns it off.
 *
 * Section 6(6) of the DPDP Act 2023 requires withdrawing consent to be comparable in ease to
 * giving it. That is broken one reasonable step at a time: a confirmation, then a "tell us why",
 * then a link to support. None of those would ever be added to the granting path, and that
 * asymmetry is the whole offence. So there is exactly one control, it costs one tap in either
 * direction, and a guardrail counts them.
 */
function renderConsent() {
  const controls = shop.consent();
  el('consent').replaceChildren(...controls.map((control) => {
    const row = document.createElement('div');
    row.className = 'consent-row';

    const label = document.createElement('span');
    label.textContent = words(PURPOSE_WORDS, control.purpose);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'switch';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', control.granted ? 'true' : 'false');
    // Words, not only a colour and a position — this is the control that decides what a shop may
    // do with somebody's information, and it has to be unambiguous to everybody.
    toggle.textContent = control.granted ? t('on') : t('off');
    toggle.disabled = control.required;

    toggle.addEventListener('click', () => {
      const change = shop.setConsent(control.purpose, control.channel, !control.granted);
      if (!change.ok) {
        tell(t('myInformation'),
          change.refusal === 'required_for_service' ? t('cannotTurnOff') : t('unknownPurpose'), 'bad');
      }
      render();
    });

    row.append(label, toggle);
    if (control.required) {
      const why = document.createElement('span');
      why.className = 'why';
      // A necessary purpose that pretends to be a choice is its own dark pattern, so it says why.
      why.textContent = t('requiredPurpose');
      row.append(why);
    }
    return row;
  }));
}

/**
 * The rights, each with what the law actually allows written **on the button**.
 *
 * Somebody who taps "delete my information" believing everything goes, and learns months later
 * that eight years of invoices remain, has been misled even though every step afterwards was
 * accurate. So the caveat is in front of the tap, not in the reply.
 */
function renderRights() {
  el('rights').replaceChildren(...shop.rights().map((right) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wide';
    button.textContent = words(RIGHT_WORDS, right.kind);
    if (right.partialByLaw) {
      const caveat = document.createElement('span');
      caveat.className = 'caveat';
      caveat.textContent = t('erasureCaveat');
      button.append(caveat);
    }
    button.addEventListener('click', () => {
      const raised = shop.raise(right.kind, new Date().toISOString());
      // The model's sentence: it says the request was RECEIVED and when it must be answered by.
      // It never says the data is gone, because the phone cannot verify a requester or delete
      // anything, and both happen where the evidence is.
      tell(t('requestRaised'), raised.tellTheCustomer, 'good');
    });
    return button;
  }));
}

// ── Paint ───────────────────────────────────────────────────────────────────

function paintChrome() {
  el('tab-shop').textContent = t('shop');
  el('tab-basket').textContent = t('basket');
  el('tab-order').textContent = t('myOrder');
  el('tab-privacy').textContent = t('myInformation');
  el('shop-title').textContent = t('shop');
  el('search-label').textContent = t('searchFor');
  el('repeat-title').textContent = t('buyAgain');
  el('basket-title').textContent = t('yourBasket');
  el('review').textContent = t('checkBasket');
  el('problems-title').textContent = t('thingsChanged');
  el('accept').textContent = t('takeWhatYouHave');
  el('slot-title').textContent = t('whenWouldYouLike');
  el('pay').textContent = t('payAndPlace');
  el('order-title').textContent = t('orderTitle');
  el('privacy-title').textContent = t('privacyTitle');
  el('privacy-lead').textContent = t('privacyLead');
  el('rights-title').textContent = t('askUs');
  el('rights-lead').textContent = t('askUsLead');
  el('sample').textContent = t('sampleShop');
}

function render() {
  renderConnection();
  if (view === 'shop') { renderSearch(); renderLists(); }
  if (view === 'basket') renderBasket();
  if (view === 'order') renderOrder();
  if (view === 'privacy') { renderConsent(); renderRights(); }
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
  render();
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
el('sample').textContent = t('sampleShop');

const storageProblem = window.shopStorageProblem;
el('storage').hidden = !storageProblem;
if (storageProblem) el('storage').textContent = storageProblem;

paintChrome();
show('shop');
