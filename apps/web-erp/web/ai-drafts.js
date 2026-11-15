// The assistant's drafts — the THIN CLIENT for the A09 approver and the A07 security officer (roadmap §7 · P-05 ·
// hard rule 5). It holds no rule: the template versions, the summaries and every refusal are head office's. A09's words
// are DRAFT template versions on the PA-08 register — approving one is the existing two-person template approval, which
// the server refuses to the person who asked for the words. A07's summaries are read-only suggestions. Each POST carries
// its own idempotency key; every word has a Tamil twin and follows the one language toggle.
// CR-01 OI-13 (OB-763 B): A12's supplier-bill explanations and A14's till over/short explanations are drafts on the AI
// register (GET /v1/ai/proposals). Each reason comes as a code with its figures, so it is said in English or Tamil here;
// a person agrees or says "not right" with a reason (POST /v1/ai/proposals/:id/outcome) — which commits nothing: the bill's
// own routes and the over/short sign-off still decide. The supplier query is a draft a person checks and sends.

// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? '';
const $ = (id) => document.getElementById(id);
const who = window.aiDraftsData && typeof window.aiDraftsData === 'object' ? window.aiDraftsData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const mayDraftWords = perms.has('document.template.manage');
const mayReadSummaries = perms.has('lp.case.read');
const mayAskSummary = perms.has('lp.case.manage');
const mayReadDrafts = perms.has('ai.proposal.read');
const mayRunAgents = perms.has('ai.agent.run');
const mayDecide = perms.has('ai.proposal.decide');

