// Repack a batch (Round 4d · M11-FR-03 "a repack is traceable to its source batch") — a tested, DOM-free session for the
// Production page's repack form, over head office's `POST /v1/production/repacks/:repackId`. A batch on hand is put into
// new packs under a new batch id; head office gives the new batch the SOURCE's expiry (a fresh wrapper does not make food
// fresh), takes the source out of stock in the same write, and keeps the new batch waiting for its quality release like any
// other production output — which then appears on this page's release list. A recall on the source reaches it.
// The amount is typed in the product's own unit (OB-31: "2.5" kg is 2500 g), never rounded. It needs head office (the
// stock is checked there); with no line it says so and records nothing. `production.plan.commit` is re-checked there.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { typedQuantityMinor } from '../../../packages/contracts/src/quantity';

export type Lang = 'en' | 'ta';

export const PRODUCTION_REPACK_COPY = {
  en: {
    repackH: 'Repack a batch', repackLead: 'Put a batch on hand into new packs. The new batch keeps the expiry of the batch it came from, and waits for its quality release like anything made here. A recall of the source reaches it.',
    department: 'Department', product: 'Product code', location: 'Where it is (stock place)', sourceBatch: 'Batch it comes from', newBatch: 'New batch code', qty: 'How much', uom: 'Counted in',
    repack: 'Repack', repacked: 'Repacked. The new batch keeps expiry', awaiting: 'it waits for its quality release below.',
    u_ea: 'pieces', u_kg: 'kg', u_g: 'g', u_L: 'litres', u_ml: 'ml',
    nobody: 'Nobody is signed in on this screen.', cannotRepack: 'Your role cannot repack.', needDepartment: 'Choose the department.', needField: 'Fill in the product, the place and both batch codes.', sameBatch: 'The new batch code must differ from the batch it comes from.', badQty: 'Type an amount the unit holds exactly, e.g. 6 pieces or 2.5 kg.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was repacked. A repack needs head office, because the stock is checked there.', saving: 'Saving…',
  },
  ta: {
    repackH: 'ஒரு தொகுதியை மறுபொதி செய்', repackLead: 'கையிருப்பில் உள்ள ஒரு தொகுதியைப் புதிய பொதிகளில் வை. புதிய தொகுதி அது வந்த தொகுதியின் காலாவதியையே வைத்திருக்கும்; இங்கே செய்யும் எதையும் போலத் தரச் சோதனை விடுவிப்புக்குக் காத்திருக்கும். மூலத் தொகுதியின் திரும்பப் பெறுதல் இதையும் சென்றடையும்.',
    department: 'பிரிவு', product: 'பொருள் குறியீடு', location: 'இருக்கும் இடம் (சரக்கு இடம்)', sourceBatch: 'வந்த தொகுதி', newBatch: 'புதிய தொகுதிக் குறியீடு', qty: 'எவ்வளவு', uom: 'எண்ணும் அலகு',
    repack: 'மறுபொதி செய்', repacked: 'மறுபொதி செய்யப்பட்டது. புதிய தொகுதியின் காலாவதி', awaiting: 'கீழே தரச் சோதனை விடுவிப்புக்குக் காத்திருக்கிறது.',
    u_ea: 'எண்ணிக்கை', u_kg: 'கிலோ', u_g: 'கிராம்', u_L: 'லிட்டர்', u_ml: 'மி.லி',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRepack: 'உங்கள் பங்கு மறுபொதி செய்ய முடியாது.', needDepartment: 'பிரிவைத் தேர்ந்தெடுங்கள்.', needField: 'பொருள், இடம், இரண்டு தொகுதிக் குறியீடுகளையும் நிரப்புங்கள்.', sameBatch: 'புதிய தொகுதிக் குறியீடு வந்த தொகுதியிலிருந்து வேறாக இருக்க வேண்டும்.', badQty: 'அலகு சரியாக வைத்திருக்கும் அளவைத் தட்டச்சு செய்யுங்கள், எ.கா. 6 எண்ணிக்கை அல்லது 2.5 கிலோ.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மறுபொதி செய்யப்படவில்லை. சரக்கு அங்கே சரிபார்க்கப்படுவதால் மறுபொதிக்குத் தலைமை அலுவலகம் தேவை.', saving: 'சேமிக்கிறது…',
  },
} as const;

export const productionRepackWords = (lang: Lang, key: string): string =>
  (PRODUCTION_REPACK_COPY[lang] as Record<string, string>)[key] ?? (PRODUCTION_REPACK_COPY.en as Record<string, string>)[key] ?? key;
export const productionRepackOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => productionRepackWords(lang, k), out);

type Why = 'nobody' | 'cannotRepack' | 'needDepartment' | 'needField' | 'sameBatch' | 'badQty';
export interface RepackInput { readonly departmentId: string; readonly productId: string; readonly locationId: string; readonly sourceBatchId: string; readonly newBatchId: string; readonly qty: string; readonly uom: string }

export interface ProductionRepackSession {
  readonly may: { readonly named: boolean; readonly repack: boolean };
  repack(r: RepackInput): Promise<Outcome<{ readonly newBatchId: string; readonly expiresAt: string }, Why>>;
}

export function createProductionRepackSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): ProductionRepackSession {
  const named = input.viewer?.userId !== undefined;
  const may = { named, repack: named && (input.viewer?.permissions ?? []).includes('production.plan.commit') };
  const call = makeCaller({ keyPrefix: 'repack', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why): Outcome<never, Why> => ({ result: 'invalid', why });
  return {
    may,
    repack: async (r) => {
      if (!named) return no('nobody');
      if (!may.repack) return no('cannotRepack');
      if (r.departmentId.trim() === '') return no('needDepartment');
      if ([r.productId, r.locationId, r.sourceBatchId, r.newBatchId].some((x) => x.trim() === '')) return no('needField');
      if (r.newBatchId.trim() === r.sourceBatchId.trim()) return no('sameBatch');
      const quantityMinor = typedQuantityMinor(r.qty, r.uom);
      if (quantityMinor === undefined) return no('badQty');
      const out = await call<{ newBatchId?: unknown; expiresAt?: unknown }>('POST', `/v1/production/repacks/${encodeURIComponent(newId('rp'))}`, {
        departmentId: r.departmentId.trim(), productId: r.productId.trim(), locationId: r.locationId.trim(), sourceBatchId: r.sourceBatchId.trim(), newBatchId: r.newBatchId.trim(), quantityMinor, uom: r.uom,
      });
      return out.result === 'ok' ? { result: 'ok', value: { newBatchId: r.newBatchId.trim(), expiresAt: typeof out.value.expiresAt === 'string' ? out.value.expiresAt : '' } } : out;
    },
  };
}
