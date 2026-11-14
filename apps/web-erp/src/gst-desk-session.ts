// The GST and statutory tax desk (W5 · route audit section 2, bundle 2 · API-09 · M23 · A14 · A17 · A18 · A19 · A24 ·
// OB-143 · OB-191 · OB-428 · OB-432 · OB-433) — a tested, DOM-free session over head office's GST routes that no screen
// reached. Every figure is head office's; this session only turns typed rupees into paise, percent into basis points,
// and the shop's month into the dates head office asks for. Each write goes ONCE: its idempotency key is kept while head
// office's answer is lost (a retry is the same act) and dropped on any definite answer.
//
//   GSTR-1 (the GST returns page):
//     • the full return (GET /v1/finance/gstr1/return) and Table 12 (GET /v1/finance/gstr1/table-12);
//     • Table 12 from the till's own banked sales (POST /v1/finance/gstr1/from-sales/table-12) — needs the shop's annual
//       turnover, typed by the person (it sets the HSN digit rule; never a default here);
//     • the GSTN JSON file to upload on the portal by hand (GET /v1/finance/gstr1/export) — nothing is filed from here;
//       the owner checks it in the GSTN offline tool before the first live filing (OB-433).
//   The owner's warning window before the 3-year bar (PUT /v1/finance/gst/controls/time-bar-warning-days, A19 · OB-191).
//   GSTR-9C: the reason for an open difference (POST /v1/finance/gstr9c/:fy/reasons, A18).
//   Reverse charge (A14 · OB-143 "A", switched off until the owner switches it on): the CA's heads (GET/POST
//     /v1/finance/rcm/heads, …/retire), a purchase recorded (POST /v1/finance/rcm/purchases/:id), its tax paid in cash
//     (…/paid), and the month's register (GET /v1/finance/rcm/register).
//   Income-tax TDS (A24 · OB-143 "A"): the CA's list of sections and payees ("not set" until the CA fills it — never an
//     invented rate), the owner's switch, a challan, and the quarter's 26Q.
//   Input tax credit (the ITC page, A17): what GSTR-3B Table 4 may claim (GET /v1/finance/itc/:month/claim) and a Rule
//     37 / 42 / 43 or free-sample reversal (POST /v1/finance/itc/:month/reversals/:id) — its own compensating record.
// Head office re-checks every permission and refuses in its own words (OB-553: its sentences stay English).

export type Lang = 'en' | 'ta';

export type Outcome<T> =
  | { readonly result: 'ok'; readonly value: T }
  | { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string; readonly nextSafeAction: string }
  | { readonly result: 'invalid'; readonly why: DeskWhy }
  | { readonly result: 'lost_link' };

export type DeskWhy =
  | 'nobody' | 'notAllowed' | 'badPeriod' | 'badFy' | 'badGstin' | 'badTurnover' | 'badDays' | 'needReason'
  | 'badHeadCode' | 'badRate' | 'needName' | 'needCitation' | 'needSupplier' | 'badDate' | 'badAmount' | 'needDescription'
  | 'badPlace' | 'needChallan' | 'needPayments' | 'badSection' | 'badThreshold' | 'needLabel' | 'badPan' | 'badRule'
  | 'needSource' | 'badCode';