const WORDS = {
  en: {
    title: 'Assistant drafts', campH: 'Campaign words waiting for approval',
    campLede: 'Words the assistant drafted for a message. A different person from the one who asked must approve them before anything can be sent; the send still checks each customer\'s consent and the weekly cap.',
    tplId: 'Template name', channel: 'Channel', brief: 'Brief (optional)', email: 'Email', push: 'App notification', askCampaign: 'Ask the assistant for the words',
    draftedBy: 'Asked for by', version: 'version', fromRecords: 'drafted by the assistant from', records: 'record(s)', approve: 'Approve these words', approvedBy: 'Approved by',
    noDrafts: 'No campaign words are waiting.', anomH: 'Anomaly summaries',
    anomLede: 'What the assistant sees across the open investigations and the rule breaches, and what it suggests looking at first. It suspends nobody and opens or closes nothing.',
    askSummary: 'Ask the assistant for a summary', suggested: 'Suggested order', noSummaries: 'No summaries yet.', askedBy: 'asked for by',
    drafted: 'The assistant drafted words — a different person approves them.', summarised: 'The assistant wrote a summary.',
    notDrafted: 'The assistant did not draft:', stopped: 'The assistant is switched off or out of budget.',
    noPricing: 'The assistant cannot run: no model pricing is set for this shop yet, so head office admits no call. Nothing was drafted.',
    // OB-561 (owner, 31 Oct 2026): live AI stays off until Release 8 (OB-382) — the plain reason, before any technical one.
    offUntilR8: 'The assistants are off until Release 8 — the owner decided this on 31 October 2026. Nothing on this page is drafted by an assistant yet; do this work yourself.',
    done: 'Done.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', cannotRead: 'Your role cannot read these.',
    // CR-01 OI-13 (OB-763 B) — A12 and A14.
    billsH: 'Supplier bills that do not match',
    billsLede: 'Why a supplier bill does not match its order and the goods received, in plain words, with a query to the supplier drafted. It works on fixed rules (no live AI, ₹0 a month). It pays nothing and issues no debit note — the accounts person decides.',
    askBills: 'Explain the bills now', noBills: 'No supplier bill needs explaining.',
    tillsH: 'Tills over or short',
    tillsLede: 'The likely reasons a till was over or short at day close, from the till\'s own records — records, not people. It works on fixed rules (no live AI, ₹0 a month). It writes nothing off and changes no cash — the manager decides.',
    askTills: 'Explain the tills now', noTills: 'No till over or short is waiting.',
    billOf: 'Bill', tillOf: 'Till close', reasonsH: 'Why', supplierDraft: 'Draft to the supplier (a person checks it and sends it):',
    evidence: 'from', confidence: { high: 'Confidence: high', medium: 'Confidence: medium', low: 'Confidence: low' },
    agree: 'Agree — I will act on it', notRight: 'Not right', notRightWhy: 'Why is it not right?', needWhy: 'Say why it is not right first.',
    decided: { approved: 'Agreed by', rejected: 'Marked not right by' }, decidedOk: 'Recorded. Nothing was changed anywhere — act through the bill or the till sign-off.',
    explained: 'The assistant looked at the records.', willDo: 'Who acts:', cannotDecide: 'Your role may read these, not decide them.',
    agentOff: 'This assistant is switched off. The owner switches it on on the AI control page; until then do this by hand.',
  },
  ta: {
    title: 'உதவியாளர் வரைவுகள்', campH: 'ஒப்புதலுக்காகக் காத்திருக்கும் பிரச்சார வார்த்தைகள்',
    campLede: 'ஒரு செய்திக்காக உதவியாளர் வரைந்த வார்த்தைகள். கேட்டவர் அல்லாத வேறொருவர் ஒப்புதல் அளிக்கும் வரை எதுவும் அனுப்ப முடியாது; அனுப்பும்போது ஒவ்வொரு வாடிக்கையாளரின் ஒப்புதலும் வார வரம்பும் சரிபார்க்கப்படும்.',
    tplId: 'வார்ப்புருவின் பெயர்', channel: 'வழி', brief: 'சுருக்கம் (விருப்பம்)', email: 'மின்னஞ்சல்', push: 'செயலி அறிவிப்பு', askCampaign: 'உதவியாளரிடம் வார்த்தைகள் கேள்',
    draftedBy: 'கேட்டவர்', version: 'பதிப்பு', fromRecords: 'உதவியாளர் வரைந்தது — ஆதாரம்', records: 'பதிவு(கள்)', approve: 'இந்த வார்த்தைகளுக்கு ஒப்புதல்', approvedBy: 'ஒப்புதல் அளித்தவர்',
    noDrafts: 'காத்திருக்கும் பிரச்சார வார்த்தைகள் இல்லை.', anomH: 'முரண்பாடு சுருக்கங்கள்',
    anomLede: 'திறந்த விசாரணைகளிலும் விதி மீறல்களிலும் உதவியாளர் காண்பது, முதலில் எதைப் பார்க்கலாம் என்ற பரிந்துரை. அது யாரையும் இடைநீக்கம் செய்யாது, எதையும் திறக்கவோ மூடவோ செய்யாது.',
    askSummary: 'உதவியாளரிடம் சுருக்கம் கேள்', suggested: 'பரிந்துரைக்கப்பட்ட வரிசை', noSummaries: 'இன்னும் சுருக்கங்கள் இல்லை.', askedBy: 'கேட்டவர்',
    drafted: 'உதவியாளர் வார்த்தைகளை வரைந்தார் — வேறொருவர் ஒப்புதல் அளிப்பார்.', summarised: 'உதவியாளர் ஒரு சுருக்கத்தை எழுதினார்.',
    notDrafted: 'உதவியாளர் வரையவில்லை:', stopped: 'உதவியாளர் நிறுத்தப்பட்டுள்ளார் அல்லது செலவு வரம்பு தீர்ந்தது.',
    noPricing: 'உதவியாளரை இயக்க முடியாது: இந்தக் கடைக்கு மாதிரி விலை (model pricing) இன்னும் அமைக்கப்படவில்லை, எனவே தலைமை அலுவலகம் எந்த அழைப்பையும் ஏற்கவில்லை. எதுவும் வரையப்படவில்லை.',
    offUntilR8: 'உதவியாளர்கள் வெளியீடு 8 வரை அணைக்கப்பட்டுள்ளனர் — இது 31 அக்டோபர் 2026 அன்று உரிமையாளர் எடுத்த முடிவு. இந்தப் பக்கத்தில் இப்போது எதையும் உதவியாளர் வரைவதில்லை; இந்த வேலையை நீங்களே செய்யுங்கள்.',
    done: 'முடிந்தது.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotRead: 'உங்கள் பங்கால் இவற்றைப் படிக்க முடியாது.',
    // CR-01 OI-13 (OB-763 B) — A12 மற்றும் A14.
    billsH: 'பொருந்தாத விநியோகஸ்தர் பில்கள்',
    billsLede: 'ஒரு விநியோகஸ்தர் பில் அதன் ஆணையுடனும் பெற்ற பொருட்களுடனும் ஏன் பொருந்தவில்லை என்பது எளிய சொற்களில், விநியோகஸ்தருக்கான கேள்வியின் வரைவுடன். இது நிலையான விதிகளில் இயங்குகிறது (நேரடி AI இல்லை, மாதம் ₹0). அது எதையும் செலுத்தாது, டெபிட் நோட்டு வழங்காது — கணக்காளர் முடிவு செய்வார்.',
    askBills: 'இப்போது பில்களை விளக்கு', noBills: 'விளக்க வேண்டிய விநியோகஸ்தர் பில் எதுவும் இல்லை.',
    tillsH: 'கூடுதல் அல்லது குறைவான கவுண்டர்கள்',
    tillsLede: 'நாள் முடிவில் ஒரு கவுண்டரில் ரொக்கம் கூடுதலாக அல்லது குறைவாக இருந்ததற்கான சாத்தியமான காரணங்கள், அந்தக் கவுண்டரின் பதிவுகளிலிருந்து — நபர்கள் அல்ல, பதிவுகள். இது நிலையான விதிகளில் இயங்குகிறது (நேரடி AI இல்லை, மாதம் ₹0). அது எதையும் தள்ளுபடி செய்யாது, ரொக்கத்தை மாற்றாது — மேலாளர் முடிவு செய்வார்.',
    askTills: 'இப்போது கவுண்டர்களை விளக்கு', noTills: 'காத்திருக்கும் கூடுதல்/குறைவு கவுண்டர் எதுவும் இல்லை.',
    billOf: 'பில்', tillOf: 'கவுண்டர் மூடல்', reasonsH: 'ஏன்', supplierDraft: 'விநியோகஸ்தருக்கான வரைவு (ஆங்கிலத்தில்; ஒருவர் சரிபார்த்து அனுப்புவார்):',
    evidence: 'ஆதாரம்', confidence: { high: 'நம்பகத்தன்மை: உயர்', medium: 'நம்பகத்தன்மை: நடுத்தரம்', low: 'நம்பகத்தன்மை: குறைவு' },
    agree: 'ஒப்புக்கொள்கிறேன் — நான் செயல்படுவேன்', notRight: 'சரியில்லை', notRightWhy: 'ஏன் சரியில்லை?', needWhy: 'முதலில் ஏன் சரியில்லை என்று சொல்லுங்கள்.',
    decided: { approved: 'ஒப்புக்கொண்டவர்', rejected: 'சரியில்லை எனக் குறித்தவர்' }, decidedOk: 'பதிவு செய்யப்பட்டது. எங்கும் எதுவும் மாற்றப்படவில்லை — பில் அல்லது கவுண்டர் ஒப்புதல் வழியாகச் செயல்படுங்கள்.',
    explained: 'உதவியாளர் பதிவுகளைப் பார்த்தார்.', willDo: 'யார் செயல்படுவார்:', cannotDecide: 'உங்கள் பங்கால் இவற்றைப் படிக்கலாம், முடிவு செய்ய முடியாது.',
    agentOff: 'இந்த உதவியாளர் அணைக்கப்பட்டுள்ளார். உரிமையாளர் AI கட்டுப்பாட்டுப் பக்கத்தில் அதை இயக்குவார்; அதுவரை இதைக் கையால் செய்யுங்கள்.',
  },
};

