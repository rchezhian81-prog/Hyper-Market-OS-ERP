// AI control — the view layer. Every rule lives in the TESTED session model
// (`apps/web-erp/src/ai-session.ts`), attached as `window.aiSession`.
//
// ── The decision this screen is built around ────────────────────────────────
//
// **The kill switch is the first tab, not a setting three levels down.** Somebody who opens this
// screen in a hurry has come here to stop something, and beside every switch is the sentence
// describing what the shop does without that assistant — so pulling it is a decision that can be
// made calmly rather than a leap in the dark.
//
// ── And the two that follow ─────────────────────────────────────────────────
//
// **Nothing here commits.** Everything an assistant has drafted sits in one queue until a named
// person accepts it, and the record that comes back names the person as the actor and the
// assistant as the drafter (P-05, hard rule #5).
//
// **What no assistant may ever be granted is shown as a list.** A rule nobody can see is a rule
// nobody trusts, and the owner is entitled to read it rather than be told it exists.
//
// No `prompt`, `confirm` or `alert`; the banner does not fade.

const el = (id) => document.getElementById(id);

const money = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    staleShell: 'No connection to the store computer. This page is what it was last told, at',
    title: 'AI control',
    switch: 'Stop the AI', agents: 'The assistants', queue: 'Waiting for you', cost: 'What it costs',
    switchLead: 'Stopping an assistant takes effect immediately. It needs your name and a reason so it can be reviewed afterwards, but it never waits for anybody’s approval. Beside each one is what the shop does without it.',
    agentsLead: 'What each assistant may do, who decides after it, and whether it is running. Stopped ones are listed first.',
    queueLead: 'Things an assistant has drafted. Nothing here has happened. It happens when you accept it, and the record carries your name, not the assistant’s.',
    costLead: 'What the assistants have cost this month, each against its own limit and all of them against your monthly platform limit. When one runs out it stops and the shop does not.',
    pullTitle: 'Stop something now', scopeLabel: 'What do you want to stop',
    scopeAll: 'Every assistant', scopeFacing: 'Only the ones customers talk to', scopeSingle: 'One assistant',
    whichLabel: 'Which one', pullReasonLabel: 'Why are you stopping it',
    pull: 'Stop it now',
    pullNote: 'The shop carries on trading. Nothing on the till, the stock or the money depends on this.',
    lift: 'Start it again', lifted: 'Started again', stopped: 'STOPPED', running: 'running',
    nothingStopped: 'Nothing is stopped. Every assistant is running.',
    stoppedBy: 'stopped by', pulledAt: 'at', instead: 'Without it',
    forbiddenTitle: 'What no assistant may ever do',
    forbiddenNote: 'No setting, no licence and no request can grant any of these to any assistant. This is not a preference — it is built in.',
    mayUse: 'may use', decidedBy: 'decided by', nobodyDecides: 'it decides nothing — it only answers',
    readOnly: 'reads and drafts only', customerFacing: 'talks to customers',
    noBudget: 'No spending limit has been set for this assistant, so it cannot make a call at all.',
    spendNotKnown: 'Nothing has told this screen what this assistant has spent this month, so its limit cannot be enforced and it cannot make a call.',
    noEvaluation: 'This assistant has NEVER been checked for accuracy.',
    checked: 'checked', passed: 'passed', spent: 'spent', ceiling: 'limit', left: 'left',
    noQueue: 'Nothing is waiting for you.',
    cited: 'evidence it used', noCitations: 'it cited nothing',
    accept: 'Accept it', accepted: 'Accepted', drafted: 'drafted by', committedBy: 'accepted by',
    noPlatformCeiling: 'You have not set a monthly limit for what this whole system may cost, or nothing has told this screen what has been spent. Either way nothing can be measured. That is not the same as being inside a limit.',
    totalSpent: 'spent this month', platformShare: 'of your monthly limit',
    calls: 'requests', exhausted: 'has stopped at its limit', approaching: 'close to its limit',
    noAgents: 'This screen has not been told about any assistants.',
    ok: 'OK', read: 'Please read this', done: 'Done',
    nobodyNamed: 'This store box has not been told who is using this screen. Nothing can be stopped and nothing can be accepted — both carry the name of whoever did it.',
    sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
    title: 'AI கட்டுப்பாடு',
    switch: 'AI-ஐ நிறுத்து', agents: 'உதவியாளர்கள்', queue: 'உங்களுக்காகக் காத்திருப்பவை', cost: 'செலவு எவ்வளவு',
    switchLead: 'ஒரு உதவியாளரை நிறுத்தினால் உடனே நிற்கும். உங்கள் பெயரும் காரணமும் தேவை, ஆனால் யாருடைய அனுமதிக்கும் காத்திருக்காது. ஒவ்வொன்றின் அருகிலும், அது இல்லாமல் கடை என்ன செய்யும் என்பது எழுதப்பட்டுள்ளது.',
    agentsLead: 'ஒவ்வொரு உதவியாளரும் என்ன செய்யலாம், அதற்குப் பிறகு யார் முடிவு செய்கிறார், அது இயங்குகிறதா. நிறுத்தப்பட்டவை முதலில் காட்டப்படும்.',
    queueLead: 'உதவியாளர் தயாரித்தவை. இங்கே எதுவும் நடக்கவில்லை. நீங்கள் ஏற்றுக்கொண்டால் மட்டுமே நடக்கும், பதிவில் உங்கள் பெயர் இருக்கும், உதவியாளரின் பெயர் அல்ல.',
    costLead: 'இந்த மாதம் உதவியாளர்கள் எவ்வளவு செலவழித்தன — ஒவ்வொன்றும் அதன் சொந்த வரம்பிற்கு எதிராகவும், எல்லாமும் உங்கள் மாதாந்திர வரம்பிற்கு எதிராகவும். ஒன்று தீர்ந்தால் அது நிற்கும், கடை நிற்காது.',
    pullTitle: 'இப்போதே நிறுத்து', scopeLabel: 'எதை நிறுத்த வேண்டும்',
    scopeAll: 'எல்லா உதவியாளர்களும்', scopeFacing: 'வாடிக்கையாளருடன் பேசுபவை மட்டும்', scopeSingle: 'ஒரு உதவியாளர்',
    whichLabel: 'எது', pullReasonLabel: 'ஏன் நிறுத்துகிறீர்கள்',
    pull: 'இப்போதே நிறுத்து',
    pullNote: 'கடை வழக்கம்போல் நடக்கும். பில்லிங், இருப்பு, பணம் எதுவும் இதைச் சார்ந்தது அல்ல.',
    lift: 'மீண்டும் தொடங்கு', lifted: 'மீண்டும் தொடங்கியது', stopped: 'நிறுத்தப்பட்டது', running: 'இயங்குகிறது',
    nothingStopped: 'எதுவும் நிறுத்தப்படவில்லை. எல்லா உதவியாளர்களும் இயங்குகின்றன.',
    stoppedBy: 'நிறுத்தியவர்', pulledAt: 'நேரம்', instead: 'அது இல்லாமல்',
    forbiddenTitle: 'எந்த உதவியாளரும் ஒருபோதும் செய்யக்கூடாதவை',
    forbiddenNote: 'எந்த அமைப்பும், எந்த உரிமமும், எந்தக் கோரிக்கையும் இவற்றை எந்த உதவியாளருக்கும் வழங்க முடியாது. இது ஒரு விருப்பம் அல்ல — உள்ளேயே கட்டப்பட்டது.',
    mayUse: 'பயன்படுத்தலாம்', decidedBy: 'முடிவு செய்பவர்', nobodyDecides: 'இது எதையும் முடிவு செய்யாது — பதில் மட்டுமே சொல்லும்',
    readOnly: 'படிக்கவும் வரையவும் மட்டுமே', customerFacing: 'வாடிக்கையாளருடன் பேசும்',
    noBudget: 'இந்த உதவியாளருக்கு செலவு வரம்பு நிர்ணயிக்கப்படவில்லை. எனவே இது எந்தக் கோரிக்கையையும் செய்ய முடியாது.',
    spendNotKnown: 'இந்த உதவியாளர் இந்த மாதம் எவ்வளவு செலவழித்தது என்று இந்தத் திரைக்குச் சொல்லப்படவில்லை. எனவே வரம்பை அமல்படுத்த முடியாது, கோரிக்கையும் செய்ய முடியாது.',
    noEvaluation: 'இந்த உதவியாளரின் துல்லியம் ஒருபோதும் சரிபார்க்கப்படவில்லை.',
    checked: 'சரிபார்க்கப்பட்டது', passed: 'தேர்ச்சி', spent: 'செலவு', ceiling: 'வரம்பு', left: 'மீதம்',
    noQueue: 'உங்களுக்காக எதுவும் காத்திருக்கவில்லை.',
    cited: 'பயன்படுத்திய ஆதாரம்', noCitations: 'எந்த ஆதாரமும் சொல்லவில்லை',
    accept: 'ஏற்றுக்கொள்', accepted: 'ஏற்கப்பட்டது', drafted: 'தயாரித்தது', committedBy: 'ஏற்றவர்',
    noPlatformCeiling: 'இந்த முழு அமைப்பும் மாதம் எவ்வளவு செலவாகலாம் என்று நீங்கள் வரம்பு நிர்ணயிக்கவில்லை, அல்லது எவ்வளவு செலவானது என்று இந்தத் திரைக்குச் சொல்லப்படவில்லை. எப்படியும் எதையும் ஒப்பிட முடியாது. இது வரம்புக்குள் இருப்பது என்று பொருள் அல்ல.',
    totalSpent: 'இந்த மாதம் செலவு', platformShare: 'உங்கள் மாதாந்திர வரம்பில்',
    calls: 'கோரிக்கைகள்', exhausted: 'வரம்பில் நின்றுவிட்டது', approaching: 'வரம்பை நெருங்குகிறது',
    noAgents: 'எந்த உதவியாளர் பற்றியும் இந்தத் திரைக்குச் சொல்லப்படவில்லை.',
    ok: 'சரி', read: 'இதைப் படிக்கவும்', done: 'முடிந்தது',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைப் பெட்டிக்குத் தெரியவில்லை. எதையும் நிறுத்தவோ ஏற்கவோ முடியாது — இரண்டும் செய்தவரின் பெயரைச் சுமக்கும்.',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** Why the AI could not be stopped or started — one entry per `PullRefusal`, both languages. */
