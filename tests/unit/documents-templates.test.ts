import { describe, it, expect } from 'vitest';
import * as documentsModule from '../../packages/documents/src/templates';
import {
  publishTemplateVersion,
  currentVersion,
  issueDocument,
  reproduceDocument,
  assessTemplateRetention,
  planDocumentRetention,
  type IssuedDocument,
  type Renderer,
} from '../../packages/documents/src/templates';

// M31-FR-01 acceptance: "A TEMPLATE CHANGE PRODUCES A NEW VERSION WHILE ISSUED DOCUMENTS
// KEEP THEIR LAYOUT; retention holds."

const render: Renderer = (template, data) =>
  `${template.branding?.['address'] ?? 'no address'}\n${template.body}\nTotal: ${String(data['totalMinor'])}`;

function publish(over: Partial<Parameters<typeof publishTemplateVersion>[0]> = {}) {
  return publishTemplateVersion({
    templateId: 'tpl-invoice',
    tenantId: 't-1',
    kind: 'tax_invoice',
    body: 'TAX INVOICE',
    branding: { address: '12 Old Street, Coimbatore' },
    createdBy: 'u-designer',
    approvedBy: 'u-finance',
    changeNote: 'initial layout',
    at: '2026-07-01T09:00:00Z',
    existing: [],
    ...over,
  });
}

describe('a template change is a new version, never an edit (M31-FR-01)', () => {
  it('publishes v1, then v2, keeping v1', () => {
    const v1 = publish();
    expect(v1.version).toBe(1);

    const v2 = publish({
      body: 'TAX INVOICE (GST)',
      branding: { address: '88 New Road, Coimbatore' },
      changeNote: 'we moved premises',
      at: '2026-08-01T09:00:00Z',
      existing: [v1.template!],
    });
    expect(v2.version).toBe(2);
    expect(v2.detail).toContain('v1 is kept, and every document issued under it keeps its original layout');
  });

  it('EXPORTS NO WAY TO EDIT A PUBLISHED VERSION — the absence is the control', () => {
    const api = Object.keys(documentsModule);
    expect(api.filter((n) => /edit|update|overwrite|replace|deleteTemplate/i.test(n))).toEqual([]);
    expect(api).toContain('publishTemplateVersion');
  });

  it('needs an approver who is not the author (§28)', () => {
    expect(publish({ approvedBy: 'u-designer' }).outcome).toBe('self_approved');
    expect(publish({ approvedBy: '  ' }).outcome).toBe('not_approved');
  });

  it('needs a change note, and refuses an empty body', () => {
    expect(publish({ changeNote: '  ' }).detail).toContain("carries the shop's legal identity");
    expect(publish({ body: '   ' }).outcome).toBe('empty_body');
  });

  it('refuses to publish into another tenant\'s template', () => {
    const theirs = publish({ tenantId: 't-other' }).template!;
    const result = publish({ tenantId: 't-1', existing: [theirs] });
    expect(result.outcome).toBe('wrong_tenant');
    expect(result.detail).toContain('belongs to t-other');
  });

  it('resolves the version in force at a given instant', () => {
    const v1 = publish().template!;
    const v2 = publish({ at: '2026-08-01T09:00:00Z', existing: [v1], changeNote: 'moved' }).template!;
    const versions = [v1, v2];

    expect(currentVersion(versions, 'tpl-invoice', '2026-07-15T00:00:00Z')?.version).toBe(1);
    expect(currentVersion(versions, 'tpl-invoice', '2026-08-15T00:00:00Z')?.version).toBe(2);
    expect(currentVersion(versions, 'tpl-invoice', '2026-06-01T00:00:00Z')).toBeUndefined();
  });
});

