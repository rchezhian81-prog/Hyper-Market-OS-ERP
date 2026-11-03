// Licences, controls and findings (W5 · M34-FR-03 · M34-FR-04 · OB-331 · P-03 · P-08 · hard rules #2, #6) — a tested,
// DOM-free session over head office's compliance registers, which no screen reached: the routes were built and tested but a
// licence, a control or a penetration-test finding could only be recorded by a programmer.
//   • LICENCES AND CERTIFICATES (M34-FR-03) — the register (`GET /v1/compliance/obligations`), what needs attention before it
//     expires, each with the named person who must renew it (`GET /v1/compliance/alerts`), and the ones with nothing on file
//     to show an inspector (`GET /v1/compliance/evidence-gaps`). Register or re-state one with its named person
//     (`POST …/obligations/:id`), file a piece of evidence against it (`POST …/obligations/:id/evidence`), close one that no
//     longer applies with a reason (`POST …/obligations/:id/close`) — closed ones stay on the register for ever.
//   • CONTROLS AND THEIR CHECKS (M34-FR-04) — the registers (`GET /v1/compliance/control-register`) and each control's state
//     (`GET /v1/compliance/controls/health`), the remediation past its date (`GET …/remediations/overdue`). Register a control
//     with its owner (`POST …/controls/:id`), record an incident against the control that should have stopped it
//     (`POST …/incidents/:id`), a remediation for an incident with an owner and a date (`POST …/remediations/:id`, and the same
//     again with the day it was done), and a dated check of a control in the checker's own name (`POST …/attestations/:id`).
//     How long a check stays current is the owner's number: this page never judges a check "stale" by a number of its own.
//   • FINDINGS PEOPLE RAISE (OB-331) — the security findings register (`GET /v1/compliance/findings`); record a finding from a
//     penetration test or a review (`POST …/findings/:id`), name who must fix one (`POST …/findings/:id/owner`), and record a
//     person's finding fixed with written evidence (`POST …/findings/:id/fixed`). A scanner finding is never closed by hand —
//     it closes when a complete scan no longer reports it; this page offers no such button and head office refuses it anyway.
// Reading needs `compliance.obligation.read` / `compliance.risk.read` / `compliance.finding.read`; recording
// `compliance.obligation.manage` / `compliance.risk.manage` / `compliance.finding.record`. Head office re-checks each; `may`
// only shapes what is offered. A write whose answer was lost is sent again as the SAME record (same id, same key), never a
// second one. Every word this page adds has a Tamil twin; head office's own sentences stay in English (OB-553).

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { instantOfTyped } from '../../../packages/calendar/src/shop-day';

export type Lang = 'en' | 'ta';