const PULL_REFUSAL_WORDS = {
  nobody_is_named_at_this_desk: {
    en: 'This store computer has not been told who is using this screen. Nothing was stopped.',
    ta: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை. எதுவும் நிறுத்தப்படவில்லை.',
  },
  refused: {
    en: 'The rules refused this. Nothing changed.',
    ta: 'விதிகள் இதை மறுத்தன. எதுவும் மாறவில்லை.',
  },
};

/** Why a draft could not be accepted — one entry per `DecideRefusal`, both languages. */
const DECIDE_REFUSAL_WORDS = {
  nobody_is_named_at_this_desk: {
    en: 'This store computer has not been told who is using this screen. Nothing was accepted.',
    ta: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை. எதுவும் ஏற்கப்படவில்லை.',
  },
  no_such_proposal: {
    en: 'That draft is no longer here. Nothing was accepted.',
    ta: 'அந்த வரைவு இப்போது இல்லை. எதுவும் ஏற்கப்படவில்லை.',
  },
  refused: {
    en: 'The rules refused this. Nothing was accepted.',
    ta: 'விதிகள் இதை மறுத்தன. எதுவும் ஏற்கப்படவில்லை.',
  },
};

/** What the rules made of a draft — one entry per `ProposalVerdict`, both languages. */
const VERDICT_WORDS = {
  accepted_for_approval: {
    en: 'waiting for you to accept it — nothing has happened yet',
    ta: 'நீங்கள் ஏற்பதற்குக் காத்திருக்கிறது — இதுவரை எதுவும் நடக்கவில்லை',
  },
  forbidden_tool: {
    en: 'REFUSED — it asked for something no assistant may ever do, and that has been recorded',
    ta: 'மறுக்கப்பட்டது — எந்த உதவியாளரும் செய்யக்கூடாத ஒன்றைக் கேட்டது; இது பதிவு செய்யப்பட்டுள்ளது',
  },
  tool_not_granted: {
    en: 'REFUSED — it asked for something it was not given, and that has been recorded',
    ta: 'மறுக்கப்பட்டது — வழங்கப்படாத ஒன்றைக் கேட்டது; இது பதிவு செய்யப்பட்டுள்ளது',
  },
  read_only_agent: {
    en: 'refused — this assistant only answers questions, it proposes nothing',
    ta: 'மறுக்கப்பட்டது — இந்த உதவியாளர் பதில் மட்டுமே சொல்லும், எதையும் முன்மொழியாது',
  },
  no_evidence: {
    en: 'refused — it gave no evidence, and a confident answer with nothing behind it is the worst kind',
    ta: 'மறுக்கப்பட்டது — எந்த ஆதாரமும் தரவில்லை; ஆதாரமில்லாத நம்பிக்கையான பதிலே மிக ஆபத்தானது',
  },
  no_rationale: {
    en: 'refused — it did not say why, so nobody can check it',
    ta: 'மறுக்கப்பட்டது — ஏன் என்று சொல்லவில்லை, எனவே யாரும் சரிபார்க்க முடியாது',
  },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/** A stand-in with the same surface as the bundled session, announced whenever it is in use. */
function sampleSession() {
  const refused = { ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'this is sample data' };
  return {
    agents: () => [],
    forbidden: () => [],
    killState: () => ({ tenantId: '', allStopped: false, stoppedAgents: [], active: [], detail: '' }),
    pull: () => refused,
    lift: () => refused,
    queue: () => [],
    decide: () => refused,
    spend: () => undefined,
  };
}

const real = window.aiSession;
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

const VIEWS = ['switch', 'agents', 'queue', 'cost'];

function show(name) {
  for (const view of VIEWS) el(`view-${view}`).hidden = view !== name;
  for (const tab of VIEWS) el(`tab-${tab}`).setAttribute('aria-current', tab === name ? 'page' : 'false');
}
for (const name of VIEWS) el(`tab-${name}`).addEventListener('click', () => { show(name); });

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

// ── Stop the AI ─────────────────────────────────────────────────────────────

function renderSwitch() {
  const state = session.killState();
  const agents = session.agents();
  const box = el('kill-state');
  box.replaceChildren();

  const headline = document.createElement('span');
  headline.className = 'big';
  headline.textContent = state.stoppedAgents.length === 0
    ? t('nothingStopped')
    : `${state.stoppedAgents.length} ${t('stopped')}`;
  box.append(headline);
  if (state.stoppedAgents.length > 0) box.append(line(state.detail));

  // Every active switch, with what the shop does without each agent it stopped, and the way back.
  el('kill-list').replaceChildren(...state.active.map((sw) => {
    const row = document.createElement('div');
    row.className = 'row stopped';
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = sw.reason;
    what.append(
      name,
      line(`${t('stoppedBy')} ${sw.activatedBy} · ${t('pulledAt')} ${new Date(sw.activatedAt).toLocaleString()}`),
    );
    // What the shop does without each agent this switch stopped. Shown here, beside the way back,
    // because "can I start it again?" and "what am I living without?" are the same question.
    for (const agent of agents.filter((a) => a.stopped)) {
      what.append(line(`${t('instead')}: ${agent.fallback}`));
    }

    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = t('lift');
    back.addEventListener('click', () => {
      const outcome = session.lift({ switchId: sw.switchId, reason: sw.reason });
      if (!outcome.ok) {
        tell(t('read'), `${words(PULL_REFUSAL_WORDS, outcome.refusal)} ${outcome.detail}`);
        return;
      }
      tell(t('lifted'), outcome.detail, true);
      paintChrome();
    });

    row.append(what, back);
    return row;
  }));

  if (state.active.length === 0) el('kill-list').replaceChildren();

  // The "which one" list only matters for a single-agent stop, and it is filled from the real
  // registry so a switch can never name an assistant that does not exist.
  const which = el('which');
  which.replaceChildren(...agents.map((agent) => {
    const option = document.createElement('option');
    option.value = agent.agentId;
    option.textContent = `${agent.agentId} — ${agent.name}`;
    return option;
  }));
  el('which').hidden = el('scope').value !== 'single_agent';
  el('which-label').hidden = el('scope').value !== 'single_agent';
}

el('scope').addEventListener('change', () => {
  el('which').hidden = el('scope').value !== 'single_agent';
  el('which-label').hidden = el('scope').value !== 'single_agent';
});

el('pull').addEventListener('click', () => {
  const scope = el('scope').value;
  const outcome = session.pull({
    scope,
    ...(scope === 'single_agent' ? { agentId: el('which').value } : {}),
    // Never defaulted to a stock phrase. A switch with a made-up reason cannot be reviewed.
    reason: el('pull-reason').value,
  });
  if (!outcome.ok) {
    tell(t('read'), `${words(PULL_REFUSAL_WORDS, outcome.refusal)} ${outcome.detail}`);
    return;
  }
  tell(t('done'), outcome.detail, true);
  paintChrome();
});

// ── The assistants ──────────────────────────────────────────────────────────

function renderAgents() {
  const forbidden = session.forbidden();
  const box = el('forbidden-box');
  box.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = t('forbiddenTitle');
  box.append(title, line(t('forbiddenNote')));
  // Shown as a list, in full. A rule nobody can see is a rule nobody trusts.
  for (const tool of forbidden) {
    const chip = document.createElement('span');
    chip.className = 'chip forbidden';
    chip.textContent = tool.replace(/_/g, ' ');
    box.append(chip);
  }

  const agents = session.agents();
  el('agent-list').replaceChildren(...(agents.length === 0
    ? [emptyLine(t('noAgents'))]
    : agents.map((agent) => {
      const row = document.createElement('div');
      // Stopped is drawn as loudly as this product knows how, and the session already put these
      // first — somebody in a hurry is looking for what is off.
      row.className = `row ${agent.stopped ? 'stopped' : 'running'}`;
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = `${agent.agentId} ${agent.name} — ${agent.stopped ? t('stopped') : t('running')}`;
      what.append(name, line(agent.purpose));

      what.append(line(agent.readOnly
        ? t('readOnly')
        : `${t('decidedBy')} ${agent.approver === 'none' ? t('nobodyDecides') : agent.approver.replace(/_/g, ' ')}`));
      if (agent.customerFacing) what.append(line(t('customerFacing')));

      // Exactly what it may ask for. Never "everything", and never a summary of a count.
      for (const tool of agent.tools) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = tool.replace(/_/g, ' ');
        what.append(chip);
      }

      // What the shop does without it, on every agent, always.
      what.append(line(`${t('instead')}: ${agent.fallback}`));

      if (!agent.budget.known) {
        // Two different absences, said differently. No limit means no request can be made at all;
        // no measured spend means the limit cannot be enforced. Neither is a spend of nought.
        what.append(line(agent.budget.why === 'no_ceiling_set' ? t('noBudget') : t('spendNotKnown')));
      } else {
        what.append(line(
          `${t('spent')} ${money(agent.budget.spentMinor)} · ${t('ceiling')} ${money(agent.budget.ceilingMinor)}`
          + ` · ${t('left')} ${money(agent.budget.remainingMinor)}`,
        ));
        what.append(spendBar(agent.budget.spentMinor, agent.budget.ceilingMinor));
      }

      // Never evaluated is a different fact from evaluated and scoring nought, and it is said.
      what.append(line(agent.evaluation === undefined
        ? t('noEvaluation')
        : `${t('checked')} ${new Date(agent.evaluation.at).toLocaleDateString()} · `
          + `${agent.evaluation.passed}/${agent.evaluation.total} ${t('passed')}`));

      row.append(what);
      return row;
    })));
}

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

