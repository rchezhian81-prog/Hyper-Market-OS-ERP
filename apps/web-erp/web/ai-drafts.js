// The assistant's drafts — the THIN CLIENT for the A09 approver and the A07 security officer (roadmap §7 · P-05 ·
// hard rule 5). It holds no rule: the template versions, the summaries and every refusal are head office's. A09's words
// are DRAFT template versions on the PA-08 register — approving one is the existing two-person template approval, which
// the server refuses to the person who asked for the words. A07's summaries are read-only suggestions. Each POST carries
// its own idempotency key; every word has a Tamil twin and follows the one language toggle.

// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? '';
const $ = (id) => document.getElementById(id);
const who = window.aiDraftsData && typeof window.aiDraftsData === 'object' ? window.aiDraftsData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const mayDraftWords = perms.has('document.template.manage');
const mayReadSummaries = perms.has('lp.case.read');
const mayAskSummary = perms.has('lp.case.manage');

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
  },
};
let lang = 'en';
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
    : out.status === 0 ? t('unreachable') : out.status === 503 || out.status === 429 ? notRunWords(out) : `${t('refused')} ${out.body?.error?.whatHappened ?? out.status}`;
}

function paintWords() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['off-r8', 'offUntilR8'], ['camp-h', 'campH'], ['camp-lede', 'campLede'], ['l-tpl-id', 'tplId'], ['l-tpl-channel', 'channel'], ['l-tpl-brief', 'brief'], ['o-email', 'email'], ['o-push', 'push'], ['ask-campaign', 'askCampaign'], ['anom-h', 'anomH'], ['anom-lede', 'anomLede'], ['ask-summary', 'askSummary']]) {
    const el = $(id);
    if (el) el.textContent = t(k);
  }
  $('ask-campaign').disabled = !mayDraftWords;
  $('ask-summary').disabled = !mayAskSummary;
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
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = t('approve'); b.disabled = !mayDraftWords;
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

async function load() {
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

$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintWords();
  renderTemplates();
  renderSummaries();
});

paintWords();
if (who !== null) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