export const COMPLIANCE_REGISTERS_COPY = {
  en: {
    title: 'Licences, controls and findings',
    lead: 'The shop\'s licences and certificates with the person who must renew each one, the controls that keep risks down and who checked them, and the security findings people raise. Nothing here is ever deleted: a licence that no longer applies is closed with its reason and stays on the record.',
    tabLicences: 'Licences and certificates', tabControls: 'Controls and checks', tabFindings: 'Findings people raise',
    // Licences
    licencesH: 'Licences and certificates', alertsH: 'Needs attention', gapsH: 'Nothing on file to show an inspector', registerH: 'The register',
    noAlerts: 'Nothing is close to expiry.', noGaps: 'Every licence in force has evidence on file.', noObligations: 'No licence or certificate is on the register yet.',
    expires: 'expires', noExpiry: 'no expiry date', daysLeft: 'days left', expiredAgo: 'days ago — EXPIRED', who: 'person to act', escalated: 'told also',
    evidence: 'evidence on file', noEvidence: 'no evidence on file', closed: 'Closed', active: 'In force', reason: 'reason', authority: 'authority', reference: 'number',
    level_notice: 'Coming up', level_warning: 'Soon', level_urgent: 'Urgent', level_expired: 'Expired',
    newH: 'Register a licence or certificate', which: 'Which one', newOne: 'A new one', kind: 'Kind', name: 'Name', authorityL: 'Issued by (authority)',
    referenceL: 'Licence or certificate number', validFrom: 'Valid from', expiresOn: 'Expires on (leave empty if it does not expire)', store: 'Store (leave empty for the whole company)',
    personId: 'Person who must renew it (sign-in id)', personName: 'Their name', escalatesTo: 'Also tell (sign-in id, optional)', registerGo: 'Save on the register',
    kind_licence: 'Licence', kind_certificate: 'Certificate', kind_registration: 'Registration', kind_inspection: 'Inspection', kind_calibration: 'Scale stamping or calibration', kind_insurance: 'Insurance', kind_training: 'Training',
    evidenceH: 'File evidence', evidenceRef: 'Document number or reference', evidenceWhat: 'What the document is', evidenceGo: 'File it',
    closeH: 'Close one that no longer applies', closeWhy: 'Why it no longer applies', closeGo: 'Close it',
    registered: 'Saved on the register.', filed: 'Evidence filed.', closedDone: 'Closed. It stays on the register with its reason.', alreadyFiled: 'That evidence was already on file.',
    needRegister: 'Fill in the kind, the name, who issued it, the date it is valid from, and the named person who must renew it.',
    needEvidence: 'Choose the licence and write the document reference and what it is.', needClose: 'Choose the licence and write why it no longer applies.',
    badDate: 'Write dates as YYYY-MM-DD.',
    // Controls
    controlsH: 'Controls and their checks', healthH: 'Each control', overdueH: 'Remediation past its date',
    noControls: 'No control is on the register yet.', noOverdue: 'No remediation is past its date.',
    owner: 'owner', implementsL: 'implements', incidents: 'incident(s)', overdueCount: 'remediation(s) late', lastChecked: 'last checked', neverChecked: 'Never checked — an untested control is an assumption',
    checkedFor: 'How long a check stays current is the owner\'s number: not set, so this page shows only when each was last checked.',
    controlH: 'Register a control', controlTitle: 'What the control is', controlImplements: 'Which requirement or rule it carries out', controlOwner: 'Owner (sign-in id)', controlGo: 'Save the control',
    incidentH: 'Record an incident', incidentTitle: 'What happened', severity: 'How serious', sev1: 'Severe (sev 1)', sev2: 'Serious (sev 2)', sev3: 'Minor (sev 3)',
    occurredAt: 'When it happened', detectedAt: 'When it was noticed', control: 'The control that should have stopped it', incidentGo: 'Record the incident',
    remediationH: 'Plan a remediation', incident: 'For the incident', action: 'What will be done', remOwner: 'Who will do it (sign-in id)', dueOn: 'Due by', remediationGo: 'Save the plan',
    doneGo: 'Mark it done', done: 'done', due: 'due', late: 'LATE',
    attestH: 'Record a check of a control', statement: 'What you checked and what you found', attestGo: 'Record my check', checkedBy: 'checked by',
    controlSaved: 'Control saved.', incidentSaved: 'Incident recorded.', remediationSaved: 'Remediation saved.', remediationDone: 'Remediation marked done.', attested: 'Your check is recorded, in your name, with today\'s time.',
    needControl: 'Write what the control is, what it carries out, and its owner.', needIncident: 'Write what happened, how serious it was, when it happened and was noticed, and choose the control.',
    needRemediation: 'Choose the incident, write what will be done, who will do it and the date it is due.', needAttest: 'Choose the control and write what you checked.',
    // Findings
    findingsH: 'Security findings', findingsLead: 'Findings from scanners close by themselves when a complete scan no longer reports them. Findings a person raises — a penetration test, a review — are recorded and closed here, with written evidence.',
    noFindings: 'No security finding is on the register.', open: 'Open', fixed: 'Fixed', overdue: 'OVERDUE', noOwner: 'nobody owns it yet', fixBy: 'fix by', where: 'where',
    source_pentest: 'Penetration test', source_review: 'Review', scanner: 'Scanner', fixedBy: 'fixed by',
    severity_critical: 'Critical', severity_high: 'High', severity_medium: 'Medium', severity_low: 'Low', severity_info: 'Information',
    raiseH: 'Record a finding', source: 'Where it came from', findingTitle: 'What was found', location: 'Where (a screen, an address, a file)', findingOwner: 'Who must fix it (sign-in id, optional)', raiseGo: 'Record the finding',
    nameOwner: 'Name who must fix it', ownerGo: 'Name them', fixEvidence: 'What was fixed and how it was checked', fixGo: 'Record it fixed',
    findingSaved: 'Finding recorded.', ownerNamed: 'Owner named.', findingFixed: 'Recorded fixed, with your evidence.',
    needFinding: 'Choose where it came from and how serious it is, and write what was found and where.', needOwner: 'Write the sign-in id of the person who must fix it.', needFix: 'Write what was fixed and how it was checked.',
    // Common
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see these registers.', cannotWrite: 'Your role can see this register but not record on it.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved. Try again: the same record is sent, never a second one.', reading: 'Asking head office…', asAt: 'as at',
  },
  ta: {
    title: 'உரிமங்கள், கட்டுப்பாடுகள் மற்றும் கண்டறிதல்கள்',
    lead: 'கடையின் உரிமங்களும் சான்றிதழ்களும் ஒவ்வொன்றையும் புதுப்பிக்க வேண்டிய நபருடன், இடர்களைக் கட்டுப்படுத்தும் கட்டுப்பாடுகளும் அவற்றைச் சரிபார்த்தவர்களும், மக்கள் எழுப்பும் பாதுகாப்புக் கண்டறிதல்களும். இங்கே எதுவும் நீக்கப்படாது: இனி பொருந்தாத உரிமம் அதன் காரணத்துடன் மூடப்பட்டு பதிவில் இருக்கும்.',
    tabLicences: 'உரிமங்களும் சான்றிதழ்களும்', tabControls: 'கட்டுப்பாடுகளும் சரிபார்ப்புகளும்', tabFindings: 'மக்கள் எழுப்பும் கண்டறிதல்கள்',
    licencesH: 'உரிமங்களும் சான்றிதழ்களும்', alertsH: 'கவனம் தேவை', gapsH: 'ஆய்வாளரிடம் காட்ட எதுவும் கோப்பில் இல்லை', registerH: 'பதிவேடு',
    noAlerts: 'எதுவும் காலாவதிக்கு அருகில் இல்லை.', noGaps: 'நடைமுறையில் உள்ள ஒவ்வொரு உரிமத்திற்கும் சான்று கோப்பில் உள்ளது.', noObligations: 'பதிவேட்டில் இன்னும் உரிமமோ சான்றிதழோ இல்லை.',
    expires: 'காலாவதி', noExpiry: 'காலாவதி தேதி இல்லை', daysLeft: 'நாட்கள் உள்ளன', expiredAgo: 'நாட்களுக்கு முன் — காலாவதியானது', who: 'செயல்பட வேண்டியவர்', escalated: 'மேலும் தெரிவிக்கப்பட்டவர்',
    evidence: 'கோப்பில் உள்ள சான்று', noEvidence: 'கோப்பில் சான்று இல்லை', closed: 'மூடப்பட்டது', active: 'நடைமுறையில்', reason: 'காரணம்', authority: 'வழங்கியவர்', reference: 'எண்',
    level_notice: 'வரவிருக்கிறது', level_warning: 'விரைவில்', level_urgent: 'அவசரம்', level_expired: 'காலாவதியானது',
    newH: 'உரிமம் அல்லது சான்றிதழைப் பதிவு செய்', which: 'எது', newOne: 'புதியது', kind: 'வகை', name: 'பெயர்', authorityL: 'வழங்கியவர் (அதிகாரம்)',
    referenceL: 'உரிமம் அல்லது சான்றிதழ் எண்', validFrom: 'செல்லுபடி தொடக்கம்', expiresOn: 'காலாவதி (காலாவதி இல்லையெனில் காலியாக விடுங்கள்)', store: 'கடை (முழு நிறுவனத்திற்கு காலியாக விடுங்கள்)',
    personId: 'புதுப்பிக்க வேண்டியவர் (உள்நுழைவு அடையாளம்)', personName: 'அவர் பெயர்', escalatesTo: 'மேலும் தெரிவிக்க (உள்நுழைவு அடையாளம், விருப்பம்)', registerGo: 'பதிவேட்டில் சேமி',
    kind_licence: 'உரிமம்', kind_certificate: 'சான்றிதழ்', kind_registration: 'பதிவு', kind_inspection: 'ஆய்வு', kind_calibration: 'தராசு முத்திரை அல்லது அளவுத்திருத்தம்', kind_insurance: 'காப்பீடு', kind_training: 'பயிற்சி',
    evidenceH: 'சான்றைக் கோப்பில் சேர்', evidenceRef: 'ஆவண எண் அல்லது குறிப்பு', evidenceWhat: 'ஆவணம் என்ன', evidenceGo: 'சேர்',
    closeH: 'இனி பொருந்தாததை மூடு', closeWhy: 'ஏன் இனி பொருந்தாது', closeGo: 'மூடு',
    registered: 'பதிவேட்டில் சேமிக்கப்பட்டது.', filed: 'சான்று சேர்க்கப்பட்டது.', closedDone: 'மூடப்பட்டது. அதன் காரணத்துடன் பதிவேட்டில் இருக்கும்.', alreadyFiled: 'அந்தச் சான்று ஏற்கனவே கோப்பில் உள்ளது.',
    needRegister: 'வகை, பெயர், வழங்கியவர், செல்லுபடி தொடக்கத் தேதி, புதுப்பிக்க வேண்டிய நபர் ஆகியவற்றை நிரப்புங்கள்.',
    needEvidence: 'உரிமத்தைத் தேர்ந்தெடுத்து ஆவணக் குறிப்பையும் அது என்ன என்பதையும் எழுதுங்கள்.', needClose: 'உரிமத்தைத் தேர்ந்தெடுத்து ஏன் இனி பொருந்தாது என்று எழுதுங்கள்.',
    badDate: 'தேதிகளை YYYY-MM-DD என எழுதுங்கள்.',
    controlsH: 'கட்டுப்பாடுகளும் அவற்றின் சரிபார்ப்புகளும்', healthH: 'ஒவ்வொரு கட்டுப்பாடும்', overdueH: 'தேதி கடந்த சரிசெய்தல்',
    noControls: 'பதிவேட்டில் இன்னும் கட்டுப்பாடு இல்லை.', noOverdue: 'எந்தச் சரிசெய்தலும் தேதி கடக்கவில்லை.',
    owner: 'பொறுப்பாளர்', implementsL: 'செயல்படுத்துவது', incidents: 'நிகழ்வு(கள்)', overdueCount: 'சரிசெய்தல்(கள்) தாமதம்', lastChecked: 'கடைசியாகச் சரிபார்த்தது', neverChecked: 'ஒருபோதும் சரிபார்க்கப்படவில்லை — சோதிக்காத கட்டுப்பாடு ஒரு அனுமானம் மட்டுமே',
    checkedFor: 'ஒரு சரிபார்ப்பு எவ்வளவு காலம் செல்லும் என்பது உரிமையாளரின் எண்: அமைக்கப்படவில்லை, எனவே ஒவ்வொன்றும் கடைசியாக எப்போது சரிபார்க்கப்பட்டது என்பதை மட்டும் காட்டுகிறது.',
    controlH: 'கட்டுப்பாட்டைப் பதிவு செய்', controlTitle: 'கட்டுப்பாடு என்ன', controlImplements: 'எந்தத் தேவை அல்லது விதியை நிறைவேற்றுகிறது', controlOwner: 'பொறுப்பாளர் (உள்நுழைவு அடையாளம்)', controlGo: 'கட்டுப்பாட்டைச் சேமி',
    incidentH: 'நிகழ்வைப் பதிவு செய்', incidentTitle: 'என்ன நடந்தது', severity: 'எவ்வளவு தீவிரம்', sev1: 'கடுமையானது (sev 1)', sev2: 'தீவிரமானது (sev 2)', sev3: 'சிறியது (sev 3)',
    occurredAt: 'எப்போது நடந்தது', detectedAt: 'எப்போது கவனிக்கப்பட்டது', control: 'இதைத் தடுத்திருக்க வேண்டிய கட்டுப்பாடு', incidentGo: 'நிகழ்வைப் பதிவு செய்',
    remediationH: 'சரிசெய்தலைத் திட்டமிடு', incident: 'எந்த நிகழ்வுக்கு', action: 'என்ன செய்யப்படும்', remOwner: 'யார் செய்வார் (உள்நுழைவு அடையாளம்)', dueOn: 'கடைசித் தேதி', remediationGo: 'திட்டத்தைச் சேமி',
    doneGo: 'முடிந்தது எனக் குறி', done: 'முடிந்தது', due: 'கடைசித் தேதி', late: 'தாமதம்',
    attestH: 'கட்டுப்பாட்டின் சரிபார்ப்பைப் பதிவு செய்', statement: 'நீங்கள் என்ன சரிபார்த்தீர்கள், என்ன கண்டீர்கள்', attestGo: 'என் சரிபார்ப்பைப் பதிவு செய்', checkedBy: 'சரிபார்த்தவர்',
    controlSaved: 'கட்டுப்பாடு சேமிக்கப்பட்டது.', incidentSaved: 'நிகழ்வு பதிவு செய்யப்பட்டது.', remediationSaved: 'சரிசெய்தல் சேமிக்கப்பட்டது.', remediationDone: 'சரிசெய்தல் முடிந்தது எனக் குறிக்கப்பட்டது.', attested: 'உங்கள் சரிபார்ப்பு உங்கள் பெயரில், இன்றைய நேரத்துடன் பதிவு செய்யப்பட்டது.',
    needControl: 'கட்டுப்பாடு என்ன, எதை நிறைவேற்றுகிறது, அதன் பொறுப்பாளர் யார் என்று எழுதுங்கள்.', needIncident: 'என்ன நடந்தது, எவ்வளவு தீவிரம், எப்போது நடந்தது, எப்போது கவனிக்கப்பட்டது என்று எழுதி, கட்டுப்பாட்டைத் தேர்ந்தெடுங்கள்.',
    needRemediation: 'நிகழ்வைத் தேர்ந்தெடுத்து, என்ன செய்யப்படும், யார் செய்வார், கடைசித் தேதி ஆகியவற்றை எழுதுங்கள்.', needAttest: 'கட்டுப்பாட்டைத் தேர்ந்தெடுத்து நீங்கள் என்ன சரிபார்த்தீர்கள் என்று எழுதுங்கள்.',
    findingsH: 'பாதுகாப்புக் கண்டறிதல்கள்', findingsLead: 'ஸ்கேனர் கண்டறிதல்கள் முழுமையான ஸ்கேன் அவற்றைக் காட்டாதபோது தானாக மூடப்படும். ஒருவர் எழுப்பும் கண்டறிதல்கள் — ஊடுருவல் சோதனை, மதிப்பாய்வு — இங்கே எழுத்துச் சான்றுடன் பதிவு செய்யப்பட்டு மூடப்படும்.',
    noFindings: 'பதிவேட்டில் பாதுகாப்புக் கண்டறிதல் இல்லை.', open: 'திறந்துள்ளது', fixed: 'சரிசெய்யப்பட்டது', overdue: 'தாமதம்', noOwner: 'இன்னும் யாரும் பொறுப்பேற்கவில்லை', fixBy: 'சரிசெய்ய கடைசி', where: 'எங்கே',
    source_pentest: 'ஊடுருவல் சோதனை', source_review: 'மதிப்பாய்வு', scanner: 'ஸ்கேனர்', fixedBy: 'சரிசெய்தவர்',
    severity_critical: 'மிகக் கடுமையானது', severity_high: 'அதிகம்', severity_medium: 'நடுத்தரம்', severity_low: 'குறைவு', severity_info: 'தகவல்',
    raiseH: 'கண்டறிதலைப் பதிவு செய்', source: 'எங்கிருந்து வந்தது', findingTitle: 'என்ன கண்டறியப்பட்டது', location: 'எங்கே (திரை, முகவரி, கோப்பு)', findingOwner: 'யார் சரிசெய்ய வேண்டும் (உள்நுழைவு அடையாளம், விருப்பம்)', raiseGo: 'கண்டறிதலைப் பதிவு செய்',
    nameOwner: 'சரிசெய்ய வேண்டியவரைக் குறிப்பிடு', ownerGo: 'குறிப்பிடு', fixEvidence: 'என்ன சரிசெய்யப்பட்டது, எப்படிச் சரிபார்க்கப்பட்டது', fixGo: 'சரிசெய்யப்பட்டது எனப் பதிவு செய்',
    findingSaved: 'கண்டறிதல் பதிவு செய்யப்பட்டது.', ownerNamed: 'பொறுப்பாளர் குறிப்பிடப்பட்டார்.', findingFixed: 'உங்கள் சான்றுடன் சரிசெய்யப்பட்டது எனப் பதிவு செய்யப்பட்டது.',
    needFinding: 'எங்கிருந்து வந்தது, எவ்வளவு தீவிரம் என்பதைத் தேர்ந்தெடுத்து, என்ன கண்டறியப்பட்டது, எங்கே என்று எழுதுங்கள்.', needOwner: 'சரிசெய்ய வேண்டியவரின் உள்நுழைவு அடையாளத்தை எழுதுங்கள்.', needFix: 'என்ன சரிசெய்யப்பட்டது, எப்படிச் சரிபார்க்கப்பட்டது என்று எழுதுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு இந்தப் பதிவேடுகளைப் பார்க்க முடியாது.', cannotWrite: 'உங்கள் பங்கு இந்தப் பதிவேட்டைப் பார்க்கலாம், பதிவு செய்ய முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, சேமிக்கப்படவில்லை. மீண்டும் முயலுங்கள்: அதே பதிவுதான் அனுப்பப்படும், இரண்டாவது அல்ல.', reading: 'தலைமை அலுவலகத்திடம் கேட்கிறது…', asAt: 'நேரம்',
  },
} as const;

