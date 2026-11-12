// The SOFTWARE UPDATE page of the store computer — CR-01 step 3c (OI-05 · OB-718 · OB-719 · OB-721 · P-04 · P-07 · P-08).
//
// Served by the till's screen server on this PC only (loopback), at /update/, behind the office PIN sign-in (OB-259).
// It shows what `store-computer check-update` (step 3b) last found — kept in the data folder's status\update-check.json —
// and, when a newer signed version is ready, an Update button. The button is a REQUEST, never the update itself:
//
//   • only the OWNER may make it (OB-719): signed in to the office screens AND holding the owner role at this store AND the
//     setup authority (platform.setup.write) in the signed store pack;
//   • with his OWN till PIN typed again on the page (the same PIN register and guess limits as the till's sign-in);
//   • REFUSED while any till shift is open (OB-718): a float issued and not closed, read from this box's own till-cash log;
//   • refused unless the last check says a newer version is READY (signed, checked) — never an unsigned or unknown one;
//   • every request and every refusal is written, before the answer, to an append-only log on this box (update-requests.log,
//     never rewritten — hard rule #6); an accepted request is also left as update-request.json for the updater (step 3d),
//     which stops the services, installs and rolls back by itself. This page never stops, installs or downloads anything.

export const UPDATE_PATHS = Object.freeze({ page: '/update/', request: '/update/request' });
export const UPDATE_AUTHORITY = 'platform.setup.write';
export const OWNER_ROLE = 'owner';
export const UPDATE_LOG = 'update-requests.log';
export const UPDATE_REQUEST_FILE = 'update-request.json';

/** What step 3b kept (status\update-check.json). Unknown fields are ignored. */
export interface UpdateCheckView {
  readonly checkedAt: string;
  readonly running: string | null;
  readonly state: 'up-to-date' | 'available' | 'not-installable' | 'could-not-check';
  readonly latest: string | null;
  readonly said: string;
  readonly tag?: string | null;
  readonly commit?: string;
  readonly sha256?: string;
}

/** Read status\update-check.json; anything unreadable is "never checked" (undefined), never a made-up answer. */
export function readUpdateCheck(text: string | undefined): UpdateCheckView | undefined {
  if (text === undefined) return undefined;
  try {
    const r = JSON.parse(text) as Record<string, unknown>;
    const states = ['up-to-date', 'available', 'not-installable', 'could-not-check'];
    if (r['kind'] !== 'sre-store-pc-update-check-v1' || typeof r['checkedAt'] !== 'string' || typeof r['said'] !== 'string' || !states.includes(String(r['state']))) return undefined;
    const str = (k: string): string | undefined => (typeof r[k] === 'string' ? (r[k] as string) : undefined);
    return {
      checkedAt: r['checkedAt'] as string,
      running: str('running') ?? null,
      state: r['state'] as UpdateCheckView['state'],
      latest: str('latest') ?? null,
      said: r['said'] as string,
      ...(str('tag') === undefined ? {} : { tag: str('tag')! }),
      ...(str('commit') === undefined ? {} : { commit: str('commit')! }),
      ...(str('sha256') === undefined ? {} : { sha256: str('sha256')! }),
    };
  } catch { return undefined; }
}

export interface OpenShift { readonly tillId: string; readonly custodian: string; readonly openedAt: string }

export type UpdateRefusal = 'not_signed_in' | 'not_the_owner' | 'pin_not_confirmed' | 'shift_open' | 'nothing_to_install' | 'not_checked' | 'not_recorded';

