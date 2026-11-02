// Operational alerts (W3 · M35-FR-04 · §32 · P-03 · P-04 · P-08) — a tested, DOM-free session over head office's alert
// lifecycle and alert rules (services/platform/src/alert-lifecycle.ts, observed-health.ts), which no screen reached: an alert
// could only ESCALATE, because nobody could see it or tick it as seen, and nobody could say who owns each kind of alert.
//   • MY ALERTS — the alerts that are this person's to answer (`GET /v1/platform/alerts/inbox`);
//   • EVERY LIVE ALERT — open, acknowledged, escalated and cleared, worst first (`GET /v1/platform/alerts`);
//   • ACKNOWLEDGE — a named person ticks an open alert as seen, which stops it escalating (`POST …/alerts/:id/acknowledge`).
//     A built-in alert is the owner's alone to tick (OB-119) — head office refuses anyone else, in its words;
//   • WHO OWNS EACH ALERT — the shop's alert rules (`GET /v1/platform/alert-rules`): for each, who gets it, how soon they must
//     answer and who it escalates to; change one or add one, and set how old the newest backup may be
//     (`PUT /v1/platform/alert-rules`, the whole set, based on the version read — a save on top of someone else's is refused,
//     OB-120). The built-in rules are shown as they are; changing them stays the owner's, on head office's own terms (OB-115).
// Reading needs `platform.health.read`; acknowledging and changing rules `platform.alert.manage`. Head office re-checks each.
// Every word this page adds has a Tamil twin; head office's own sentences stay in English (OB-553).

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const ALERT_LEVELS = ['down', 'degraded', 'unknown'] as const;

