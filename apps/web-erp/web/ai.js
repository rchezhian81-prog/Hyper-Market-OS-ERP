// AI control — the view layer (OB-288 lane 4 · P1 · roadmap §27 "AI control" · AI-NFR-01…12 · hard rule 5).
//
// ── What changed ─────────────────────────────────────────────────────────────
//
// This screen used to bind a session built from `window.aiData`, which nothing supplied: it always said "Sample data",
// and pulling its kill switch changed a list in the tab and reached no server. Now every figure is head office's LIVE
// read (`GET /v1/ai/control`, in the person's own session), shaped by the tested view model (`window.aiControl`,
// apps/web-erp/src/ai-control.ts), and every act — stop, start again, decide, run the checks, an incident — is SENT to
// head office, which runs the same rules again and decides. When head office cannot be reached the screen says so and
// shows nothing as current: never a sample, never a remembered figure (P-08).
//
// ── The decisions the screen is built around ─────────────────────────────────
//
// **The kill switch is the first tab.** Somebody who opens this screen in a hurry has come to stop something, and
// beside every assistant is what the shop does without it, so pulling it is a calm decision.
// **Nothing here commits.** A draft's "approve" records a person's decision; the act itself is the ordinary route the
// draft names, with its own permissions and approvals (P-05, hard rule 5).
// **What no assistant may ever do is shown as a list.** A rule nobody can see is a rule nobody trusts.
//
// No `prompt`, `confirm` or `alert`; the banner does not fade.

// OB-606: a moment is shown on the SHOP's date (its zone, as the store computer told the page) — never this device's own date.
// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? '';
const shopDayOf = (value) => window.sreShopDay?.dateOf(value) ?? '';
const el = (id) => document.getElementById(id);

