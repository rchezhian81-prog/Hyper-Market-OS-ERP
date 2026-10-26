// API-11 HR — appointment letters (addendum C17 · OB-323, owner, 23 Oct 2026: "HR generates the letter from the employee
// record, and the signed scan is stored as HR evidence"). The rules are `packages/workforce/src/appointment-letter.ts`.
//
//   • `POST /v1/hr/workforce/appointment-letters/wording`          — the owner's own words for the letter (EN + TA), with
//     {{placeholders}}; versioned. Until he sets them a letter cannot be made ("not set").
//   • `POST /v1/hr/workforce/employees/:employeeId/appointment-letters/:letterId` — HR makes the letter from the record:
//     rendered once and FROZEN with the wording version it used. A field the wording uses and the record lacks refuses it.
//   • `POST /v1/hr/workforce/appointment-letters/:letterId/signed-scan` — the signed copy, photographed (JPEG, PNG or WebP),
//     checked against its SHA-256 and kept as HR evidence beside the letter. Never deleted (hard rule #6); a re-scan is a
//     second piece of evidence, the first kept.
//   • `GET  /v1/hr/workforce/appointment-letters?employeeId=`     — the letters, each saying whether its signed copy is held.
//   • `GET  /v1/hr/workforce/appointment-letters/:letterId`       — one letter's frozen text and its scans (no bytes).
//   • `GET  /v1/hr/workforce/appointment-letters/:letterId/signed-scan/:scanId` — one kept scan, with its bytes.

import { createHash } from 'node:crypto';
import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { Employee } from '../../../packages/workforce/src/workforce';
import { checkProductImage } from '../../../packages/product/src/images';
import {
  renderLetter, unknownPlaceholders, hourlyRateWords,
  type LetterWording, type AppointmentLetter, type SignedScan,
} from '../../../packages/workforce/src/appointment-letter';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

/** The largest signed scan kept, as base64 characters (≈ 375 KB of photo). */
export const SIGNED_SCAN_MAX_BASE64 = 500_000;