export const GST_DESK_COPY = {
  en: {
    g1H: 'GSTR-1 for the month', g1Lead: 'Head office\'s GSTR-1 for the month: the full return, Table 12 (HSN summary) and Table 12 worked out from the till\'s own sales. The GSTN file is the file you upload on the GST portal yourself — nothing is filed from this page.',
    month: 'Month (MMYYYY)', gstin: 'The shop\'s GSTIN', turnover: 'Annual turnover (₹) — sets the HSN digits', showReturn: 'Show the return', showT12: 'Show Table 12', showT12Sales: 'Table 12 from the till\'s sales', download: 'Download the GSTN file',
    fileNote: 'Upload this file on the GST portal yourself. Check it in the GSTN offline tool before the first live filing (OB-433). Once a second person has approved the return and you have uploaded it, record the portal\'s ARN on the return in the list above (OB-683). Nothing was filed.',
    b2b: 'B2B invoices', b2c: 'B2C by rate', hsnRows: 'HSN rows', notes: 'credit / debit notes', taxable: 'taxable', tax: 'tax', documents: 'documents',
    unmapped: 'sold items with no HSN or rate — NOT on the return until mapped', soldLines: 'sold lines', returnedLines: 'returned lines', net: 'net of returns',
    rate: 'rate', qty: 'qty',
    timeBarH: 'Warning before the 3-year bar', timeBarLead: 'How many days before a return\'s 3-year time bar the owner is warned. The owner decided 180 days (OB-191); only the owner changes it, with a reason.',
    days: 'Days', reason: 'Reason (required)', saveDays: 'Change the warning window', daysSaved: 'Warning window now',
    g9cH: 'GSTR-9C differences', g9cLead: 'Each difference between the books and GSTR-9 for the year. One without a reason is OPEN; write the reason for each.',
    fy: 'Financial year (YYYY-YY)', showFy: 'Show the year', saveReason: 'Record the reason', open: 'OPEN', explained: 'explained', noDiff: 'No difference — the books equal GSTR-9.',
    turnoverDiff: 'turnover', taxDiff: 'tax', reasonSaved: 'Reason recorded',
    c_month_not_filed: 'Month not filed and locked', c_outward_documents_not_in_books: 'Outward documents not in the books', c_changed_after_gstr1_filed_not_amended: 'Banked after GSTR-1 was filed — not amended', c_books_differ_from_till: 'The books differ from the till',
    rcmH: 'Reverse charge', rcmLead: 'Built switched off (OB-143): the CA lists the heads (each with its rate and the notification it falls under), then the owner switches reverse charge on. Until then a purchase is recorded but no self-invoice is issued.',
    switchedOn: 'SWITCHED ON', switchedOff: 'SWITCHED OFF', notSet: 'NOT SET — the CA has not listed any head yet', headsH: 'The CA\'s heads', retiredH: 'Retired heads',
    headCode: 'Head code (capitals and digits)', headName: 'Name', ratePct: 'GST rate (%)', notifiedUnder: 'Notified under (the CA\'s citation)', saveHead: 'Save the head', retire: 'Retire', headSaved: 'Head saved', headRetired: 'Head retired',
    purchaseH: 'Record a reverse-charge purchase', supplierId: 'Supplier (as in the supplier master)', supplyDate: 'Supply date', taxableRs: 'Taxable value (₹)', place: 'Place of supply', intra: 'Inside Tamil Nadu', inter: 'From another State', description: 'What was bought', headOptional: 'Head (optional)', recordPurchase: 'Record the purchase', purchaseSaved: 'Recorded',
    registerH: 'Reverse charge for the month', showRegister: 'Show the month', selfInvoice: 'self-invoice', noSelfInvoice: 'no self-invoice', liability: '3.1(d) to pay in cash', itcPaid: '4(A)(3) credit (paid)', unpaid: 'unpaid self-invoice(s)', exceptions: 'need a person',
    challanRef: 'Challan reference (CPIN / CIN)', paidOn: 'Paid on', markPaid: 'Mark the tax paid', paidSaved: 'Paid — credit from', noPurchases: 'No reverse-charge purchase in this month.',
    tdsOn: 'TDS is switched on: payments to the payees on the CA\'s list are made net of TDS.', tdsOffFilled: 'TDS is switched off. The CA\'s list is filled; it takes effect when the owner switches it on (OB-143).', tdsOffEmpty: 'TDS is switched off. The CA has not filled the payee, section and rate list yet; once the CA has, the owner switches it on (OB-143).',
    tdsH: 'Income-tax TDS on supplier payments', tdsLead: 'Built switched off (OB-143): the CA fills the sections, rates, thresholds and payees; the owner switches it on. Nothing here is a default — a rate not set is said, never guessed.',
    sectionsH: 'Sections', payeesH: 'Payees', noSections: 'NOT SET — the CA has not filled any section yet', noPayees: 'No payee on the list yet.',
    section: 'Section (e.g. 194C)', label: 'What it covers', singleRs: 'Single-payment threshold (₹, blank = none)', aggregateRs: 'Yearly threshold (₹, blank = none)', onCrossing: 'When crossed, deduct on',
    thisPayment: 'this payment only', wholeAggregate: 'the whole year so far', addSection: 'Add the section to the list', removeSection: 'Remove',
    payeeSupplier: 'Supplier', applicable: 'TDS applies', yes: 'yes', no: 'no', payeeSection: 'Section', pan: 'PAN', addPayee: 'Add the payee to the list', removePayee: 'Remove', saveList: 'Save the list', listSaved: 'The CA\'s list saved — version',
    switchOn: 'Switch TDS on', switchOff: 'Switch TDS off', switchReason: 'Reason (required)', switched: 'TDS now',
    openLiability: 'TDS deducted, not yet deposited', liabilitiesH: 'Deductions', deposited: 'deposited', liabilityWord: 'NOT DEPOSITED',
    challanH: 'Record a TDS challan', challanRefT: 'Challan (BSR code, date, serial)', depositedOn: 'Deposited on', paymentIds: 'Payments it covers (ids, comma-separated)', amountRs: 'Amount (₹)', recordChallan: 'Record the challan', challanSaved: 'Challan recorded',
    q26H: '26Q for the quarter', quarter: 'Quarter', show26q: 'Show the 26Q', total: 'total TDS', depositedTotal: 'deposited', undeposited: 'deduction(s) with no challan — the 26Q cannot be filed true yet', withoutPan: 'deductee(s) with no PAN on the list', noRows: 'No deduction in this quarter.',
    itcClaimH: 'What GSTR-3B Table 4 claims', claimReconciled: 'Reconciled — claim', claimNot: 'Not reconciled',
    reversalH: 'Reverse input tax credit', reversalLead: 'A Rule 37, 42 or 43 reversal, or the credit on a free sample — its own record for the month, never an edit of an accepted line.',
    rule: 'Rule', rule_37: 'Rule 37 — supplier not paid in 180 days', rule_42: 'Rule 42 — exempt / non-business use (inputs)', rule_43: 'Rule 43 — capital goods', free_samples: 'Free samples given away',
    sourceRef: 'What it is for (invoice, line or free-sample record)', igst: 'IGST (₹)', cgst: 'CGST (₹)', sgst: 'SGST (₹)', cess: 'Cess (₹)', recordReversal: 'Record the reversal', reversalSaved: 'Reversal recorded', reversalsH: 'Reversals this month', noReversals: 'No reversal this month.',
    saved: 'Saved.', reading: 'Asking head office…',
    nobody: 'Nobody is signed in on this screen.', notAllowed: 'Your role cannot do this — head office would refuse it.',
    badPeriod: 'Write the month as MMYYYY, e.g. 052026.', badFy: 'Write the year as YYYY-YY, e.g. 2026-27.', badGstin: 'Write the shop\'s 15-character GSTIN.',
    badTurnover: 'Write the annual turnover in rupees.', badDays: 'Write a whole number of days, from 1 to 1095.', needReason: 'Write the reason first.',
    badHeadCode: 'A head code is capital letters and digits.', badRate: 'Write the rate as a percentage, e.g. 5 or 18.', needName: 'Write the name.', needCitation: 'Write the notification it is notified under.',
    needSupplier: 'Write the supplier as in the supplier master.', badDate: 'Choose the date.', badAmount: 'Write an amount in rupees above zero.', needDescription: 'Write what was bought.',
    badPlace: 'Choose the place of supply.', needChallan: 'Write the challan reference.', needPayments: 'Name the payments the challan covers.',
    badSection: 'Write the section, e.g. 194C.', badThreshold: 'A threshold is an amount in rupees, or blank for none.', needLabel: 'Write what the section covers.', badPan: 'A PAN is 10 characters, e.g. ABCDE1234F.',
    badRule: 'Choose the rule.', needSource: 'Write what the reversal is for.', badCode: 'Choose the difference.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was saved or changed. Press again: it is the same request and head office does it only once.',
  },
  ta: {
    g1H: 'மாதத்தின் GSTR-1', g1Lead: 'தலைமை அலுவலகத்தின் மாத GSTR-1: முழு வருமானம், அட்டவணை 12 (HSN சுருக்கம்), கல்லாவின் சொந்த விற்பனையிலிருந்து கணக்கிட்ட அட்டவணை 12. GSTN கோப்பை நீங்களே GST போர்ட்டலில் பதிவேற்றுகிறீர்கள் — இந்தப் பக்கத்திலிருந்து எதுவும் தாக்கல் செய்யப்படாது.',
    month: 'மாதம் (MMYYYY)', gstin: 'கடையின் GSTIN', turnover: 'ஆண்டு விற்றுமுதல் (₹) — HSN இலக்கங்களை முடிவு செய்கிறது', showReturn: 'வருமானத்தைக் காட்டு', showT12: 'அட்டவணை 12-ஐக் காட்டு', showT12Sales: 'கல்லா விற்பனையிலிருந்து அட்டவணை 12', download: 'GSTN கோப்பைப் பதிவிறக்கு',
    fileNote: 'இந்தக் கோப்பை நீங்களே GST போர்ட்டலில் பதிவேற்றுங்கள். முதல் நேரடித் தாக்கலுக்கு முன் GSTN ஆஃப்லைன் கருவியில் சரிபார்க்கவும் (OB-433). இரண்டாவது நபர் ஒப்புதல் அளித்து நீங்கள் பதிவேற்றிய பின், மேலே உள்ள பட்டியலில் அந்த வருமானத்தில் போர்ட்டலின் ARN-ஐப் பதிவு செய்யுங்கள் (OB-683). எதுவும் தாக்கல் செய்யப்படவில்லை.',
    b2b: 'B2B விலைப்பட்டியல்கள்', b2c: 'வீதப்படி B2C', hsnRows: 'HSN வரிசைகள்', notes: 'வரவு / பற்று குறிப்புகள்', taxable: 'வரிக்குரியது', tax: 'வரி', documents: 'ஆவணங்கள்',
    unmapped: 'HSN அல்லது வீதம் இல்லாத விற்ற பொருட்கள் — பொருத்தும் வரை வருமானத்தில் இல்லை', soldLines: 'விற்ற வரிகள்', returnedLines: 'திருப்பிய வரிகள்', net: 'திருப்பியவை கழித்து',
    rate: 'வீதம்', qty: 'அளவு',
    timeBarH: '3 ஆண்டு தடைக்கு முன் எச்சரிக்கை', timeBarLead: 'ஒரு வருமானத்தின் 3 ஆண்டு கால வரம்புக்கு எத்தனை நாள் முன் உரிமையாளருக்கு எச்சரிக்கை. உரிமையாளர் 180 நாள் என முடிவு செய்தார் (OB-191); உரிமையாளர் மட்டுமே காரணத்துடன் மாற்றுவார்.',
    days: 'நாட்கள்', reason: 'காரணம் (தேவை)', saveDays: 'எச்சரிக்கைக் காலத்தை மாற்று', daysSaved: 'எச்சரிக்கைக் காலம் இப்போது',
    g9cH: 'GSTR-9C வேறுபாடுகள்', g9cLead: 'ஆண்டுக்கான கணக்குகளுக்கும் GSTR-9-க்கும் இடையிலான ஒவ்வொரு வேறுபாடும். காரணம் இல்லாதது திறந்த நிலையில்; ஒவ்வொன்றுக்கும் காரணத்தை எழுதுங்கள்.',
    fy: 'நிதியாண்டு (YYYY-YY)', showFy: 'ஆண்டைக் காட்டு', saveReason: 'காரணத்தைப் பதிவு செய்', open: 'திறந்தது', explained: 'விளக்கப்பட்டது', noDiff: 'வேறுபாடு இல்லை — கணக்குகள் GSTR-9-க்குச் சமம்.',
    turnoverDiff: 'விற்றுமுதல்', taxDiff: 'வரி', reasonSaved: 'காரணம் பதிவானது',
    c_month_not_filed: 'மாதம் தாக்கல் செய்யப்பட்டுப் பூட்டப்படவில்லை', c_outward_documents_not_in_books: 'கணக்குகளில் இல்லாத வெளிச்செல்லும் ஆவணங்கள்', c_changed_after_gstr1_filed_not_amended: 'GSTR-1 தாக்கலுக்குப் பின் வந்தது — திருத்தப்படவில்லை', c_books_differ_from_till: 'கணக்குகள் கல்லாவிலிருந்து வேறுபடுகின்றன',
    rcmH: 'தலைகீழ் வரி (RCM)', rcmLead: 'நிறுத்தப்பட்ட நிலையில் கட்டப்பட்டது (OB-143): CA தலைப்புகளைப் பட்டியலிடுகிறார் (வீதமும் அறிவிப்பும்), பிறகு உரிமையாளர் இயக்குகிறார். அதுவரை கொள்முதல் பதிவாகும், ஆனால் சுய விலைப்பட்டியல் வழங்கப்படாது.',
    switchedOn: 'இயக்கத்தில்', switchedOff: 'நிறுத்தப்பட்டுள்ளது', notSet: 'அமைக்கப்படவில்லை — CA இன்னும் எந்தத் தலைப்பையும் பட்டியலிடவில்லை', headsH: 'CA-வின் தலைப்புகள்', retiredH: 'ஓய்வுபெற்ற தலைப்புகள்',
    headCode: 'தலைப்புக் குறியீடு (பெரிய எழுத்துகள், இலக்கங்கள்)', headName: 'பெயர்', ratePct: 'GST வீதம் (%)', notifiedUnder: 'அறிவிப்பு (CA-வின் மேற்கோள்)', saveHead: 'தலைப்பைச் சேமி', retire: 'ஓய்வு', headSaved: 'தலைப்பு சேமிக்கப்பட்டது', headRetired: 'தலைப்பு ஓய்வுபெற்றது',
    purchaseH: 'தலைகீழ் வரிக் கொள்முதலைப் பதிவு செய்', supplierId: 'விநியோகஸ்தர் (விநியோகஸ்தர் பட்டியலில் உள்ளபடி)', supplyDate: 'விநியோகத் தேதி', taxableRs: 'வரிக்குரிய மதிப்பு (₹)', place: 'விநியோக இடம்', intra: 'தமிழ்நாட்டுக்குள்', inter: 'வேறு மாநிலத்திலிருந்து', description: 'என்ன வாங்கப்பட்டது', headOptional: 'தலைப்பு (விருப்பம்)', recordPurchase: 'கொள்முதலைப் பதிவு செய்', purchaseSaved: 'பதிவானது',
    registerH: 'மாதத்தின் தலைகீழ் வரி', showRegister: 'மாதத்தைக் காட்டு', selfInvoice: 'சுய விலைப்பட்டியல்', noSelfInvoice: 'சுய விலைப்பட்டியல் இல்லை', liability: '3.1(d) பணமாகச் செலுத்த வேண்டியது', itcPaid: '4(A)(3) வரவு (செலுத்தியது)', unpaid: 'செலுத்தாத சுய விலைப்பட்டியல்(கள்)', exceptions: 'ஒருவர் பார்க்க வேண்டியவை',
    challanRef: 'சலான் குறிப்பு (CPIN / CIN)', paidOn: 'செலுத்திய தேதி', markPaid: 'வரி செலுத்தியதாகக் குறி', paidSaved: 'செலுத்தப்பட்டது — வரவு இந்த மாதத்திலிருந்து', noPurchases: 'இந்த மாதம் தலைகீழ் வரிக் கொள்முதல் இல்லை.',
    tdsOn: 'TDS இயக்கத்தில் உள்ளது: CA-வின் பட்டியலில் உள்ள பெறுநர்களுக்கான கொடுப்பனவுகள் TDS கழித்துச் செய்யப்படும்.', tdsOffFilled: 'TDS நிறுத்தப்பட்டுள்ளது. CA-வின் பட்டியல் நிரப்பப்பட்டுள்ளது; உரிமையாளர் இயக்கியதும் அது நடைமுறைக்கு வரும் (OB-143).', tdsOffEmpty: 'TDS நிறுத்தப்பட்டுள்ளது. பெறுநர், பிரிவு மற்றும் விகிதப் பட்டியலை CA இன்னும் நிரப்பவில்லை; நிரப்பியதும் உரிமையாளர் இயக்குவார் (OB-143).',
    tdsH: 'விநியோகஸ்தர் கொடுப்பனவுகளில் வருமான வரி TDS', tdsLead: 'நிறுத்தப்பட்ட நிலையில் கட்டப்பட்டது (OB-143): CA பிரிவுகள், வீதங்கள், வரம்புகள், பெறுநர்களை நிரப்புகிறார்; உரிமையாளர் இயக்குகிறார். இங்கு எதுவும் இயல்புநிலை அல்ல — அமைக்கப்படாத வீதம் சொல்லப்படும், ஊகிக்கப்படாது.',
    sectionsH: 'பிரிவுகள்', payeesH: 'பெறுநர்கள்', noSections: 'அமைக்கப்படவில்லை — CA இன்னும் எந்தப் பிரிவையும் நிரப்பவில்லை', noPayees: 'பட்டியலில் இன்னும் பெறுநர் இல்லை.',
    section: 'பிரிவு (எ.கா. 194C)', label: 'எதற்கானது', singleRs: 'ஒரு கொடுப்பனவு வரம்பு (₹, காலி = இல்லை)', aggregateRs: 'ஆண்டு வரம்பு (₹, காலி = இல்லை)', onCrossing: 'வரம்பைத் தாண்டினால் பிடித்தம்',
    thisPayment: 'இந்தக் கொடுப்பனவில் மட்டும்', wholeAggregate: 'ஆண்டு முழுவதற்கும் இதுவரை', addSection: 'பிரிவைப் பட்டியலில் சேர்', removeSection: 'நீக்கு',
    payeeSupplier: 'விநியோகஸ்தர்', applicable: 'TDS பொருந்தும்', yes: 'ஆம்', no: 'இல்லை', payeeSection: 'பிரிவு', pan: 'PAN', addPayee: 'பெறுநரைப் பட்டியலில் சேர்', removePayee: 'நீக்கு', saveList: 'பட்டியலைச் சேமி', listSaved: 'CA-வின் பட்டியல் சேமிக்கப்பட்டது — பதிப்பு',
    switchOn: 'TDS-ஐ இயக்கு', switchOff: 'TDS-ஐ நிறுத்து', switchReason: 'காரணம் (தேவை)', switched: 'TDS இப்போது',
    openLiability: 'பிடிக்கப்பட்டு இன்னும் செலுத்தப்படாத TDS', liabilitiesH: 'பிடித்தங்கள்', deposited: 'செலுத்தப்பட்டது', liabilityWord: 'செலுத்தப்படவில்லை',
    challanH: 'TDS சலானைப் பதிவு செய்', challanRefT: 'சலான் (BSR குறியீடு, தேதி, வரிசை எண்)', depositedOn: 'செலுத்திய தேதி', paymentIds: 'அது உள்ளடக்கும் கொடுப்பனவுகள் (அடையாளங்கள், காற்புள்ளியால் பிரித்து)', amountRs: 'தொகை (₹)', recordChallan: 'சலானைப் பதிவு செய்', challanSaved: 'சலான் பதிவானது',
    q26H: 'காலாண்டின் 26Q', quarter: 'காலாண்டு', show26q: '26Q-ஐக் காட்டு', total: 'மொத்த TDS', depositedTotal: 'செலுத்தப்பட்டது', undeposited: 'சலான் இல்லாத பிடித்தம்(கள்) — 26Q-ஐ இன்னும் சரியாகத் தாக்கல் செய்ய முடியாது', withoutPan: 'பட்டியலில் PAN இல்லாத பெறுநர்(கள்)', noRows: 'இந்தக் காலாண்டில் பிடித்தம் இல்லை.',
    itcClaimH: 'GSTR-3B அட்டவணை 4 கோருவது', claimReconciled: 'சரிபார்க்கப்பட்டது — கோரிக்கை', claimNot: 'சரிபார்க்கப்படவில்லை',
    reversalH: 'உள்ளீட்டு வரி வரவைத் திருப்பு', reversalLead: 'விதி 37, 42 அல்லது 43 திருப்பம், அல்லது இலவச மாதிரியின் வரவு — மாதத்திற்கான தனிப் பதிவு; ஏற்கப்பட்ட வரியின் திருத்தம் அல்ல.',
    rule: 'விதி', rule_37: 'விதி 37 — 180 நாளில் விநியோகஸ்தருக்குச் செலுத்தவில்லை', rule_42: 'விதி 42 — விலக்கு / வணிகமல்லாத பயன் (உள்ளீடுகள்)', rule_43: 'விதி 43 — மூலதனப் பொருட்கள்', free_samples: 'இலவசமாகக் கொடுத்த மாதிரிகள்',
    sourceRef: 'எதற்காக (விலைப்பட்டியல், வரி அல்லது இலவச மாதிரிப் பதிவு)', igst: 'IGST (₹)', cgst: 'CGST (₹)', sgst: 'SGST (₹)', cess: 'செஸ் (₹)', recordReversal: 'திருப்பத்தைப் பதிவு செய்', reversalSaved: 'திருப்பம் பதிவானது', reversalsH: 'இந்த மாதத் திருப்பங்கள்', noReversals: 'இந்த மாதம் திருப்பம் இல்லை.',
    saved: 'சேமிக்கப்பட்டது.', reading: 'தலைமை அலுவலகத்திடம் கேட்கிறது…',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', notAllowed: 'உங்கள் பங்கு இதைச் செய்ய முடியாது — தலைமை அலுவலகம் மறுக்கும்.',
    badPeriod: 'மாதத்தை MMYYYY ஆக எழுதுங்கள், எ.கா. 052026.', badFy: 'ஆண்டை YYYY-YY ஆக எழுதுங்கள், எ.கா. 2026-27.', badGstin: 'கடையின் 15 எழுத்து GSTIN-ஐ எழுதுங்கள்.',
    badTurnover: 'ஆண்டு விற்றுமுதலை ரூபாயில் எழுதுங்கள்.', badDays: '1 முதல் 1095 வரை முழு எண்ணிக்கையில் நாட்களை எழுதுங்கள்.', needReason: 'முதலில் காரணத்தை எழுதுங்கள்.',
    badHeadCode: 'தலைப்புக் குறியீடு பெரிய எழுத்துகளும் இலக்கங்களும்.', badRate: 'வீதத்தைச் சதவீதமாக எழுதுங்கள், எ.கா. 5 அல்லது 18.', needName: 'பெயரை எழுதுங்கள்.', needCitation: 'அறிவிப்பை எழுதுங்கள்.',
    needSupplier: 'விநியோகஸ்தர் பட்டியலில் உள்ளபடி விநியோகஸ்தரை எழுதுங்கள்.', badDate: 'தேதியைத் தேர்ந்தெடுங்கள்.', badAmount: 'பூஜ்யத்திற்கு மேற்பட்ட தொகையை ரூபாயில் எழுதுங்கள்.', needDescription: 'என்ன வாங்கப்பட்டது என்று எழுதுங்கள்.',
    badPlace: 'விநியோக இடத்தைத் தேர்ந்தெடுங்கள்.', needChallan: 'சலான் குறிப்பை எழுதுங்கள்.', needPayments: 'சலான் உள்ளடக்கும் கொடுப்பனவுகளைக் குறிப்பிடுங்கள்.',
    badSection: 'பிரிவை எழுதுங்கள், எ.கா. 194C.', badThreshold: 'வரம்பு ரூபாயில் ஒரு தொகை, அல்லது இல்லையெனில் காலி.', needLabel: 'பிரிவு எதற்கானது என்று எழுதுங்கள்.', badPan: 'PAN 10 எழுத்துகள், எ.கா. ABCDE1234F.',
    badRule: 'விதியைத் தேர்ந்தெடுங்கள்.', needSource: 'திருப்பம் எதற்காக என்று எழுதுங்கள்.', badCode: 'வேறுபாட்டைத் தேர்ந்தெடுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் சேமிக்கப்படவில்லை. மீண்டும் அழுத்தவும்: இது அதே கோரிக்கை, தலைமை அலுவலகம் ஒரே ஒருமுறை செய்யும்.',
  },
} as const;