// ── Waiting for you ─────────────────────────────────────────────────────────

function renderQueue() {
  const queued = session.queue();
  el('queue-list').replaceChildren(...(queued.length === 0
    ? [emptyLine(t('noQueue'))]
    : queued.map(({ pending, review }) => {
      const row = document.createElement('div');
      row.className = `row ${review.accepted ? 'held' : 'refused'}`;
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = pending.proposal.tool.replace(/_/g, ' ');
      what.append(
        name,
        line(pending.proposal.rationale),
        line(`${t('drafted')} ${pending.agentId} · ${new Date(pending.proposedAt).toLocaleString()}`),
        // What the rules made of it, in the shop's words — never a code.
        line(words(VERDICT_WORDS, review.verdict)),
        // The evidence that was VERIFIED, never what the model claimed to have used.
        line(pending.verifiedCitations.length === 0
          ? t('noCitations')
          : `${t('cited')}: ${pending.verifiedCitations.join(', ')}`),
      );

      row.append(what);

      if (review.accepted) {
        const accept = document.createElement('button');
        accept.type = 'button';
        accept.className = 'primary';
        accept.textContent = t('accept');
        accept.addEventListener('click', () => {
          // The role is the one the rules require for this assistant, read back from the review.
          // The screen never picks a role that would let the wrong person accept.
          const outcome = session.decide({ proposalId: pending.proposalId, approverRole: review.approver });
          if (!outcome.ok) {
            tell(t('read'), `${words(DECIDE_REFUSAL_WORDS, outcome.refusal)} ${outcome.detail}`);
            return;
          }
          // The person is the actor; the assistant is the drafter. Said in that order.
          tell(
            t('accepted'),
            `${t('committedBy')} ${outcome.record.actor} · ${t('drafted')} ${outcome.record.draftedBy}`,
            true,
          );
          paintChrome();
        });
        row.append(accept);
      }
      return row;
    })));
}