export const OPS_ALERTS_COPY = {
  en: {
    title: 'Operational alerts',
    lead: 'Problems with the shop\'s systems — a backup that did not run, a store computer that went quiet, a queue that is stuck. Each alert has a named owner who must tick it as seen in time, or it goes to the next person. Tick an alert once you are dealing with it.',
    mineH: 'My alerts', noMine: 'No alert is waiting for you.', allH: 'Every live alert', noAlerts: 'No alert has been raised.',
    st_open: 'open — nobody has ticked it yet', st_acknowledged: 'seen', st_escalated: 'escalated', st_cleared: 'cleared',
    lv_down: 'down', lv_degraded: 'not working well', lv_unknown: 'not known', lv_ok: 'fine',
    owner: 'owner', answerBy: 'answer by', escalatedTo: 'went to', seenBy: 'seen by', ack: 'Tick as seen',
    bi_on: 'on', bi_edited: 'changed by the owner', bi_off: 'turned off', bi_no_owner: 'no owner to reach yet', rulesH: 'Who owns each alert', noRules: 'No alert rules of the shop\'s own are set yet.', builtInH: 'Built-in alerts (they reach the owner)', builtInState: 'state',
    component: 'What it watches', firesAt: 'Raise it when it is', ownerId: 'Owner (staff id)', ownerName: 'Owner\'s name', ackMinutes: 'Must answer within (minutes)', escalatesTo: 'If not answered, goes to (staff id, optional)',
    save: 'Save this owner', addH: 'Add an alert', add: 'Add the alert', backupH: 'Backups', backupAge: 'Newest backup may be at most (hours old)', saveBackup: 'Save',
    acked: 'Ticked as seen. It will not escalate.', saved: 'Saved. The rules in force are now version', version: 'version',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see operational alerts.', cannotManage: 'You can see the alerts; ticking them and changing who owns them needs the alert manager\'s permission.',
    needComponent: 'Say what the alert watches.', needOwner: 'Name the owner (staff id and name).', needMinutes: 'Type the minutes as a whole number above 0.', needHours: 'Type the hours as a whole number above 0.', exists: 'An alert for that already exists — change its owner instead.', readFirst: 'Read the rules first.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Asking head office…',
  },
  ta: {
    title: 'செயல்பாட்டு எச்சரிக்கைகள்',
    lead: 'கடையின் அமைப்புகளில் உள்ள சிக்கல்கள் — இயங்காத காப்புப் பிரதி, அமைதியான கடைக் கணினி, சிக்கிய வரிசை. ஒவ்வொரு எச்சரிக்கைக்கும் பெயரிடப்பட்ட பொறுப்பாளர் உண்டு; அவர் நேரத்திற்குள் பார்த்ததாகக் குறிக்க வேண்டும், இல்லையெனில் அடுத்தவருக்குச் செல்லும். நீங்கள் கவனிக்கத் தொடங்கியதும் குறியுங்கள்.',
    mineH: 'என் எச்சரிக்கைகள்', noMine: 'உங்களுக்காக எந்த எச்சரிக்கையும் காத்திருக்கவில்லை.', allH: 'இயக்கத்தில் உள்ள எல்லா எச்சரிக்கைகளும்', noAlerts: 'எந்த எச்சரிக்கையும் எழுப்பப்படவில்லை.',
    st_open: 'திறந்தது — இன்னும் யாரும் குறிக்கவில்லை', st_acknowledged: 'பார்க்கப்பட்டது', st_escalated: 'மேலே அனுப்பப்பட்டது', st_cleared: 'சரியானது',
    lv_down: 'இயங்கவில்லை', lv_degraded: 'சரியாக இயங்கவில்லை', lv_unknown: 'தெரியவில்லை', lv_ok: 'சரி',
    owner: 'பொறுப்பாளர்', answerBy: 'பதில் அளிக்க வேண்டிய நேரம்', escalatedTo: 'அனுப்பப்பட்டவர்', seenBy: 'பார்த்தவர்', ack: 'பார்த்ததாகக் குறி',
    bi_on: 'இயக்கத்தில்', bi_edited: 'உரிமையாளரால் மாற்றப்பட்டது', bi_off: 'நிறுத்தப்பட்டது', bi_no_owner: 'அனுப்ப இன்னும் உரிமையாளர் இல்லை', rulesH: 'ஒவ்வொரு எச்சரிக்கையின் பொறுப்பாளர்', noRules: 'கடையின் சொந்த எச்சரிக்கை விதிகள் இன்னும் அமைக்கப்படவில்லை.', builtInH: 'உள்ளமைந்த எச்சரிக்கைகள் (உரிமையாளருக்குச் செல்லும்)', builtInState: 'நிலை',
    component: 'எதைக் கண்காணிக்கிறது', firesAt: 'எப்போது எழுப்புவது', ownerId: 'பொறுப்பாளர் (பணியாளர் அடையாளம்)', ownerName: 'பொறுப்பாளர் பெயர்', ackMinutes: 'பதில் அளிக்க வேண்டிய நேரம் (நிமிடங்கள்)', escalatesTo: 'பதில் இல்லையெனில் செல்லும் நபர் (பணியாளர் அடையாளம், விருப்பம்)',
    save: 'இந்தப் பொறுப்பாளரைச் சேமி', addH: 'ஒரு எச்சரிக்கையைச் சேர்', add: 'எச்சரிக்கையைச் சேர்', backupH: 'காப்புப் பிரதிகள்', backupAge: 'புதிய காப்புப் பிரதி அதிகபட்சம் (மணி நேரம் பழையது)', saveBackup: 'சேமி',
    acked: 'பார்த்ததாகக் குறிக்கப்பட்டது. இது மேலே அனுப்பப்படாது.', saved: 'சேமிக்கப்பட்டது. நடைமுறையில் உள்ள விதிகள் இப்போது பதிப்பு', version: 'பதிப்பு',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு செயல்பாட்டு எச்சரிக்கைகளைப் பார்க்க முடியாது.', cannotManage: 'எச்சரிக்கைகளைப் பார்க்கலாம்; குறிக்கவும் பொறுப்பாளரை மாற்றவும் எச்சரிக்கை மேலாளர் அனுமதி தேவை.',
    needComponent: 'எச்சரிக்கை எதைக் கண்காணிக்கிறது என்று சொல்லுங்கள்.', needOwner: 'பொறுப்பாளரைக் குறிப்பிடுங்கள் (பணியாளர் அடையாளமும் பெயரும்).', needMinutes: 'நிமிடங்களை 0-க்கு மேற்பட்ட முழு எண்ணாகத் தட்டச்சு செய்யுங்கள்.', needHours: 'மணி நேரத்தை 0-க்கு மேற்பட்ட முழு எண்ணாகத் தட்டச்சு செய்யுங்கள்.', exists: 'அதற்கான எச்சரிக்கை ஏற்கனவே உள்ளது — அதன் பொறுப்பாளரை மாற்றுங்கள்.', readFirst: 'முதலில் விதிகளைப் படியுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.', reading: 'தலைமை அலுவலகத்திடம் கேட்கிறது…',
  },
} as const;

