// The competitor rule (W3 · D06-FR-05 "competitor capture" · D-18 · OB-216) — on the Competitor prices tab of Products and
// prices. The session (apps/web-erp/src/markdown-session.ts, in the bundle as window.competitorRule) does every call; this
// says the rule in force (how far below us, how freshly seen, before a price change is DRAFTED) and, for whoever approves
// prices (the owner), lets it be changed with a reason — a new version, the old ones kept. Changing it reprices nothing; each
// draft still waits for a person. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.competitorRule ?? null;
const session = api?.session ?? null;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k, slots) => (api === null ? k : api.words(lang(), k, slots));
let rule = null; let ruleOut = null;

function paint() {
  if (api === null || session === null || !session.may.propose) return;
  $('rule-block').hidden = false;
  for (const [id, k] of [['rule-title', 'ruleH'], ['rule-lead', 'ruleLead'], ['rule-gap-label', 'gap'], ['rule-age-label', 'age'], ['rule-why-label', 'reason'], ['rule-save', 'setRule']]) $(id).textContent = t(k);
  $('rule-form').hidden = !session.may.setRule;
  $('rule-now').textContent = rule === null
    ? (ruleOut === null ? t('reading') : api.outcomeWords(lang(), ruleOut))
    : `${t('ruleNow', { gap: (rule.gapBps / 100).toFixed(1), age: rule.maxAgeDays })} ${rule.source === 'owner_setting' ? t('ruleOwner', { v: rule.version ?? '' }) : t('ruleDefault')}${session.may.setRule ? '' : ` ${t('ruleOwnerOnly')}`}`;
}

async function load() {
  const out = await session.rule();
  if (out.result === 'ok') { rule = out.value; ruleOut = null; if ($('rule-gap').value === '') { $('rule-gap').value = String(rule.gapBps / 100); $('rule-age').value = String(rule.maxAgeDays); } } else { rule = null; ruleOut = out; }
  paint();
}

$('rule-save')?.addEventListener('click', async () => {
  if (session === null) return;
  $('rule-status').textContent = t('saving');
  const out = await session.setRule({ gapPercent: $('rule-gap').value, maxAgeDays: $('rule-age').value, reason: $('rule-why').value });
  $('rule-status').textContent = out.result === 'ok' ? (out.value.alreadyInForce ? t('ruleSame') : t('ruleSaved', { v: out.value.version ?? '' })) : api.outcomeWords(lang(), out);
  if (out.result === 'ok') { $('rule-why').value = ''; await load(); }
});
new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
if (session !== null && session.may.propose) { paint(); void load(); }