export interface AppointmentLetterDeps {
  readonly now: () => string;
  readonly wordings: (tenantId: string) => Promise<readonly LetterWording[]>;
  readonly putWording: (tenantId: string, w: LetterWording) => Promise<void>;
  readonly employee: (tenantId: string, employeeId: string) => Promise<Employee | undefined>;
  /** The employer's legal name for the employee's branch (its GST registration), or undefined when none is recorded. */
  readonly employerNameFor: (tenantId: string, branchId: string) => Promise<string | undefined>;
  readonly letters: (tenantId: string) => Promise<readonly AppointmentLetter[]>;
  readonly putLetter: (tenantId: string, l: AppointmentLetter) => Promise<void>;
  readonly scans: (tenantId: string, letterId?: string) => Promise<readonly SignedScan[]>;
  readonly putScan: (tenantId: string, s: SignedScan, contentBase64: string) => Promise<void>;
  readonly scanBytes: (tenantId: string, scanId: string) => Promise<string | undefined>;
  readonly recordAudit?: Recorder;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const bad = (code: string, whatHappened: string): never => {
  throw apiError(400, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Correct it and send it again. Nothing was saved.' });
};
const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string): never => {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
};

export function appointmentLetterRoutes(deps: AppointmentLetterDeps): readonly Route[] {
  const seal = async (ctx: RequestContext, action: string, objectId: string, after: Record<string, string>): Promise<void> => {
    await deps.recordAudit?.(ctx.tenantId, { actorId: ctx.userId, action, objectType: 'appointment_letter', objectId, at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null, after, correlationId: objectId });
  };
  const wordingNow = async (tenantId: string): Promise<LetterWording | undefined> => (await deps.wordings(tenantId)).at(-1);
  const letterOf = async (tenantId: string, letterId: string): Promise<AppointmentLetter> => {
    const l = (await deps.letters(tenantId)).find((x) => x.letterId === letterId);
    if (l === undefined) throw notFound(`appointment letter ${letterId}`);
    return l;
  };
  return [
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/appointment-letters/wording',
      permission: 'hr.appointmentletter.issue',
      handler: async (ctx) => {
        const w = await wordingNow(ctx.tenantId);
        return { status: 200, body: w === undefined ? { set: false } : { set: true, wording: w } };
      },
    },
    {
      // The owner's words. Body: { bodyEn, bodyTa } with {{employerName}} {{employeeName}} {{employeeId}} {{roles}} {{branch}}
      // {{effectiveFrom}} {{hourlyRate}} {{issuedOn}}.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/appointment-letters/wording',
      permission: 'hr.appointmentletter.wording', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['bodyEn']) || !isStr(b['bodyTa'])) bad('not_readable_as_letter_wording', 'The letter\'s words are { bodyEn, bodyTa } — English and Tamil both.');
        const unknown = [...unknownPlaceholders(b['bodyEn'] as string), ...unknownPlaceholders(b['bodyTa'] as string)];
        if (unknown.length > 0) bad('unknown_placeholder', `The words use {{${[...new Set(unknown)].join('}}, {{')}}}, which a letter cannot fill. The fields are employerName, employeeName, employeeId, roles, branch, effectiveFrom, hourlyRate and issuedOn.`);
        const prior = await wordingNow(ctx.tenantId);
        if (prior !== undefined && prior.bodyEn === b['bodyEn'] && prior.bodyTa === b['bodyTa']) return { status: 200, body: { wording: prior, alreadySet: true } };
        const w: LetterWording = { version: (prior?.version ?? 0) + 1, bodyEn: b['bodyEn'] as string, bodyTa: b['bodyTa'] as string, setBy: ctx.userId, setAt: deps.now() };
        await deps.putWording(ctx.tenantId, w);
        await seal(ctx, 'hr.appointmentletter.wording_set', `wording-v${w.version}`, { version: String(w.version) });
        return { status: 201, body: { wording: w } };
      },
    },
    {
      // HR makes the letter from the record. Body: { effectiveFrom: YYYY-MM-DD }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/employees/:employeeId/appointment-letters/:letterId',
      permission: 'hr.appointmentletter.issue', idempotent: true,
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const letterId = (ctx.params['letterId'] ?? '').trim();
        const effectiveFrom = (ctx.body as { effectiveFrom?: unknown } | null)?.effectiveFrom;
        if (letterId === '' || !isDay(effectiveFrom)) bad('not_readable_as_a_letter_request', 'A letter needs its id in the address and { effectiveFrom: YYYY-MM-DD } — the day the appointment takes effect.');
        const existing = (await deps.letters(ctx.tenantId)).find((l) => l.letterId === letterId);
        if (existing !== undefined) {
          if (existing.employeeId !== employeeId) refuse(409, 'letter_id_in_use', `Letter ${letterId} is another person's.`, 'Use a new letter id. Nothing was saved.');
          return { status: 200, body: { letter: existing, alreadyIssued: true } };
        }
        const employee = await deps.employee(ctx.tenantId, employeeId);
        if (employee === undefined) throw notFound(`employee ${employeeId} on the staff list`);
        if (!employee.active) refuse(422, 'employee_has_left', `${employee.name} has left — an appointment letter is for somebody working here.`, 'Check the person. Nothing was made.');
        if (employeeId === ctx.userId) refuse(422, 'own_appointment_letter', 'Nobody makes their own appointment letter (§28).', 'Ask the owner or another manager. Nothing was made.');
        const wording = await wordingNow(ctx.tenantId);
        if (wording === undefined) refuse(409, 'letter_wording_not_set', 'The owner has not set the appointment letter\'s words yet (not set) — the software does not write a legal letter\'s words.', 'Ask the owner to set the words on the Appointment letters page. Nothing was made.');
        const employer = await deps.employerNameFor(ctx.tenantId, employee.branchId);
        const issuedAt = deps.now();
        const rendered = renderLetter(wording!, {
          employeeName: employee.name, employeeId: employee.employeeId, roles: employee.roles.join(', '), branch: employee.branchId,
          effectiveFrom: effectiveFrom as string, issuedOn: shopDateIn(issuedAt), // R1c: the shop's date on the letter
          ...(employer === undefined ? {} : { employerName: employer }),
          ...(employee.hourlyRateMinor === undefined ? {} : { hourlyRate: hourlyRateWords(employee.hourlyRateMinor) }),
        });
        if (!rendered.ok) refuse(422, 'letter_field_not_on_record', `The letter's words use ${rendered.missing.join(', ')}, which ${employee.name}'s record (or the shop's registration) does not hold.`, 'Complete the record (or ask the owner to change the words), then make the letter. Nothing was made.');
        const r = rendered as { textEn: string; textTa: string };
        const letter: AppointmentLetter = { letterId, employeeId, wordingVersion: wording!.version, effectiveFrom: effectiveFrom as string, textEn: r.textEn, textTa: r.textTa, issuedBy: ctx.userId, issuedAt };
        await deps.putLetter(ctx.tenantId, letter);
        await seal(ctx, 'hr.appointmentletter.issued', letterId, { employeeId, wordingVersion: String(letter.wordingVersion), effectiveFrom: letter.effectiveFrom });
        return { status: 201, body: { letter } };
      },
    },
    {
      // The signed copy. Body: { mediaType, contentBase64, sha256 } — the photo of the signed letter.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/appointment-letters/:letterId/signed-scan',
      permission: 'hr.appointmentletter.issue', idempotent: true,
      handler: async (ctx) => {
        const letter = await letterOf(ctx.tenantId, (ctx.params['letterId'] ?? '').trim());
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['mediaType']) || !isStr(b['contentBase64']) || !isStr(b['sha256']) || !/^[0-9a-f]{64}$/.test(b['sha256'])) bad('not_readable_as_a_signed_scan', 'A signed scan needs { mediaType, contentBase64, sha256 }.');
        if ((b['contentBase64'] as string).length > SIGNED_SCAN_MAX_BASE64) refuse(413, 'scan_too_large', `The scan is larger than the ${SIGNED_SCAN_MAX_BASE64} characters a signed scan may be.`, 'Take the photo at a lower size and send it again. Nothing was kept.');
        const bytes = Buffer.from(b['contentBase64'] as string, 'base64');
        const checked = checkProductImage(b['mediaType'], new Uint8Array(bytes));
        if (!checked.ok) refuse(422, 'scan_not_an_image', `The scan was not kept: ${checked.detail}.`, 'Photograph the signed letter (JPEG, PNG or WebP) and send it again. Nothing was kept.');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== b['sha256']) refuse(422, 'scan_changed_on_the_way', 'The SHA-256 sent is not the scan\'s own — the file changed on the way.', 'Send it again. Nothing was kept.');
        const scanId = `scan-${sha256.slice(0, 32)}`;
        const prior = (await deps.scans(ctx.tenantId, letter.letterId)).find((s) => s.scanId === scanId);
        if (prior !== undefined) return { status: 200, body: { scan: prior, alreadyKept: true } };
        const scan: SignedScan = { letterId: letter.letterId, employeeId: letter.employeeId, scanId, mediaType: (checked as { mediaType: string }).mediaType, bytes: bytes.length, sha256, keptBy: ctx.userId, keptAt: deps.now() };
        await deps.putScan(ctx.tenantId, scan, b['contentBase64'] as string);
        await seal(ctx, 'hr.appointment_letter.signed_scan_kept', letter.letterId, { employeeId: letter.employeeId, scanId, sha256, bytes: String(scan.bytes) });
        return { status: 201, body: { scan } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/appointment-letters',
      permission: 'hr.appointmentletter.issue',
      handler: async (ctx) => {
        const employeeId = isStr(ctx.query['employeeId']) ? ctx.query['employeeId'] : undefined;
        const [letters, scans] = await Promise.all([deps.letters(ctx.tenantId), deps.scans(ctx.tenantId)]);
        const rows = letters.filter((l) => employeeId === undefined || l.employeeId === employeeId).map((l) => {
          const mine = scans.filter((s) => s.letterId === l.letterId);
          return { letterId: l.letterId, employeeId: l.employeeId, effectiveFrom: l.effectiveFrom, wordingVersion: l.wordingVersion, issuedBy: l.issuedBy, issuedAt: l.issuedAt, signedCopyKept: mine.length > 0, scans: mine.length };
        }).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
        return { status: 200, body: { letters: rows, awaitingSignedCopy: rows.filter((r) => !r.signedCopyKept).length } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/appointment-letters/:letterId',
      permission: 'hr.appointmentletter.issue',
      handler: async (ctx) => {
        const letter = await letterOf(ctx.tenantId, (ctx.params['letterId'] ?? '').trim());
        return { status: 200, body: { letter, scans: await deps.scans(ctx.tenantId, letter.letterId) } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/appointment-letters/:letterId/signed-scan/:scanId',
      permission: 'hr.appointmentletter.issue',
      handler: async (ctx) => {
        const letter = await letterOf(ctx.tenantId, (ctx.params['letterId'] ?? '').trim());
        const scan = (await deps.scans(ctx.tenantId, letter.letterId)).find((s) => s.scanId === ctx.params['scanId']);
        const contentBase64 = scan === undefined ? undefined : await deps.scanBytes(ctx.tenantId, scan.scanId);
        if (scan === undefined || contentBase64 === undefined) throw notFound(`signed scan ${ctx.params['scanId'] ?? ''}`);
        return { status: 200, body: { scan, contentBase64 } };
      },
    },
  ];
}