// CR-01 OI-13: each reason the assistant gives, said in Tamil from its code and figures (English uses head office's own
// sentence). A code with no Tamil words here falls back to the English sentence — never to nothing.
const up = (v) => String(v ?? '').toUpperCase();
const REASONS_TA = {
  'A12.bill_not_on_file': (v) => `பில் ${v.invoiceId} தலைமை அலுவலகத்தில் பதிவில் இல்லை, எனவே எதனுடனும் ஒப்பிட முடியவில்லை.`,
  'A12.no_purchase_order': () => 'பில்லில் கொள்முதல் ஆணை குறிப்பிடப்படவில்லை; இந்த விநியோகஸ்தருக்கு எந்த ஆணையும் கிடைக்கவில்லை.',
  'A12.order_unknown': (v) => `பில் குறிப்பிடும் ஆணை ${v.poId} பதிவில் இல்லை.`,
  'A12.order_not_issued': (v) => `பில் ஒப்பிடப்பட்டபோது ஆணை ${v.poId} வழங்கப்படவில்லை, எனவே இப்போது பில்லில் எதையும் செலுத்த முடியாது.`,
  'A12.supplier_differs_from_order': (v) => `இந்தப் பில் ஆணை ${v.poId}-இல் உள்ள விநியோகஸ்தரிடமிருந்து அல்ல, வேறொருவரிடமிருந்து வந்துள்ளது.`,
  'A12.billed_more_than_ordered': (v) => `முந்தைய பில்களுடன் சேர்த்து, இந்தப் பில் ஆணை ${v.poId} கேட்டதை விட அதிகமாகக் கோருகிறது.`,
  'A12.nothing_to_compare': () => 'ஒப்பிட ஆணை, விநியோகம் அல்லது பில் வரி எதுவும் கிடைக்கவில்லை; எனவே இந்தப் பில்லில் இப்போது எதுவும் செலுத்த முடியாது.',
  'A12.billed_more_than_received': (v) => (v.billed === undefined
    ? `${v.productId}: பெற்றதை விட ${v.extra} அதிகமாகப் பில் செய்யப்பட்டுள்ளது.`
    : `${v.productId}: பில்லில் ${v.billed}, நாம் பெற்றது ${v.received} — பெற்றதை விட ${v.extra} அதிகமாகப் பில் செய்யப்பட்டுள்ளது.`),
  'A12.billed_less_than_received': (v) => `${v.productId}: பெற்றதை விட ${v.fewer} குறைவாகப் பில் செய்யப்பட்டுள்ளது — மீதிக்கு விநியோகஸ்தர் இரண்டாவது பில் அனுப்பலாம்.`,
  'A12.price_higher_than_order': (v) => `${v.productId}: பில் விலை ஆணையை விட ஒரு அலகுக்கு ${v.perUnit} அதிகம்.`,
  'A12.price_lower_than_order': (v) => `${v.productId}: பில் விலை ஆணையை விட ஒரு அலகுக்கு ${v.perUnit} குறைவு — குறைந்த விலையே செலுத்தப்படும்.`,
  'A12.within_tolerance': () => 'எல்லா வேறுபாடுகளும் கடையின் பொருத்த வரம்புக்குள் உள்ளன; பில்லைப் பொருந்தியபடி செலுத்தலாம்.',
  'A14.cash_sale_may_be_upi_or_card': (v) => `பில் ${v.ref} ${v.amount}-க்கு ரொக்கமாகப் பதிவானது — பற்றாக்குறைக்குச் சரியாகச் சமம். அது உண்மையில் UPI அல்லது கார்டு மூலம் செலுத்தப்பட்டதா எனச் சரிபார்க்கவும்.`,
  'A14.non_cash_sale_may_be_cash': (v) => `பில் ${v.ref} ${v.amount}-க்கு ${up(v.tender)} ஆகப் பதிவானது — கூடுதல் தொகைக்குச் சரியாகச் சமம். அது உண்மையில் ரொக்கமாகச் செலுத்தப்பட்டதா எனச் சரிபார்க்கவும்.`,
  'A14.non_cash_refund_may_be_cash': (v) => `திருப்பித் தொகை ${v.ref} ${v.amount}-க்கு ${up(v.tender)} மூலம் திருப்பியதாகப் பதிவானது — பற்றாக்குறைக்குச் சரியாகச் சமம். அது உண்மையில் ரொக்கமாகக் கொடுக்கப்பட்டதா எனச் சரிபார்க்கவும்.`,
  'A14.cash_refund_may_be_non_cash': (v) => `திருப்பித் தொகை ${v.ref} ${v.amount}-க்கு ரொக்கமாகக் கொடுத்ததாகப் பதிவானது — கூடுதல் தொகைக்குச் சரியாகச் சமம். அது உண்மையில் UPI அல்லது கார்டு மூலம் திரும்பியதா எனச் சரிபார்க்கவும்.`,
  'A14.round_sum_short': (v) => `பற்றாக்குறை ஒரு முழுத் தொகை ${v.amount}. அந்தத் தொகைக்கு ரொக்க எடுப்பு அல்லது பெட்டக வைப்பு எடுக்கப்பட்டுப் பதிவு செய்யப்படாமல் போனதா எனச் சரிபார்க்கவும் (இந்த கவுண்டரில் ${v.pickups} எடுப்புகள் பதிவாகியுள்ளன).`,
  'A14.round_sum_over': (v) => `கூடுதல் தொகை ஒரு முழுத் தொகை ${v.amount}. அந்தத் தொகை ரொக்கம் (சில்லறை அல்லது தொடக்கத் தொகை சேர்ப்பு) டிராயரில் வைக்கப்பட்டுப் பதிவு செய்யப்படாமல் போனதா எனச் சரிபார்க்கவும்.`,
  'A14.within_tolerance': (v) => `${v.amount} வேறுபாடு இந்த கவுண்டரின் வரம்பு ${v.tolerance}-க்குள் உள்ளது — பெரும்பாலும் சில்லறை தவறாகக் கொடுக்கப்பட்டது. மீண்டும் நடந்தால் மட்டும் மேலும் பாருங்கள்.`,
  'A14.count_not_broken_down': () => 'எண்ணிக்கை மொத்தமாக மட்டுமே பதிவானது. நோட்டு நோட்டாக மீண்டும் எண்ணினால் எந்த நோட்டுகள் அல்லது நாணயங்கள் குறைவு அல்லது கூடுதல் எனத் தெரியும்.',
  'A14.no_cause_found': () => 'இந்த கவுண்டரின் எந்தப் பதிவும் வேறுபாட்டை விளக்கவில்லை. எதையும் முடிவு செய்வதற்கு முன் இரண்டாவது நபருடன் டிராயரை மீண்டும் எண்ணுங்கள்.',
};
const reasonWords = (agent, r) => {
  if (lang !== 'ta') return r.sentence;
  const said = REASONS_TA[`${agent}.${r.code}`];
  return said === undefined ? r.sentence : said(r.values ?? {});
};
// Who acts on each assistant's draft — in the reader's language (the route itself is head office's, shown as is).
const WHO_ACTS = {
  A12: { en: 'the accounts person, on the bill (match it again once corrected, or the supplier\'s debit note). Never automatic.', ta: 'கணக்காளர், பில்லிலேயே (சரிசெய்த பின் மீண்டும் பொருத்துதல், அல்லது விநியோகஸ்தரின் டெபிட் நோட்டு). ஒருபோதும் தானாக அல்ல.' },
  A14: { en: 'the manager, through the over/short sign-off (never the person who counted). A write-off is never automatic.', ta: 'மேலாளர், கூடுதல்/குறைவு ஒப்புதல் வழியாக (எண்ணியவர் ஒருபோதும் அல்ல). தள்ளுபடி ஒருபோதும் தானாக அல்ல.' },
};
let lang = 'en';