export type DeskWord = keyof typeof GST_DESK_COPY.en;
export const gstDeskWords = (lang: Lang, key: string): string =>
  (GST_DESK_COPY[lang] as Record<string, string>)[key] ?? (GST_DESK_COPY.en as Record<string, string>)[key] ?? key;
/** An outcome that is not ok, in words (head office's own sentence when it refused). */
export function gstDeskOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  if (out.result === 'ok') return gstDeskWords(lang, 'saved');
  if (out.result === 'refused') return `${gstDeskWords(lang, 'refused')} ${out.whatHappened} ${out.nextSafeAction}`.trim();
  if (out.result === 'invalid') return gstDeskWords(lang, out.why);
  return gstDeskWords(lang, 'unreachable');
}

// ── the pure conversions (tested) ─────────────────────────────────────────────────────────────────────────

const FP = /^(0[1-9]|1[0-2])(\d{4})$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** A filing month MMYYYY → its first and last day (a calendar month — no clock involved). */
export function monthDates(fp: string): { readonly from: string; readonly to: string; readonly ym: string } | undefined {
  const m = FP.exec(fp.trim());
  if (m === null) return undefined;
  const month = Number(m[1]); const year = Number(m[2]);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}`, ym: `${year}-${mm}` };
}

/** The financial year a filing month belongs to (April to March), as YYYY-YY. */
export function fyOfMonth(fp: string): string | undefined {
  const m = FP.exec(fp.trim());
  if (m === null) return undefined;
  const month = Number(m[1]); const year = Number(m[2]);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const isFy = (fy: string): boolean => {
  const m = /^(\d{4})-(\d{2})$/.exec(fy.trim());
  return m !== null && (Number(m[1]) + 1) % 100 === Number(m[2]);
};

/** Typed rupees ("1,23,456.50", "₹ 80") → whole paise; `undefined` for anything that is not a plain amount. */
export function paiseOf(text: string): number | undefined {
  const t = text.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const [whole, frac = ''] = t.split('.');
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : undefined;
}

/** A typed percentage ("18", "2.5") → basis points; `undefined` for anything else. */
export function bpsOf(text: string): number | undefined {
  const t = text.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return undefined;
  const [whole, frac = ''] = t.split('.');
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return bps <= 10_000 ? bps : undefined;
}

/** ₹ from paise, Indian grouping — for reading, never for sums. */
export const rupeesOf = (minor: number): string => `${minor < 0 ? '−' : ''}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The name the GSTN file is saved under: the return, the GSTIN and the filing month — never a guess. */
export const gstnFileName = (gstin: string, fp: string): string => `GSTR1_${gstin}_${fp}.json`;

