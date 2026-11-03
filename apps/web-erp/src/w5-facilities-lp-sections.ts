// W5 (bundle 5 — store operations, part 2): the facilities records (M26-FR-01/02/04) on the Facilities set-up page, and the
// loss-prevention reads and sealed evidence (M15-FR-04, M13) on the Loss prevention and Return governance pages — tested,
// DOM-free sections drawn by `apps/web-erp/web/w5-sections.js` (the shapes are in `w5-store-ops-sections.ts`).
//
//   • Facilities set-up — asset health on a day (critical assets in their own list), downtime measured from when the asset
//     FAILED (not when it was reported), energy readings with their source (an estimate is said to be one), power events
//     (mains, generator, UPS) and the power report by what it protects, and what is in a cold room now (the batches a breach
//     would hold). A typed time is the SHOP's clock (Asia/Kolkata), never the device's.
//   • Loss prevention — the rule feedback (closed outcomes say whether a rule should be kept, tightened or retired — advice
//     for a person; nothing changes a rule from here), sealed evidence added to a case with its chain of custody (a CCTV clip
//     stays a reference on its own form), and the bills where more came back than was sold.
//   • Return governance — the report of every return taken without a bill: what it cost and who gave and approved it.

import { shopDay, instantOfTyped } from '../../../packages/calendar/src/shop-day';
import { shopMomentOf } from './findings-session';
import { makeCaller, newId } from './r4-insight-call';
import {
  W5_COMMON_COPY, wordsOf, raw, join, said, invalid, rupees, paiseOf, type Lang, type W5Action, type W5Field, type W5Line, type W5Section, type SectionInput, type Tone,
} from './w5-store-ops-sections';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const filled = (v: string | undefined): string | undefined => { const s = (v ?? '').trim(); return s === '' ? undefined : s; };
const enc = encodeURIComponent;
const common = wordsOf(W5_COMMON_COPY);