// U2 · G10 (UI/UX gap audit): a refusal says what happened, that nothing was changed, and the next safe action — the
// chrome's shared words (apps/web-erp/src/refusal-words.ts), never a raw code or HTTP status. The page's own prefix with
// head office's sentence stands in only until the chrome has loaded.
const refusalLine = (status, err) => {
  const office = window.sreOffice;
  if (office && typeof office.refusalWords === 'function') return office.refusalWords({ status, code: err?.code, whatHappened: err?.whatHappened, nextSafeAction: err?.nextSafeAction });
  const said = `${err?.whatHappened ?? ''} ${err?.nextSafeAction ?? ''}`.trim();
  return said === '' ? t('refused') : `${t('refused')} ${said}`;
};
const t = (k) => WORDS[lang][k] ?? WORDS.en[k] ?? k;
const idem = () => ((crypto.randomUUID && crypto.randomUUID()) || `act-${Date.now()}-${Math.random()}`);

let templates = null;
let summaries = null;

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}
async function post(path, body) {
  try {
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': idem() }, body: JSON.stringify(body ?? {}) });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}
// Round B: head office names WHY the assistant did not run (`error.code`). No model pricing set for this shop is said as
// that — not as "switched off or out of budget", which sent the reader to the wrong switch.
// OB-561: the plain reason first — the assistants are off until Release 8 — then head office's technical one.
const notRunWords = (out) => `${t('offUntilR8')} ${out.body?.error?.code === 'no_pricing' ? t('noPricing') : t('stopped')}`;
function say(el, out, good) {
  el.className = `status ${out.ok ? 'good' : 'err'}`;
  if (out.ok && out.body?.drafted === false) { el.className = 'status err'; el.textContent = `${t('notDrafted')} ${out.body.detail ?? ''}`; return; }
  el.textContent = out.ok ? (good ?? t('done'))
    : out.status === 0 ? t('unreachable') : out.status === 503 || out.status === 429 ? notRunWords(out) : refusalLine(out.status, out.body?.error);
}

function paintWords() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['off-r8', 'offUntilR8'], ['camp-h', 'campH'], ['camp-lede', 'campLede'], ['l-tpl-id', 'tplId'], ['l-tpl-channel', 'channel'], ['l-tpl-brief', 'brief'], ['o-email', 'email'], ['o-push', 'push'], ['ask-campaign', 'askCampaign'], ['anom-h', 'anomH'], ['anom-lede', 'anomLede'], ['ask-summary', 'askSummary'],
    ['bills-h', 'billsH'], ['bills-lede', 'billsLede'], ['ask-bills', 'askBills'], ['tills-h', 'tillsH'], ['tills-lede', 'tillsLede'], ['ask-tills', 'askTills']]) {
    const el = $(id);
    if (el) el.textContent = t(k);
  }
  $('ask-campaign').disabled = !mayDraftWords; whyDisabled($('ask-campaign'), mayDraftWords ? '' : 'role');
  $('ask-summary').disabled = !mayAskSummary; whyDisabled($('ask-summary'), mayAskSummary ? '' : 'role');
  for (const id of ['ask-bills', 'ask-tills']) { $(id).disabled = !mayRunAgents; whyDisabled($(id), mayRunAgents ? '' : 'role'); }
  const nobody = $('nobody');
  nobody.hidden = who !== null;
  nobody.textContent = t('nobody');
}