// ── the session ──────────────────────────────────────────────────────────────────────────────────────────

export interface TdsSectionInput { readonly section: string; readonly label: string; readonly rate: string; readonly single: string; readonly aggregate: string; readonly onCrossing: string }
export interface TdsPayeeInput { readonly supplierId: string; readonly tdsApplicable: boolean; readonly section: string; readonly pan: string }

export interface GstDeskSession {
  readonly may: Readonly<Record<'named' | 'readGst' | 'setTimeBar' | 'giveReason' | 'readRcm' | 'configureRcm' | 'recordRcm' | 'payRcm'
    | 'readTds' | 'configureTds' | 'switchTds' | 'recordChallan' | 'readItc' | 'actItc', boolean>>;
  gstr1Return(fp: string): Promise<Outcome<Record<string, unknown>>>;
  table12(fp: string): Promise<Outcome<Record<string, unknown>>>;
  table12FromSales(fp: string, turnoverRupees: string): Promise<Outcome<Record<string, unknown>>>;
  gstnFile(fp: string, gstin: string): Promise<Outcome<{ readonly fileName: string; readonly text: string }>>;
  setTimeBarDays(days: string, reason: string): Promise<Outcome<Record<string, unknown>>>;
  gstr9c(fy: string): Promise<Outcome<Record<string, unknown>>>;
  give9cReason(fy: string, period: string, code: string, reason: string): Promise<Outcome<Record<string, unknown>>>;
  rcmHeads(): Promise<Outcome<Record<string, unknown>>>;
  setRcmHead(input: { readonly headCode: string; readonly name: string; readonly rate: string; readonly notifiedUnder: string }): Promise<Outcome<Record<string, unknown>>>;
  retireRcmHead(headCode: string, reason: string): Promise<Outcome<Record<string, unknown>>>;
  rcmRegister(fp: string): Promise<Outcome<Record<string, unknown>>>;
  recordRcmPurchase(input: { readonly supplierId: string; readonly headCode: string; readonly supplyDate: string; readonly taxable: string; readonly placeOfSupply: string; readonly description: string }): Promise<Outcome<Record<string, unknown>>>;
  markRcmPaid(purchaseId: string, challanRef: string, paidOn: string): Promise<Outcome<Record<string, unknown>>>;
  tds(): Promise<Outcome<Record<string, unknown>>>;
  setTdsList(sections: readonly TdsSectionInput[], payees: readonly TdsPayeeInput[]): Promise<Outcome<Record<string, unknown>>>;
  switchTds(enabled: boolean, reason: string): Promise<Outcome<Record<string, unknown>>>;
  recordTdsChallan(input: { readonly challanRef: string; readonly depositedOn: string; readonly paymentIds: string; readonly amount: string }): Promise<Outcome<Record<string, unknown>>>;
  form26q(fy: string, quarter: string): Promise<Outcome<Record<string, unknown>>>;
  itcClaim(ym: string): Promise<Outcome<Record<string, unknown>>>;
  itcReversal(ym: string, input: { readonly rule: string; readonly sourceRef: string; readonly reason: string; readonly igst: string; readonly cgst: string; readonly sgst: string; readonly cess: string }): Promise<Outcome<Record<string, unknown>>>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REVERSAL_RULES = ['rule_37', 'rule_42', 'rule_43', 'free_samples'];
const CODES_9C = ['month_not_filed', 'outward_documents_not_in_books', 'changed_after_gstr1_filed_not_amended', 'books_differ_from_till'];
const rand = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export function createGstDeskSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly newKey?: () => string;
}): GstDeskSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const has = (p: string): boolean => named && held.has(p);
  const may = {
    named, readGst: has('finance.gstr.read'), setTimeBar: has('finance.gst.timebar.set'), giveReason: has('finance.gstr.generate'),
    readRcm: has('finance.rcm.read'), configureRcm: has('finance.rcm.configure'), recordRcm: has('finance.rcm.record'), payRcm: has('finance.rcm.pay'),
    readTds: has('finance.tds.read'), configureTds: has('finance.tds.configure'), switchTds: has('finance.tds.switch'), recordChallan: has('finance.tds.challan.record'),
    readItc: has('finance.itc.read'), actItc: has('finance.itc.action'),
  };
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  const newKey = input.newKey ?? (() => `gst-desk-${rand()}`);
  /** A write whose answer was lost keeps its key, so pressing again is the same act. */
  const lostKeys = new Map<string, string>();
  /** The ids minted for a typed record, kept while its answer is lost (pressing again names the same record). */
  const rcmIds = new Map<string, string>();
  const reversalIds = new Map<string, string>();
  const no =(why: DeskWhy): { result: 'invalid'; why: DeskWhy } => ({ result: 'invalid', why });
  const gate = (allowed: boolean): { result: 'invalid'; why: DeskWhy } | undefined => (!named ? no('nobody') : !allowed ? no('notAllowed') : undefined);

  const call = async <T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, slotId?: string): Promise<Outcome<T>> => {
    const write = method !== 'GET';
    const slot = write ? `${method} ${path} ${slotId ?? JSON.stringify(body ?? {})}` : '';
    const key = write ? (lostKeys.get(slot) ?? newKey()) : '';
    try {
      const res = await http(path, {
        method, credentials: 'same-origin',
        headers: { accept: 'application/json', ...(write ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
        ...(write ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const err = json['error'] as { code?: string; whatHappened?: string; nextSafeAction?: string } | undefined;
      if (!res.ok && err === undefined && res.status >= 502 && res.status <= 504) { if (write) lostKeys.set(slot, key); return { result: 'lost_link' }; }
      if (write) lostKeys.delete(slot);
      if (!res.ok) return { result: 'refused', status: res.status, code: err?.code ?? String(res.status), whatHappened: err?.whatHappened ?? `status ${res.status}`, nextSafeAction: err?.nextSafeAction ?? '' };
      return { result: 'ok', value: json as T };
    } catch {
      if (write) lostKeys.set(slot, key);
      return { result: 'lost_link' };
    }
  };
  const q = (o: Record<string, string>): string => new URLSearchParams(o).toString();

  return {
    may,
    gstr1Return: async (fp) => {
      const g = gate(may.readGst); if (g) return g;
      const d = monthDates(fp); if (d === undefined) return no('badPeriod');
      return call('GET', `/v1/finance/gstr1/return?${q({ from: d.from, to: d.to })}`);
    },
    table12: async (fp) => {
      const g = gate(may.readGst); if (g) return g;
      const d = monthDates(fp); if (d === undefined) return no('badPeriod');
      return call('GET', `/v1/finance/gstr1/table-12?${q({ from: d.from, to: d.to })}`);
    },
    table12FromSales: async (fp, turnover) => {
      const g = gate(may.readGst); if (g) return g;
      const d = monthDates(fp); if (d === undefined) return no('badPeriod');
      const t = paiseOf(turnover); if (t === undefined) return no('badTurnover');
      return call('POST', '/v1/finance/gstr1/from-sales/table-12', { from: d.from, to: d.to, annualTurnoverMinor: t });
    },
    gstnFile: async (fp, gstinText) => {
      const g = gate(may.readGst); if (g) return g;
      const d = monthDates(fp); if (d === undefined) return no('badPeriod');
      const gstin = gstinText.trim().toUpperCase(); if (!GSTIN.test(gstin)) return no('badGstin');
      const out = await call<Record<string, unknown>>('GET', `/v1/finance/gstr1/export?${q({ from: d.from, to: d.to, gstin, fp: fp.trim() })}`);
      if (out.result !== 'ok') return out;
      // The file is head office's answer exactly as it gave it — never reshaped here.
      return { result: 'ok', value: { fileName: gstnFileName(gstin, fp.trim()), text: JSON.stringify(out.value, null, 2) } };
    },
    setTimeBarDays: async (daysText, reason) => {
      const g = gate(may.setTimeBar); if (g) return g;
      const t = daysText.trim();
      const days = /^\d{1,4}$/.test(t) ? Number(t) : NaN;
      if (!Number.isInteger(days) || days < 1 || days > 1095) return no('badDays');
      if (reason.trim() === '') return no('needReason');
      return call('PUT', '/v1/finance/gst/controls/time-bar-warning-days', { days, reason: reason.trim() });
    },
    gstr9c: async (fy) => {
      const g = gate(may.readGst); if (g) return g;
      if (!isFy(fy)) return no('badFy');
      return call('GET', `/v1/finance/gstr9c/${encodeURIComponent(fy.trim())}`);
    },
    give9cReason: async (fy, period, code, reason) => {
      const g = gate(may.giveReason); if (g) return g;
      if (!isFy(fy)) return no('badFy');
      if (!FP.test(period)) return no('badPeriod');
      if (!CODES_9C.includes(code)) return no('badCode');
      if (reason.trim() === '') return no('needReason');
      return call('POST', `/v1/finance/gstr9c/${encodeURIComponent(fy.trim())}/reasons`, { period, code, reason: reason.trim() });
    },
    rcmHeads: async () => {
      const g = gate(may.readRcm); if (g) return g;
      return call('GET', '/v1/finance/rcm/heads');
    },
    setRcmHead: async (h) => {
      const g = gate(may.configureRcm); if (g) return g;
      const code = h.headCode.trim().toUpperCase();
      if (!/^[A-Z0-9]{1,16}$/.test(code)) return no('badHeadCode');
      if (h.name.trim() === '') return no('needName');
      const rateBps = bpsOf(h.rate); if (rateBps === undefined) return no('badRate');
      if (h.notifiedUnder.trim() === '') return no('needCitation');
      return call('POST', `/v1/finance/rcm/heads/${encodeURIComponent(code)}`, { name: h.name.trim(), rateBps, notifiedUnder: h.notifiedUnder.trim() });
    },
    retireRcmHead: async (headCode, reason) => {
      const g = gate(may.configureRcm); if (g) return g;
      if (reason.trim() === '') return no('needReason');
      return call('POST', `/v1/finance/rcm/heads/${encodeURIComponent(headCode)}/retire`, { reason: reason.trim() });
    },
    rcmRegister: async (fp) => {
      const g = gate(may.readRcm); if (g) return g;
      if (!FP.test(fp.trim())) return no('badPeriod');
      return call('GET', `/v1/finance/rcm/register?${q({ period: fp.trim() })}`);
    },
    recordRcmPurchase: async (p) => {
      const g = gate(may.recordRcm); if (g) return g;
      if (p.supplierId.trim() === '') return no('needSupplier');
      if (!DATE.test(p.supplyDate)) return no('badDate');
      const taxableMinor = paiseOf(p.taxable); if (taxableMinor === undefined || taxableMinor <= 0) return no('badAmount');
      if (p.placeOfSupply !== 'intra_state' && p.placeOfSupply !== 'inter_state') return no('badPlace');
      if (p.description.trim() === '') return no('needDescription');
      const body = {
        supplierId: p.supplierId.trim(), supplyDate: p.supplyDate, taxableMinor, placeOfSupply: p.placeOfSupply, description: p.description.trim(),
        ...(p.headCode.trim() === '' ? {} : { headCode: p.headCode.trim().toUpperCase() }),
      };
      // The purchase's id is minted once per typed purchase and kept while the answer is lost (the same act again).
      const slot = JSON.stringify(body);
      const id = rcmIds.get(slot) ?? `RCM-${rand().replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
      rcmIds.set(slot, id);
      const out = await call<Record<string, unknown>>('POST', `/v1/finance/rcm/purchases/${encodeURIComponent(id)}`, body);
      if (out.result !== 'lost_link') rcmIds.delete(slot);
      return out;
    },
    markRcmPaid: async (purchaseId, challanRef, paidOn) => {
      const g = gate(may.payRcm); if (g) return g;
      if (challanRef.trim() === '') return no('needChallan');
      if (!DATE.test(paidOn)) return no('badDate');
      return call('POST', `/v1/finance/rcm/purchases/${encodeURIComponent(purchaseId)}/paid`, { challanRef: challanRef.trim(), paidOn });
    },
    tds: async () => {
      const g = gate(may.readTds); if (g) return g;
      return call('GET', '/v1/finance/tds');
    },
    setTdsList: async (sections, payees) => {
      const g = gate(may.configureTds); if (g) return g;
      const outSections: Record<string, unknown>[] = [];
      for (const s of sections) {
        if (!/^[0-9A-Za-z]{3,8}$/.test(s.section.trim())) return no('badSection');
        if (s.label.trim() === '') return no('needLabel');
        const rateBps = bpsOf(s.rate); if (rateBps === undefined) return no('badRate');
        const single = s.single.trim() === '' ? null : paiseOf(s.single);
        const aggregate = s.aggregate.trim() === '' ? null : paiseOf(s.aggregate);
        if (single === undefined || aggregate === undefined) return no('badThreshold');
        if (s.onCrossing !== 'this_payment' && s.onCrossing !== 'whole_aggregate') return no('badThreshold');
        outSections.push({ section: s.section.trim().toUpperCase(), label: s.label.trim(), rateBps, singleThresholdMinor: single, aggregateThresholdMinor: aggregate, onCrossing: s.onCrossing });
      }
      const outPayees: Record<string, unknown>[] = [];
      for (const p of payees) {
        if (p.supplierId.trim() === '') return no('needSupplier');
        const pan = p.pan.trim().toUpperCase();
        if (pan !== '' && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return no('badPan');
        outPayees.push({ supplierId: p.supplierId.trim(), tdsApplicable: p.tdsApplicable, section: p.section.trim() === '' ? null : p.section.trim().toUpperCase(), pan: pan === '' ? null : pan });
      }
      return call('POST', '/v1/finance/tds/config', { sections: outSections, payees: outPayees });
    },
    switchTds: async (enabled, reason) => {
      const g = gate(may.switchTds); if (g) return g;
      if (reason.trim() === '') return no('needReason');
      return call('POST', '/v1/finance/tds/switch', { enabled, reason: reason.trim() });
    },
    recordTdsChallan: async (c) => {
      const g = gate(may.recordChallan); if (g) return g;
      if (c.challanRef.trim() === '') return no('needChallan');
      if (!DATE.test(c.depositedOn)) return no('badDate');
      const paymentIds = c.paymentIds.split(',').map((x) => x.trim()).filter((x) => x !== '');
      if (paymentIds.length === 0) return no('needPayments');
      const amountMinor = paiseOf(c.amount); if (amountMinor === undefined || amountMinor <= 0) return no('badAmount');
      // The challan's own id is its bank reference — the same challan recorded twice is the same record.
      const challanId = c.challanRef.trim().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
      return call('POST', `/v1/finance/tds/challans/${encodeURIComponent(challanId)}`, { challanRef: c.challanRef.trim(), depositedOn: c.depositedOn, paymentIds, amountMinor });
    },
    form26q: async (fy, quarter) => {
      const g = gate(may.readTds); if (g) return g;
      if (!isFy(fy)) return no('badFy');
      if (!/^Q[1-4]$/.test(quarter)) return no('badFy');
      return call('GET', `/v1/finance/tds/26q/${encodeURIComponent(fy.trim())}/${quarter}`);
    },
    itcClaim: async (ym) => {
      const g = gate(may.readItc); if (g) return g;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return no('badPeriod');
      return call('GET', `/v1/finance/itc/${encodeURIComponent(ym)}/claim`);
    },
    itcReversal: async (ym, r) => {
      const g = gate(may.actItc); if (g) return g;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return no('badPeriod');
      if (!REVERSAL_RULES.includes(r.rule)) return no('badRule');
      if (r.sourceRef.trim() === '') return no('needSource');
      if (r.reason.trim() === '') return no('needReason');
      const amounts: Record<string, number> = {};
      for (const [k, v] of [['igstMinor', r.igst], ['cgstMinor', r.cgst], ['sgstMinor', r.sgst], ['cessMinor', r.cess]] as const) {
        const p = v.trim() === '' ? 0 : paiseOf(v);
        if (p === undefined) return no('badAmount');
        amounts[k] = p;
      }
      if (Object.values(amounts).every((x) => x === 0)) return no('badAmount');
      const body = { rule: r.rule, sourceRef: r.sourceRef.trim(), reason: r.reason.trim(), ...amounts };
      const slot = `${ym} ${JSON.stringify(body)}`;
      const id = reversalIds.get(slot) ?? `REV-${rand().replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
      reversalIds.set(slot, id);
      const out = await call<Record<string, unknown>>('POST', `/v1/finance/itc/${encodeURIComponent(ym)}/reversals/${encodeURIComponent(id)}`, body);
      if (out.result !== 'lost_link') reversalIds.delete(slot);
      return out;
    },
  };
}