describe('AN ISSUED DOCUMENT IS FROZEN — the whole point of the requirement', () => {
  const v1 = publish().template!;
  const v2 = publish({
    body: 'TAX INVOICE (GST)',
    branding: { address: '88 New Road, Coimbatore' },
    changeNote: 'we moved premises',
    at: '2026-08-01T09:00:00Z',
    existing: [v1],
  }).template!;

  it('issues under the version in force, storing the rendered content', () => {
    const july = issueDocument({
      documentId: 'INV-JULY',
      tenantId: 't-1',
      kind: 'tax_invoice',
      subjectRef: 'S-1',
      templateId: 'tpl-invoice',
      versions: [v1, v2],
      data: { totalMinor: 120_000 },
      render,
      issuedBy: 'u-cashier',
      at: '2026-07-15T10:00:00Z',
    });
    expect(july.issued).toBe(true);
    expect(july.document?.templateVersion).toBe(1);
    expect(july.document?.content).toContain('12 Old Street');
  });

  it('JULY\'S INVOICE STILL SHOWS JULY\'S ADDRESS after the shop moves in August', () => {
    const july = issueDocument({
      documentId: 'INV-JULY', tenantId: 't-1', kind: 'tax_invoice', subjectRef: 'S-1',
      templateId: 'tpl-invoice', versions: [v1, v2], data: { totalMinor: 120_000 },
      render, issuedBy: 'u-cashier', at: '2026-07-15T10:00:00Z',
    }).document!;

    const august = issueDocument({
      documentId: 'INV-AUG', tenantId: 't-1', kind: 'tax_invoice', subjectRef: 'S-2',
      templateId: 'tpl-invoice', versions: [v1, v2], data: { totalMinor: 90_000 },
      render, issuedBy: 'u-cashier', at: '2026-08-15T10:00:00Z',
    }).document!;

    // The August invoice uses the new address...
    expect(august.templateVersion).toBe(2);
    expect(august.content).toContain('88 New Road');

    // ...and July's is untouched. Reproducing it returns the SAME BYTES the customer got.
    const reproduced = reproduceDocument(july);
    expect(reproduced.content).toContain('12 Old Street');
    expect(reproduced.content).not.toContain('88 New Road');
    expect(reproduced.templateVersion).toBe(1);
    expect(reproduced.detail).toContain('reproduced exactly as issued on 2026-07-15');
  });

  it('is IDEMPOTENT — re-issuing would produce a second, different copy', () => {
    const first = issueDocument({
      documentId: 'INV-1', tenantId: 't-1', kind: 'tax_invoice', subjectRef: 'S-1',
      templateId: 'tpl-invoice', versions: [v1], data: { totalMinor: 120_000 },
      render, issuedBy: 'u-cashier', at: '2026-07-15T10:00:00Z',
    }).document!;

    // Later, under a newer template — exactly the case that silently rewrites history.
    const again = issueDocument({
      documentId: 'INV-1', tenantId: 't-1', kind: 'tax_invoice', subjectRef: 'S-1',
      templateId: 'tpl-invoice', versions: [v1, v2], data: { totalMinor: 120_000 },
      render, issuedBy: 'u-cashier', at: '2026-08-20T10:00:00Z',
      alreadyIssued: [first],
    });
    expect(again.issued).toBe(false);
    expect(again.outcome).toBe('already_issued');
    expect(again.document?.templateVersion).toBe(1);
    expect(again.detail).toContain('a second, different copy of the same document');
  });

  it('refuses when no approved template exists yet, or it belongs to another tenant', () => {
    expect(
      issueDocument({
        documentId: 'INV-2', tenantId: 't-1', kind: 'tax_invoice', subjectRef: 'S-1',
        templateId: 'tpl-invoice', versions: [v1], data: {}, render,
        issuedBy: 'u-1', at: '2026-06-01T10:00:00Z',
      }).outcome,
    ).toBe('no_template');

    expect(
      issueDocument({
        documentId: 'INV-3', tenantId: 't-other', kind: 'tax_invoice', subjectRef: 'S-1',
        templateId: 'tpl-invoice', versions: [v1], data: {}, render,
        issuedBy: 'u-1', at: '2026-07-15T10:00:00Z',
      }).outcome,
    ).toBe('no_template');
  });

  it('refuses a render that throws or produces nothing', () => {
    const boom: Renderer = () => {
      throw new Error('missing field: gstin');
    };
    const failed = issueDocument({
      documentId: 'INV-4', tenantId: 't-1', kind: 'tax_invoice', subjectRef: 'S-1',
      templateId: 'tpl-invoice', versions: [v1], data: {}, render: boom,
      issuedBy: 'u-1', at: '2026-07-15T10:00:00Z',
    });
    expect(failed.outcome).toBe('render_failed');
    expect(failed.detail).toContain('missing field: gstin');

    const empty = issueDocument({
      documentId: 'INV-5', tenantId: 't-1', kind: 'tax_invoice', subjectRef: 'S-1',
      templateId: 'tpl-invoice', versions: [v1], data: {}, render: () => '   ',
      issuedBy: 'u-1', at: '2026-07-15T10:00:00Z',
    });
    expect(empty.detail).toContain('empty document');
  });
});

