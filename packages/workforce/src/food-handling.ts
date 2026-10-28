// OB-502 (owner, 28 Oct 2026, in writing) · M25-FR-03 "an expired certification blocks the gated task".
//
// An expired — or missing — food-handling certificate BLOCKS recording food-handling work: a production run, a bakery
// run and a counter-food (weighed) run. Only that: the till is unchanged, and the person may still do every other job
// (the gate is on the task, never the person — `canPerformTask`). The same rule runs at head office and on the store
// computer with the line down (the certificates travel in the signed store pack), so the answer does not depend on the
// network. The refusal is in plain words, English and Tamil, naming the certificate and the date it expired.
//
// Pure and deterministic: "today" is passed in (the shop's own date — never UTC), no I/O.

import { canPerformTask, type Certification, type Employee, type TaskGateDecision } from './workforce';

/** The certificate kind food-handling work needs, as the certificate register records it. */
export const FOOD_HANDLING_CERTIFICATE = 'food-handling';

/** The kinds of work this gate covers (OB-502): production, bakery and counter-food runs. */
export type FoodHandlingTask = 'production_run' | 'weighed_run';

/**
 * A certificate kind as people type it — "Food handling", "food_handling", "FOOD-HANDLING" — read as one kind, so a
 * certificate recorded with a different spelling is never silently missed.
 */
export function certificateKindKey(kind: string): string {
  return kind.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * OB-522 (owner, 28 Oct 2026): "food handling" and "FoSTaC" (the FSSAI Food Safety Training and Certification) count as the
 * SAME food-handling certificate for the OB-502 gate — on head office, in the signed pack and on the store computer offline.
 */
export const FOOD_HANDLING_KINDS: readonly string[] = Object.freeze([FOOD_HANDLING_CERTIFICATE, 'fostac']);

/** Is this certificate kind (however it was typed) a food-handling certificate for the OB-502 gate? */
export function isFoodHandlingKind(kind: string): boolean {
  return FOOD_HANDLING_KINDS.includes(certificateKindKey(kind));
}

/**
 * OB-522: the short pick-list of certificate kinds the office screen offers. Only the kinds the system already knows: the
 * food-handling certificate (OB-502) and FoSTaC, which counts as the same. Each has its words in English and Tamil.
 */
export const CERTIFICATE_KINDS: readonly { readonly kind: string; readonly en: string; readonly ta: string; readonly foodHandling: boolean }[] = Object.freeze([
  { kind: FOOD_HANDLING_CERTIFICATE, en: 'Food handling', ta: 'உணவு கையாளுதல்', foodHandling: true },
  { kind: 'fostac', en: 'FoSTaC (FSSAI food safety training) — counts as food handling', ta: 'FoSTaC (FSSAI உணவுப் பாதுகாப்புப் பயிற்சி) — உணவு கையாளுதலாகவே கணக்கிடப்படும்', foodHandling: true },
]);

export type FoodHandlingVerdict =
  | { readonly allowed: true; readonly validUntil: string }
  | {
    readonly allowed: false;
    readonly code: 'food_handling_certificate_expired' | 'food_handling_certificate_missing' | 'food_handler_inactive';
    /** The certificate this work needs. */
    readonly certificate: string;
    /** When the newest verified certificate expired (only for an expired one). */
    readonly expiredOn?: string;
    readonly words: { readonly en: string; readonly ta: string };
    readonly decision: TaskGateDecision;
  };

const TASK_WORDS: Record<FoodHandlingTask, { readonly en: string; readonly ta: string }> = {
  production_run: { en: 'a production or bakery run', ta: 'உற்பத்தி அல்லது பேக்கரி பதிவு' },
  weighed_run: { en: 'counter-food (weighed) work', ta: 'கவுண்டர் உணவு (எடை) பதிவு' },
};

/**
 * May this person have food-handling work recorded in their name TODAY? `employee` is the person's staff record (absent
 * when the shop holds none — then there can be no certificate on file either). Only a VERIFIED certificate counts.
 */
export function foodHandlingVerdict(input: {
  readonly personId: string;
  readonly employee: Employee | undefined;
  readonly certifications: readonly Certification[];
  readonly today: string;
  readonly task: FoodHandlingTask;
}): FoodHandlingVerdict {
  const who = input.employee?.name ?? input.personId;
  const task = TASK_WORDS[input.task];
  const employee: Employee = input.employee ?? { employeeId: input.personId, name: input.personId, branchId: '', roles: [], active: true };
  const certifications = input.certifications
    .filter((c) => c.employeeId === input.personId && isFoodHandlingKind(c.kind))
    .map((c) => ({ ...c, kind: FOOD_HANDLING_CERTIFICATE }));
  const decision = canPerformTask({ employee, task: input.task, requiresCertification: FOOD_HANDLING_CERTIFICATE, certifications, today: input.today });
  if (decision.allowed) {
    const newest = certifications.filter((c) => c.verifiedBy !== undefined).sort((a, b) => b.validUntil.localeCompare(a.validUntil))[0];
    return { allowed: true, validUntil: newest?.validUntil ?? input.today };
  }
  if (decision.outcome === 'inactive') {
    return {
      allowed: false, code: 'food_handler_inactive', certificate: FOOD_HANDLING_CERTIFICATE, decision,
      words: {
        en: `${who} is recorded as having left, so ${task.en} cannot be recorded in their name. Nothing was saved.`,
        ta: `${who} பணியிலிருந்து விலகியதாகப் பதிவாகியுள்ளது; அவர் பெயரில் ${task.ta} செய்ய முடியாது. எதுவும் சேமிக்கப்படவில்லை.`,
      },
    };
  }
  if (decision.outcome === 'certification_expired') {
    const expiredOn = certifications.filter((c) => c.verifiedBy !== undefined).sort((a, b) => b.validUntil.localeCompare(a.validUntil))[0]?.validUntil ?? '';
    return {
      allowed: false, code: 'food_handling_certificate_expired', certificate: FOOD_HANDLING_CERTIFICATE, expiredOn, decision,
      words: {
        en: `${who}'s food-handling certificate expired on ${expiredOn}. ${cap(task.en)} cannot be recorded in their name until a renewed certificate is recorded. They may still do other work. Nothing was saved.`,
        ta: `${who} அவர்களின் உணவு கையாளும் சான்றிதழ் ${expiredOn} அன்று காலாவதியானது. புதுப்பித்த சான்றிதழ் பதியும் வரை அவர் பெயரில் ${task.ta} செய்ய முடியாது. மற்ற வேலைகளைச் செய்யலாம். எதுவும் சேமிக்கப்படவில்லை.`,
      },
    };
  }
  return {
    allowed: false, code: 'food_handling_certificate_missing', certificate: FOOD_HANDLING_CERTIFICATE, decision,
    words: {
      en: `There is no verified food-handling certificate on file for ${who}. ${cap(task.en)} cannot be recorded in their name until a manager records one. They may still do other work. Nothing was saved.`,
      ta: `${who} அவர்களுக்குச் சரிபார்க்கப்பட்ட உணவு கையாளும் சான்றிதழ் பதிவில் இல்லை. ஒரு மேலாளர் அதைப் பதியும் வரை அவர் பெயரில் ${task.ta} செய்ய முடியாது. மற்ற வேலைகளைச் செய்யலாம். எதுவும் சேமிக்கப்படவில்லை.`,
    },
  };
}

const cap = (s: string): string => (s === '' ? s : `${s[0]!.toUpperCase()}${s.slice(1)}`);