export const complianceWords = (lang: Lang, key: string): string =>
  (COMPLIANCE_REGISTERS_COPY[lang] as Record<string, string>)[key] ?? (COMPLIANCE_REGISTERS_COPY.en as Record<string, string>)[key] ?? key;
export const complianceOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => complianceWords(lang, k), out);

// ── A write that survives a lost answer ─────────────────────────────────────────────────────────────────────────────────

/**
 * Writes for one form: while the last attempt's answer was LOST (the link dropped), sending the same body again reuses the
 * same record id and idempotency key, so head office keeps one record, never two (hard rule #2). Any answer — saved or
 * refused — forgets them, so the next send is a new record.
 */
export function steadyWriter(input: { readonly keyPrefix: string; readonly fetch?: typeof globalThis.fetch }) {
  const pending = new Map<string, { readonly id: string; readonly key: string; readonly body: string }>();
  return async <T>(slot: string, idPrefix: string, path: (id: string) => string, body: unknown, method: 'POST' | 'PUT' = 'POST', id?: string,
    /** When the record's id travels in the body (not the path): the body to send for that id. */
    withId?: (id: string) => unknown): Promise<Outcome<T, never>> => {
    const json = JSON.stringify(body ?? {});
    const kept = pending.get(slot);
    const same = kept !== undefined && kept.body === json && (id === undefined || id === kept.id);
    const use = same ? kept : { id: id ?? newId(idPrefix), key: newId(input.keyPrefix), body: json };
    pending.set(slot, use);
    const call = makeCaller({ keyPrefix: input.keyPrefix, newKey: () => use.key, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
    const out = await call<T>(method, path(use.id), withId === undefined ? body : withId(use.id));
    if (out.result !== 'lost_link') pending.delete(slot);
    return out;
  };
}

// ── Shapes as the page shows them ───────────────────────────────────────────────────────────────────────────────────────

export const OBLIGATION_KINDS = Object.freeze(['licence', 'certificate', 'registration', 'inspection', 'calibration', 'insurance', 'training'] as const);
export type ObligationKind = typeof OBLIGATION_KINDS[number];
export const INCIDENT_SEVERITIES = Object.freeze(['sev1', 'sev2', 'sev3'] as const);
export const FINDING_SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low', 'info'] as const);
export const PERSON_FINDING_SOURCES = Object.freeze(['pentest', 'review'] as const);

export interface ObligationRow {
  readonly obligationId: string; readonly kind: string; readonly name: string; readonly authority: string; readonly reference?: string;
  readonly branchId: string | null; readonly validFrom: string; readonly expiresOn?: string;
  readonly responsible: { readonly userId: string; readonly name: string; readonly escalatesToUserId?: string };
  readonly evidence: readonly { readonly evidenceId: string; readonly description: string; readonly recordedAt: string }[];
  readonly status: 'active' | 'closed'; readonly closedReason?: string; readonly closedAt?: string;
}
export interface AlertRow {
  readonly obligationId: string; readonly name: string; readonly expiresOn: string; readonly daysRemaining: number; readonly level: string;
  readonly responsible: { readonly userId: string; readonly name: string }; readonly escalatedToUserId?: string; readonly evidenceMissing: boolean;
}
export interface LicencesView { readonly obligations: readonly ObligationRow[]; readonly alerts: readonly AlertRow[]; readonly gaps: readonly string[]; readonly asOf: string }

export interface ControlRow { readonly controlId: string; readonly title: string; readonly implements: string; readonly ownerUserId: string }
export interface IncidentRow { readonly incidentId: string; readonly title: string; readonly severity: string; readonly occurredAt: string; readonly detectedAt: string; readonly controlId: string }
export interface RemediationRow { readonly remediationId: string; readonly incidentId: string; readonly action: string; readonly ownerUserId: string; readonly dueOn: string; readonly completedAt?: string }
export interface AttestationRow { readonly attestationId: string; readonly controlId: string; readonly attestedBy: string; readonly attestedAt: string; readonly statement: string }
export interface HealthRow { readonly controlId: string; readonly incidentCount: number; readonly overdueRemediations: number; readonly lastAttestedAt?: string }
export interface ControlsView {
  readonly controls: readonly ControlRow[]; readonly incidents: readonly IncidentRow[]; readonly remediations: readonly RemediationRow[];
  readonly attestations: readonly AttestationRow[]; readonly health: readonly HealthRow[]; readonly overdue: readonly string[]; readonly asOf: string;
}

export interface FindingRow {
  readonly findingId: string; readonly source: string; readonly byPerson: boolean; readonly title: string; readonly severity: string; readonly location: string;
  readonly status: 'open' | 'fixed'; readonly ownerUserId?: string; readonly fixDueBy?: string; readonly overdue: boolean; readonly fixedBy?: string; readonly fixedEvidence?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const opt = (k: string, v: unknown): Record<string, string> => (typeof v === 'string' && v !== '' ? { [k]: v } : {});
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const list = (v: unknown): readonly Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const realDay = (v: string): boolean => DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export function obligationRowOf(o: Record<string, unknown>): ObligationRow | undefined {
  if (!filled(o['obligationId'])) return undefined;
  const r = isObj(o['responsible']) ? o['responsible'] : {};
  return {
    obligationId: str(o['obligationId']), kind: str(o['kind']), name: str(o['name']), authority: str(o['authority']), ...opt('reference', o['reference']),
    branchId: typeof o['branchId'] === 'string' ? o['branchId'] : null, validFrom: str(o['validFrom']), ...opt('expiresOn', o['expiresOn']),
    responsible: { userId: str(r['userId']), name: str(r['name']), ...opt('escalatesToUserId', r['escalatesToUserId']) },
    evidence: list(o['evidence']).map((e) => ({ evidenceId: str(e['evidenceId']), description: str(e['description']), recordedAt: str(e['recordedAt']) })),
    status: o['status'] === 'closed' ? 'closed' : 'active', ...opt('closedReason', o['closedReason']), ...opt('closedAt', o['closedAt']),
  };
}

export function findingRowOf(f: Record<string, unknown>): FindingRow | undefined {
  if (!filled(f['findingId'])) return undefined;
  const source = str(f['source']);
  return {
    findingId: str(f['findingId']), source, byPerson: (PERSON_FINDING_SOURCES as readonly string[]).includes(source), title: str(f['title']), severity: str(f['severity']),
    location: str(f['location']), status: f['status'] === 'fixed' ? 'fixed' : 'open', ...opt('ownerUserId', f['ownerUserId']), ...opt('fixDueBy', f['fixDueBy']),
    overdue: f['overdue'] === true, ...opt('fixedBy', f['fixedBy']), ...opt('fixedEvidence', f['fixedEvidence']),
  };
}

// ── The session ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Why = 'nobody' | 'cannotRead' | 'cannotWrite' | 'needRegister' | 'needEvidence' | 'needClose' | 'badDate'
  | 'needControl' | 'needIncident' | 'needRemediation' | 'needAttest' | 'needFinding' | 'needOwner' | 'needFix';
type Done<T> = Promise<Outcome<T, Why>>;
type Area = 'licences' | 'controls' | 'findings';

export interface ObligationInput {
  readonly obligationId?: string; readonly kind: string; readonly name: string; readonly authority: string; readonly reference?: string;
  readonly validFrom: string; readonly expiresOn?: string; readonly branchId?: string;
  readonly personId: string; readonly personName: string; readonly escalatesTo?: string;
}

export interface ComplianceRegistersSession {
  readonly may: { readonly named: boolean } & Readonly<Record<`read_${Area}` | `write_${Area}`, boolean>>;
  licences(): Done<LicencesView>;
  register(o: ObligationInput): Done<{ readonly obligationId: string }>;
  fileEvidence(obligationId: string, reference: string, description: string): Done<{ readonly alreadyOnFile: boolean }>;
  close(obligationId: string, reason: string): Done<{ readonly obligationId: string }>;
  controls(): Done<ControlsView>;
  saveControl(c: { readonly controlId?: string; readonly title: string; readonly implements: string; readonly ownerUserId: string }): Done<{ readonly controlId: string }>;
  recordIncident(i: { readonly title: string; readonly severity: string; readonly occurredAt: string; readonly detectedAt: string; readonly controlId: string }): Done<{ readonly incidentId: string }>;
  planRemediation(r: { readonly incidentId: string; readonly action: string; readonly ownerUserId: string; readonly dueOn: string }): Done<{ readonly remediationId: string }>;
  markDone(r: RemediationRow): Done<{ readonly remediationId: string }>;
  attest(controlId: string, statement: string): Done<{ readonly attestedAt: string }>;
  findings(): Done<{ readonly findings: readonly FindingRow[]; readonly asAt: string }>;
  raiseFinding(f: { readonly source: string; readonly title: string; readonly severity: string; readonly location: string; readonly ownerUserId?: string }): Done<{ readonly findingId: string }>;
  nameOwner(findingId: string, ownerUserId: string): Done<{ readonly ownerUserId: string }>;
  markFixed(findingId: string, evidence: string): Done<{ readonly status: string }>;
}

const PERM: Readonly<Record<`read_${Area}` | `write_${Area}`, string>> = {
  read_licences: 'compliance.obligation.read', write_licences: 'compliance.obligation.manage',
  read_controls: 'compliance.risk.read', write_controls: 'compliance.risk.manage',
  read_findings: 'compliance.finding.read', write_findings: 'compliance.finding.record',
};

export function createComplianceRegistersSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch;
  /** The shop's zone (what `datetime-local` fields mean); the store computer's, else the shop default. */
  readonly timeZone?: string;
  /** The moment now — a check is recorded at it. */
  readonly now?: () => string;
}): ComplianceRegistersSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = Object.freeze({ named, ...Object.fromEntries(Object.entries(PERM).map(([k, p]) => [k, named && held.has(p)])) }) as ComplianceRegistersSession['may'];
  const call = makeCaller({ keyPrefix: 'compliance', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const write = steadyWriter({ keyPrefix: 'compliance', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const now = input.now ?? (() => new Date().toISOString());
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (area: Area, w: 'read' | 'write') => (!named ? no('nobody') : !may[`${w}_${area}`] ? no(w === 'read' ? 'cannotRead' : 'cannotWrite') : undefined);
  const instant = (typed: string): string => (input.timeZone === undefined ? instantOfTyped(typed) : instantOfTyped(typed, input.timeZone));
  const enc = encodeURIComponent;

  return {
    may,

    licences: async () => {
      const g = gate('licences', 'read'); if (g) return g;
      const [reg, alerts, gaps] = await Promise.all([
        call<{ obligations?: unknown }>('GET', '/v1/compliance/obligations'),
        call<{ alerts?: unknown; asOf?: unknown }>('GET', '/v1/compliance/alerts'),
        call<{ obligations?: unknown }>('GET', '/v1/compliance/evidence-gaps'),
      ]);
      if (reg.result !== 'ok') return reg;
      if (alerts.result !== 'ok') return alerts;
      if (gaps.result !== 'ok') return gaps;
      return {
        result: 'ok',
        value: {
          obligations: list(reg.value.obligations).map(obligationRowOf).filter((o): o is ObligationRow => o !== undefined),
          alerts: list(alerts.value.alerts).map((a) => {
            const r = isObj(a['responsible']) ? a['responsible'] : {};
            return {
              obligationId: str(a['obligationId']), name: str(a['name']), expiresOn: str(a['expiresOn']), daysRemaining: num(a['daysRemaining']), level: str(a['level']),
              responsible: { userId: str(r['userId']), name: str(r['name']) }, ...opt('escalatedToUserId', a['escalatedToUserId']), evidenceMissing: a['evidenceMissing'] === true,
            };
          }),
          gaps: list(gaps.value.obligations).map((o) => str(o['obligationId'])).filter((x) => x !== ''),
          asOf: str(alerts.value.asOf),
        },
      };
    },

    register: async (o) => {
      const g = gate('licences', 'write'); if (g) return g;
      if (!(OBLIGATION_KINDS as readonly string[]).includes(o.kind) || ![o.name, o.authority, o.validFrom, o.personId, o.personName].every(filled)) return no('needRegister');
      const expires = o.expiresOn?.trim() ?? '';
      if (!realDay(o.validFrom.trim()) || (expires !== '' && !realDay(expires))) return no('badDate');
      const body = {
        kind: o.kind, name: o.name.trim(), authority: o.authority.trim(), ...(filled(o.reference) ? { reference: o.reference.trim() } : {}),
        validFrom: o.validFrom.trim(), ...(expires === '' ? {} : { expiresOn: expires }), ...(filled(o.branchId) ? { branchId: o.branchId.trim() } : {}),
        responsible: { userId: o.personId.trim(), name: o.personName.trim(), ...(filled(o.escalatesTo) ? { escalatesToUserId: o.escalatesTo.trim() } : {}) },
      };
      const id = filled(o.obligationId) ? o.obligationId.trim() : undefined;
      const out = await write<{ obligationId?: unknown }>('register', 'lic', (x) => `/v1/compliance/obligations/${enc(x)}`, body, 'POST', id);
      return out.result === 'ok' ? { result: 'ok', value: { obligationId: str(out.value.obligationId) } } : out;
    },

    fileEvidence: async (obligationId, reference, description) => {
      const g = gate('licences', 'write'); if (g) return g;
      if (![obligationId, reference, description].every(filled)) return no('needEvidence');
      const out = await write<{ alreadyOnFile?: unknown }>(`evidence:${obligationId}`, 'ev', () => `/v1/compliance/obligations/${enc(obligationId.trim())}/evidence`,
        { evidenceId: reference.trim(), description: description.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { alreadyOnFile: out.value.alreadyOnFile === true } } : out;
    },

    close: async (obligationId, reason) => {
      const g = gate('licences', 'write'); if (g) return g;
      if (![obligationId, reason].every(filled)) return no('needClose');
      const out = await write<{ obligationId?: unknown }>(`close:${obligationId}`, 'close', () => `/v1/compliance/obligations/${enc(obligationId.trim())}/close`, { reason: reason.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { obligationId: str(out.value.obligationId) } } : out;
    },

    controls: async () => {
      const g = gate('controls', 'read'); if (g) return g;
      // No validDays is sent: how long a check stays current is the owner's number, and this page judges no staleness.
      const [reg, health, overdue] = await Promise.all([
        call<Record<string, unknown>>('GET', '/v1/compliance/control-register'),
        call<{ health?: unknown; asOf?: unknown }>('GET', '/v1/compliance/controls/health'),
        call<{ overdue?: unknown }>('GET', '/v1/compliance/remediations/overdue'),
      ]);
      if (reg.result !== 'ok') return reg;
      if (health.result !== 'ok') return health;
      if (overdue.result !== 'ok') return overdue;
      const v = reg.value;
      return {
        result: 'ok',
        value: {
          controls: list(v['controls']).map((c) => ({ controlId: str(c['controlId']), title: str(c['title']), implements: str(c['implements']), ownerUserId: str(c['ownerUserId']) })),
          incidents: list(v['incidents']).map((i) => ({ incidentId: str(i['incidentId']), title: str(i['title']), severity: str(i['severity']), occurredAt: str(i['occurredAt']), detectedAt: str(i['detectedAt']), controlId: str(i['controlId']) })),
          remediations: list(v['remediations']).map((r) => ({ remediationId: str(r['remediationId']), incidentId: str(r['incidentId']), action: str(r['action']), ownerUserId: str(r['ownerUserId']), dueOn: str(r['dueOn']), ...opt('completedAt', r['completedAt']) })),
          attestations: list(v['attestations']).map((a) => ({ attestationId: str(a['attestationId']), controlId: str(a['controlId']), attestedBy: str(a['attestedBy']), attestedAt: str(a['attestedAt']), statement: str(a['statement']) })),
          health: list(health.value.health).map((h) => ({ controlId: str(h['controlId']), incidentCount: num(h['incidentCount']), overdueRemediations: num(h['overdueRemediations']), ...opt('lastAttestedAt', h['lastAttestedAt']) })),
          overdue: list(overdue.value.overdue).map((r) => str(r['remediationId'])).filter((x) => x !== ''),
          asOf: str(health.value.asOf),
        },
      };
    },

    saveControl: async (c) => {
      const g = gate('controls', 'write'); if (g) return g;
      if (![c.title, c.implements, c.ownerUserId].every(filled)) return no('needControl');
      const id = filled(c.controlId) ? c.controlId.trim() : undefined;
      const out = await write<{ controlId?: unknown }>('control', 'ctl', (x) => `/v1/compliance/controls/${enc(x)}`, { title: c.title.trim(), implements: c.implements.trim(), ownerUserId: c.ownerUserId.trim() }, 'POST', id);
      return out.result === 'ok' ? { result: 'ok', value: { controlId: str(out.value.controlId) } } : out;
    },

    recordIncident: async (i) => {
      const g = gate('controls', 'write'); if (g) return g;
      if (![i.title, i.controlId, i.occurredAt, i.detectedAt].every(filled) || !(INCIDENT_SEVERITIES as readonly string[]).includes(i.severity)) return no('needIncident');
      const occurredAt = instant(i.occurredAt); const detectedAt = instant(i.detectedAt);
      if (occurredAt === '' || detectedAt === '') return no('badDate');
      const out = await write<{ incidentId?: unknown }>('incident', 'inc', (x) => `/v1/compliance/incidents/${enc(x)}`, { title: i.title.trim(), severity: i.severity, occurredAt, detectedAt, controlId: i.controlId.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { incidentId: str(out.value.incidentId) } } : out;
    },

    planRemediation: async (r) => {
      const g = gate('controls', 'write'); if (g) return g;
      if (![r.incidentId, r.action, r.ownerUserId, r.dueOn].every(filled)) return no('needRemediation');
      if (!realDay(r.dueOn.trim())) return no('badDate');
      const out = await write<{ remediationId?: unknown }>('remediation', 'rem', (x) => `/v1/compliance/remediations/${enc(x)}`,
        { incidentId: r.incidentId.trim(), action: r.action.trim(), ownerUserId: r.ownerUserId.trim(), dueOn: r.dueOn.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { remediationId: str(out.value.remediationId) } } : out;
    },

    // Done is the same remediation again with the moment it was completed — a new fact, never an edit (hard rule #2).
    markDone: async (r) => {
      const g = gate('controls', 'write'); if (g) return g;
      const out = await write<{ remediationId?: unknown }>(`done:${r.remediationId}`, 'rem', () => `/v1/compliance/remediations/${enc(r.remediationId)}`,
        { incidentId: r.incidentId, action: r.action, ownerUserId: r.ownerUserId, dueOn: r.dueOn, completedAt: now() });
      return out.result === 'ok' ? { result: 'ok', value: { remediationId: str(out.value.remediationId) } } : out;
    },

    attest: async (controlId, statement) => {
      const g = gate('controls', 'write'); if (g) return g;
      if (![controlId, statement].every(filled)) return no('needAttest');
      // No attestedAt is sent: head office stamps the moment, and takes the checker from the sign-in (never a field).
      const out = await write<{ attestedAt?: unknown }>(`attest:${controlId}`, 'att', (x) => `/v1/compliance/attestations/${enc(x)}`, { controlId: controlId.trim(), statement: statement.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { attestedAt: str(out.value.attestedAt) } } : out;
    },

    findings: async () => {
      const g = gate('findings', 'read'); if (g) return g;
      const out = await call<{ findings?: unknown; asAt?: unknown }>('GET', '/v1/compliance/findings');
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: { findings: list(out.value.findings).map(findingRowOf).filter((f): f is FindingRow => f !== undefined), asAt: str(out.value.asAt) } };
    },

    raiseFinding: async (f) => {
      const g = gate('findings', 'write'); if (g) return g;
      if (!(PERSON_FINDING_SOURCES as readonly string[]).includes(f.source) || !(FINDING_SEVERITIES as readonly string[]).includes(f.severity) || ![f.title, f.location].every(filled)) return no('needFinding');
      const body = { source: f.source, title: f.title.trim(), severity: f.severity, location: f.location.trim(), ...(filled(f.ownerUserId) ? { ownerUserId: f.ownerUserId.trim() } : {}) };
      const out = await write<{ finding?: { findingId?: unknown } }>('finding', `${f.source}`, (x) => `/v1/compliance/findings/${enc(x)}`, body);
      return out.result === 'ok' ? { result: 'ok', value: { findingId: str(out.value.finding?.findingId) } } : out;
    },

    nameOwner: async (findingId, ownerUserId) => {
      const g = gate('findings', 'write'); if (g) return g;
      if (!filled(ownerUserId)) return no('needOwner');
      const out = await write<{ ownerUserId?: unknown }>(`owner:${findingId}`, 'own', () => `/v1/compliance/findings/${enc(findingId)}/owner`, { ownerUserId: ownerUserId.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { ownerUserId: str(out.value.ownerUserId) } } : out;
    },

    markFixed: async (findingId, evidence) => {
      const g = gate('findings', 'write'); if (g) return g;
      if (!filled(evidence)) return no('needFix');
      const out = await write<{ status?: unknown }>(`fixed:${findingId}`, 'fix', () => `/v1/compliance/findings/${enc(findingId)}/fixed`, { evidence: evidence.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { status: str(out.value.status) } } : out;
    },
  };
}