const money = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    title: 'AI control',
    switch: 'Stop the AI', agents: 'The assistants', queue: 'Waiting for you', cost: 'What it costs', models: 'Models and checks', incidents: 'Incidents',
    switchLead: 'Stopping an assistant takes effect immediately. It needs your name and a reason so it can be reviewed afterwards, but it never waits for anybody’s approval. Beside each one is what the shop does without it.',
    agentsLead: 'What each assistant may do, who decides after it, and whether it is running. Stopped ones are listed first.',
    queueLead: 'Things an assistant has drafted. Nothing here has happened. Approving one records your decision; the act itself goes through its own screen, with its own checks.',
    costLead: 'What the assistants have cost this month, each against its own limit, all of them against the shop’s AI limit, inside the ₹15,000 monthly limit for the whole system.',
    modelsLead: 'Which model may be used, if any, and how each assistant did on its accuracy and safety checks. A model is used only after it passed every check, and only through the one governed door.',
    incidentsLead: 'Times an assistant reached for something it is not allowed, failed a safety check, or somebody saw it say something wrong. Each one needs a named person to look into it and close it with a reason.',
    pullTitle: 'Stop something now', scopeLabel: 'What do you want to stop',
    scopeAll: 'Every assistant', scopeFacing: 'Only the ones customers talk to', scopeSingle: 'One assistant',
    whichLabel: 'Which one', pullReasonLabel: 'Why are you stopping it',
    pull: 'Stop it now',
    stopOneTitle: 'Or stop just one assistant — write why above, then press its button',
    stopThis: 'Stop',
    pullNote: 'The shop carries on trading. Nothing on the till, the stock or the money depends on this.',
    lift: 'Start it again', liftReason: 'Why is it safe to start again', lifted: 'Started again', stopped: 'STOPPED', running: 'running', notEnabled: 'not switched on',
    masterOn: 'The shop-wide AI switch is ON: every assistant is stopped (the owner’s decision OB-296 — the assistants stay rule-based for now).',
    nothingStopped: 'Nothing is stopped. Every switched-on assistant is running.',
    stoppedBy: 'stopped by', pulledAt: 'at', instead: 'Without it',
    forbiddenTitle: 'What no assistant may ever do',
    forbiddenNote: 'No setting, no licence and no request can grant any of these to any assistant. This is not a preference — it is built in.',
    mayUse: 'may use', decidedBy: 'decided by', nobodyDecides: 'it decides nothing — it only answers',
    readOnly: 'reads and drafts only', customerFacing: 'talks to customers',
    noCeiling: 'No limit of its own is set: only the shop’s AI limit applies to it.',
    noRate: 'No hourly limit on requests is set.', perHour: 'requests an hour at most',
    noEvaluation: 'This assistant has NEVER been checked for accuracy.', noCases: 'There are no checks written for this assistant.',
    checked: 'checked', passed: 'passed', unsafe: 'UNSAFE', incomplete: 'proves nothing — the checks never reached a model',
    spent: 'spent', ceiling: 'limit', left: 'left',
    noQueue: 'Nothing is waiting for you.',
    evidence: 'what it rests on', toAct: 'To act on it', approve: 'Approve', reject: 'Reject', rejectReason: 'Why reject it',
    approvedBy: 'approved by', rejectedBy: 'rejected by', drafted: 'drafted by',
    bandHigh: 'Sure', bandMedium: 'Likely', bandLow: 'Unsure', cannotKnow: 'What it cannot know',
    noCap: 'No AI limit is set for the shop, so nothing that costs money can run (the owner’s decision OB-296: no AI cost).',
    totalSpent: 'spent this month', ofCap: 'of the shop’s AI limit', platform: 'whole-system monthly limit',
    providerTitle: 'Model provider', noModels: 'No model is approved, so no model can be used at all.',
    approvedOn: 'approved', withdrawn: 'WITHDRAWN', residency: 'data kept in', india: 'India', outside: 'outside India',
    runChecks: 'Run the checks', checksRan: 'The checks ran.', freeTextOff: 'Free-text questions and answers are OFF (OB-296).', freeTextOn: 'Free-text questions and answers are ON.',
    noCalls: 'Nothing has been asked of a model.', piiRemoved: 'personal details removed before it was asked', blocked: 'reached for, and was refused',
    chainOk: 'The record of every request is intact.', chainBroken: 'The record of requests has been ALTERED — tell the owner.',
    noIncidents: 'No incidents.', open: 'open', owned: 'being looked into by', closed: 'closed',
    takeIt: 'I will look into it', closeIt: 'Close it', closeReason: 'What was found, and what was done',
    raiseTitle: 'Report something an assistant did', raiseAgent: 'Which assistant', raiseSummary: 'What happened', raise: 'Report it', anyAgent: 'Not sure which',
    raised: 'Reported. A named person must now look into it.', ownedOk: 'You are looking into it.', closedOk: 'Closed, with your reason.',
    noAgents: 'Head office has not told this screen about any assistant.',
    ok: 'OK', read: 'Please read this', done: 'Done', refused: 'Head office said no —',
    nobodyNamed: 'This screen has not been told who is using it. Nothing can be stopped, started or decided — each carries the name of whoever did it.',
    cannotRead: 'Your role cannot read the AI control screen.',
    unreachable: 'Head office cannot be reached — nothing on this screen is current, and nothing can be stopped from here until it can.',
    asAt: 'as at',
    actionsTitle: 'What needs you today — from the owner’s assistant (A01)', actionsNone: 'Nothing needs you from the assistants today.',
    actionsOff: 'The owner’s assistant (A01) is not running, so it has no list for you. The figures are on the dashboard as always.',
  },
  ta: {
    title: 'AI கட்டுப்பாடு',
    switch: 'AI-ஐ நிறுத்து', agents: 'உதவியாளர்கள்', queue: 'உங்களுக்காகக் காத்திருப்பவை', cost: 'செலவு எவ்வளவு', models: 'மாதிரிகளும் சோதனைகளும்', incidents: 'நிகழ்வுகள்',
    switchLead: 'ஒரு உதவியாளரை நிறுத்தினால் உடனே நிற்கும். உங்கள் பெயரும் காரணமும் தேவை, ஆனால் யாருடைய அனுமதிக்கும் காத்திருக்காது. ஒவ்வொன்றின் அருகிலும், அது இல்லாமல் கடை என்ன செய்யும் என்பது எழுதப்பட்டுள்ளது.',
    agentsLead: 'ஒவ்வொரு உதவியாளரும் என்ன செய்யலாம், அதற்குப் பிறகு யார் முடிவு செய்கிறார், அது இயங்குகிறதா. நிறுத்தப்பட்டவை முதலில் காட்டப்படும்.',
    queueLead: 'உதவியாளர் தயாரித்தவை. இங்கே எதுவும் நடக்கவில்லை. ஒப்புதல் உங்கள் முடிவைப் பதிவு செய்யும்; அந்தச் செயல் அதன் சொந்தத் திரையில், அதன் சொந்தச் சரிபார்ப்புகளுடன் நடக்கும்.',
    costLead: 'இந்த மாதம் உதவியாளர்கள் எவ்வளவு செலவழித்தன — ஒவ்வொன்றும் அதன் சொந்த வரம்பிற்கு எதிராக, எல்லாமும் கடையின் AI வரம்பிற்கு எதிராக, முழு அமைப்புக்கான மாதம் ₹15,000 வரம்புக்குள்.',
    modelsLead: 'எந்த மாதிரியைப் பயன்படுத்தலாம், ஏதாவது இருந்தால், ஒவ்வொரு உதவியாளரும் துல்லியம் மற்றும் பாதுகாப்புச் சோதனைகளில் எப்படிச் செய்தது. எல்லாச் சோதனைகளிலும் தேறிய பின்னரே, ஒரே கட்டுப்படுத்தப்பட்ட வழியில் மட்டுமே மாதிரி பயன்படுத்தப்படும்.',
    incidentsLead: 'ஒரு உதவியாளர் அனுமதியில்லாத ஒன்றைக் கேட்ட, பாதுகாப்புச் சோதனையில் தோற்ற, அல்லது தவறாகச் சொன்னதை யாராவது கண்ட நேரங்கள். ஒவ்வொன்றையும் பெயரிடப்பட்ட ஒருவர் ஆராய்ந்து காரணத்துடன் மூட வேண்டும்.',
    pullTitle: 'இப்போதே நிறுத்து', scopeLabel: 'எதை நிறுத்த வேண்டும்',
    scopeAll: 'எல்லா உதவியாளர்களும்', scopeFacing: 'வாடிக்கையாளருடன் பேசுபவை மட்டும்', scopeSingle: 'ஒரு உதவியாளர்',
    whichLabel: 'எது', pullReasonLabel: 'ஏன் நிறுத்துகிறீர்கள்',
    pull: 'இப்போதே நிறுத்து',
    stopOneTitle: 'அல்லது ஒரு உதவியாளரை மட்டும் நிறுத்துங்கள் — மேலே காரணம் எழுதி, அதன் பொத்தானை அழுத்துங்கள்',
    stopThis: 'நிறுத்து',
    pullNote: 'கடை வழக்கம்போல் நடக்கும். பில்லிங், இருப்பு, பணம் எதுவும் இதைச் சார்ந்தது அல்ல.',
    lift: 'மீண்டும் தொடங்கு', liftReason: 'மீண்டும் தொடங்குவது ஏன் பாதுகாப்பானது', lifted: 'மீண்டும் தொடங்கியது', stopped: 'நிறுத்தப்பட்டது', running: 'இயங்குகிறது', notEnabled: 'இயக்கப்படவில்லை',
    masterOn: 'கடை முழுவதற்குமான AI சுவிட்ச் ON: எல்லா உதவியாளர்களும் நிறுத்தப்பட்டுள்ளன (உரிமையாளரின் முடிவு OB-296 — இப்போதைக்கு உதவியாளர்கள் விதிகளின் அடிப்படையில் மட்டுமே).',
    nothingStopped: 'எதுவும் நிறுத்தப்படவில்லை. இயக்கப்பட்ட எல்லா உதவியாளர்களும் இயங்குகின்றன.',
    stoppedBy: 'நிறுத்தியவர்', pulledAt: 'நேரம்', instead: 'அது இல்லாமல்',
    forbiddenTitle: 'எந்த உதவியாளரும் ஒருபோதும் செய்யக்கூடாதவை',
    forbiddenNote: 'எந்த அமைப்பும், எந்த உரிமமும், எந்தக் கோரிக்கையும் இவற்றை எந்த உதவியாளருக்கும் வழங்க முடியாது. இது ஒரு விருப்பம் அல்ல — உள்ளேயே கட்டப்பட்டது.',
    mayUse: 'பயன்படுத்தலாம்', decidedBy: 'முடிவு செய்பவர்', nobodyDecides: 'இது எதையும் முடிவு செய்யாது — பதில் மட்டுமே சொல்லும்',
    readOnly: 'படிக்கவும் வரையவும் மட்டுமே', customerFacing: 'வாடிக்கையாளருடன் பேசும்',
    noCeiling: 'இதற்குச் சொந்த வரம்பு இல்லை: கடையின் AI வரம்பு மட்டுமே பொருந்தும்.',
    noRate: 'மணிநேரக் கோரிக்கை வரம்பு அமைக்கப்படவில்லை.', perHour: 'மணிக்கு அதிகபட்சக் கோரிக்கைகள்',
    noEvaluation: 'இந்த உதவியாளரின் துல்லியம் ஒருபோதும் சரிபார்க்கப்படவில்லை.', noCases: 'இந்த உதவியாளருக்குச் சோதனைகள் எழுதப்படவில்லை.',
    checked: 'சரிபார்க்கப்பட்டது', passed: 'தேர்ச்சி', unsafe: 'பாதுகாப்பற்றது', incomplete: 'எதையும் நிரூபிக்கவில்லை — சோதனைகள் மாதிரியை அடையவில்லை',
    spent: 'செலவு', ceiling: 'வரம்பு', left: 'மீதம்',
    noQueue: 'உங்களுக்காக எதுவும் காத்திருக்கவில்லை.',
    evidence: 'எதை அடிப்படையாகக் கொண்டது', toAct: 'செயல்பட', approve: 'ஒப்புதல்', reject: 'நிராகரி', rejectReason: 'ஏன் நிராகரிக்கிறீர்கள்',
    approvedBy: 'ஒப்புதல் அளித்தவர்', rejectedBy: 'நிராகரித்தவர்', drafted: 'தயாரித்தது',
    bandHigh: 'உறுதி', bandMedium: 'வாய்ப்புள்ளது', bandLow: 'உறுதியில்லை', cannotKnow: 'இது அறிய முடியாதது',
    noCap: 'கடைக்கு AI வரம்பு அமைக்கப்படவில்லை, எனவே பணம் செலவாகும் எதுவும் இயங்க முடியாது (உரிமையாளரின் முடிவு OB-296: AI செலவு இல்லை).',
    totalSpent: 'இந்த மாதம் செலவு', ofCap: 'கடையின் AI வரம்பில்', platform: 'முழு அமைப்பின் மாதாந்திர வரம்பு',
    providerTitle: 'மாதிரி வழங்குநர்', noModels: 'எந்த மாதிரிக்கும் ஒப்புதல் இல்லை, எனவே எந்த மாதிரியையும் பயன்படுத்த முடியாது.',
    approvedOn: 'ஒப்புதல்', withdrawn: 'திரும்பப் பெறப்பட்டது', residency: 'தரவு வைக்கப்படும் இடம்', india: 'இந்தியா', outside: 'இந்தியாவுக்கு வெளியே',
    runChecks: 'சோதனைகளை இயக்கு', checksRan: 'சோதனைகள் இயங்கின.', freeTextOff: 'தானாக எழுதும் கேள்வி-பதில் OFF (OB-296).', freeTextOn: 'தானாக எழுதும் கேள்வி-பதில் ON.',
    noCalls: 'மாதிரியிடம் எதுவும் கேட்கப்படவில்லை.', piiRemoved: 'கேட்பதற்கு முன் நீக்கப்பட்ட தனிப்பட்ட விவரங்கள்', blocked: 'கேட்டது, மறுக்கப்பட்டது',
    chainOk: 'ஒவ்வொரு கோரிக்கையின் பதிவும் மாறாமல் உள்ளது.', chainBroken: 'கோரிக்கைகளின் பதிவு மாற்றப்பட்டுள்ளது — உரிமையாளரிடம் சொல்லுங்கள்.',
    noIncidents: 'நிகழ்வுகள் இல்லை.', open: 'திறந்தது', owned: 'ஆராய்பவர்', closed: 'மூடப்பட்டது',
    takeIt: 'நான் ஆராய்கிறேன்', closeIt: 'மூடு', closeReason: 'என்ன கண்டறியப்பட்டது, என்ன செய்யப்பட்டது',
    raiseTitle: 'ஒரு உதவியாளர் செய்ததைத் தெரிவி', raiseAgent: 'எந்த உதவியாளர்', raiseSummary: 'என்ன நடந்தது', raise: 'தெரிவி', anyAgent: 'எது என்று தெரியவில்லை',
    raised: 'தெரிவிக்கப்பட்டது. பெயரிடப்பட்ட ஒருவர் இப்போது ஆராய வேண்டும்.', ownedOk: 'நீங்கள் ஆராய்கிறீர்கள்.', closedOk: 'உங்கள் காரணத்துடன் மூடப்பட்டது.',
    noAgents: 'தலைமை அலுவலகம் இந்தத் திரைக்கு எந்த உதவியாளர் பற்றியும் சொல்லவில்லை.',
    ok: 'சரி', read: 'இதைப் படிக்கவும்', done: 'முடிந்தது', refused: 'தலைமை அலுவலகம் மறுத்தது —',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று சொல்லப்படவில்லை. எதையும் நிறுத்தவோ தொடங்கவோ முடிவு செய்யவோ முடியாது — ஒவ்வொன்றும் செய்தவரின் பெயரைச் சுமக்கும்.',
    cannotRead: 'உங்கள் பங்கால் AI கட்டுப்பாட்டுத் திரையைப் படிக்க முடியாது.',
    unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — இந்தத் திரையில் எதுவும் தற்போதையது அல்ல, அது கிடைக்கும் வரை இங்கிருந்து எதையும் நிறுத்த முடியாது.',
    asAt: 'நிலவரம்',
    actionsTitle: 'இன்று உங்களுக்குத் தேவையானவை — உரிமையாளரின் உதவியாளரிடமிருந்து (A01)', actionsNone: 'இன்று உதவியாளர்களிடமிருந்து உங்களுக்கு எதுவும் இல்லை.',
    actionsOff: 'உரிமையாளரின் உதவியாளர் (A01) இயங்கவில்லை, எனவே உங்களுக்குப் பட்டியல் இல்லை. எண்ணிக்கைகள் எப்போதும் போல் டாஷ்போர்டில் உள்ளன.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** Why the page itself did not send an act — one entry per `ACT_REFUSAL_KINDS`, both languages. */
const ACT_REFUSAL_WORDS = {
  nobody_is_named_at_this_desk: {
    en: 'This screen has not been told who is using it. Nothing was sent.',
    ta: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று சொல்லப்படவில்லை. எதுவும் அனுப்பப்படவில்லை.',
  },
  reason_needed: {
    en: 'Please write the reason first — it is what makes the decision reviewable. Nothing was sent.',
    ta: 'முதலில் காரணத்தை எழுதுங்கள் — அதுவே முடிவை மறுபார்வைக்கு உட்படுத்துகிறது. எதுவும் அனுப்பப்படவில்லை.',
  },
  which_agent: {
    en: 'Choose which assistant to stop. Nothing was sent.',
    ta: 'எந்த உதவியாளரை நிறுத்த வேண்டும் என்று தேர்வு செய்யுங்கள். எதுவும் அனுப்பப்படவில்லை.',
  },
  same_person: {
    en: 'You stopped it, so a different person decides it may start again. Nothing was sent.',
    ta: 'நீங்கள் நிறுத்தினீர்கள், எனவே மீண்டும் தொடங்கலாமா என்பதை வேறொருவர் முடிவு செய்வார். எதுவும் அனுப்பப்படவில்லை.',
  },
  not_yours: {
    en: 'This has already been decided. Nothing was sent.',
    ta: 'இது ஏற்கனவே முடிவு செய்யப்பட்டது. எதுவும் அனுப்பப்படவில்லை.',
  },
};

/** How sure a suggestion is — one entry per confidence band, both languages (AI-NFR-04). */
const BAND_WORDS = {
  high: { en: 'Sure — a fact on record', ta: 'உறுதி — பதிவில் உள்ள உண்மை' },
  medium: { en: 'Likely — check the evidence', ta: 'வாய்ப்புள்ளது — ஆதாரத்தைச் சரிபாருங்கள்' },
  low: { en: 'Unsure — nothing checked behind it', ta: 'உறுதியில்லை — பின்னால் சரிபார்த்தது எதுவும் இல்லை' },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

// ── Head office ─────────────────────────────────────────────────────────────

const kit = window.aiControl;
const viewer = window.aiViewer ?? { userId: window.aiData?.userId ?? null, permissions: null };
const idem = () => ((crypto.randomUUID && crypto.randomUUID()) || `act-${Date.now()}-${Math.random()}`);
let view = null;
let actions = null; // A01's action list, or null when it could not be read
let readState = 'loading'; // loading | ok | unreachable | forbidden

async function load() {
  try {
    const res = await fetch('/v1/ai/control', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (res.status === 401 || res.status === 403) { readState = 'forbidden'; view = null; return; }
    if (!res.ok || kit === undefined) { readState = 'unreachable'; view = null; return; }
    view = kit.view(await res.json(), viewer);
    readState = 'ok';
    // A01's deterministic action list — a second read; when it cannot be had, the box says nothing rather than a guess.
    try {
      const a = await fetch('/v1/ai/owner/action-list', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      actions = a.ok ? await a.json() : null;
    } catch {
      actions = null;
    }
  } catch {
    readState = 'unreachable';
    view = null;
  }
}

async function send(check) {
  try {
    const res = await fetch(check.path, {
      method: check.method, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': idem() },
      body: JSON.stringify(check.body),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** Check an act with the view model, send it, say what head office answered, and re-read. */
async function act(check, good) {
  if (!check.ok) { tell(t('read'), words(ACT_REFUSAL_WORDS, check.refusal)); return false; }
  const out = await send(check);
  if (!out.ok) {
    tell(t('read'), out.status === 0 ? t('unreachable') : `${t('refused')} ${out.body?.error?.whatHappened ?? out.status}`);
    return false;
  }
  tell(t('done'), good(out.body), true);
  await refresh();
  return true;
}

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

const VIEWS = ['switch', 'agents', 'queue', 'cost', 'models', 'incidents'];
const TAB_ICONS = { switch: 'pause-circle', agents: 'sparkles', queue: 'list-checks', cost: 'indian-rupee', models: 'badge-check', incidents: 'shield-alert' };

function show(name) {
  for (const v of VIEWS) el(`view-${v}`).hidden = v !== name;
  for (const v of VIEWS) el(`tab-${v}`).setAttribute('aria-current', v === name ? 'page' : 'false');
}
for (const name of VIEWS) el(`tab-${name}`).addEventListener('click', () => { show(name); });

/** A button's word with its icon beside it (OB-201: never an icon alone). */
function label(button, icon, word) {
  button.setAttribute('aria-label', word);
  if (window.sreIcon && typeof window.sreIcon.withWord === 'function') button.replaceChildren(window.sreIcon.withWord(icon, word));
  else button.textContent = word;
}

function emptyLine(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}
function line(text) {
  const small = document.createElement('small');
  small.textContent = text;
  return small;
}
function chip(text, cls = '') {
  const c = document.createElement('span');
  c.className = `chip ${cls}`.trim();
  c.textContent = text;
  return c;
}
function field(tag = 'textarea') {
  const f = document.createElement(tag);
  return f;
}
function button(word, icon, cls, onClick, enabled = true) {
  const b = document.createElement('button');
  b.type = 'button';
  if (cls) b.className = cls;
  label(b, icon, word);
  b.disabled = !enabled;
  b.addEventListener('click', onClick);
  return b;
}

// ── Stop the AI ─────────────────────────────────────────────────────────────

function renderSwitch() {
  const box = el('kill-state');
  box.replaceChildren();
  if (view === null) { box.append(emptyLine(readState === 'forbidden' ? t('cannotRead') : t('unreachable'))); el('kill-list').replaceChildren(); return; }
  const headline = document.createElement('span');
  headline.className = 'big';
  headline.textContent = view.kill.masterOn ? t('masterOn') : view.kill.active.length === 0 ? t('nothingStopped') : `${view.kill.active.length} ${t('stopped')}`;
  box.append(headline, line(`${t('asAt')} ${shopWhen(view.asAt)}`));

  // Every active scoped switch, with what the shop does without what it stopped, and the way back.
  el('kill-list').replaceChildren(...view.kill.active.map((sw) => {
    const row = document.createElement('div');
    row.className = 'row stopped';
    row.dataset.switch = sw.switchId;
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = sw.reason;
    what.append(name, line(`${sw.scope === 'single_agent' ? sw.agentId : sw.scope === 'all_ai' ? t('scopeAll') : t('scopeFacing')} · ${t('stoppedBy')} ${sw.activatedBy} · ${t('pulledAt')} ${shopWhen(sw.activatedAt)}`));
    for (const agent of view.agents.filter((a) => a.stopped && a.stoppedBecause === 'kill_switch')) what.append(line(`${t('instead')}: ${kit.withoutIt(agent)}`));
    const acts = document.createElement('span');
    acts.className = 'acts';
    const reason = field();
    reason.setAttribute('aria-label', t('liftReason'));
    reason.placeholder = t('liftReason');
    acts.append(reason, button(t('lift'), 'refresh-cw', '', () => {
      void act(kit.lift(viewer, sw, reason.value), (b) => b?.detail ?? t('lifted'));
    }, view.may.stop));
    row.append(what, acts);
    return row;
  }));

  const which = el('which');
  which.replaceChildren(...view.agents.map((agent) => {
    const option = document.createElement('option');
    option.value = agent.agentId;
    option.textContent = `${agent.agentId} — ${agent.name}`;
    return option;
  }));
  const single = el('scope').value === 'single_agent';
  el('which').hidden = !single;
  el('which-label').hidden = !single;
  el('pull').disabled = !view.may.stop;

  // OB-390 · ai-control.md "pull an agent's kill switch ≤2": one button per RUNNING assistant, beside the reason. Write why,
  // press its button — two acts. The reason is never defaulted (a stop with a made-up reason cannot be reviewed); an empty
  // one is refused on the page exactly as "Stop it now" refuses it, and nothing is sent.
  const running = view.agents.filter((agent) => !agent.stopped);
  el('stop-one-title').hidden = running.length === 0;
  el('stop-one-title').textContent = t('stopOneTitle');
  el('stop-one').replaceChildren(...running.map((agent) => {
    const b = button(`${t('stopThis')} ${agent.agentId} — ${agent.name}`, 'pause-circle', 'danger stop-one', () => { pullOne(agent.agentId); }, view.may.stop);
    b.dataset.agent = agent.agentId;
    return b;
  }));
}

/** Stop ONE assistant with the reason written above (OB-390): the same check and the same POST as "Stop it now". */
function pullOne(agentId) {
  const check = kit === undefined
    ? { ok: false, refusal: 'nobody_is_named_at_this_desk' }
    : kit.pull(viewer, { scope: 'single_agent', agentId, reason: el('pull-reason').value });
  void act(check, (b) => b?.detail ?? t('done')).then((sent) => { if (sent) el('pull-reason').value = ''; });
}

el('scope').addEventListener('change', () => {
  el('which').hidden = el('scope').value !== 'single_agent';
  el('which-label').hidden = el('scope').value !== 'single_agent';
});

el('pull').addEventListener('click', () => {
  const scope = el('scope').value;
  // Never defaulted to a stock phrase. A switch with a made-up reason cannot be reviewed.
  const check = kit === undefined
    ? { ok: false, refusal: 'nobody_is_named_at_this_desk' }
    : kit.pull(viewer, { scope, ...(scope === 'single_agent' ? { agentId: el('which').value } : {}), reason: el('pull-reason').value });
  void act(check, (b) => b?.detail ?? t('done')).then((sent) => { if (sent) el('pull-reason').value = ''; });
});

// ── The assistants ──────────────────────────────────────────────────────────

function renderAgents() {
  const box = el('forbidden-box');
  box.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = t('forbiddenTitle');
  box.append(title, line(t('forbiddenNote')));
  // Shown as a list, in full. A rule nobody can see is a rule nobody trusts.
  for (const tool of view?.forbidden ?? []) box.append(chip(tool.replace(/_/g, ' '), 'forbidden'));

  const agents = view?.agents ?? [];
  el('agent-list').replaceChildren(...(agents.length === 0
    ? [emptyLine(view === null ? t('unreachable') : t('noAgents'))]
    : agents.map((agent) => {
      const row = document.createElement('div');
      // Stopped is drawn as loudly as this product knows how, and the view model already put these first.
      row.className = `row ${agent.stopped ? 'stopped' : 'running'}`;
      row.dataset.agent = agent.agentId;
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = `${agent.agentId} ${agent.name} — ${agent.stopped ? (agent.stoppedBecause === 'not_enabled' ? t('notEnabled') : t('stopped')) : t('running')}`;
      what.append(name, line(agent.purpose));
      what.append(line(agent.readOnly ? t('readOnly') : `${t('decidedBy')} ${agent.approver === 'none' ? t('nobodyDecides') : agent.approver.replace(/_/g, ' ')}`));
      if (agent.customerFacing) what.append(line(t('customerFacing')));
      // Exactly what it may ask for. Never "everything".
      for (const tool of agent.tools) what.append(chip(tool.replace(/_/g, ' ')));
      what.append(line(`${t('instead')}: ${kit.withoutIt(agent)}`));
      what.append(line(agent.ceilingMinor === null
        ? `${t('spent')} ${money(agent.spentMinor)} · ${t('noCeiling')}`
        : `${t('spent')} ${money(agent.spentMinor)} · ${t('ceiling')} ${money(agent.ceilingMinor)} · ${t('left')} ${money(Math.max(0, agent.ceilingMinor - agent.spentMinor))}`));
      what.append(line(agent.callsPerHour === null ? t('noRate') : `${agent.callsPerHour} ${t('perHour')}`));
      // Never evaluated is a different fact from evaluated and scoring nought, and it is said.
      what.append(line(evaluationWords(agent)));
      row.append(what);
      return row;
    })));
}

function evaluationWords(agent) {
  if (agent.evaluationCases === 0) return t('noCases');
  const e = agent.lastEvaluation;
  if (e === null) return t('noEvaluation');
  if (!e.complete) return `${t('checked')} ${shopDayOf(e.at)} · ${t('incomplete')}`;
  return `${t('checked')} ${shopDayOf(e.at)} · ${e.passed}/${e.total} ${t('passed')}${e.unsafe > 0 ? ` · ${e.unsafe} ${t('unsafe')}` : ''}`;
}

// ── Waiting for you ─────────────────────────────────────────────────────────

function renderActions() {
  const box = el('actions-box');
  box.replaceChildren();
  box.hidden = actions === null;
  if (actions === null) return;
  const title = document.createElement('strong');
  title.textContent = t('actionsTitle');
  box.append(title);
  if (!actions.agentActive) { box.append(line(t('actionsOff'))); return; }
  if (actions.items.length === 0) { box.append(line(t('actionsNone'))); return; }
  for (const item of actions.items) {
    const l = line(`${item.says} — ${item.where}`);
    l.dataset.action = item.actionId;
    box.append(l);
  }
}

function renderQueue() {
  renderActions();
  const queued = view?.queue ?? [];
  el('queue-list').replaceChildren(...(queued.length === 0
    ? [emptyLine(view === null ? t('unreachable') : t('noQueue'))]
    : queued.map((p) => {
      const row = document.createElement('div');
      row.className = `row ${p.outcome === null ? 'held' : p.outcome.decision === 'approved' ? 'clean' : 'refused'}`;
      row.dataset.proposal = p.proposalId;
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = p.summary;
      what.append(name, line(`${t('drafted')} ${p.agent} ${p.agentName} · ${shopWhen(p.createdAt)}`));
      // AI-NFR-04: how sure, and what it cannot know — on every suggestion.
      what.append(chip(words(BAND_WORDS, p.confidence.band), `band-${p.confidence.band}`), line(`${t('cannotKnow')}: ${p.confidence.uncertainty}`));
      what.append(line(`${t('evidence')}: ${p.evidence.map((e) => `${e.source} — ${e.summary}`).join(' · ')}`));
      const where = line(`${t('toAct')}: ${p.wouldRequire}`);
      where.className = 'where';
      what.append(where);
      if (p.outcome !== null) {
        what.append(line(`${p.outcome.decision === 'approved' ? t('approvedBy') : t('rejectedBy')} ${p.outcome.by} · ${shopWhen(p.outcome.at)}${p.outcome.reason === undefined ? '' : ` — ${p.outcome.reason}`}`));
      }
      row.append(what);
      if (p.mayDecide) {
        const acts = document.createElement('span');
        acts.className = 'acts';
        const reason = field();
        reason.setAttribute('aria-label', t('rejectReason'));
        reason.placeholder = t('rejectReason');
        acts.append(
          button(t('approve'), 'circle-check', 'primary', () => { void act(kit.decide(viewer, p, 'approved', reason.value), (b) => b?.nextStep ?? t('done')); }),
          reason,
          button(t('reject'), 'x', '', () => { void act(kit.decide(viewer, p, 'rejected', reason.value), (b) => b?.nextStep ?? t('done')); }),
        );
        row.append(acts);
      }
      return row;
    })));
}

// ── What it costs ───────────────────────────────────────────────────────────

function spendBar(spentMinor, ceilingMinor) {
  const bar = document.createElement('span');
  bar.className = 'bar';
  const fill = document.createElement('i');
  const bps = ceilingMinor === 0 ? 0 : Math.round((spentMinor * 10_000) / ceilingMinor);
  fill.style.width = `${Math.min(100, bps / 100)}%`;
  // Colour is never the only signal — the figures are on the line above.
  if (bps >= 10_000) fill.className = 'over';
  else if (bps >= 8_000) fill.className = 'warn';
  bar.append(fill);
  return bar;
}

function renderCost() {
  const box = el('cost-summary');
  box.replaceChildren();
  if (view === null) { box.append(emptyLine(t('unreachable'))); el('cost-list').replaceChildren(); return; }
  if (!view.cost.known) {
    // No cap means nothing that costs may run — not a comfortable nought.
    box.append(emptyLine(t('noCap')));
    el('cost-list').replaceChildren();
    return;
  }
  const total = document.createElement('span');
  total.className = 'big';
  total.textContent = money(view.cost.spentMinor);
  box.append(total,
    line(`${t('totalSpent')} · ${(view.cost.usedBps / 100).toFixed(1)}% ${t('ofCap')} (${money(view.cost.capMinor)})`),
    line(`${t('platform')}: ${money(view.cost.platformCeilingMinor)}`),
    spendBar(view.cost.spentMinor, view.cost.capMinor));
  el('cost-list').replaceChildren(...view.cost.rows.map((r) => {
    const row = document.createElement('div');
    row.className = `row ${r.usedBps !== null && r.usedBps >= 10_000 ? 'refused' : r.usedBps !== null && r.usedBps >= 8_000 ? 'flagged' : 'clean'}`;
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = r.agentId;
    what.append(name, line(r.ceilingMinor === null
      ? `${t('spent')} ${money(r.spentMinor)} · ${t('noCeiling')}`
      : `${t('spent')} ${money(r.spentMinor)} · ${t('ceiling')} ${money(r.ceilingMinor)}`));
    if (r.ceilingMinor !== null) what.append(spendBar(r.spentMinor, r.ceilingMinor));
    row.append(what);
    return row;
  }));
}

// ── Models and checks ───────────────────────────────────────────────────────

function renderModels() {
  const box = el('provider-box');
  box.replaceChildren();
  if (view === null) { box.append(emptyLine(t('unreachable'))); for (const id of ['model-list', 'check-list', 'call-list']) el(id).replaceChildren(); return; }
  const title = document.createElement('strong');
  title.textContent = t('providerTitle');
  box.append(title, line(view.provider.said), line(view.freeTextOn ? t('freeTextOn') : t('freeTextOff')));
  for (const [id, said] of Object.entries(view.decisions)) box.append(line(`${id}: ${said}`));

  el('model-list').replaceChildren(...(view.models.length === 0
    ? [emptyLine(t('noModels'))]
    : view.models.map((m) => {
      const row = document.createElement('div');
      row.className = `row ${m.state === 'approved' ? 'clean' : 'refused'}`;
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = `${m.modelId} (${m.tier}) — ${m.state === 'approved' ? t('approvedOn') : t('withdrawn')}`;
      what.append(name, line(`${m.adapterId} · ${t('residency')} ${m.dataResidency === 'india' ? t('india') : t('outside')} · ${m.approvedBy} · ${shopDayOf(m.approvedAt)}${m.withdrawnReason === undefined ? '' : ` · ${m.withdrawnReason}`}`));
      row.append(what);
      return row;
    })));

  el('check-list').replaceChildren(...view.agents.filter((a) => a.evaluationCases > 0).map((agent) => {
    const e = agent.lastEvaluation;
    const row = document.createElement('div');
    row.className = `row ${e === null || !e.complete ? 'flagged' : e.unsafe > 0 || !e.fitToFacePeople ? 'refused' : 'clean'}`;
    row.dataset.check = agent.agentId;
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = `${agent.agentId} ${agent.name}`;
    what.append(name, line(evaluationWords(agent)));
    row.append(what, button(t('runChecks'), 'list-checks', '', () => {
      void act({ ok: true, method: 'POST', path: `/v1/ai/evaluations/${agent.agentId}`, body: {} }, (b) => `${t('checksRan')} ${b?.run?.detail ?? ''}`);
    }, view.may.evaluate));
    return row;
  }));

  const calls = view.modelCalls;
  el('call-list').replaceChildren(
    line(calls.chain.ok ? t('chainOk') : t('chainBroken')),
    ...(calls.recent.length === 0 ? [emptyLine(t('noCalls'))] : calls.recent.map((c) => {
      const row = document.createElement('div');
      row.className = `row ${c.calledAModel ? 'clean' : 'held'}`;
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = `${c.agent} · ${c.outcome} · ${shopWhen(c.at)}`;
      what.append(name, line(c.instruction), line(`${c.evidenceFrom ?? '—'} · ${c.evidenceCount} · ${c.modelId ?? '—'}`));
      if (c.piiRemoved.length > 0) what.append(line(`${t('piiRemoved')}: ${c.piiRemoved.join(', ')}`));
      if (c.blockedTools.length > 0) what.append(line(`${t('blocked')}: ${c.blockedTools.join(', ')}`));
      row.append(what);
      return row;
    })),
  );
}

// ── Incidents ───────────────────────────────────────────────────────────────

function renderIncidents() {
  const list = view?.incidents.list ?? [];
  el('incident-list').replaceChildren(...(list.length === 0
    ? [emptyLine(view === null ? t('unreachable') : t('noIncidents'))]
    : list.map((i) => {
      const row = document.createElement('div');
      row.className = `row ${i.state === 'closed' ? 'closed' : i.state === 'owned' ? 'held' : 'refused'}`;
      row.dataset.incident = i.incidentId;
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = i.summary;
      what.append(name, line(`${i.agent ?? '—'} · ${i.raisedBy} · ${shopWhen(i.raisedAt)}`),
        line(i.state === 'open' ? t('open') : i.state === 'owned' ? `${t('owned')} ${i.owner}` : `${t('closed')} — ${i.closeReason ?? ''}`));
      row.append(what);
      if (i.state !== 'closed' && view.may.manageIncidents) {
        const acts = document.createElement('span');
        acts.className = 'acts';
        if (i.state === 'open') {
          acts.append(button(t('takeIt'), 'hand', 'primary', () => {
            void act({ ok: true, method: 'POST', path: `/v1/ai/incidents/${encodeURIComponent(i.incidentId)}/owner`, body: { owner: viewer.userId } }, () => t('ownedOk'));
          }, viewer.userId !== null));
        } else {
          const reason = field();
          reason.setAttribute('aria-label', t('closeReason'));
          reason.placeholder = t('closeReason');
          acts.append(reason, button(t('closeIt'), 'circle-check', '', () => {
            void act(reason.value.trim() === '' ? { ok: false, refusal: 'reason_needed' } : { ok: true, method: 'POST', path: `/v1/ai/incidents/${encodeURIComponent(i.incidentId)}/close`, body: { reason: reason.value.trim() } }, () => t('closedOk'));
          }));
        }
        row.append(acts);
      }
      return row;
    })));
  const agent = el('raise-agent');
  agent.replaceChildren(...[{ agentId: '', name: t('anyAgent') }, ...(view?.agents ?? [])].map((a) => {
    const o = document.createElement('option');
    o.value = a.agentId;
    o.textContent = a.agentId === '' ? a.name : `${a.agentId} — ${a.name}`;
    return o;
  }));
  el('raise').disabled = view === null || !view.may.manageIncidents;
}

el('raise').addEventListener('click', () => {
  const summary = el('raise-summary').value.trim();
  const agent = el('raise-agent').value;
  const check = viewer.userId === null ? { ok: false, refusal: 'nobody_is_named_at_this_desk' }
    : summary === '' ? { ok: false, refusal: 'reason_needed' }
      : { ok: true, method: 'POST', path: '/v1/ai/incidents', body: { summary, ...(agent === '' ? {} : { agent }) } };
  void act(check, () => t('raised')).then((sent) => { if (sent) el('raise-summary').value = ''; });
});

// ── Language and chrome ─────────────────────────────────────────────────────

function paintChrome() {
  el('who').firstChild.textContent = `${t('title')} `;
  el('whoami').textContent = viewer.userId ?? '';
  for (const v of VIEWS) label(el(`tab-${v}`), TAB_ICONS[v], t(v));
  for (const [id, key] of [
    ['switch-title', 'switch'], ['switch-lead', 'switchLead'],
    ['agents-title', 'agents'], ['agents-lead', 'agentsLead'],
    ['queue-title', 'queue'], ['queue-lead', 'queueLead'],
    ['cost-title', 'cost'], ['cost-lead', 'costLead'],
    ['models-title', 'models'], ['models-lead', 'modelsLead'],
    ['incidents-title', 'incidents'], ['incidents-lead', 'incidentsLead'],
    ['pull-title', 'pullTitle'], ['scope-label', 'scopeLabel'],
    ['scope-all', 'scopeAll'], ['scope-facing', 'scopeFacing'], ['scope-single', 'scopeSingle'],
    ['which-label', 'whichLabel'], ['pull-reason-label', 'pullReasonLabel'],
    ['pull-note', 'pullNote'], ['unreachable', 'unreachable'],
    ['raise-title', 'raiseTitle'], ['raise-agent-label', 'raiseAgent'], ['raise-summary-label', 'raiseSummary'],
  ]) {
    el(id).textContent = t(key);
  }
  label(el('pull'), 'pause-circle', t('pull'));
  label(el('raise'), 'send', t('raise'));
  el('unreachable').hidden = readState !== 'unreachable';

  const nobody = el('nobody');
  nobody.hidden = viewer.userId !== null;
  nobody.textContent = nobody.hidden ? '' : t('nobodyNamed');

  renderSwitch();
  renderAgents();
  renderQueue();
  renderCost();
  renderModels();
  renderIncidents();
}

let reads = 0;
async function refresh() {
  await load();
  paintChrome();
  // What the page last read, for whoever is watching it (an operator's script, the browser test): never a figure.
  reads += 1;
  document.body.dataset.aiControl = readState;
  document.body.dataset.aiReads = String(reads);
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
});

// ── Boot ────────────────────────────────────────────────────────────────────

paintChrome();
show('switch');
void refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