describe('retention holds for the whole chain (hard rule #6)', () => {
  const v1 = publish().template!;
  const v2 = publish({ changeNote: 'moved', at: '2026-08-01T09:00:00Z', existing: [v1] }).template!;

  const doc = (over: Partial<IssuedDocument>): IssuedDocument => ({
    documentId: 'D-1',
    tenantId: 't-1',
    kind: 'tax_invoice',
    subjectRef: 'S-1',
    templateId: 'tpl-invoice',
    templateVersion: 1,
    content: 'x',
    issuedAt: '2026-07-15T10:00:00Z',
    issuedBy: 'u-1',
    ...over,
  });

  it('A VERSION ANY DOCUMENT DEPENDS ON CAN NEVER BE REMOVED', () => {
    const decisions = assessTemplateRetention({
      versions: [v1, v2],
      documents: [doc({}), doc({ documentId: 'D-2' })],
    });
    expect(decisions[0]?.disposable).toBe(false);
    expect(decisions[0]?.dependentDocuments).toBe(2);
    expect(decisions[0]?.detail).toContain('it is the record of what that layout meant');
    // v2 was published but never used.
    expect(decisions[1]?.disposable).toBe(true);
  });

  it('never proposes a statutory document for disposal, whatever the date says', () => {
    const plans = planDocumentRetention({
      documents: [doc({ retainUntil: '2020-01-01' })],
      today: '2026-08-05',
    });
    expect(plans[0]?.action).toBe('keep');
    expect(plans[0]?.reason).toContain('statutory record and is never proposed');
  });

  it('a legal hold beats a retention date', () => {
    const plans = planDocumentRetention({
      documents: [doc({ kind: 'notification', retainUntil: '2020-01-01', legalHold: true })],
      today: '2026-08-05',
    });
    expect(plans[0]?.action).toBe('keep');
    expect(plans[0]?.reason).toContain('legal hold beats any retention date');
  });

  it('keeps a document with no retention policy — silence never means discard', () => {
    const plans = planDocumentRetention({ documents: [doc({ kind: 'notification' })], today: '2026-08-05' });
    expect(plans[0]?.action).toBe('keep');
    expect(plans[0]?.reason).toContain('silence never means discard');
  });

  it('PROPOSES rather than deletes once retention has genuinely ended', () => {
    const plans = planDocumentRetention({
      documents: [doc({ kind: 'notification', retainUntil: '2026-01-01' })],
      today: '2026-08-05',
    });
    expect(plans[0]?.action).toBe('propose_disposal');
    expect(plans[0]?.reason).toContain('never deleted automatically');
  });

  it('keeps a document still inside its retention window', () => {
    const plans = planDocumentRetention({
      documents: [doc({ kind: 'notification', retainUntil: '2027-01-01' })],
      today: '2026-08-05',
    });
    expect(plans[0]?.action).toBe('keep');
  });
});
