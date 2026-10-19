import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * D-21 (R4, OB-217): "It proposes a case; a person decides whether to open it. Nothing is opened, or blamed on anyone, by
 * itself. A CCTV clip is recorded only as a reference (camera, time from and to, who collected it); no video is stored or
 * analysed." Both claims are structural, so they are pinned on the source.
 */
const code = (p: string): string => readFileSync(p, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
const ENGINE = code('packages/loss-prevention/src/correlate.ts');
const ROUTES = code('services/pos/src/lp-correlation.ts');
const ADAPTERS = code('services/api/src/r4-supply-lp-adapters.ts');
const GENERIC = code('services/pos/src/loss-prevention.ts');

describe('the LP view opens no case and keeps no video (D-21)', () => {
  it('the engine is pure and only proposes: it imports nothing and never opens a case', () => {
    expect([...ENGINE.matchAll(/from '([^']+)'/g)]).toEqual([]);
    expect(ENGINE).not.toMatch(/openCase|recordOpened/);
    expect(ENGINE).toMatch(/opened: false,/);
  });

  it('the view route reads only — no writer, no case opened; the only write in the module is a CCTV reference', () => {
    const view = ROUTES.slice(ROUTES.indexOf("path: '/v1/loss-prevention/correlation'"), ROUTES.indexOf("path: '/v1/loss-prevention/cases/:caseId/cctv/:evidenceId'"));
    expect(view).not.toMatch(/deps\.record/);
    expect(ROUTES).not.toMatch(/openCase|recordOpened|recordClosed/);
    expect([...ROUTES.matchAll(/deps\.record(\w+)(?:\?\.)?\(/g)].map((m) => m[1])).toEqual(['Evidence', 'Audit']);
  });

  it('no video: the CCTV route keeps a reference string, decodes nothing, and refuses video fields by name; the generic door refuses the cctv kind', () => {
    const cctv = ROUTES.slice(ROUTES.indexOf("path: '/v1/loss-prevention/cases/:caseId/cctv/:evidenceId'"));
    expect(cctv).toMatch(/kind: 'cctv_reference', ref: cctvEvidenceRef\(r\)/);
    expect(cctv).not.toMatch(/Buffer|base64|atob|createHash/);
    expect(ENGINE).toMatch(/CCTV_VIDEO_FIELDS = Object\.freeze\(\['video', 'clip', 'file', 'content', 'contentBase64', 'data', 'url', 'link', 'frames', 'image', 'stream'\]/);
    expect(GENERIC).toMatch(/if \(b\.kind === 'cctv_reference'\) \{\s*refuse\('cctv_reference_has_its_own_form'/);
  });

  it('the adapter only reads the till, the write-offs and the counts — the one write is the case evidence it delegates', () => {
    const from = ADAPTERS.indexOf('export function lpCorrelationAdapter');
    const adapter = ADAPTERS.slice(from, ADAPTERS.indexOf('\nexport function ', from + 1));
    expect(adapter).not.toMatch(/\.append\(|\.appendBatch\(|recordOpened/);
    expect(adapter).toMatch(/recordEvidence: \(t, caseId, item\) => cases\.recordEvidence\(t, caseId, item\)/);
  });
});