function setup(input: SectionInput, prefix: string) {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = (p: string): boolean => named && held.has(p);
  const call = makeCaller({ keyPrefix: prefix, ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const id = (p: string): string => (input.ids === undefined ? newId(p) : `${p}-${input.ids()}`);
  return { may, call, id, userId: input.viewer?.userId };
}
const only = (actions: readonly (W5Action | null)[]): W5Action[] => actions.filter((a): a is W5Action => a !== null);

// ═════════════════════════════════════════════════ Facilities set-up — the records ═════════════════════════════════════

export const FACILITIES_RECORDS_COPY = {
  en: {
    h: 'Facilities records — breakdowns, energy, power and cold-room contents', lead: 'What happened to the shop\'s equipment and power, kept as it happened. A breakdown is measured from when the equipment FAILED, not when someone reported it. An energy figure says whether it was read off a meter, a bill or estimated. Times are the shop\'s clock.',
    health: 'Equipment health on a day', day: 'Day', healthGo: 'Check', critical: 'Critical: {asset} — {state}', other: '{asset} — {state}', noAssets: 'No equipment is registered for this store.',
    healthFine: 'Every piece of equipment is covered and serviced.',
    hs_amc_expiring: 'maintenance contract running out', hs_amc_expired: 'MAINTENANCE CONTRACT EXPIRED', hs_amc_missing: 'NO MAINTENANCE CONTRACT', hs_warranty_expiring: 'warranty running out', hs_service_overdue: 'SERVICE OVERDUE', hs_never_serviced: 'NEVER SERVICED',
    downtime: 'Breakdowns so far', downtimeGo: 'Show them', downLine: '{asset}: {minutes} minute(s) down over {events} breakdown(s){still}{unreported}', stillDown: ' — STILL DOWN', unreported: ' — {late} minute(s) before anyone reported it', noDowntime: 'No breakdown recorded.',
    recordDown: 'Record a breakdown', asset: 'Equipment (asset code)', failedAt: 'When it failed', reportedAt: 'When it was reported', restoredAt: 'When it was working again', cause: 'Cause', downGo: 'Record the breakdown', downSaved: 'Breakdown {id} recorded{still}.', downStill: ' — the equipment is still down',
    energy: 'Record an energy reading', onDate: 'Day', kwh: 'Kilowatt-hours', cost: 'Cost (₹)', source: 'Where the figure came from', src_meter: 'Read off the meter', src_bill: 'From the bill', src_estimate: 'Estimated', energyGo: 'Record the reading', energySaved: 'Reading {id} recorded ({source}).',
    energyReport: 'Energy used over days', from: 'From', to: 'To', reportGo: 'Show the report', energyLine: '{kwh} kWh costing {cost} — {estimated} of the cost estimated, not metered', noEnergy: 'No reading in those days.',
    power: 'Record a power event', kind: 'What happened', at: 'When', note: 'Note', powerGo: 'Record it', powerSaved: 'Power event {id} recorded: {kind}.',
    pk_mains_failed: 'Mains power failed', pk_mains_restored: 'Mains power back', pk_dg_started: 'Generator started', pk_dg_failed_to_start: 'Generator FAILED to start', pk_ups_on_battery: 'UPS on battery', pk_ups_depleted: 'UPS battery ran out',
    powerReport: 'Power: what was left unprotected', powerReportGo: 'Show it', powerHead: '{unprotected} minute(s) with no power and nothing behind it.', noBackup: 'Lost power with no backup behind: {assets}',
    contents: 'What is in a cold room or freezer now', room: 'Cold room or freezer (asset code)', lines: 'One batch a line: batch, product, value in ₹ (e.g. B12, MILK-1L, 1200)', contentsGo: 'Save what is in it', contentsSaved: '{room} holds {n} batch(es) worth {value} — a temperature breach would hold them.', badLine: 'Line {n} is not "batch, product, value in ₹".',
    needStore: 'This page does not know its store, so these records cannot be written from here.',
  },
  ta: {
    h: 'வசதிப் பதிவுகள் — பழுதுகள், மின்சக்தி, மின்சாரம், குளிர் அறை உள்ளடக்கம்', lead: 'கடையின் உபகரணங்களுக்கும் மின்சாரத்திற்கும் நடந்தது, நடந்தபடியே வைக்கப்படுகிறது. பழுது, யாராவது தெரிவித்த நேரத்திலிருந்து அல்ல, உபகரணம் பழுதான நேரத்திலிருந்து அளக்கப்படுகிறது. மின் அளவு மீட்டரிலிருந்தா, பில்லிலிருந்தா, மதிப்பீடா என்று சொல்கிறது. நேரங்கள் கடையின் கடிகாரம்.',
    health: 'ஒரு நாளில் உபகரண நிலை', day: 'நாள்', healthGo: 'சரிபார்', critical: 'முக்கியம்: {asset} — {state}', other: '{asset} — {state}', noAssets: 'இந்தக் கடைக்கு எந்த உபகரணமும் பதியப்படவில்லை.',
    healthFine: 'ஒவ்வொரு உபகரணமும் ஒப்பந்தத்திலும் பராமரிப்பிலும் உள்ளது.',
    hs_amc_expiring: 'பராமரிப்பு ஒப்பந்தம் முடிகிறது', hs_amc_expired: 'பராமரிப்பு ஒப்பந்தம் முடிந்தது', hs_amc_missing: 'பராமரிப்பு ஒப்பந்தம் இல்லை', hs_warranty_expiring: 'உத்தரவாதம் முடிகிறது', hs_service_overdue: 'பராமரிப்பு தாமதம்', hs_never_serviced: 'ஒருபோதும் பராமரிக்கப்படவில்லை',
    downtime: 'இதுவரை பழுதுகள்', downtimeGo: 'காட்டு', downLine: '{asset}: {events} பழுதுகளில் {minutes} நிமிடம் இயங்கவில்லை{still}{unreported}', stillDown: ' — இன்னும் இயங்கவில்லை', unreported: ' — யாரும் தெரிவிக்கும் முன் {late} நிமிடம்', noDowntime: 'எந்தப் பழுதும் பதியப்படவில்லை.',
    recordDown: 'பழுதைப் பதி', asset: 'உபகரணம் (சொத்துக் குறியீடு)', failedAt: 'பழுதான நேரம்', reportedAt: 'தெரிவித்த நேரம்', restoredAt: 'மீண்டும் இயங்கிய நேரம்', cause: 'காரணம்', downGo: 'பழுதைப் பதி', downSaved: 'பழுது {id} பதியப்பட்டது{still}.', downStill: ' — உபகரணம் இன்னும் இயங்கவில்லை',
    energy: 'மின் அளவைப் பதி', onDate: 'நாள்', kwh: 'கிலோவாட்-மணி', cost: 'செலவு (₹)', source: 'அளவு எங்கிருந்து', src_meter: 'மீட்டரில் படித்தது', src_bill: 'பில்லிலிருந்து', src_estimate: 'மதிப்பீடு', energyGo: 'அளவைப் பதி', energySaved: 'அளவு {id} பதியப்பட்டது ({source}).',
    energyReport: 'நாட்களில் பயன்பட்ட மின்சக்தி', from: 'இருந்து', to: 'வரை', reportGo: 'அறிக்கையைக் காட்டு', energyLine: '{kwh} kWh, செலவு {cost} — செலவில் {estimated} மதிப்பீடு, மீட்டர் அல்ல', noEnergy: 'அந்த நாட்களில் எந்த அளவும் இல்லை.',
    power: 'மின்சார நிகழ்வைப் பதி', kind: 'என்ன நடந்தது', at: 'எப்போது', note: 'குறிப்பு', powerGo: 'பதி', powerSaved: 'மின்சார நிகழ்வு {id} பதியப்பட்டது: {kind}.',
    pk_mains_failed: 'மின்சாரம் தடைபட்டது', pk_mains_restored: 'மின்சாரம் திரும்பியது', pk_dg_started: 'ஜெனரேட்டர் தொடங்கியது', pk_dg_failed_to_start: 'ஜெனரேட்டர் தொடங்கவில்லை', pk_ups_on_battery: 'யுபிஎஸ் பேட்டரியில்', pk_ups_depleted: 'யுபிஎஸ் பேட்டரி தீர்ந்தது',
    powerReport: 'மின்சாரம்: பாதுகாப்பின்றி விடப்பட்டது', powerReportGo: 'காட்டு', powerHead: '{unprotected} நிமிடம் மின்சாரமும் பின்னால் காப்பும் இல்லை.', noBackup: 'காப்பு இல்லாமல் மின்சாரம் இழந்தவை: {assets}',
    contents: 'குளிர் அறை அல்லது உறைவிப்பானில் இப்போது உள்ளது', room: 'குளிர் அறை அல்லது உறைவிப்பான் (சொத்துக் குறியீடு)', lines: 'ஒரு வரிக்கு ஒரு தொகுதி: தொகுதி, பொருள், ₹ மதிப்பு (எ.கா. B12, MILK-1L, 1200)', contentsGo: 'உள்ளதைச் சேமி', contentsSaved: '{room}இல் {value} மதிப்புள்ள {n} தொகுதிகள் — வெப்ப மீறல் அவற்றை நிறுத்தி வைக்கும்.', badLine: 'வரி {n} "தொகுதி, பொருள், ₹ மதிப்பு" அல்ல.',
    needStore: 'இந்தப் பக்கத்திற்குத் தன் கடை தெரியாது, எனவே இந்தப் பதிவுகளை இங்கிருந்து எழுத முடியாது.',
  },
} as const;

const POWER_KINDS = ['mains_failed', 'mains_restored', 'dg_started', 'dg_failed_to_start', 'ups_on_battery', 'ups_depleted'] as const;

export function facilitiesRecordsSection(input: SectionInput & { readonly storeId?: string; readonly now?: () => string; readonly timeZone?: string }): W5Section | null {
  const { may, call, id } = setup(input, 'w5-fac');
  const w = wordsOf(FACILITIES_RECORDS_COPY);
  const now = input.now ?? (() => new Date().toISOString());
  const day = shopDay(input.timeZone, now);
  const branch = input.storeId;
  const when = (typed: string | undefined): string => (input.timeZone === undefined ? instantOfTyped(typed ?? '') : instantOfTyped(typed ?? '', input.timeZone));
  const isDate = (v: string | undefined): v is string => /^\d{4}-\d{2}-\d{2}$/.test((v ?? '').trim());
  if (branch === undefined) return null;
  const asset: W5Field = { key: 'asset', label: w('asset'), kind: 'text' };
  const actions: (W5Action | null)[] = [
    !may('facilities.asset.read') ? null : {
      id: 'health', title: w('health'), go: w('healthGo'), fields: [{ key: 'day', label: w('day'), kind: 'date', initial: day.today() }],
      run: async (v) => {
        const d = (v['day'] ?? '').trim() === '' ? day.today() : (v['day'] ?? '').trim();
        if (!isDate(d)) return invalid(common('needDate'));
        return said(await call<Record<string, unknown>>('GET', `/v1/facilities/assets/health?branchId=${enc(branch)}&asOf=${enc(d)}`), (b) => {
          // Head office's alerts: critical equipment in its OWN list, first; each with head office's own sentence.
          const row = (r: Record<string, unknown>, crit: boolean): W5Line => {
            const kind = str(r['kind']);
            const tone: Tone = kind.endsWith('expiring') ? 'warn' : 'error';
            return { key: `${str(r['assetId'])}|${kind}`, tone, text: (l: Lang) => w(crit ? 'critical' : 'other', { asset: `${str(r['name'])} (${str(r['assetId'])})`, state: w(`hs_${kind}`)(l) })(l) + ` — ${str(r['detail'])}` };
          };
          const lines = [...arr(b['critical']).filter(isObj).map((r) => row(r, true)), ...arr(b['other']).filter(isObj).map((r) => row(r, false))];
          return lines.length === 0 ? { tone: 'ok', text: w('healthFine') } : { tone: arr(b['critical']).length > 0 ? 'error' : 'warn', text: raw(str(b['detail'])), lines };
        });
      },
    },
    !may('facilities.asset.read') ? null : {
      id: 'downtime', title: w('downtime'), go: w('downtimeGo'), fields: [], auto: true,
      run: async () => said(await call<Record<string, unknown>>('GET', `/v1/facilities/assets/downtime?asOf=${enc(now())}`), (b) => {
        const rows = arr(b['summaries']).filter(isObj);
        if (rows.length === 0) return { tone: 'info', text: w('noDowntime') };
        return {
          tone: rows.some((r) => r['stillDown'] === true) ? 'error' : 'info', text: raw(''),
          lines: rows.map((r) => {
            const late = num(r['unreportedMinutes']) ?? 0;
            return {
              key: str(r['assetId']), tone: r['stillDown'] === true ? 'error' as const : 'warn' as const,
              text: (l: Lang) => w('downLine', {
                asset: str(r['name']), minutes: str(r['totalMinutes']), events: str(r['events']),
                still: r['stillDown'] === true ? w('stillDown')(l) : '', unreported: late > 0 ? w('unreported', { late })(l) : '',
              })(l),
            };
          }),
        };
      }),
    },
    !may('facilities.asset.manage') ? null : {
      id: 'record-downtime', title: w('recordDown'), go: w('downGo'), refresh: ['downtime'],
      fields: [asset, { key: 'failedAt', label: w('failedAt'), kind: 'datetime' }, { key: 'reportedAt', label: w('reportedAt'), kind: 'datetime' },
        { key: 'restoredAt', label: join(w('restoredAt'), common('optional')), kind: 'datetime' }, { key: 'cause', label: join(w('cause'), common('optional')), kind: 'text' }],
      run: async (v) => {
        const a = filled(v['asset']); const failedAt = when(v['failedAt']); const reportedAt = when(v['reportedAt']);
        if (a === undefined) return invalid(common('needText'));
        if (failedAt === '' || reportedAt === '') return invalid(common('needWhen'));
        const restored = filled(v['restoredAt']) === undefined ? undefined : when(v['restoredAt']);
        if (restored === '') return invalid(common('needWhen'));
        const cause = filled(v['cause']); const eid = id('down');
        return said(await call<Record<string, unknown>>('POST', `/v1/facilities/assets/${enc(a)}/downtime/${enc(eid)}`, { failedAt, reportedAt, ...(restored === undefined ? {} : { restoredAt: restored }), ...(cause === undefined ? {} : { cause }) }),
          (b) => ({ tone: b['stillDown'] === true ? 'warn' : 'ok', text: (l: Lang) => w('downSaved', { id: eid, still: b['stillDown'] === true ? w('downStill')(l) : '' })(l) }));
      },
    },
    !may('facilities.asset.manage') ? null : {
      id: 'energy', title: w('energy'), go: w('energyGo'),
      fields: [{ key: 'onDate', label: w('onDate'), kind: 'date', initial: day.today() }, { key: 'kwh', label: w('kwh'), kind: 'text' }, { key: 'cost', label: w('cost'), kind: 'money' },
        { key: 'source', label: w('source'), kind: 'select', options: (['meter', 'bill', 'estimate'] as const).map((s) => ({ value: s, label: w(`src_${s}`) })) },
        { ...asset, label: join(w('asset'), common('optional')) }],
      run: async (v) => {
        const d = (v['onDate'] ?? '').trim(); const kwh = Number((v['kwh'] ?? '').trim()); const cost = paiseOf(v['cost']); const src = v['source'];
        if (!isDate(d)) return invalid(common('needDate'));
        if ((v['kwh'] ?? '').trim() === '' || !Number.isFinite(kwh) || kwh < 0) return invalid(common('needWhole'));
        if (cost === undefined) return invalid(common('needMoney'));
        if (src !== 'meter' && src !== 'bill' && src !== 'estimate') return invalid(common('needText'));
        const a = filled(v['asset']); const rid = id('kwh');
        return said(await call('POST', `/v1/facilities/energy/${enc(rid)}`, { branchId: branch, onDate: d, kilowattHours: kwh, costMinor: cost, source: src, ...(a === undefined ? {} : { assetId: a }) }),
          () => ({ tone: 'ok', text: (l: Lang) => w('energySaved', { id: rid, source: w(`src_${src}`)(l) })(l) }));
      },
    },
    !may('facilities.asset.read') ? null : {
      id: 'energy-report', title: w('energyReport'), go: w('reportGo'),
      fields: [{ key: 'from', label: w('from'), kind: 'date', initial: day.daysAgo(30) }, { key: 'to', label: w('to'), kind: 'date', initial: day.today() }],
      run: async (v) => {
        const from = (v['from'] ?? '').trim(); const to = (v['to'] ?? '').trim();
        if (!isDate(from) || !isDate(to)) return invalid(common('needDate'));
        return said(await call<Record<string, unknown>>('GET', `/v1/facilities/energy?branchId=${enc(branch)}&from=${enc(from)}&to=${enc(to)}`), (b) => {
          const kwh = num(b['kilowattHours']) ?? 0; const cost = num(b['costMinor']) ?? 0; const est = num(b['estimatedShareBps']);
          if (kwh === 0 && cost === 0) return { tone: 'info', text: w('noEnergy') };
          return { tone: (est ?? 0) > 0 ? 'warn' : 'ok', text: w('energyLine', { kwh, cost: rupees(cost), estimated: `${((est ?? 0) / 100).toFixed(1)}%` }) };
        });
      },
    },
    !may('facilities.reading.record') ? null : {
      id: 'power', title: w('power'), go: w('powerGo'), refresh: ['power-report'],
      fields: [{ key: 'kind', label: w('kind'), kind: 'select', options: POWER_KINDS.map((k) => ({ value: k, label: w(`pk_${k}`) })) }, { key: 'at', label: w('at'), kind: 'datetime' }, { key: 'note', label: join(w('note'), common('optional')), kind: 'text' }],
      run: async (v) => {
        const kind = (POWER_KINDS as readonly string[]).includes(v['kind'] ?? '') ? v['kind']! : undefined; const at = when(v['at']);
        if (kind === undefined) return invalid(common('needText'));
        if (at === '') return invalid(common('needWhen'));
        const note = filled(v['note']); const eid = id('pwr');
        return said(await call('POST', `/v1/facilities/power/${enc(eid)}`, { branchId: branch, kind, at, ...(note === undefined ? {} : { note }) }),
          () => ({ tone: kind.includes('fail') || kind === 'ups_depleted' ? 'warn' : 'ok', text: (l: Lang) => w('powerSaved', { id: eid, kind: w(`pk_${kind}`)(l) })(l) }));
      },
    },
    !may('facilities.asset.read') ? null : {
      id: 'power-report', title: w('powerReport'), go: w('powerReportGo'), fields: [],
      run: async () => said(await call<Record<string, unknown>>('GET', `/v1/facilities/power?branchId=${enc(branch)}&asOf=${enc(now())}`), (b) => {
        const exposed = arr(b['assetsAtRisk']).map(str);
        const head = join(w('powerHead', { unprotected: str(b['unprotectedMinutes'] ?? 0) }), raw(str(b['detail'])));
        return exposed.length === 0
          ? { tone: b['severity'] === 'normal' ? 'ok' : 'warn', text: head }
          : { tone: 'error', text: head, lines: [{ key: 'no-backup', tone: 'error', text: w('noBackup', { assets: exposed.join(', ') }) }] };
      }),
    },
    !may('facilities.asset.manage') ? null : {
      id: 'contents', title: w('contents'), go: w('contentsGo'),
      fields: [{ key: 'room', label: w('room'), kind: 'text' }, { key: 'lines', label: w('lines'), kind: 'lines' }],
      run: async (v) => {
        const room = filled(v['room']);
        if (room === undefined) return invalid(common('needText'));
        const rows = (v['lines'] ?? '').split('\n').map((x) => x.trim()).filter((x) => x !== '');
        const contents: { batchId: string; productId: string; valueMinor: number }[] = [];
        for (const [i, r] of rows.entries()) {
          const [b, p, value, ...rest] = r.split(',').map((x) => x.trim());
          const minor = paiseOf(value);
          if (b === undefined || b === '' || p === undefined || p === '' || minor === undefined || rest.length > 0) return invalid(w('badLine', { n: i + 1 }));
          contents.push({ batchId: b, productId: p, valueMinor: minor });
        }
        return said(await call<Record<string, unknown>>('POST', `/v1/facilities/equipment/${enc(room)}/contents`, { contents }),
          (b) => ({ tone: 'ok', text: w('contentsSaved', { room, n: str(b['batches']), value: rupees(num(b['valueMinor']) ?? 0) }) }));
      },
    },
  ];
  return { id: 'w5-facilities', heading: w('h'), lead: w('lead'), actions: only(actions) };
}

// ═════════════════════════════════════════════════ Loss prevention — feedback, evidence, over-returns ══════════════════

export const LP_RECORDS_COPY = {
  en: {
    h: 'Rules, sealed evidence and over-returns', lead: 'What closed investigations say about each rule that raised them — advice for a person: nothing here changes a rule. Evidence added to a case is sealed onto its chain and can never be edited or removed; a CCTV clip is recorded only as a reference, on its own form. A bill with more back than was sold is money already gone — it is shown, never quietly corrected.',
    feedback: 'What closed cases say about each rule', feedbackGo: 'Show it', fbLine: '{rule}: {action} — {detail}', noFeedback: 'No investigation has closed yet.',
    a_keep: 'keep', a_retire: 'RETIRE', a_relax: 'relax', a_tighten: 'TIGHTEN',
    evidence: 'Add sealed evidence to a case', caseId: 'Case number', kind: 'Kind of evidence', ref: 'Reference (bill, count or record number)', description: 'What it shows', collectedBy: 'Collected by', collectedFrom: 'Collected from (where it was taken)', evidenceGo: 'Seal it onto the case',
    k_transaction_record: 'A bill or till record', k_witness_statement: 'A witness statement', k_stock_count: 'A stock count', k_settlement_record: 'A card or UPI settlement record', k_note: 'A note',
    sealed: 'Sealed onto case {case} as item {n} — seal {seal}. It can never be edited or removed.',
    over: 'A bill with more returned than was sold', sale: 'Bill (sale) number', overGo: 'Check the bill', overNone: 'Nothing on bill {sale} came back more than once.', overLine: '{product}: {returned} came back, {sold} were sold — {extra} too many',
  },
  ta: {
    h: 'விதிகள், முத்திரையிட்ட சான்று, அதிகத் திருப்பங்கள்', lead: 'மூடப்பட்ட விசாரணைகள் அவற்றை எழுப்பிய ஒவ்வொரு விதியைப் பற்றியும் சொல்வது — ஒருவருக்கான ஆலோசனை: இங்கே எதுவும் விதியை மாற்றாது. வழக்கில் சேர்க்கப்படும் சான்று அதன் சங்கிலியில் முத்திரையிடப்படும், ஒருபோதும் திருத்தவோ நீக்கவோ முடியாது; சிசிடிவி பதிவு அதன் சொந்தப் படிவத்தில் குறிப்பாக மட்டுமே பதியப்படும். விற்றதை விட அதிகம் திரும்பிய பில் ஏற்கனவே போன பணம் — அது காட்டப்படும், அமைதியாகச் சரிசெய்யப்படாது.',
    feedback: 'மூடிய வழக்குகள் ஒவ்வொரு விதியைப் பற்றியும் சொல்வது', feedbackGo: 'காட்டு', fbLine: '{rule}: {action} — {detail}', noFeedback: 'இன்னும் எந்த விசாரணையும் மூடப்படவில்லை.',
    a_keep: 'வை', a_retire: 'நீக்கு', a_relax: 'தளர்த்து', a_tighten: 'இறுக்கு',
    evidence: 'வழக்கில் முத்திரையிட்ட சான்றைச் சேர்', caseId: 'வழக்கு எண்', kind: 'சான்றின் வகை', ref: 'குறிப்பு (பில், எண்ணிக்கை அல்லது பதிவு எண்)', description: 'அது என்ன காட்டுகிறது', collectedBy: 'சேகரித்தவர்', collectedFrom: 'எங்கிருந்து சேகரிக்கப்பட்டது', evidenceGo: 'வழக்கில் முத்திரையிடு',
    k_transaction_record: 'பில் அல்லது பணப்பெட்டிப் பதிவு', k_witness_statement: 'சாட்சி வாக்குமூலம்', k_stock_count: 'இருப்பு எண்ணிக்கை', k_settlement_record: 'கார்டு அல்லது யுபிஐ தீர்வுப் பதிவு', k_note: 'குறிப்பு',
    sealed: 'வழக்கு {case}இல் உருப்படி {n}ஆக முத்திரையிடப்பட்டது — முத்திரை {seal}. ஒருபோதும் திருத்தவோ நீக்கவோ முடியாது.',
    over: 'விற்றதை விட அதிகம் திரும்பிய பில்', sale: 'பில் (விற்பனை) எண்', overGo: 'பில்லைச் சரிபார்', overNone: 'பில் {sale}இல் எதுவும் ஒருமுறைக்கு மேல் திரும்பவில்லை.', overLine: '{product}: {returned} திரும்பியது, {sold} விற்கப்பட்டது — {extra} அதிகம்',
  },
} as const;

const EVIDENCE_KINDS = ['transaction_record', 'witness_statement', 'stock_count', 'settlement_record', 'note'] as const;

export function lpRecordsSection(input: SectionInput): W5Section | null {
  const { may, call, id, userId } = setup(input, 'w5-lp');
  const w = wordsOf(LP_RECORDS_COPY);
  const actions: (W5Action | null)[] = [
    !may('lp.case.read') ? null : {
      id: 'feedback', title: w('feedback'), go: w('feedbackGo'), fields: [], auto: true,
      run: async () => said(await call<Record<string, unknown>>('GET', '/v1/loss-prevention/rule-feedback'), (b) => {
        const rows = arr(b['adjustments']).filter(isObj);
        if (rows.length === 0) return { tone: 'info', text: w('noFeedback') };
        return {
          tone: 'info', text: raw(''),
          lines: rows.map((r) => {
            const action = str(r['action']);
            return { key: str(r['ruleRef']), tone: action === 'keep' ? 'ok' as const : 'warn' as const, text: (l: Lang) => w('fbLine', { rule: str(r['ruleRef']), action: w(`a_${action}`)(l), detail: str(r['detail']) })(l) };
          }),
        };
      }),
    },
    !may('lp.case.manage') ? null : {
      id: 'evidence', title: w('evidence'), go: w('evidenceGo'),
      fields: [
        { key: 'case', label: w('caseId'), kind: 'text' },
        { key: 'kind', label: w('kind'), kind: 'select', options: EVIDENCE_KINDS.map((k) => ({ value: k, label: w(`k_${k}`) })) },
        { key: 'ref', label: w('ref'), kind: 'text' }, { key: 'description', label: w('description'), kind: 'text' },
        { key: 'collectedBy', label: w('collectedBy'), kind: 'text', ...(userId === undefined ? {} : { initial: userId }) },
        { key: 'collectedFrom', label: w('collectedFrom'), kind: 'text' },
      ],
      run: async (v) => {
        const c = filled(v['case']); const k = (EVIDENCE_KINDS as readonly string[]).includes(v['kind'] ?? '') ? v['kind'] : undefined;
        const ref = filled(v['ref']); const d = filled(v['description']); const by = filled(v['collectedBy']); const from = filled(v['collectedFrom']);
        if (c === undefined || k === undefined || ref === undefined || d === undefined || by === undefined || from === undefined) return invalid(common('needText'));
        const eid = id('ev');
        return said(await call<Record<string, unknown>>('POST', `/v1/loss-prevention/cases/${enc(c)}/evidence/${enc(eid)}`, { kind: k, ref, description: d, collectedBy: by, collectedFrom: from }),
          (b) => ({ tone: 'ok', text: w('sealed', { case: c, n: str(b['items']), seal: str(b['seal']).slice(0, 12) }) }));
      },
    },
    !may('lp.case.read') ? null : {
      id: 'over-returns', title: w('over'), go: w('overGo'), fields: [{ key: 'sale', label: w('sale'), kind: 'text' }],
      run: async (v) => {
        const s = filled(v['sale']);
        if (s === undefined) return invalid(common('needText'));
        return said(await call<Record<string, unknown>>('GET', `/v1/sales/${enc(s)}/over-returns`), (b) => {
          const over = arr(b['overReturned']).filter(isObj);
          if (over.length === 0) return { tone: 'ok', text: w('overNone', { sale: s }) };
          return {
            tone: 'error', text: raw(''),
            lines: over.map((o) => {
              const sold = num(o['soldMinor']) ?? 0; const back = num(o['returnedMinor']) ?? 0;
              return { key: str(o['productId']), tone: 'error' as const, text: w('overLine', { product: str(o['productId']), returned: back, sold, extra: back - sold }) };
            }),
          };
        });
      },
    },
  ];
  return { id: 'w5-lp', heading: w('h'), lead: w('lead'), actions: only(actions) };
}

// ═════════════════════════════════════════════════ Return governance — the no-receipt report ═══════════════════════════

export const NO_RECEIPT_REPORT_COPY = {
  en: {
    h: 'Returns taken without a bill', lead: 'Every return taken with no bill, what it cost and who gave and who approved it — the loss to watch. A return the store recorded against a rule is marked.',
    report: 'The report', reportGo: 'Read it again', head: '{count} return(s) without a bill, {amount} refunded; {flagged} marked against a rule.', none: 'No return has been taken without a bill.',
    line: '{when} · {product} · {amount} · given by {by}, approved by {approver}{flag}', flag: ' — MARKED: {flags}', nobody: '(nobody)',
    byWho: 'Given by {who}: {count} return(s), {amount}',
  },
  ta: {
    h: 'ரசீது இல்லாமல் எடுத்த திருப்பங்கள்', lead: 'ரசீது இல்லாமல் எடுத்த ஒவ்வொரு திருப்பமும், அதன் செலவும், யார் கொடுத்தார், யார் அனுமதித்தார் என்பதும் — கவனிக்க வேண்டிய இழப்பு. விதிக்கு எதிராகப் பதியப்பட்ட திருப்பம் குறிக்கப்படும்.',
    report: 'அறிக்கை', reportGo: 'மீண்டும் படி', head: 'ரசீது இல்லாத {count} திருப்பங்கள், {amount} திருப்பித் தரப்பட்டது; {flagged} விதிக்கு எதிராகக் குறிக்கப்பட்டது.', none: 'ரசீது இல்லாமல் எந்தத் திருப்பமும் எடுக்கப்படவில்லை.',
    line: '{when} · {product} · {amount} · கொடுத்தவர் {by}, அனுமதித்தவர் {approver}{flag}', flag: ' — குறிக்கப்பட்டது: {flags}', nobody: '(யாரும் இல்லை)',
    byWho: 'கொடுத்தவர் {who}: {count} திருப்பங்கள், {amount}',
  },
} as const;

export function noReceiptReportSection(input: SectionInput): W5Section | null {
  const { may, call } = setup(input, 'w5-noreceipt');
  const w = wordsOf(NO_RECEIPT_REPORT_COPY);
  if (!may('lp.case.read')) return null;
  return {
    id: 'w5-no-receipt', heading: w('h'), lead: w('lead'),
    actions: [{
      id: 'report', title: w('report'), go: w('reportGo'), fields: [], auto: true,
      run: async () => said(await call<Record<string, unknown>>('GET', '/v1/pos/no-receipt-returns'), (b) => {
        const rows = arr(b['returns']).filter(isObj);
        if (rows.length === 0) return { tone: 'info', text: w('none') };
        const flagged = num(b['flaggedCount']) ?? 0;
        const lines: W5Line[] = [
          ...arr(b['byProcessor']).filter(isObj).map((p) => ({ key: `by-${str(p['userId'])}`, tone: 'info' as const, text: w('byWho', { who: str(p['userId']), count: str(p['count']), amount: rupees(num(p['refundedMinor']) ?? 0) }) })),
          ...rows.map((r) => {
            const flags = arr(r['governanceFlags']).map(str);
            const product = arr(r['lines']).filter(isObj).map((l) => str(l['productId'])).join(', ');
            return {
              key: str(r['returnId']), tone: flags.length > 0 ? 'error' as const : 'warn' as const,
              text: (l: Lang) => w('line', {
                when: str(r['processedAt']) === '' ? '' : shopMomentOf(str(r['processedAt'])), product, amount: rupees(num(r['refundMinor']) ?? 0),
                by: str(r['processedBy']), approver: str(r['approvedBy']) === '' ? w('nobody')(l) : str(r['approvedBy']), flag: flags.length === 0 ? '' : w('flag', { flags: flags.join(', ') })(l),
              })(l),
            };
          }),
        ];
        return { tone: flagged > 0 ? 'error' : 'warn', text: w('head', { count: str(b['count']), amount: rupees(num(b['totalRefundedMinor']) ?? 0), flagged }), lines };
      }),
    }],
  };
}