function renderTemplates() {
  const list = $('camp-list');
  list.replaceChildren();
  if (templates === null) return;
  const mine = templates.filter((v) => v.aiDraft !== undefined).sort((a, b) => (a.state === 'draft' ? 0 : 1) - (b.state === 'draft' ? 0 : 1) || a.templateId.localeCompare(b.templateId));
  if (mine.length === 0) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = t('noDrafts'); list.append(p); return; }
  for (const v of mine) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.template = `${v.templateId}@${v.version}`;
    const meta = document.createElement('p');
    meta.className = 'muted';
    meta.textContent = `${v.templateId} ${t('version')} ${v.version} · ${v.channel} · ${t('draftedBy')} ${v.draftedBy} · ${t('fromRecords')} ${v.aiDraft.citedEvidenceIds.length} ${t('records')}`;
    const q = document.createElement('blockquote');
    q.textContent = v.body;
    card.append(meta, q);
    if (v.state === 'draft') {
      const b = document.createElement('button'); b.classList.add('sre-btn');
      b.type = 'button'; b.textContent = t('approve'); b.disabled = !mayDraftWords; whyDisabled(b, mayDraftWords ? '' : 'role');
      b.addEventListener('click', async () => {
        const out = await post(`/v1/notifications/templates/${encodeURIComponent(v.templateId)}/approval`, { version: v.version });
        say($('camp-status'), out);
        await load();
      });
      card.append(b);
    } else {
      const p = document.createElement('p'); p.className = 'status good'; p.textContent = `${t('approvedBy')} ${v.approvedBy ?? ''}`;
      card.append(p);
    }
    list.append(card);
  }
}