export const REFUSAL_WORDS: Readonly<Record<UpdateRefusal, { readonly en: string; readonly ta: string }>> = Object.freeze({
  not_signed_in: { en: 'Your office sign-in has ended. Sign in again with your own PIN.', ta: 'உங்கள் அலுவலக உள்நுழைவு முடிந்தது. உங்கள் PIN-உடன் மீண்டும் உள்நுழையவும்.' },
  not_the_owner: { en: 'Only the owner may update the store computer.', ta: 'கடை உரிமையாளர் மட்டுமே கணினியைப் புதுப்பிக்க முடியும்.' },
  pin_not_confirmed: { en: 'Your PIN was not confirmed.', ta: 'உங்கள் PIN உறுதிசெய்யப்படவில்லை.' },
  shift_open: { en: 'A till shift is open. Close every till first, then update.', ta: 'ஒரு பணப்பெட்டி ஷிஃப்ட் திறந்துள்ளது. முதலில் எல்லா பணப்பெட்டிகளையும் மூடவும்.' },
  nothing_to_install: { en: 'There is no newer signed version to install.', ta: 'நிறுவ புதிய கையொப்பமிட்ட பதிப்பு இல்லை.' },
  not_checked: { en: 'This PC has not checked for a new version yet.', ta: 'இந்தக் கணினி இன்னும் புதிய பதிப்பைச் சரிபார்க்கவில்லை.' },
  not_recorded: { en: 'The request could not be written down on this PC, so it was not made.', ta: 'கோரிக்கையை இந்தக் கணினியில் பதிவு செய்ய முடியவில்லை.' },
});

export interface UpdateDeps {
  /** The last check (status\update-check.json), read per request. */
  readonly check: () => UpdateCheckView | undefined;
  /** Every till whose shift is open now, from this box's own till-cash log. */
  readonly openShifts: () => Promise<readonly OpenShift[]>;
  /** The person's roles at this store, from the signed store pack (null: the pack does not know them). */
  readonly rolesOf: (userId: string) => readonly string[] | null;
  /** Their own till PIN, checked by the till's PIN register (same guess limits); holding `authority`. */
  readonly verifyPin: (userId: string, pin: string, authority: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly laneMessage: string }>;
  /** Append one record to update-requests.log, durably. Throws when it cannot. */
  readonly record: (entry: Record<string, unknown>) => Promise<void>;
  /** Leave the accepted request for the updater (update-request.json). Throws when it cannot. */
  readonly leaveRequest: (request: Record<string, unknown>) => Promise<void>;
  readonly now: () => string;
}

export type UpdateAnswer =
  | { readonly ok: true; readonly version: string; readonly en: string; readonly ta: string }
  | { readonly ok: false; readonly refusedBecause: UpdateRefusal; readonly en: string; readonly ta: string; readonly detail?: string };

const refused = (why: UpdateRefusal, detail?: string): UpdateAnswer => ({ ok: false, refusedBecause: why, ...REFUSAL_WORDS[why], ...(detail === undefined ? {} : { detail }) });

/**
 * The Update button's request, decided in order: owner → PIN → nothing open → a ready version. The record is written
 * BEFORE the answer, a refusal as much as a request (P-08 · OB-719); if it cannot be written, nothing is requested.
 */