// ── What it costs ───────────────────────────────────────────────────────────

function renderCost() {
  const summary = session.spend();
  const box = el('cost-summary');
  box.replaceChildren();

  if (summary === undefined) {
    // No ceiling means the owner has never agreed one. A share of nothing is not reassurance.
    box.append(emptyLine(t('noPlatformCeiling')));
    el('cost-list').replaceChildren();
    return;
  }

  const total = document.createElement('span');
  total.className = 'big';
  total.textContent = money(summary.totalMinor);
  box.append(
    total,
    line(`${t('totalSpent')} · ${(summary.platformShareBps / 100).toFixed(1)}% ${t('platformShare')} `
      + `(${money(summary.platformCeilingMinor)})`),
    line(summary.detail),
  );

  el('cost-list').replaceChildren(...summary.byAgent.map((agent) => {
    const row = document.createElement('div');
    row.className = `row ${summary.exhausted.includes(agent.agentId)
      ? 'refused'
      : summary.approaching.includes(agent.agentId) ? 'flagged' : 'clean'}`;
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = agent.agentId;
    what.append(
      name,
      line(`${t('spent')} ${money(agent.costMinor)} · ${t('ceiling')} ${money(agent.ceilingMinor)}`
        + ` · ${agent.calls} ${t('calls')}`),
      spendBar(agent.costMinor, agent.ceilingMinor),
    );
    // Said in words as well as drawn, always.
    if (summary.exhausted.includes(agent.agentId)) what.append(line(t('exhausted')));
    else if (summary.approaching.includes(agent.agentId)) what.append(line(t('approaching')));
    row.append(what);
    return row;
  }));
}