function renderSummaries() {
  const list = $('anom-list');
  list.replaceChildren();
  if (!mayReadSummaries) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = t('cannotRead'); list.append(p); return; }
  if (summaries === null) return;
  if (summaries.length === 0) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = t('noSummaries'); list.append(p); return; }
  for (const s of summaries) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.summary = s.summaryId;
    const meta = document.createElement('p');
    meta.className = 'muted';
    meta.textContent = `${s.summaryId} · ${shopWhen(s.at)} · ${t('askedBy')} ${s.requestedBy} · ${t('fromRecords')} ${s.citedEvidenceIds.length} ${t('records')}`;
    const q = document.createElement('blockquote');
    q.textContent = s.text;
    card.append(meta, q);
    if (s.suggestedOrder.length > 0) { const p = document.createElement('p'); p.textContent = `${t('suggested')}: ${s.suggestedOrder.join(' → ')}`; card.append(p); }
    list.append(card);
  }
}

// CR-01 OI-13: the A12 / A14 drafts on the register, newest first; each says why, from what, and who acts — and offers the
// person "agree" or "not right" (a decision on record that commits nothing).
let proposals = null;
const subjectOf = (p) => (p.agent === 'A12' ? (/^a12-bill:(.+):\d+$/.exec(p.proposalId)?.[1] ?? p.proposalId) : (/^a14-till:(.+)$/.exec(p.proposalId)?.[1] ?? p.proposalId));
function renderExplained(agent, listId, noneKey) {
  const list = $(listId);
  list.replaceChildren();
  if (!mayReadDrafts) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = t('cannotRead'); list.append(p); return; }
  if (proposals === null) return;
  const mine = proposals.filter((p) => p.agent === agent).sort((a, b) => Number(a.outcome !== null) - Number(b.outcome !== null) || String(b.createdAt).localeCompare(String(a.createdAt)));
  if (mine.length === 0) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = t(noneKey); list.append(p); return; }
  for (const p of mine) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.proposal = p.proposalId;
    const head = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = `${agent === 'A12' ? t('billOf') : t('tillOf')} ${subjectOf(p)}`;
    head.append(strong);
    const meta = document.createElement('p');
    meta.className = 'muted';
    const band = p.confidence?.band ?? 'medium';
    meta.textContent = `${shopWhen(p.createdAt)} · ${t('evidence')} ${(p.evidence ?? []).length} ${t('records')} · ${(t('confidence') ?? {})[band] ?? band}`;
    card.append(head);
    if (lang === 'en') { const sum = document.createElement('p'); sum.textContent = p.summary; card.append(sum); }
    const ul = document.createElement('ul');
    ul.setAttribute('aria-label', t('reasonsH'));
    for (const r of p.reasons ?? []) { const li = document.createElement('li'); li.dataset.reason = r.code; li.textContent = reasonWords(agent, r); ul.append(li); }
    card.append(ul);
    if (typeof p.draftText === 'string' && p.draftText !== '') {
      const label = document.createElement('p'); label.className = 'muted'; label.textContent = t('supplierDraft');
      const q = document.createElement('blockquote'); q.textContent = p.draftText;
      card.append(label, q);
    }
    const acts = document.createElement('p'); acts.className = 'muted'; acts.textContent = `${t('willDo')} ${WHO_ACTS[agent]?.[lang] ?? WHO_ACTS[agent]?.en ?? ''}`;
    card.append(meta, acts);
    if (p.outcome !== null && p.outcome !== undefined) {
      const done = document.createElement('p'); done.className = 'status good';
      done.textContent = `${(t('decided') ?? {})[p.outcome.decision] ?? p.outcome.decision} ${p.outcome.by}${p.outcome.reason ? ` — ${p.outcome.reason}` : ''}`;
      card.append(done);
    } else if (!mayDecide) {
      const no = document.createElement('p'); no.className = 'muted'; no.textContent = t('cannotDecide'); card.append(no);
    } else {
      const status = document.createElement('p'); status.className = 'status'; status.setAttribute('role', 'status');
      const why = document.createElement('input'); why.placeholder = t('notRightWhy'); why.setAttribute('aria-label', t('notRightWhy')); why.autocomplete = 'off';
      const yes = document.createElement('button'); yes.type = 'button'; yes.classList.add('sre-btn', 'sre-btn-primary'); yes.textContent = t('agree'); yes.dataset.decide = 'approved';
      const no = document.createElement('button'); no.type = 'button'; no.classList.add('sre-btn'); no.textContent = t('notRight'); no.dataset.decide = 'rejected';
      const decide = async (decision) => {
        const reason = why.value.trim();
        if (decision === 'rejected' && reason === '') { status.className = 'status err'; status.textContent = t('needWhy'); return; }
        const out = await post(`/v1/ai/proposals/${encodeURIComponent(p.proposalId)}/outcome`, { decision, ...(reason === '' ? {} : { reason }) });
        say(status, out, t('decidedOk'));
        if (out.ok) await load();
      };
      yes.addEventListener('click', () => { void decide('approved'); });
      no.addEventListener('click', () => { void decide('rejected'); });
      const row = document.createElement('div'); row.className = 'row'; row.append(yes, why, no);
      card.append(row, status);
    }
    list.append(card);
  }
}