export const opsAlertsWords = (lang: Lang, key: string): string =>
  (OPS_ALERTS_COPY[lang] as Record<string, string>)[key] ?? (OPS_ALERTS_COPY.en as Record<string, string>)[key] ?? key;
export const opsAlertsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => opsAlertsWords(lang, k), out);

export interface AlertRow {
  readonly alertId: string; readonly component: string; readonly level: string; readonly detail: string; readonly ownerUserId: string; readonly ownerName: string;
  readonly ackDueBy: string; readonly state: string; readonly acknowledgedBy?: string; readonly escalatedTo?: string; readonly builtIn: boolean;
}
export interface AlertRule { readonly alertId: string; readonly component: string; readonly firesAt: string; readonly ownerUserId: string; readonly ownerName: string; readonly ackWithinMinutes: number; readonly escalatesToUserId?: string; readonly branchId?: string; readonly [k: string]: unknown }
export interface AlertRules {
  readonly version: number; readonly rules: readonly AlertRule[]; readonly builtIn: readonly { readonly alertId: string; readonly state: string; readonly words: string }[];
  readonly thresholds: unknown; readonly backupMaxAgeSeconds: number;
}
export interface OwnerForm { readonly ownerUserId: string; readonly ownerName: string; readonly ackWithinMinutes: string; readonly escalatesToUserId: string }

type Why = 'nobody' | 'cannotRead' | 'cannotManage' | 'needComponent' | 'needOwner' | 'needMinutes' | 'needHours' | 'exists' | 'readFirst';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const RESERVED = /^(built-in|notice):/;
const whole = (raw: string): number | undefined => (/^\d{1,6}$/.test(raw.trim()) && Number(raw.trim()) > 0 ? Number(raw.trim()) : undefined);

function alertRowOf(a: unknown): AlertRow[] {
  if (!isObj(a) || !isObj(a['alert']) || typeof a['alert']['alertId'] !== 'string') return [];
  const al = a['alert'];
  return [{
    alertId: al['alertId'] as string, component: str(al['component']), level: str(al['status']), detail: str(al['detail']), ownerUserId: str(al['ownerUserId']), ownerName: str(al['ownerName']),
    ackDueBy: str(al['ackDueBy']), state: str(a['state']), builtIn: RESERVED.test(al['alertId'] as string),
    ...(typeof a['acknowledgedBy'] === 'string' ? { acknowledgedBy: a['acknowledgedBy'] } : {}), ...(typeof a['escalatedTo'] === 'string' ? { escalatedTo: a['escalatedTo'] } : {}),
  }];
}

/** The id a new alert rule gets: what it watches and the level it fires at, in the shop's own words (never a reserved name). */
export const ruleIdOf = (component: string, firesAt: string): string => `shop:${component.trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-')}:${firesAt}`;

export interface OpsAlertsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean };
  mine(): Done<readonly AlertRow[]>;
  board(): Done<readonly AlertRow[]>;
  acknowledge(alertId: string): Done<{ readonly acknowledged: true }>;
  rules(): Done<AlertRules>;
  setOwner(rules: AlertRules, alertId: string, form: OwnerForm): Done<{ readonly version: number }>;
  addRule(rules: AlertRules, input: OwnerForm & { readonly component: string; readonly firesAt: string }): Done<{ readonly version: number }>;
  setBackupAge(rules: AlertRules, hours: string): Done<{ readonly version: number }>;
}