// ── Language and chrome ─────────────────────────────────────────────────────

function paintChrome() {
  el('who').firstChild.textContent = `${t('title')} `;
  el('whoami').textContent = window.aiData?.userId ?? '';
  for (const [id, key] of [
    ['tab-switch', 'switch'], ['tab-agents', 'agents'], ['tab-queue', 'queue'], ['tab-cost', 'cost'],
    ['switch-title', 'switch'], ['switch-lead', 'switchLead'],
    ['agents-title', 'agents'], ['agents-lead', 'agentsLead'],
    ['queue-title', 'queue'], ['queue-lead', 'queueLead'],
    ['cost-title', 'cost'], ['cost-lead', 'costLead'],
    ['pull-title', 'pullTitle'], ['scope-label', 'scopeLabel'],
    ['scope-all', 'scopeAll'], ['scope-facing', 'scopeFacing'], ['scope-single', 'scopeSingle'],
    ['which-label', 'whichLabel'], ['pull-reason-label', 'pullReasonLabel'],
    ['pull', 'pull'], ['pull-note', 'pullNote'], ['sample', 'sampleData'],
  ]) {
    el(id).textContent = t(key);
  }

  const nobody = el('nobody');
  nobody.hidden = window.aiData?.userId !== undefined;
  nobody.textContent = nobody.hidden ? '' : t('nobodyNamed');

  renderSwitch();
  renderAgents();
  renderQueue();
  renderCost();
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
paintChrome();
show('switch');

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