async function load() {
  if (mayReadDrafts) {
    try { proposals = (await getJson('/v1/ai/proposals')).proposals.filter((p) => p.agent === 'A12' || p.agent === 'A14'); } catch { proposals = null; }
  }
  renderExplained('A12', 'bills-list', 'noBills');
  renderExplained('A14', 'tills-list', 'noTills');
  try { templates = (await getJson('/v1/notifications/templates')).templates; } catch { templates = null; }
  if (mayReadSummaries) {
    try { summaries = (await getJson('/v1/ai/security/anomaly-summaries')).summaries; } catch { summaries = null; }
  }
  renderTemplates();
  renderSummaries();
}

$('ask-campaign').addEventListener('click', async () => {
  const templateId = $('tpl-id').value.trim();
  const brief = $('tpl-brief').value.trim();
  const out = await post(`/v1/ai/marketing/campaign-drafts/${encodeURIComponent(templateId)}`, { purpose: 'marketing', channel: $('tpl-channel').value, ...(brief === '' ? {} : { brief }) });
  say($('camp-status'), out, t('drafted'));
  await load();
});

$('ask-summary').addEventListener('click', async () => {
  const out = await post('/v1/ai/security/anomaly-summaries', { summaryId: `s-${Date.now().toString(36)}` });
  say($('anom-status'), out, t('summarised'));
  await load();
});