export function createOpsAlertsSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): OpsAlertsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('platform.health.read'), manage: named && held.has('platform.alert.manage') };
  const call = makeCaller({ keyPrefix: 'ops-alerts', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'manage') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : 'cannotManage') : undefined);
  const ownerOf = (f: OwnerForm): Outcome<Pick<AlertRule, 'ownerUserId' | 'ownerName' | 'ackWithinMinutes' | 'escalatesToUserId'>, Why> => {
    if (f.ownerUserId.trim() === '' || f.ownerName.trim() === '') return no('needOwner');
    const minutes = whole(f.ackWithinMinutes);
    if (minutes === undefined) return no('needMinutes');
    return { result: 'ok', value: { ownerUserId: f.ownerUserId.trim(), ownerName: f.ownerName.trim(), ackWithinMinutes: minutes, ...(f.escalatesToUserId.trim() === '' ? {} : { escalatesToUserId: f.escalatesToUserId.trim() }) } };
  };
  // The whole set, as read, with this change — based on the version read (OB-120: a save on top of another is refused).
  const save = async (r: AlertRules, rules: readonly AlertRule[], backupMaxAgeSeconds: number): Done<{ readonly version: number }> => {
    const out = await call<{ version?: unknown }>('PUT', '/v1/platform/alert-rules', { rules, ...(r.thresholds === null || r.thresholds === undefined ? {} : { thresholds: r.thresholds }), backupMaxAgeSeconds, basedOnVersion: r.version });
    if (out.result !== 'ok') return out;
    return { result: 'ok', value: { version: typeof out.value.version === 'number' ? out.value.version : r.version + 1 } };
  };
  return {
    may,
    mine: async () => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ alerts?: unknown[] }>('GET', '/v1/platform/alerts/inbox');
      return out.result === 'ok' ? { result: 'ok', value: (out.value.alerts ?? []).flatMap(alertRowOf) } : out;
    },
    board: async () => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ alerts?: unknown[] }>('GET', '/v1/platform/alerts');
      return out.result === 'ok' ? { result: 'ok', value: (out.value.alerts ?? []).flatMap(alertRowOf) } : out;
    },
    acknowledge: async (alertId) => {
      const g = gate('manage'); if (g) return g;
      const out = await call('POST', `/v1/platform/alerts/${encodeURIComponent(alertId)}/acknowledge`, {});
      return out.result === 'ok' ? { result: 'ok', value: { acknowledged: true } } : out;
    },
    rules: async () => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ rules?: unknown; builtIn?: unknown[]; defaults?: unknown }>('GET', '/v1/platform/alert-rules');
      if (out.result !== 'ok') return out;
      const stored = isObj(out.value.rules) ? out.value.rules : undefined;
      const defaults = isObj(out.value.defaults) ? out.value.defaults : {};
      const rules = (Array.isArray(stored?.['rules']) ? stored['rules'] as unknown[] : []).filter((x): x is AlertRule => isObj(x) && typeof x['alertId'] === 'string');
      const builtIn = (out.value.builtIn ?? []).flatMap((b) => (isObj(b) && typeof b['alertId'] === 'string'
        ? [{ alertId: b['alertId'], state: str(b['state']), words: str(b['description']) }] : []));
      return {
        result: 'ok',
        value: {
          version: typeof stored?.['version'] === 'number' ? stored['version'] : 0, rules, builtIn,
          thresholds: stored?.['thresholds'] ?? null,
          backupMaxAgeSeconds: typeof stored?.['backupMaxAgeSeconds'] === 'number' ? stored['backupMaxAgeSeconds'] : typeof defaults['backupMaxAgeSeconds'] === 'number' ? defaults['backupMaxAgeSeconds'] : 86_400,
        },
      };
    },
    setOwner: async (r, alertId, form) => {
      const g = gate('manage'); if (g) return g;
      const owner = ownerOf(form); if (owner.result !== 'ok') return owner;
      const rules = r.rules.map((x) => {
        if (x.alertId !== alertId) return x;
        const { escalatesToUserId: _drop, ...rest } = x;
        return { ...rest, ...owner.value };
      });
      return save(r, rules, r.backupMaxAgeSeconds);
    },
    addRule: async (r, a) => {
      const g = gate('manage'); if (g) return g;
      if (a.component.trim() === '') return no('needComponent');
      const owner = ownerOf(a); if (owner.result !== 'ok') return owner;
      const alertId = ruleIdOf(a.component, a.firesAt);
      if (r.rules.some((x) => x.alertId === alertId)) return no('exists');
      return save(r, [...r.rules, { alertId, component: a.component.trim(), firesAt: a.firesAt, ...owner.value }], r.backupMaxAgeSeconds);
    },
    setBackupAge: async (r, hours) => {
      const g = gate('manage'); if (g) return g;
      const h = whole(hours);
      if (h === undefined) return no('needHours');
      if (r.rules.length === 0) return no('needComponent');
      return save(r, r.rules, h * 3600);
    },
  };
}