export async function requestUpdate(deps: UpdateDeps, who: { readonly userId: string } | null, pin: unknown): Promise<UpdateAnswer> {
  const at = deps.now();
  const write = async (outcome: string, extra: Record<string, unknown>): Promise<boolean> => {
    try { await deps.record({ kind: 'update_request', at, userId: who?.userId ?? null, outcome, ...extra }); return true; } catch { return false; }
  };
  const refuse = async (why: UpdateRefusal, extra: Record<string, unknown> = {}, detail?: string): Promise<UpdateAnswer> => {
    const kept = await write(`refused:${why}`, extra);
    return kept ? refused(why, detail) : refused('not_recorded');
  };
  if (who === null) return refuse('not_signed_in');
  if (!(deps.rolesOf(who.userId) ?? []).includes(OWNER_ROLE)) return refuse('not_the_owner');
  const confirmed = await deps.verifyPin(who.userId, typeof pin === 'string' ? pin : '', UPDATE_AUTHORITY);
  if (!confirmed.ok) return refuse('pin_not_confirmed', {}, confirmed.laneMessage);
  const open = await deps.openShifts();
  if (open.length > 0) {
    const tills = open.map((s) => `${s.tillId} (${s.custodian}, since ${s.openedAt})`).join(', ');
    return refuse('shift_open', { openShifts: open }, `Open: ${tills}.`);
  }
  const check = deps.check();
  if (check === undefined) return refuse('not_checked');
  if (check.state !== 'available' || check.latest === null || check.commit === undefined || check.sha256 === undefined) {
    return refuse('nothing_to_install', { checkState: check.state, latest: check.latest }, check.said);
  }
  const request = { kind: 'sre-store-pc-update-request-v1', requestedAt: at, requestedBy: who.userId, version: check.latest, tag: check.tag ?? null, commit: check.commit, sha256: check.sha256, from: check.running };
  if (!(await write('requested', { version: check.latest, from: check.running }))) return refused('not_recorded');
  try { await deps.leaveRequest(request); } catch {
    await write('refused:not_recorded', { version: check.latest, step: 'leave_request' });
    return refused('not_recorded');
  }
  return {
    ok: true, version: check.latest,
    en: `Update to version ${check.latest} is requested, in your name. The updater installs it and puts the old version back by itself if anything fails.`,
    ta: `பதிப்பு ${check.latest}-க்கு புதுப்பிக்க உங்கள் பெயரில் கோரப்பட்டது.`,
  };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface UpdatePageView {
  readonly check: UpdateCheckView | undefined;
  readonly isOwner: boolean;
  readonly displayName: string;
  readonly openShifts: readonly OpenShift[];
  /** True when the updater (step 3d) is not installed yet: the page says so beside the button. */
  readonly updaterPending: boolean;
}

/** The page, English and Tamil. Server-rendered; one small script posts the request as JSON from this page only. */
export function updatePage(v: UpdatePageView): string {
  const c = v.check;
  const headline = c === undefined
    ? { en: 'This PC has not checked for a new version yet.', ta: 'இந்தக் கணினி இன்னும் சரிபார்க்கவில்லை.', tone: 'grey' }
    : c.state === 'available' ? { en: `A new version is ready: ${c.latest}`, ta: `புதிய பதிப்பு தயார்: ${c.latest}`, tone: 'green' }
      : c.state === 'up-to-date' ? { en: 'Up to date', ta: 'புதுப்பித்த நிலையில் உள்ளது', tone: 'green' }
        : c.state === 'not-installable' ? { en: 'A newer version exists but cannot be installed', ta: 'புதிய பதிப்பு உள்ளது, ஆனால் நிறுவ முடியாது', tone: 'amber' }
          : { en: 'Could not check for a new version', ta: 'புதிய பதிப்பைச் சரிபார்க்க முடியவில்லை', tone: 'amber' };
  const facts = c === undefined ? '' : [
    '<table>',
    `<tr><th>This PC runs <span lang="ta">இயங்கும் பதிப்பு</span></th><td><code>${esc(c.running ?? 'unknown')}</code></td></tr>`,
    `<tr><th>Newest found <span lang="ta">கிடைத்த புதிய பதிப்பு</span></th><td><code>${esc(c.latest ?? '—')}</code></td></tr>`,
    `<tr><th>Checked at <span lang="ta">சரிபார்த்த நேரம்</span></th><td>${esc(c.checkedAt)}</td></tr>`,
    `<tr><th>What the check said <span lang="ta">சரிபார்ப்பு கூறியது</span></th><td>${esc(c.said)}</td></tr>`,
    '</table>',
  ].join('');
  const shifts = v.openShifts.length === 0 ? '' : `<p class="warn" id="shifts">${esc(REFUSAL_WORDS.shift_open.en)} <span lang="ta">${esc(REFUSAL_WORDS.shift_open.ta)}</span><br>${v.openShifts.map((s) => `${esc(s.tillId)} — ${esc(s.custodian)}`).join('<br>')}</p>`;
  const action = c?.state !== 'available' ? '' : !v.isOwner
    ? `<p class="note" id="owner-only">${esc(REFUSAL_WORDS.not_the_owner.en)} <span lang="ta">${esc(REFUSAL_WORDS.not_the_owner.ta)}</span></p>`
    : [
      '<form id="update-form" autocomplete="off">',
      `<label for="pin">${esc(v.displayName)}, type your own till PIN to confirm <span lang="ta">உறுதிசெய்ய உங்கள் PIN-ஐ உள்ளிடவும்</span></label>`,
      '<input id="pin" name="pin" type="password" inputmode="numeric" maxlength="12" required>',
      `<button type="submit" id="update-button"${v.openShifts.length > 0 ? ' disabled' : ''}>Update to ${esc(c.latest ?? '')} <span lang="ta">· புதுப்பிக்கவும்</span></button>`,
      v.updaterPending ? '<p class="note" id="updater-pending">The updater that installs it arrives in the next part of this change (CR-01 step 3d). Until then a request is written down and nothing is installed. <span lang="ta">நிறுவும் பகுதி அடுத்த கட்டத்தில் வரும்; அதுவரை கோரிக்கை மட்டும் பதிவு செய்யப்படும்.</span></p>' : '',
      '<p id="answer" role="status" aria-live="polite"></p>',
      '</form>',
      '<script>',
      "document.getElementById('update-form').addEventListener('submit',async function(e){e.preventDefault();",
      "var a=document.getElementById('answer'),b=document.getElementById('update-button'),p=document.getElementById('pin');b.disabled=true;a.textContent='…';",
      `try{var r=await fetch('${UPDATE_PATHS.request}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:p.value})});`,
      "var o=await r.json();a.textContent=o.en+(o.detail?' '+o.detail:'')+' — '+o.ta;a.className=o.ok?'ok':'warn';}catch(x){a.textContent='The store computer did not answer. Nothing was requested.';a.className='warn';}",
      "p.value='';b.disabled=false;});",
      '</script>',
    ].join('');
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Software update</title>',
    '<style>body{font:16px/1.5 system-ui,"Segoe UI","Nirmala UI",sans-serif;margin:0;background:#f5f6f8;color:#1b1f24}main{max-width:720px;margin:24px auto;padding:0 16px}',
    'h1{font-size:22px;margin:0 0 8px}h2{font-size:19px;margin:16px 0 8px}.green{color:#1d6b3a}.amber{color:#8a4b00}.grey{color:#5b6470}',
    'table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d6dae0;border-radius:8px}th,td{text-align:left;padding:10px 12px;border-top:1px solid #d6dae0;vertical-align:top}th{width:40%;font-weight:600}',
    'label{display:block;margin-top:16px;font-weight:600}input{font-size:20px;padding:8px;width:12em;margin:8px 0}button{font-size:18px;padding:12px 20px;min-height:48px;border:0;border-radius:8px;background:#1d6b3a;color:#fff;cursor:pointer}button[disabled]{opacity:.5;cursor:default}',
    '.warn{color:#8a1f11;font-weight:600}.ok{color:#1d6b3a;font-weight:600}.note{color:#5b6470}</style>',
    '</head><body><main>',
    '<h1>Software update <span lang="ta">· மென்பொருள் புதுப்பிப்பு</span></h1>',
    `<h2 class="${headline.tone}" id="headline">${esc(headline.en)} <span lang="ta">· ${esc(headline.ta)}</span></h2>`,
    facts, shifts, action,
    '<p class="note">Only the owner may update, with his own PIN, and never while a till shift is open. Every request is written down on this PC. <span lang="ta">உரிமையாளர் மட்டுமே, தன் PIN-உடன், எந்த ஷிஃப்டும் திறந்திருக்காத போது புதுப்பிக்கலாம்.</span></p>',
    '</main></body></html>',
  ].join('');
}