// CR-01 OI-13: ask A12 / A14 to look at the records now. Refused while the assistant is switched off (it starts OFF) or
// the AI is stopped — said in plain words; nothing is changed either way.
for (const [button, agent, statusId] of [['ask-bills', 'A12', 'bills-status'], ['ask-tills', 'A14', 'tills-status']]) {
  $(button).addEventListener('click', async () => {
    const out = await post(`/v1/ai/agents/${agent}/runs`, {});
    const el = $(statusId);
    if (!out.ok && (out.status === 503 || out.status === 429)) { el.className = 'status err'; el.textContent = `${t('agentOff')} ${out.body?.error?.whatHappened ?? ''}`.trim(); return; }
    say(el, out, t('explained'));
    await load();
  });
}

$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintWords();
  renderTemplates();
  renderSummaries();
  renderExplained('A12', 'bills-list', 'noBills');
  renderExplained('A14', 'tills-list', 'noTills');
});

paintWords();
if (who !== null) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}

/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not), 'offline' (head office cannot
 *  be reached), a page's own { en, ta } pair or sentence; '' takes the words away. */
function whyWords() {
  return {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
  offline: { en: 'Head office cannot be reached, so this cannot be done now.', ta: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இப்போது இதைச் செய்ய முடியாது.' },
  };
}
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (whyWords()[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
