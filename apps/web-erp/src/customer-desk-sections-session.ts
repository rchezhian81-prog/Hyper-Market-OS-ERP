// W5 (customers, privacy, service desk and online orders) — the sections this wave adds to twelve existing office pages,
// over head-office routes that were built and tested but that no screen called (route audit, bundle 8). A tested, DOM-free
// session; the shared page script `apps/web-erp/web/customer-desk-sections.js` lays out what it is told.
//
//   Customers ............ who looked at a customer's record (M16-FR-04 · P-04)        GET  /v1/customers/:ref/profile/views
//   Data requests ........ the nominee a customer named, and staff verifying it (C5 · DPDP s.14)
//                                                                                       GET  /v1/privacy/nominees/:ref
//                                                                                       POST /v1/privacy/nominees/:ref/activation
//                          the sealed record of an erasure (M20-FR-04 · hard rule #6)  GET  /v1/privacy/data-requests/:id/tombstone
//                          the processor-contract register (M01-FR-02)                 GET/POST /v1/privacy/processor-contracts
//   Incidents ............ a personal-data breach: what must be told, to whom, by when (C2 · DPDP s.8(6))
//                                                                                       POST /v1/privacy/breach/assess
//   Loyalty .............. a member leaves the programme at the desk (M16-FR-02)       POST /v1/loyalty/members/:ref/leave
//                          W6: a referral reward owed, paid out or let lapse by a person (M17-FR-02 · OB-221 · OB-356)
//                                                                                       GET  /v1/loyalty/referral-programme · GET /v1/finance/referral-liability
//                                                                                       POST /v1/loyalty/referrals/:id/payout · …/expire
//   Message queue ........ withdraw an approved message template (PA-08 r6)           POST /v1/notifications/templates/:id/withdrawal
//   Campaigns ............ the campaign decision log (M21-FR-01 · P-08)               GET  /v1/service/campaigns/plans
//   Trial switches ....... consent-manager records that could not be applied (OB-324) GET  /v1/privacy/consent-manager/exceptions
//   Customer cases ....... first reply, compensation (and carrying it out again), the customer's rating (M21-FR-04 · PF-11)
//   Store credit ......... one family's pooled balance (M17-FR-04)                    GET  /v1/stored-value/households/:ref/balance
//   Dispatch ............. the proof of delivery and its images (D09-FR-05 · WF-15); the goods that came back from a partial
//                          delivery, counted (M19-FR-02)                               GET  /v1/delivery/orders/:id/proof · …/proof-images/:id
//                                                                                       POST /v1/fulfilment/orders/:id/handback
//   Delivery exceptions .. move an exception to another queue, with the reason (M19-FR-01)
//   Online orders ........ the customer's substitution answer, told to staff (FUL-14); order notices (M20-FR-03); the refused-
//                          access register (P-04); W6 · OB-687: the swaps the picker put to a customer, and the customer's yes or
//                          no told to staff by phone (counts the same as the app's); how long the picker waits — the OWNER's number
//                                                                                       GET  /v1/orders/:id/substitution-proposals
//                                                                                       POST /v1/orders/:id/substitution-proposals/:line/answer
//                                                                                       GET/POST /v1/fulfilment/substitution-wait
//
// Every rule is head office's: this session refuses only the cheap things before a request (nobody signed in, the role, an
// empty box) and never writes on open. A number the owner has not entered is never invented here. Head office's own
// sentences stay in English (OB-553); every word this file adds has a Tamil twin.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const DESK_COPY = {
  en: {
    nobody: 'Nobody is signed in on this screen.', reading: 'Reading from head office…', done: 'Done.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.',
    cannot: 'Your role cannot do this.', needCustomer: 'Type the customer code.', needOrder: 'Type the order number.',
    needCase: 'Type the case number.', orderNo: 'Order number', needReason: 'Say why, in a few words.', needText: 'Fill in every box marked as needed.',
    needNumber: 'Type a whole number.', needRupees: 'Type the amount in rupees, e.g. 150 or 150.50.', needWhen: 'Type the date and time.',
    needScore: 'Choose a score from 1 to 5.', none: 'Nothing on record.', show: 'Show', when: 'when', by: 'by',
    // Customers — who looked
    viewsH: 'Who looked at a customer\'s record', viewsLead: 'Every time someone opens a customer\'s record it is written down. Type the customer code to see who looked and when.',
    customer: 'Customer code', viewsShow: 'Show who looked', views: 'look(s)', noViews: 'Nobody has opened this record.',
    // Data requests — nominee
    nomineeH: 'The customer\'s nominee', nomineeLead: 'A customer may name someone who can use their privacy rights if they die or can no longer act. Staff record that the death or incapacity was checked against a certificate; only then may the nominee act.',
    nomineeShow: 'Show the nomination', noNominee: 'This customer has named nobody.', nomineeIs: 'Nominee', relationship: 'relationship',
    history: 'Every change on file', recorded: 'named', changed: 'changed', withdrawn: 'withdrawn', verifications: 'Checked by staff',
    basis: 'What was checked', basis_death: 'death', basis_incapacity: 'cannot act any more', evidence: 'Certificate number (the number only)',
    activate: 'Record that it was checked', activated: 'Recorded. The nominee may now act for the customer.',
    // Data requests — tombstone
    sealedH: 'Sealed records of erasures', sealedLead: 'When a customer\'s data is erased, a sealed record is kept that it happened — who approved it, who carried it out, what was erased and what the law kept. It holds no personal data.',
    sealedShow: 'Show finished erasures', sealedOne: 'Show the sealed record', noErasures: 'No erasure has been finished.',
    erasedAt: 'Erased', maker: 'carried out by', checker: 'approved by', erased: 'Erased', minimised: 'Name and contact removed', kept: 'Kept by law',
    complete: 'Everything the erasure was to erase or minimise was done.', partial: 'NOT everything the erasure was to erase or minimise was done — look at what is listed above.',
    // Data requests — processors
    procH: 'Companies that handle customer data for the shop', procLead: 'Every outside company that handles customers\' personal data (SMS, payments, delivery, the cloud) must be on this list with the contract it works under. Head office checks the list against what the system really does.',
    procShow: 'Read the list and the check', procOk: 'Every company seen handling personal data is on the list with a contract in force.',
    procFindings: 'Problems found', procEntries: 'On the list', vendorId: 'Company code', vendorName: 'Company name', categories: 'Personal data it handles (comma between)',
    purpose: 'What for', contractRef: 'Contract number', contractFrom: 'Contract from', contractUntil: 'Contract until (optional)', procRecord: 'Add to the list',
    procRecorded: 'Added to the list.', openEnded: 'no end date',
    // Incidents — breach
    breachH: 'Customer data leak: what must be told, to whom, by when', breachLead: 'If customers\' personal data was lost, stolen or seen by someone it should not be, the law says the Data Protection Board must be told at once and given a full report within 72 hours, and every person affected must be told. Fill in what you know; head office works out what is due and what is still missing. It sends nothing — a person sends each notice.',
    breachRef: 'Reference for this leak', discovered: 'When the shop found out (shop time)', affectedCats: 'What data was involved (comma between)', affectedCount: 'How many people',
    description: 'What happened', consequences: 'What could happen to them', mitigation: 'What was done to limit it', remedial: 'What will stop it happening again',
    safety: 'What people should do to protect themselves', contact: 'Who people can contact', boardTold: 'Board told at (optional)', reportFiled: 'Full report filed at (optional)', peopleTold: 'People told at (optional)',
    breachCheck: 'Work out what is due', deadline: 'Full report due by', allDone: 'Everything due has been done and nothing is missing.',
    ob_board_immediate_intimation: 'Tell the Data Protection Board at once', ob_board_72h_report: 'Full report to the Board', ob_affected_principal_notices: 'Tell every person affected',
    st_done: 'done', st_due: 'due', st_overdue: 'LATE', immediately: 'at once', missing: 'still missing', adviceOnly: 'This only works out what is due. A person sends every notice.',
    // Loyalty — leave
    leaveH: 'A member leaves the programme', leaveLead: 'When a member asks to stop, record it here. From then on their code earns nothing. Their points history is kept.',
    member: 'Member code', reason: 'Reason', leave: 'Record that they left', left: 'Recorded. The member has left; the code earns nothing from now on.', alreadyLeft: 'This member had already left.',
    // Loyalty — referral rewards owed (W6)
    owedH: 'Referral rewards still to pay', owedLead: 'A referral reward is money the shop owes the customer from the day it is earned. When you pay one — in cash, as store credit or by bank transfer — record how and the receipt or transfer number. A reward the customer will not take may be let lapse, with the reason. Each is kept; nothing is changed afterwards.',
    owedShow: 'Show rewards still to pay', noOwed: 'No referral reward is waiting to be paid.', owes: 'owed', side_referrer: 'referred a friend', side_referred: 'was referred',
    how: 'Paid by', how_cash: 'cash', how_store_credit: 'store credit', how_bank_transfer: 'bank transfer', payRef: 'Receipt, credit or transfer number', payOut: 'Record the payment', paidOut: 'Recorded as paid.',
    lapseReason: 'Why it lapses', lapse: 'Let it lapse', lapsed: 'Recorded as lapsed.',
    // Message queue — withdraw a template
    withdrawH: 'Stop an approved message', withdrawLead: 'If the words of an approved message must not go out any more (a mistake, an offer taken back), stop it here. Nothing more is sent with it; messages still waiting with it are held back and kept, with your reason.',
    withdrawShow: 'Show the approved messages', noApproved: 'No approved message.', version: 'version', withdraw: 'Stop this message', withdrawnOk: 'Stopped. Nothing more goes out with it.',
    // Campaigns — log
    logH: 'Campaign decision log', logLead: 'Every campaign planned: who planned it, how many it would reach, and how many were left out and why. Newest first.',
    logShow: 'Show the log', noPlans: 'No campaign has been planned.', reach: 'would reach', leftOut: 'left out', blocked: 'BLOCKED',
    // Rollout — consent exceptions
    cxH: 'Consent records that could not be brought in', cxLead: 'When a consent manager\'s file is brought in, any record that could not be applied is kept here with the reason. Each one needs a person to look at it.',
    cxShow: 'Show them', noCx: 'Every record brought in was applied.',
    // Service desk — follow-up
    caseH: 'Follow up a case: first reply, compensation, the customer\'s rating', caseLead: 'Type the case number. Mark when the customer first got a reply from a person, give compensation (with the reason; above your own limit it needs a second person\'s approval from the Approvals page), and record how the customer rated it once it is resolved.',
    caseNo: 'Case number', caseOpen: 'Open the follow-up', firstReply: 'Mark the first reply as given now', firstDone: 'First reply recorded.',
    compH: 'Compensation on this case', noComp: 'No compensation given on this case.', total: 'total', compKind: 'Kind', kind_refund: 'refund', kind_goodwill_credit: 'goodwill credit',
    kind_loyalty_points: 'loyalty points', kind_replacement: 'replacement', amount: 'Amount (₹)', approvalId: 'Approval number (only above your limit)', grant: 'Give compensation',
    granted: 'Given.', retry: 'Carry it out again', f_completed: 'carried out', f_pending: 'waiting', f_failed: 'FAILED', notCarried: 'not carried out by this system',
    rateH: 'How the customer rated it', score: 'Score (1 = poor, 5 = very good)', comment: 'What they said (optional)', rate: 'Record the rating', rated: 'Rating recorded.',
    // Stored value — household
    houseH: 'A family\'s pooled balance', houseLead: 'A family\'s gift cards and store credit are one purse. Type the family\'s customer code to see what is left on all of them together.',
    houseShow: 'Show the pooled balance', houseBal: 'Left on all cards together', cards: 'card(s)',
    // Dispatch — proof
    proofH: 'Proof of delivery', proofLead: 'What the driver\'s phone recorded at the door for an order, how head office judged it, and the photos or signatures kept.',
    proofShow: 'Show the proof', codeIssued: 'A delivery code was given to the customer', noCode: 'No delivery code was given', door: 'At the door', noDoor: 'The driver\'s phone has recorded nothing at the door for this order.',
    images: 'Photos and signatures kept', noImages: 'No photo or signature kept.', showImage: 'Show it', photo: 'photo', signature: 'signature', notAnImage: 'This file is not a picture the page can show.',
    // Dispatch — hand-back
    backH: 'Goods back from a part delivery', backLead: 'When a customer kept only part of an order, count what came back for each packed line. Head office then finishes the order: the sale for what was kept, and any refund due for a person to give.',
    backShow: 'Read the pack', backQty: 'came back', packed: 'packed', backRecord: 'Record what came back', backDone: 'Recorded.', backAlready: 'Already counted — head office kept the first count.',
    notPacked: 'Head office holds no pack for this order.',
    // Delivery exceptions — reassign
    moveH: 'Move an exception to another queue', moveLead: 'A manager may move an exception to the queue that should deal with it. The reason is kept.',
    exception: 'Exception number', toQueue: 'Move to', q_fulfilment_supervisor: 'fulfilment supervisor', q_customer_service_desk: 'customer service desk',
    q_finance_recon_queue: 'finance (matching money)', q_duty_manager: 'duty manager', move: 'Move it', moved: 'Moved.',
    // Online orders — substitution answer, notices, refused access
    subH: 'What the customer said about substitutes (told to staff)', subLead: 'When a customer tells staff — by phone, in person or by message — what may be swapped on their order, record it here with how you reached them. A swap then rests on this, not on what the picker types.',
    pref: 'They said', pref_best_match: 'swap for the closest match', pref_contact_me: 'ask me first', pref_no_substitution: 'do not swap anything',
    method: 'How you reached them', m_phone: 'phone', m_whatsapp: 'WhatsApp', m_sms: 'SMS', m_in_person: 'in person', contactRef: 'Call or message reference', subRecord: 'Record what they said', subRecorded: 'Recorded.',
    noticesH: 'Messages about online orders', noticesLead: 'Every message due to a customer about their order, and whether it went on the message queue — or why not.',
    noticesShow: 'Show them', noNotices: 'No message about an order is due.', queued: 'on the queue', notQueued: 'NOT on the queue',
    refusalsH: 'Customers who asked for someone else\'s order', refusalsLead: 'Every time the app refused a customer who asked to see or order on another customer\'s order. A customer who tried more than one order is named first.',
    refusalsShow: 'Show the register', noRefusals: 'No customer has asked for another customer\'s order.', probing: 'Tried more than one order', orders: 'order(s)', a_read: 'tried to see', a_place: 'tried to order on',
    // W6 · OB-687 — swaps put to the customer, and the owner's wait
    swapsH: 'Swaps put to the customer', swapsLead: 'When the picker cannot find an item and the customer asked to be asked first, the picker offers a swap and the customer answers yes or no in the app. If the customer tells you by phone instead, record their answer here with how you reached them — it counts the same as the app.',
    swapsShow: 'Show the swaps', noSwaps: 'No swap has been put to the customer on this order.', swapLine: 'Which swap', swapAnswer: 'They said', d_confirmed: 'yes — send the swap', d_declined: 'no — leave it out', swapRecord: 'Record their answer', swapRecorded: 'Recorded. The picker will be told through the store computer.',
    for: 'for', each: 'each', answerBy: 'answer by', s_waiting: 'waiting for the customer', s_yes: 'the customer said YES', s_no: 'the customer said NO', s_refused: 'the shop\'s rules refuse it', s_too_late: 'no answer in time — packed short', s_closed: 'closed — the picker packed the line',
    via_app: 'in the app', via_staff: 'told to staff', onOrder: 'put on the order', notOnOrder: 'NOT put on the order',
    waitH: 'How long the picker waits for the customer', waitLead: 'The owner decides how many minutes the picker waits for a customer\'s yes or no to a swap. Until he sets it, the picker does not wait: the line goes short and the customer is not asked.',
    waitShow: 'Show the wait', waitNotSet: 'NOT SET by the owner — the picker does not wait; a line whose customer asked first goes short.', waitIs: 'The picker waits', minutes: 'minute(s)', setByOwner: 'set by',
    waitMinutes: 'Minutes to wait (1 to 240)', waitReason: 'Why (optional)', waitSave: 'Set the wait', waitSaved: 'Saved. The picker phones get it with their next wave.',
  },
  ta: {
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…', done: 'முடிந்தது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.',
    cannot: 'உங்கள் பங்கு இதைச் செய்ய முடியாது.', needCustomer: 'வாடிக்கையாளர் குறியீட்டைத் தட்டச்சு செய்யுங்கள்.', needOrder: 'ஆர்டர் எண்ணைத் தட்டச்சு செய்யுங்கள்.',
    needCase: 'வழக்கு எண்ணைத் தட்டச்சு செய்யுங்கள்.', orderNo: 'ஆர்டர் எண்', needReason: 'ஏன் என்று சில வார்த்தைகளில் சொல்லுங்கள்.', needText: 'தேவை எனக் குறித்த ஒவ்வொரு பெட்டியையும் நிரப்புங்கள்.',
    needNumber: 'ஒரு முழு எண்ணைத் தட்டச்சு செய்யுங்கள்.', needRupees: 'தொகையை ரூபாயில் தட்டச்சு செய்யுங்கள், எ.கா. 150 அல்லது 150.50.', needWhen: 'தேதியும் நேரமும் தட்டச்சு செய்யுங்கள்.',
    needScore: '1 முதல் 5 வரை ஒரு மதிப்பெண்ணைத் தேர்ந்தெடுங்கள்.', none: 'பதிவில் எதுவும் இல்லை.', show: 'காட்டு', when: 'எப்போது', by: 'செய்தவர்',
    viewsH: 'வாடிக்கையாளர் பதிவைப் பார்த்தவர்கள்', viewsLead: 'ஒருவர் வாடிக்கையாளர் பதிவைத் திறக்கும் ஒவ்வொரு முறையும் எழுதப்படுகிறது. யார், எப்போது பார்த்தார்கள் என்று அறிய வாடிக்கையாளர் குறியீட்டைத் தட்டச்சு செய்யுங்கள்.',
    customer: 'வாடிக்கையாளர் குறியீடு', viewsShow: 'பார்த்தவர்களைக் காட்டு', views: 'முறை பார்க்கப்பட்டது', noViews: 'இந்தப் பதிவை யாரும் திறக்கவில்லை.',
    nomineeH: 'வாடிக்கையாளரின் நியமனதாரர்', nomineeLead: 'வாடிக்கையாளர் இறந்தால் அல்லது செயல்பட முடியாவிட்டால், அவர்களின் தனியுரிமை உரிமைகளைப் பயன்படுத்த ஒருவரை நியமிக்கலாம். இறப்பு அல்லது இயலாமை சான்றிதழுடன் சரிபார்க்கப்பட்டதைப் பணியாளர் பதிவு செய்வார்; அதன் பிறகே நியமனதாரர் செயல்படலாம்.',
    nomineeShow: 'நியமனத்தைக் காட்டு', noNominee: 'இந்த வாடிக்கையாளர் யாரையும் நியமிக்கவில்லை.', nomineeIs: 'நியமனதாரர்', relationship: 'உறவு',
    history: 'கோப்பில் உள்ள ஒவ்வொரு மாற்றமும்', recorded: 'நியமிக்கப்பட்டது', changed: 'மாற்றப்பட்டது', withdrawn: 'திரும்பப் பெறப்பட்டது', verifications: 'பணியாளர் சரிபார்த்தவை',
    basis: 'சரிபார்த்தது', basis_death: 'இறப்பு', basis_incapacity: 'இனி செயல்பட முடியாது', evidence: 'சான்றிதழ் எண் (எண் மட்டும்)',
    activate: 'சரிபார்த்ததாகப் பதிவு செய்', activated: 'பதிவு செய்யப்பட்டது. இப்போது நியமனதாரர் வாடிக்கையாளருக்காகச் செயல்படலாம்.',
    sealedH: 'அழிப்புகளின் முத்திரையிட்ட பதிவுகள்', sealedLead: 'வாடிக்கையாளரின் தரவு அழிக்கப்படும்போது, அது நடந்தது என்ற முத்திரையிட்ட பதிவு வைக்கப்படும் — யார் ஒப்புதல் அளித்தார், யார் செய்தார், எது அழிக்கப்பட்டது, சட்டம் எதை வைத்தது. அதில் தனிப்பட்ட தரவு இல்லை.',
    sealedShow: 'முடிந்த அழிப்புகளைக் காட்டு', sealedOne: 'முத்திரையிட்ட பதிவைக் காட்டு', noErasures: 'எந்த அழிப்பும் முடியவில்லை.',
    erasedAt: 'அழிக்கப்பட்டது', maker: 'செய்தவர்', checker: 'ஒப்புதல்', erased: 'அழிக்கப்பட்டவை', minimised: 'பெயரும் தொடர்பும் நீக்கப்பட்டவை', kept: 'சட்டப்படி வைக்கப்பட்டவை',
    complete: 'அழிக்க அல்லது குறைக்க வேண்டிய அனைத்தும் செய்யப்பட்டது.', partial: 'அழிக்க அல்லது குறைக்க வேண்டிய அனைத்தும் செய்யப்படவில்லை — மேலே பட்டியலிட்டதைப் பாருங்கள்.',
    procH: 'கடைக்காக வாடிக்கையாளர் தரவைக் கையாளும் நிறுவனங்கள்', procLead: 'வாடிக்கையாளர்களின் தனிப்பட்ட தரவைக் கையாளும் ஒவ்வொரு வெளி நிறுவனமும் (SMS, பணம், டெலிவரி, கிளவுட்) அது பணிபுரியும் ஒப்பந்தத்துடன் இந்தப் பட்டியலில் இருக்க வேண்டும். அமைப்பு உண்மையில் செய்வதுடன் தலைமை அலுவலகம் பட்டியலைச் சரிபார்க்கிறது.',
    procShow: 'பட்டியலையும் சரிபார்ப்பையும் படி', procOk: 'தனிப்பட்ட தரவைக் கையாளும் ஒவ்வொரு நிறுவனமும் நடப்பிலுள்ள ஒப்பந்தத்துடன் பட்டியலில் உள்ளது.',
    procFindings: 'கண்டறிந்த சிக்கல்கள்', procEntries: 'பட்டியலில் உள்ளவை', vendorId: 'நிறுவனக் குறியீடு', vendorName: 'நிறுவனப் பெயர்', categories: 'அது கையாளும் தனிப்பட்ட தரவு (இடையில் காற்புள்ளி)',
    purpose: 'எதற்காக', contractRef: 'ஒப்பந்த எண்', contractFrom: 'ஒப்பந்தம் தொடங்கும் நாள்', contractUntil: 'ஒப்பந்தம் முடியும் நாள் (விருப்பம்)', procRecord: 'பட்டியலில் சேர்',
    procRecorded: 'பட்டியலில் சேர்க்கப்பட்டது.', openEnded: 'முடிவுத் தேதி இல்லை',
    breachH: 'வாடிக்கையாளர் தரவுக் கசிவு: யாரிடம், எதை, எப்போது சொல்ல வேண்டும்', breachLead: 'வாடிக்கையாளர்களின் தனிப்பட்ட தரவு தொலைந்தால், திருடப்பட்டால் அல்லது பார்க்கக்கூடாதவர் பார்த்தால், தரவுப் பாதுகாப்பு வாரியத்திடம் உடனே சொல்லி, 72 மணி நேரத்தில் முழு அறிக்கை தர வேண்டும்; பாதிக்கப்பட்ட ஒவ்வொருவரிடமும் சொல்ல வேண்டும் என்று சட்டம் சொல்கிறது. தெரிந்ததை நிரப்புங்கள்; எது செய்ய வேண்டும், எது இன்னும் இல்லை என்று தலைமை அலுவலகம் கணக்கிடும். அது எதையும் அனுப்பாது — ஒவ்வொரு அறிவிப்பையும் ஒருவர் அனுப்புவார்.',
    breachRef: 'இந்தக் கசிவுக்கான குறிப்பு', discovered: 'கடைக்குத் தெரிந்த நேரம் (கடை நேரம்)', affectedCats: 'சம்பந்தப்பட்ட தரவு (இடையில் காற்புள்ளி)', affectedCount: 'எத்தனை பேர்',
    description: 'என்ன நடந்தது', consequences: 'அவர்களுக்கு என்ன ஆகலாம்', mitigation: 'கட்டுப்படுத்த என்ன செய்யப்பட்டது', remedial: 'மீண்டும் நடக்காமல் எது தடுக்கும்',
    safety: 'தங்களைப் பாதுகாக்க மக்கள் என்ன செய்ய வேண்டும்', contact: 'மக்கள் யாரைத் தொடர்பு கொள்ளலாம்', boardTold: 'வாரியத்திடம் சொன்ன நேரம் (விருப்பம்)', reportFiled: 'முழு அறிக்கை தாக்கல் நேரம் (விருப்பம்)', peopleTold: 'மக்களிடம் சொன்ன நேரம் (விருப்பம்)',
    breachCheck: 'செய்ய வேண்டியதைக் கணக்கிடு', deadline: 'முழு அறிக்கைக்கான கடைசி நேரம்', allDone: 'செய்ய வேண்டிய அனைத்தும் முடிந்தது, எதுவும் குறையவில்லை.',
    ob_board_immediate_intimation: 'தரவுப் பாதுகாப்பு வாரியத்திடம் உடனே சொல்', ob_board_72h_report: 'வாரியத்திற்கு முழு அறிக்கை', ob_affected_principal_notices: 'பாதிக்கப்பட்ட ஒவ்வொருவரிடமும் சொல்',
    st_done: 'முடிந்தது', st_due: 'செய்ய வேண்டியது', st_overdue: 'தாமதம்', immediately: 'உடனே', missing: 'இன்னும் இல்லாதவை', adviceOnly: 'இது செய்ய வேண்டியதை மட்டும் கணக்கிடுகிறது. ஒவ்வொரு அறிவிப்பையும் ஒருவர் அனுப்புவார்.',
    leaveH: 'உறுப்பினர் திட்டத்திலிருந்து விலகுகிறார்', leaveLead: 'ஒரு உறுப்பினர் நிறுத்தக் கேட்டால் இங்கே பதிவு செய்யுங்கள். அதன் பிறகு அவர்களின் குறியீடு எதையும் சம்பாதிக்காது. புள்ளி வரலாறு வைக்கப்படும்.',
    member: 'உறுப்பினர் குறியீடு', reason: 'காரணம்', leave: 'விலகியதாகப் பதிவு செய்', left: 'பதிவு செய்யப்பட்டது. உறுப்பினர் விலகினார்; இனி குறியீடு எதையும் சம்பாதிக்காது.', alreadyLeft: 'இந்த உறுப்பினர் ஏற்கனவே விலகிவிட்டார்.',
    owedH: 'இன்னும் கொடுக்க வேண்டிய பரிந்துரைப் பரிசுகள்', owedLead: 'ஒரு பரிந்துரைப் பரிசு சம்பாதித்த நாளிலிருந்து கடை வாடிக்கையாளருக்குக் கொடுக்க வேண்டிய பணம். அதைக் கொடுக்கும்போது — ரொக்கம், கடை வரவு அல்லது வங்கிப் பரிமாற்றம் — எப்படி என்பதையும் ரசீது அல்லது பரிமாற்ற எண்ணையும் பதிவு செய்யுங்கள். வாடிக்கையாளர் ஏற்காத பரிசைக் காரணத்துடன் காலாவதியாக விடலாம். ஒவ்வொன்றும் வைக்கப்படும்; பின்னர் எதுவும் மாற்றப்படாது.',
    owedShow: 'கொடுக்க வேண்டிய பரிசுகளைக் காட்டு', noOwed: 'கொடுக்கக் காத்திருக்கும் பரிந்துரைப் பரிசு எதுவும் இல்லை.', owes: 'கொடுக்க வேண்டியது', side_referrer: 'நண்பரைப் பரிந்துரைத்தவர்', side_referred: 'பரிந்துரைக்கப்பட்டவர்',
    how: 'கொடுத்த விதம்', how_cash: 'ரொக்கம்', how_store_credit: 'கடை வரவு', how_bank_transfer: 'வங்கிப் பரிமாற்றம்', payRef: 'ரசீது, வரவு அல்லது பரிமாற்ற எண்', payOut: 'கொடுத்ததைப் பதிவு செய்', paidOut: 'கொடுத்ததாகப் பதிவு செய்யப்பட்டது.',
    lapseReason: 'காலாவதியாகும் காரணம்', lapse: 'காலாவதியாக விடு', lapsed: 'காலாவதியானதாகப் பதிவு செய்யப்பட்டது.',
    withdrawH: 'ஒப்புதல் பெற்ற செய்தியை நிறுத்து', withdrawLead: 'ஒப்புதல் பெற்ற செய்தியின் வார்த்தைகள் இனி வெளியே போகக்கூடாது என்றால் (தவறு, திரும்பப் பெற்ற சலுகை), இங்கே நிறுத்துங்கள். அதைக் கொண்டு இனி எதுவும் அனுப்பப்படாது; காத்திருக்கும் செய்திகள் உங்கள் காரணத்துடன் நிறுத்தி வைக்கப்படும்.',
    withdrawShow: 'ஒப்புதல் பெற்ற செய்திகளைக் காட்டு', noApproved: 'ஒப்புதல் பெற்ற செய்தி இல்லை.', version: 'பதிப்பு', withdraw: 'இந்தச் செய்தியை நிறுத்து', withdrawnOk: 'நிறுத்தப்பட்டது. இனி அதைக் கொண்டு எதுவும் போகாது.',
    logH: 'பிரச்சார முடிவுப் பதிவு', logLead: 'திட்டமிட்ட ஒவ்வொரு பிரச்சாரமும்: யார் திட்டமிட்டார், எத்தனை பேரை அடையும், எத்தனை பேர் ஏன் விடப்பட்டனர். புதியது முதலில்.',
    logShow: 'பதிவைக் காட்டு', noPlans: 'எந்தப் பிரச்சாரமும் திட்டமிடப்படவில்லை.', reach: 'அடையும்', leftOut: 'விடப்பட்டவர்', blocked: 'தடுக்கப்பட்டது',
    cxH: 'கொண்டுவர முடியாத ஒப்புதல் பதிவுகள்', cxLead: 'ஒப்புதல் மேலாளரின் கோப்பு கொண்டுவரப்படும்போது, பயன்படுத்த முடியாத பதிவு காரணத்துடன் இங்கே வைக்கப்படும். ஒவ்வொன்றையும் ஒருவர் பார்க்க வேண்டும்.',
    cxShow: 'அவற்றைக் காட்டு', noCx: 'கொண்டுவந்த ஒவ்வொரு பதிவும் பயன்படுத்தப்பட்டது.',
    caseH: 'வழக்கைத் தொடர்: முதல் பதில், இழப்பீடு, வாடிக்கையாளரின் மதிப்பீடு', caseLead: 'வழக்கு எண்ணைத் தட்டச்சு செய்யுங்கள். வாடிக்கையாளருக்கு ஒருவரிடமிருந்து முதல் பதில் கிடைத்த நேரத்தைக் குறியுங்கள், இழப்பீடு கொடுங்கள் (காரணத்துடன்; உங்கள் வரம்புக்கு மேல் என்றால் ஒப்புதல்கள் பக்கத்தில் இரண்டாவது நபரின் ஒப்புதல் தேவை), தீர்ந்த பிறகு வாடிக்கையாளர் எப்படி மதிப்பிட்டார் என்று பதிவு செய்யுங்கள்.',
    caseNo: 'வழக்கு எண்', caseOpen: 'தொடர்தலைத் திற', firstReply: 'முதல் பதில் இப்போது கொடுக்கப்பட்டதாகக் குறி', firstDone: 'முதல் பதில் பதிவு செய்யப்பட்டது.',
    compH: 'இந்த வழக்கில் இழப்பீடு', noComp: 'இந்த வழக்கில் இழப்பீடு கொடுக்கப்படவில்லை.', total: 'மொத்தம்', compKind: 'வகை', kind_refund: 'பணம் திருப்பம்', kind_goodwill_credit: 'நல்லெண்ணக் கடன்',
    kind_loyalty_points: 'விசுவாசப் புள்ளிகள்', kind_replacement: 'மாற்றுப் பொருள்', amount: 'தொகை (₹)', approvalId: 'ஒப்புதல் எண் (உங்கள் வரம்புக்கு மேல் மட்டும்)', grant: 'இழப்பீடு கொடு',
    granted: 'கொடுக்கப்பட்டது.', retry: 'மீண்டும் செயல்படுத்து', f_completed: 'செயல்படுத்தப்பட்டது', f_pending: 'காத்திருக்கிறது', f_failed: 'தோல்வி', notCarried: 'இந்த அமைப்பு செயல்படுத்துவதில்லை',
    rateH: 'வாடிக்கையாளர் எப்படி மதிப்பிட்டார்', score: 'மதிப்பெண் (1 = மோசம், 5 = மிக நன்று)', comment: 'அவர்கள் சொன்னது (விருப்பம்)', rate: 'மதிப்பீட்டைப் பதிவு செய்', rated: 'மதிப்பீடு பதிவு செய்யப்பட்டது.',
    houseH: 'ஒரு குடும்பத்தின் மொத்த இருப்பு', houseLead: 'ஒரு குடும்பத்தின் பரிசு அட்டைகளும் கடைக் கடனும் ஒரே பணப்பை. அனைத்திலும் சேர்த்து எவ்வளவு மீதம் என்று அறிய குடும்பத்தின் வாடிக்கையாளர் குறியீட்டைத் தட்டச்சு செய்யுங்கள்.',
    houseShow: 'மொத்த இருப்பைக் காட்டு', houseBal: 'எல்லா அட்டைகளிலும் சேர்த்து மீதம்', cards: 'அட்டை(கள்)',
    proofH: 'டெலிவரிச் சான்று', proofLead: 'ஒரு ஆர்டருக்கு ஓட்டுநரின் தொலைபேசி வாசலில் பதிவு செய்தது, தலைமை அலுவலகம் அதை எப்படி மதிப்பிட்டது, வைக்கப்பட்ட புகைப்படங்கள் அல்லது கையொப்பங்கள்.',
    proofShow: 'சான்றைக் காட்டு', codeIssued: 'வாடிக்கையாளருக்கு டெலிவரிக் குறியீடு கொடுக்கப்பட்டது', noCode: 'டெலிவரிக் குறியீடு கொடுக்கப்படவில்லை', door: 'வாசலில்', noDoor: 'இந்த ஆர்டருக்கு ஓட்டுநரின் தொலைபேசி வாசலில் எதையும் பதிவு செய்யவில்லை.',
    images: 'வைக்கப்பட்ட புகைப்படங்களும் கையொப்பங்களும்', noImages: 'புகைப்படம் அல்லது கையொப்பம் வைக்கப்படவில்லை.', showImage: 'காட்டு', photo: 'புகைப்படம்', signature: 'கையொப்பம்', notAnImage: 'இந்தக் கோப்பு பக்கம் காட்டக்கூடிய படம் அல்ல.',
    backH: 'பகுதி டெலிவரியிலிருந்து திரும்பிய பொருட்கள்', backLead: 'வாடிக்கையாளர் ஆர்டரின் ஒரு பகுதியை மட்டும் வைத்துக்கொண்டால், பேக் செய்த ஒவ்வொரு வரியிலும் திரும்பி வந்ததை எண்ணுங்கள். பின்னர் தலைமை அலுவலகம் ஆர்டரை முடிக்கும்: வைத்துக்கொண்டதற்கான விற்பனை, கொடுக்க வேண்டிய பணம் திருப்பம் ஒருவர் கொடுப்பதற்காக.',
    backShow: 'பேக்கைப் படி', backQty: 'திரும்பி வந்தது', packed: 'பேக் செய்தது', backRecord: 'திரும்பி வந்ததைப் பதிவு செய்', backDone: 'பதிவு செய்யப்பட்டது.', backAlready: 'ஏற்கனவே எண்ணப்பட்டது — முதல் எண்ணிக்கையைத் தலைமை அலுவலகம் வைத்துள்ளது.',
    notPacked: 'இந்த ஆர்டருக்குத் தலைமை அலுவலகத்திடம் பேக் இல்லை.',
    moveH: 'விதிவிலக்கை வேறு வரிசைக்கு மாற்று', moveLead: 'ஒரு மேலாளர் விதிவிலக்கை அதைக் கையாள வேண்டிய வரிசைக்கு மாற்றலாம். காரணம் வைக்கப்படும்.',
    exception: 'விதிவிலக்கு எண்', toQueue: 'எங்கே மாற்ற', q_fulfilment_supervisor: 'ஆர்டர் நிறைவு மேற்பார்வையாளர்', q_customer_service_desk: 'வாடிக்கையாளர் சேவை மேசை',
    q_finance_recon_queue: 'நிதி (பணம் பொருத்துதல்)', q_duty_manager: 'பணி மேலாளர்', move: 'மாற்று', moved: 'மாற்றப்பட்டது.',
    subH: 'மாற்றுப் பொருட்கள் பற்றி வாடிக்கையாளர் சொன்னது (பணியாளரிடம்)', subLead: 'வாடிக்கையாளர் தொலைபேசி, நேரில் அல்லது செய்தி மூலம் தங்கள் ஆர்டரில் எதை மாற்றலாம் என்று பணியாளரிடம் சொன்னால், எப்படித் தொடர்பு கொண்டீர்கள் என்பதுடன் இங்கே பதிவு செய்யுங்கள். பின்னர் மாற்றம் இதைச் சார்ந்திருக்கும், எடுப்பவர் தட்டச்சு செய்வதை அல்ல.',
    pref: 'அவர்கள் சொன்னது', pref_best_match: 'மிக நெருக்கமானதுடன் மாற்று', pref_contact_me: 'முதலில் என்னிடம் கேள்', pref_no_substitution: 'எதையும் மாற்ற வேண்டாம்',
    method: 'எப்படித் தொடர்பு கொண்டீர்கள்', m_phone: 'தொலைபேசி', m_whatsapp: 'வாட்ஸ்அப்', m_sms: 'SMS', m_in_person: 'நேரில்', contactRef: 'அழைப்பு அல்லது செய்தி குறிப்பு', subRecord: 'அவர்கள் சொன்னதைப் பதிவு செய்', subRecorded: 'பதிவு செய்யப்பட்டது.',
    noticesH: 'ஆன்லைன் ஆர்டர்கள் பற்றிய செய்திகள்', noticesLead: 'ஒரு வாடிக்கையாளருக்கு அவர்களின் ஆர்டர் பற்றி அனுப்ப வேண்டிய ஒவ்வொரு செய்தியும், அது செய்தி வரிசையில் சேர்ந்ததா — இல்லையென்றால் ஏன்.',
    noticesShow: 'அவற்றைக் காட்டு', noNotices: 'ஆர்டர் பற்றி எந்தச் செய்தியும் அனுப்ப வேண்டியதில்லை.', queued: 'வரிசையில் உள்ளது', notQueued: 'வரிசையில் இல்லை',
    refusalsH: 'வேறொருவரின் ஆர்டரைக் கேட்ட வாடிக்கையாளர்கள்', refusalsLead: 'வேறொரு வாடிக்கையாளரின் ஆர்டரைப் பார்க்க அல்லது அதில் ஆர்டர் செய்யக் கேட்ட வாடிக்கையாளரைச் செயலி மறுத்த ஒவ்வொரு முறையும். ஒன்றுக்கு மேற்பட்ட ஆர்டர்களை முயன்றவர் முதலில் பெயரிடப்படுவார்.',
    refusalsShow: 'பதிவேட்டைக் காட்டு', noRefusals: 'எந்த வாடிக்கையாளரும் வேறொருவரின் ஆர்டரைக் கேட்கவில்லை.', probing: 'ஒன்றுக்கு மேற்பட்ட ஆர்டர்களை முயன்றவர்', orders: 'ஆர்டர்(கள்)', a_read: 'பார்க்க முயன்றது', a_place: 'ஆர்டர் செய்ய முயன்றது',
    swapsH: 'வாடிக்கையாளரிடம் கேட்ட மாற்றங்கள்', swapsLead: 'எடுப்பவரால் ஒரு பொருளைக் கண்டுபிடிக்க முடியாமல், வாடிக்கையாளர் முதலில் கேட்கச் சொல்லியிருந்தால், எடுப்பவர் ஒரு மாற்றை வழங்குகிறார்; வாடிக்கையாளர் செயலியில் ஆம் அல்லது இல்லை என்கிறார். அதற்குப் பதிலாக தொலைபேசியில் சொன்னால், எப்படித் தொடர்பு கொண்டீர்கள் என்பதுடன் இங்கே பதிவு செய்யுங்கள் — அது செயலியில் சொன்னதைப் போலவே கணக்கிடப்படும்.',
    swapsShow: 'மாற்றங்களைக் காட்டு', noSwaps: 'இந்த ஆர்டரில் வாடிக்கையாளரிடம் எந்த மாற்றமும் கேட்கப்படவில்லை.', swapLine: 'எந்த மாற்றம்', swapAnswer: 'அவர்கள் சொன்னது', d_confirmed: 'ஆம் — மாற்றை அனுப்பு', d_declined: 'இல்லை — விட்டுவிடு', swapRecord: 'அவர்களின் பதிலைப் பதிவு செய்', swapRecorded: 'பதிவு செய்யப்பட்டது. கடை கணினி மூலம் எடுப்பவருக்குத் தெரிவிக்கப்படும்.',
    for: 'இதற்குப் பதிலாக', each: 'ஒன்றுக்கு', answerBy: 'பதில் சொல்ல வேண்டிய நேரம்', s_waiting: 'வாடிக்கையாளருக்காகக் காத்திருக்கிறது', s_yes: 'வாடிக்கையாளர் ஆம் என்றார்', s_no: 'வாடிக்கையாளர் இல்லை என்றார்', s_refused: 'கடையின் விதிகள் இதை மறுக்கின்றன', s_too_late: 'நேரத்திற்குள் பதில் இல்லை — குறைவாக பேக் செய்யப்பட்டது', s_closed: 'மூடப்பட்டது — எடுப்பவர் வரியை பேக் செய்துவிட்டார்',
    via_app: 'செயலியில்', via_staff: 'பணியாளரிடம் சொன்னது', onOrder: 'ஆர்டரில் சேர்க்கப்பட்டது', notOnOrder: 'ஆர்டரில் சேர்க்கப்படவில்லை',
    waitH: 'வாடிக்கையாளருக்காக எடுப்பவர் எவ்வளவு நேரம் காத்திருப்பார்', waitLead: 'ஒரு மாற்றத்திற்கு வாடிக்கையாளரின் ஆம் அல்லது இல்லை பதிலுக்கு எடுப்பவர் எத்தனை நிமிடம் காத்திருக்க வேண்டும் என்று உரிமையாளர் முடிவு செய்கிறார். அவர் அமைக்கும் வரை, எடுப்பவர் காத்திருக்க மாட்டார்: வரி குறைவாகும், வாடிக்கையாளரிடம் கேட்கப்படாது.',
    waitShow: 'காத்திருப்பைக் காட்டு', waitNotSet: 'உரிமையாளர் அமைக்கவில்லை — எடுப்பவர் காத்திருக்க மாட்டார்; முதலில் கேட்கச் சொன்ன வாடிக்கையாளரின் வரி குறைவாகும்.', waitIs: 'எடுப்பவர் காத்திருப்பது', minutes: 'நிமிடம்', setByOwner: 'அமைத்தவர்',
    waitMinutes: 'காத்திருக்கும் நிமிடங்கள் (1 முதல் 240)', waitReason: 'ஏன் (விருப்பம்)', waitSave: 'காத்திருப்பை அமை', waitSaved: 'சேமிக்கப்பட்டது. அடுத்த வேலையுடன் எடுப்பவர் தொலைபேசிகளுக்குக் கிடைக்கும்.',
  },
} as const;

export const deskWords = (lang: Lang, key: string): string =>
  (DESK_COPY[lang] as Record<string, string>)[key] ?? (DESK_COPY.en as Record<string, string>)[key] ?? key;
export const deskOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => deskWords(lang, k), out);

export const NOMINEE_BASES = ['death', 'incapacity'] as const;
export const COMPENSATION_KINDS = ['goodwill_credit', 'refund', 'loyalty_points', 'replacement'] as const;
export const EXCEPTION_QUEUES = ['fulfilment_supervisor', 'customer_service_desk', 'finance_recon_queue', 'duty_manager'] as const;
export const SUB_PREFERENCES = ['contact_me', 'best_match', 'no_substitution'] as const;
export const CONTACT_METHODS = ['phone', 'in_person', 'whatsapp', 'sms'] as const;
/** W6 (M17-FR-02): how a referral reward was paid out — head office's own list (services/customer/src/offer-liability.ts). */
export const PAYOUT_HOWS = ['cash', 'store_credit', 'bank_transfer'] as const;

/** Rupees as typed ("150", "150.5", "150.50") → paise; undefined when it is not an amount. */
export function paiseOf(text: string): number | undefined {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  return m === null ? undefined : Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}

/** "a, b ,, c" → ['a','b','c'] (blanks dropped). */
export const listOf = (text: string): string[] => text.split(',').map((x) => x.trim()).filter((x) => x !== '');

/**
 * A wall-clock time typed on the page (`YYYY-MM-DDTHH:MM`, the shop's own clock) → the instant it names. India is +330 and
 * keeps no summer time; the offset is a parameter so a test can say so. Undefined when it is not a date and time.
 */
export function instantOf(local: string, offsetMinutes = 330): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(local.trim());
  if (m === null) return undefined;
  const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00.000Z`);
  return Number.isNaN(at) ? undefined : new Date(at - offsetMinutes * 60_000).toISOString();
}

// ── what head office answers, as the page reads it ───────────────────────────────────────────────────────────────────
export interface ProfileViews { readonly customerRef: string; readonly views: readonly { readonly viewedBy: string; readonly at: string }[]; readonly count: number }
export interface NomineeRecord { readonly action: string; readonly nomineeRef: string | null; readonly relationship: string | null; readonly by: string; readonly at: string }
export interface Nomination {
  readonly customerRef: string; readonly current: NomineeRecord | null; readonly history: readonly NomineeRecord[];
  readonly activations: readonly { readonly nomineeRef: string; readonly basis: string; readonly evidenceRef: string; readonly verifiedBy: string; readonly verifiedAt: string }[];
}
export interface Tombstone {
  readonly requestId: string; readonly erasedAt: string; readonly maker: string; readonly checker: string; readonly complete: boolean;
  readonly categoriesErased: readonly string[]; readonly categoriesMinimised: readonly string[]; readonly categoriesRetained: readonly { readonly category: string; readonly retentionBasis?: string; readonly retainUntil?: string }[];
}
export interface ProcessorEntry { readonly vendorId: string; readonly vendorName: string; readonly dataCategories: readonly string[]; readonly purpose: string; readonly contractRef: string; readonly contractFrom: string; readonly contractUntil?: string; readonly recordedBy: string }
export interface ProcessorRegister { readonly register: readonly ProcessorEntry[]; readonly check: { readonly compliant: boolean; readonly asOf: string; readonly findings: readonly { readonly vendorName: string; readonly flag: string; readonly detail: string }[]; readonly detail: string } }
export interface BreachPlan {
  readonly breachId: string; readonly reportDeadline: string; readonly allSatisfied: boolean; readonly detail: string;
  readonly obligations: readonly { readonly obligation: string; readonly due: string; readonly status: 'done' | 'due' | 'overdue'; readonly missingContent: readonly string[]; readonly detail: string }[];
}
export interface TemplateRow { readonly templateId: string; readonly version: number; readonly purpose: string; readonly channel: string; readonly body: string; readonly state: string; readonly approvedBy?: string }
export interface CampaignPlanRow { readonly campaignId: string; readonly purpose: string; readonly channel: string; readonly templateId: string; readonly sendToCount: number; readonly excludedCount: number; readonly excludedByReason: Readonly<Record<string, number>>; readonly blocked: boolean | string | null; readonly plannedBy: string; readonly at: string }
export interface ConsentException { readonly exceptionId: string; readonly dataPrincipalRef: string; readonly purpose: string; readonly channel: string; readonly detail: string; readonly at: string }
export interface CompensationRow { readonly compensationId?: string; readonly kind: string; readonly amountMinor: number; readonly grantedBy: string; readonly approvedBy?: string; readonly reason: string; readonly at: string; readonly fulfilment?: { readonly status: string; readonly detail?: string } }
export interface Compensations { readonly caseId: string; readonly compensations: readonly CompensationRow[]; readonly count: number; readonly totalMinor: number }
export interface Household { readonly ownerRef: string; readonly balanceMinor: number; readonly instrumentIds: readonly string[]; readonly instrumentCount: number }
export interface ProofImageMeta { readonly imageId: string; readonly kind: string; readonly mediaType: string; readonly capturedAt: string; readonly driverId: string; readonly governanceFlags: readonly string[] }
export interface DeliveryProof {
  readonly orderId: string; readonly codeIssued: boolean; readonly codeIssuedAt?: string;
  readonly door: { readonly state: string; readonly proofKind?: string | null; readonly proofCheck?: { readonly code?: string; readonly fence?: { readonly result?: string } } | null; readonly flags?: readonly string[]; readonly at: string } | null;
  readonly images: readonly ProofImageMeta[];
}
export interface PackLine { readonly lineId: string; readonly productId: string; readonly name: string; readonly packedMinor: number }
export interface OrderNotice { readonly noticeId: string; readonly orderId: string; readonly customerRef: string; readonly kind: string; readonly outcome: 'queued' | 'not_queued'; readonly code?: string; readonly detail: string; readonly at: string }
/** W6: one referral reward still owed, as head office's liability register holds it — and, where its programme names it, whose. */
export interface OwedReferral { readonly referralId: string; readonly earnedMinor: number; readonly outstandingMinor: number; readonly side: 'referrer' | 'referred' | null; readonly customerRef: string | null }
/** W6 · OB-687: one swap the picker put to a customer, as head office holds it, with where it stands. */
export interface SwapProposal {
  readonly proposalId: string; readonly lineId: string; readonly orderedName: string; readonly substituteProductId: string; readonly substituteName: string;
  readonly substituteUnitPriceMinor: number | null; readonly state: 'waiting' | 'yes' | 'no' | 'refused' | 'too_late' | 'closed'; readonly answerBy: string | null;
  readonly answeredVia?: 'app' | 'staff'; readonly contact?: { readonly method: string; readonly reference: string }; readonly refusedBecause?: string | null;
  readonly settled?: { readonly packed: string; readonly decision: string | null; readonly onOrder: boolean; readonly refusal: { readonly code: string; readonly whatHappened: string } | null };
}
/** W6 · OB-687: the owner's wait, as head office holds it ("not set" until he sets it). */
export interface SwapWait { readonly minutes: number | null; readonly state: 'set' | 'not_set'; readonly setBy: string | null; readonly setAt: string | null }
export const SWAP_DECISIONS = ['confirmed', 'declined'] as const;

export interface AccessRegister { readonly refusals: readonly { readonly customerRef: string; readonly orderId: string; readonly outcome: string; readonly action: string; readonly at: string }[]; readonly probing: readonly { readonly customerRef: string; readonly distinctOrders: number }[]; readonly detail: string }

type Why = 'nobody' | 'cannot' | 'needCustomer' | 'needOrder' | 'needCase' | 'needReason' | 'needText' | 'needNumber' | 'needRupees' | 'needWhen' | 'needScore';
type Done<T> = Promise<Outcome<T, Why>>;

/** The permission words each section's routes ask for — the page offers a section only to whom head office would answer. */
export const SECTION_WORDS = {
  views: 'customer.identity.approve', privacy: 'privacy.request.manage', breach: 'customer.consent.write', leave: 'loyalty.member.enrol',
  templates: 'document.template.manage', campaignLog: 'customer.campaign.read', consentExceptions: 'customer.consent.write',
  caseRead: 'service.case.read', caseManage: 'service.case.manage', household: 'loyalty.value.read', proof: 'delivery.run.read',
  handback: 'fulfilment.pack.record', packRead: 'fulfilment.pack.read', reassign: 'order.exception.manage', subPref: 'order.lifecycle.manage', orderRead: 'order.read',
  referral: 'loyalty.referral.settle',
  // W6 · OB-687: the owner's own number — how long the picker waits for a customer's answer to a swap.
  waitSet: 'fulfilment.substitution_wait.set',
} as const;
export type SectionKey = keyof typeof SECTION_WORDS;

export interface DeskSession {
  readonly may: Readonly<Record<SectionKey | 'named', boolean>>;
  profileViews(customerRef: string): Done<ProfileViews>;
  nomination(customerRef: string): Done<Nomination>;
  activateNominee(customerRef: string, i: { readonly nomineeRef: string; readonly basis: string; readonly evidenceRef: string }): Done<unknown>;
  finishedErasures(): Done<readonly { readonly requestId: string; readonly customerRef: string; readonly state: string }[]>;
  tombstone(requestId: string): Done<Tombstone>;
  processors(): Done<ProcessorRegister>;
  recordProcessor(i: { readonly vendorId: string; readonly vendorName: string; readonly categories: string; readonly purpose: string; readonly contractRef: string; readonly contractFrom: string; readonly contractUntil: string }): Done<unknown>;
  assessBreach(i: Readonly<Record<string, string>>, offsetMinutes?: number): Done<BreachPlan>;
  leave(memberRef: string, reason: string): Done<{ readonly memberRef: string; readonly alreadyLeft?: boolean }>;
  /** W6: the referral rewards still owed (the programme read first, so a reward now due is given before the register is read). */
  owedReferrals(): Done<readonly OwedReferral[]>;
  payReferral(referralId: string, how: string, reference: string): Done<unknown>;
  lapseReferral(referralId: string, reason: string): Done<unknown>;
  approvedTemplates(): Done<readonly TemplateRow[]>;
  withdrawTemplate(templateId: string, version: number, reason: string): Done<unknown>;
  campaignLog(): Done<readonly CampaignPlanRow[]>;
  consentExceptions(): Done<readonly ConsentException[]>;
  firstReply(caseId: string): Done<{ readonly firstRespondedAt: string }>;
  compensations(caseId: string): Done<Compensations>;
  grant(caseId: string, i: { readonly kind: string; readonly rupees: string; readonly reason: string; readonly approvalId: string }): Done<unknown>;
  carryOutAgain(caseId: string, compensationId: string): Done<unknown>;
  rate(caseId: string, i: { readonly customerRef: string; readonly score: string; readonly comment: string }): Done<unknown>;
  household(ownerRef: string): Done<Household>;
  proof(orderId: string): Done<DeliveryProof>;
  proofImage(imageId: string): Done<{ readonly mediaType: string; readonly contentBase64: string; readonly kind: string }>;
  packLines(orderId: string): Done<readonly PackLine[]>;
  handback(orderId: string, counted: Readonly<Record<string, string>>): Done<{ readonly alreadyRecorded: boolean }>;
  reassign(exceptionId: string, toOwner: string, reason: string): Done<unknown>;
  recordPreference(orderId: string, i: { readonly preference: string; readonly method: string; readonly reference: string }): Done<unknown>;
  orderNotices(): Done<{ readonly notices: readonly OrderNotice[]; readonly notQueued: readonly OrderNotice[]; readonly detail: string }>;
  accessRefusals(): Done<AccessRegister>;
  /** W6 · OB-687: the swaps put to the customer on one order. */
  swapProposals(orderId: string): Done<readonly SwapProposal[]>;
  /** W6 · OB-687: the customer's yes or no, told to staff — with how they were reached and the reference. */
  answerSwap(orderId: string, lineId: string, i: { readonly decision: string; readonly method: string; readonly reference: string }): Done<unknown>;
  swapWait(): Done<SwapWait>;
  /** W6 · OB-687: the owner sets the wait — whole minutes, 1 to 240. */
  setSwapWait(minutes: string, reason: string): Done<SwapWait>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** W6 · OB-687: head office's wait read as it said it — a number, or "not set"; never a default. */
const waitOf = (v: Partial<SwapWait>): SwapWait => ({ minutes: typeof v.minutes === 'number' ? v.minutes : null, state: v.state === 'set' ? 'set' : 'not_set', setBy: v.setBy ?? null, setAt: v.setAt ?? null });
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function createDeskSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): DeskSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = Object.freeze({
    named, ...Object.fromEntries(Object.entries(SECTION_WORDS).map(([k, word]) => [k, named && held.has(word)])),
  }) as Readonly<Record<SectionKey | 'named', boolean>>;
  const call = makeCaller({ keyPrefix: 'desk', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const enc = encodeURIComponent;
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (k: SectionKey): { result: 'invalid'; why: Why } | undefined => (!named ? no('nobody') : !may[k] ? no('cannot') : undefined);
  const need = (v: string, why: Why): { result: 'invalid'; why: Why } | undefined => (v.trim() === '' ? no(why) : undefined);
  const map = async <A, B>(p: Promise<Outcome<A, never>>, f: (a: A) => B): Done<B> => { const o = await p; return o.result === 'ok' ? { result: 'ok', value: f(o.value) } : o; };

  return {
    may,
    profileViews: async (ref) => gate('views') ?? need(ref, 'needCustomer') ?? call<ProfileViews>('GET', `/v1/customers/${enc(ref.trim())}/profile/views`),
    nomination: async (ref) => gate('privacy') ?? need(ref, 'needCustomer') ?? call<Nomination>('GET', `/v1/privacy/nominees/${enc(ref.trim())}`),
    activateNominee: async (ref, i) => {
      const g = gate('privacy') ?? need(ref, 'needCustomer') ?? need(i.nomineeRef, 'needText') ?? need(i.evidenceRef, 'needText'); if (g) return g;
      if (!(NOMINEE_BASES as readonly string[]).includes(i.basis)) return no('needText');
      // One verification per press: the id names the customer, the nominee and the certificate, so a double press is one.
      const activationId = `act-${ref.trim()}-${i.nomineeRef.trim()}-${i.evidenceRef.trim()}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120);
      return call('POST', `/v1/privacy/nominees/${enc(ref.trim())}/activation`, { activationId, nomineeRef: i.nomineeRef.trim(), basis: i.basis, evidenceRef: i.evidenceRef.trim() });
    },
    finishedErasures: async () => gate('privacy') ?? map(call<{ queue?: unknown[] }>('GET', '/v1/privacy/data-requests?state=all'), (v) => arr<Record<string, unknown>>(v.queue)
      .filter((r) => isObj(r) && r['kind'] === 'erasure' && (r['state'] === 'fulfilled' || r['state'] === 'partially_fulfilled'))
      .map((r) => ({ requestId: String(r['requestId']), customerRef: String(r['customerRef']), state: String(r['state']) }))),
    tombstone: async (id) => gate('privacy') ?? need(id, 'needText') ?? call<Tombstone>('GET', `/v1/privacy/data-requests/${enc(id.trim())}/tombstone`),
    processors: async () => gate('privacy') ?? call<ProcessorRegister>('GET', '/v1/privacy/processor-contracts'),
    recordProcessor: async (i) => {
      const g = gate('privacy'); if (g) return g;
      const cats = listOf(i.categories);
      if ([i.vendorId, i.vendorName, i.purpose, i.contractRef].some((x) => x.trim() === '') || cats.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(i.contractFrom.trim())) return no('needText');
      if (i.contractUntil.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(i.contractUntil.trim())) return no('needText');
      return call('POST', '/v1/privacy/processor-contracts', {
        vendorId: i.vendorId.trim(), vendorName: i.vendorName.trim(), dataCategories: cats, purpose: i.purpose.trim(), contractRef: i.contractRef.trim(),
        contractFrom: i.contractFrom.trim(), ...(i.contractUntil.trim() === '' ? {} : { contractUntil: i.contractUntil.trim() }),
      });
    },
    assessBreach: async (i, offsetMinutes = 330) => {
      const g = gate('breach'); if (g) return g;
      const v = (k: string): string => (i[k] ?? '').trim();
      if (v('breachId') === '' || listOf(v('categories')).length === 0) return no('needText');
      if (!/^\d+$/.test(v('count'))) return no('needNumber');
      const discoveredAt = instantOf(v('discovered'), offsetMinutes);
      if (discoveredAt === undefined) return no('needWhen');
      const body: Record<string, unknown> = { breachId: v('breachId'), discoveredAt, affectedDataCategories: listOf(v('categories')), affectedPrincipalCount: Number(v('count')) };
      for (const k of ['description', 'likelyConsequences', 'mitigationMeasures', 'remedialMeasures', 'safetyMeasuresForPrincipals', 'contactPoint']) if (v(k) !== '') body[k] = v(k);
      for (const k of ['boardIntimatedAt', 'boardReportFiledAt', 'principalsNotifiedAt']) {
        if (v(k) === '') continue;
        const at = instantOf(v(k), offsetMinutes); if (at === undefined) return no('needWhen');
        body[k] = at;
      }
      return call<BreachPlan>('POST', '/v1/privacy/breach/assess', body);
    },
    leave: async (ref, reason) => gate('leave') ?? need(ref, 'needCustomer') ?? need(reason, 'needReason')
      ?? call('POST', `/v1/loyalty/members/${enc(ref.trim())}/leave`, { reason: reason.trim() }),
    owedReferrals: async () => {
      const g = gate('referral'); if (g) return g;
      // The staff-side programme read brings each referral up to date (a reward now due is given there) and names whose it is.
      const programme = await call<{ referrals?: unknown[] }>('GET', '/v1/loyalty/referral-programme');
      if (programme.result !== 'ok') return programme;
      const whose = new Map<string, { side: 'referrer' | 'referred'; customerRef: string }>();
      for (const r of arr<Record<string, unknown>>(programme.value.referrals)) {
        for (const gr of arr<Record<string, unknown>>(isObj(r) ? r['grants'] : undefined)) {
          if (isObj(gr) && typeof gr['referralId'] === 'string' && (gr['side'] === 'referrer' || gr['side'] === 'referred')) whose.set(gr['referralId'], { side: gr['side'], customerRef: String(gr['customerRef'] ?? '') });
        }
      }
      return map(call<{ register?: { referrals?: unknown[] } }>('GET', '/v1/finance/referral-liability'), (v) => arr<Record<string, unknown>>(v.register?.referrals)
        .filter((r) => isObj(r) && typeof r['referralId'] === 'string' && typeof r['outstandingMinor'] === 'number' && r['outstandingMinor'] > 0)
        .map((r): OwedReferral => {
          const id = r['referralId'] as string; const w = whose.get(id);
          return { referralId: id, earnedMinor: Number(r['earnedMinor'] ?? 0), outstandingMinor: r['outstandingMinor'] as number, side: w?.side ?? null, customerRef: w === undefined || w.customerRef === '' ? null : w.customerRef };
        }));
    },
    payReferral: async (id, how, reference) => {
      const g = gate('referral') ?? need(id, 'needText') ?? need(reference, 'needText'); if (g) return g;
      if (!(PAYOUT_HOWS as readonly string[]).includes(how)) return no('needText');
      return call('POST', `/v1/loyalty/referrals/${enc(id.trim())}/payout`, { how, reference: reference.trim() });
    },
    lapseReferral: async (id, reason) => gate('referral') ?? need(id, 'needText') ?? need(reason, 'needReason')
      ?? call('POST', `/v1/loyalty/referrals/${enc(id.trim())}/expire`, { reason: reason.trim() }),
    approvedTemplates: async () => gate('templates') ?? map(call<{ templates?: unknown[] }>('GET', '/v1/notifications/templates'), (v) => {
      // The latest state of each version: one approved and later withdrawn is not offered again.
      const latest = new Map<string, TemplateRow>();
      for (const t of arr<TemplateRow>(v.templates)) if (isObj(t)) latest.set(`${t.templateId}|${t.version}`, t);
      return [...latest.values()].filter((t) => t.state === 'approved').sort((a, b) => a.templateId.localeCompare(b.templateId) || a.version - b.version);
    }),
    withdrawTemplate: async (id, version, reason) => gate('templates') ?? need(reason, 'needReason')
      ?? call('POST', `/v1/notifications/templates/${enc(id)}/withdrawal`, { version, reason: reason.trim() }),
    campaignLog: async () => gate('campaignLog') ?? map(call<{ plans?: unknown[] }>('GET', '/v1/service/campaigns/plans'), (v) => arr<CampaignPlanRow>(v.plans)),
    consentExceptions: async () => gate('consentExceptions') ?? map(call<{ exceptions?: unknown[] }>('GET', '/v1/privacy/consent-manager/exceptions'), (v) => arr<ConsentException>(v.exceptions)),
    firstReply: async (caseId) => gate('caseManage') ?? need(caseId, 'needCase') ?? call('POST', `/v1/service/cases/${enc(caseId.trim())}/first-response`, {}),
    compensations: async (caseId) => gate('caseRead') ?? need(caseId, 'needCase') ?? call<Compensations>('GET', `/v1/service/cases/${enc(caseId.trim())}/compensations`),
    grant: async (caseId, i) => {
      const g = gate('caseManage') ?? need(caseId, 'needCase') ?? need(i.reason, 'needReason'); if (g) return g;
      if (!(COMPENSATION_KINDS as readonly string[]).includes(i.kind)) return no('needText');
      const amountMinor = paiseOf(i.rupees);
      if (amountMinor === undefined || amountMinor <= 0) return no('needRupees');
      return call('POST', `/v1/service/cases/${enc(caseId.trim())}/compensation`, { kind: i.kind, amountMinor, reason: i.reason.trim(), ...(i.approvalId.trim() === '' ? {} : { approvalId: i.approvalId.trim() }) });
    },
    carryOutAgain: async (caseId, compensationId) => gate('caseManage') ?? call('POST', `/v1/service/cases/${enc(caseId.trim())}/compensations/${enc(compensationId)}/fulfil`, {}),
    rate: async (caseId, i) => {
      const g = gate('caseManage') ?? need(caseId, 'needCase') ?? need(i.customerRef, 'needCustomer'); if (g) return g;
      if (!/^[1-5]$/.test(i.score.trim())) return no('needScore');
      return call('POST', `/v1/service/cases/${enc(caseId.trim())}/satisfaction`, { customerRef: i.customerRef.trim(), score: Number(i.score.trim()), ...(i.comment.trim() === '' ? {} : { comment: i.comment.trim() }) });
    },
    household: async (ref) => gate('household') ?? need(ref, 'needCustomer') ?? call<Household>('GET', `/v1/stored-value/households/${enc(ref.trim())}/balance`),
    proof: async (orderId) => gate('proof') ?? need(orderId, 'needOrder') ?? call<DeliveryProof>('GET', `/v1/delivery/orders/${enc(orderId.trim())}/proof`),
    proofImage: async (imageId) => gate('proof') ?? call('GET', `/v1/delivery/proof-images/${enc(imageId)}`),
    packLines: async (orderId) => gate('packRead') ?? need(orderId, 'needOrder')
      ?? map(call<{ lines?: unknown[] }>('GET', `/v1/fulfilment/orders/${enc(orderId.trim())}/pack`), (v) => arr<PackLine>(v.lines).map((l) => ({ lineId: l.lineId, productId: l.productId, name: l.name, packedMinor: l.packedMinor }))),
    handback: async (orderId, counted) => {
      const g = gate('handback') ?? need(orderId, 'needOrder'); if (g) return g;
      const lines = Object.entries(counted).map(([lineId, q]) => ({ lineId, q: q.trim() }));
      if (lines.length === 0 || lines.some((l) => !/^\d+$/.test(l.q))) return no('needNumber');
      return map(call<{ alreadyRecorded?: boolean }>('POST', `/v1/fulfilment/orders/${enc(orderId.trim())}/handback`, { lines: lines.map((l) => ({ lineId: l.lineId, quantityMinor: Number(l.q) })) }), (v) => ({ alreadyRecorded: v.alreadyRecorded === true }));
    },
    reassign: async (id, to, reason) => {
      const g = gate('reassign') ?? need(id, 'needText') ?? need(reason, 'needReason'); if (g) return g;
      if (!(EXCEPTION_QUEUES as readonly string[]).includes(to)) return no('needText');
      return call('POST', `/v1/orders/substitution-exceptions/${enc(id.trim())}/reassign`, { toOwner: to, reasonCode: reason.trim() });
    },
    recordPreference: async (orderId, i) => {
      const g = gate('subPref') ?? need(orderId, 'needOrder') ?? need(i.reference, 'needText'); if (g) return g;
      if (!(SUB_PREFERENCES as readonly string[]).includes(i.preference) || !(CONTACT_METHODS as readonly string[]).includes(i.method)) return no('needText');
      return call('POST', `/v1/orders/${enc(orderId.trim())}/substitution-preference`, { rules: { preference: i.preference }, contact: { method: i.method, reference: i.reference.trim() } });
    },
    orderNotices: async () => gate('orderRead') ?? map(call<{ notices?: unknown[]; notQueued?: unknown[]; detail?: unknown }>('GET', '/v1/storefront/order-notices'),
      (v) => ({ notices: arr<OrderNotice>(v.notices), notQueued: arr<OrderNotice>(v.notQueued), detail: typeof v.detail === 'string' ? v.detail : '' })),
    accessRefusals: async () => gate('orderRead') ?? map(call<{ refusals?: unknown[]; probing?: unknown[]; detail?: unknown }>('GET', '/v1/storefront/access-refusals'),
      (v) => ({ refusals: arr(v.refusals), probing: arr(v.probing), detail: typeof v.detail === 'string' ? v.detail : '' })),
    swapProposals: async (orderId) => gate('orderRead') ?? need(orderId, 'needOrder')
      ?? map(call<{ proposals?: unknown[] }>('GET', `/v1/orders/${enc(orderId.trim())}/substitution-proposals`), (v) => arr<SwapProposal>(v.proposals)),
    answerSwap: async (orderId, lineId, i) => {
      const g = gate('subPref') ?? need(orderId, 'needOrder') ?? need(lineId, 'needText') ?? need(i.reference, 'needText'); if (g) return g;
      if (!(SWAP_DECISIONS as readonly string[]).includes(i.decision) || !(CONTACT_METHODS as readonly string[]).includes(i.method)) return no('needText');
      return call('POST', `/v1/orders/${enc(orderId.trim())}/substitution-proposals/${enc(lineId.trim())}/answer`, { decision: i.decision, contact: { method: i.method, reference: i.reference.trim() } });
    },
    swapWait: async () => gate('orderRead') ?? map(call<SwapWait>('GET', '/v1/fulfilment/substitution-wait'), waitOf),
    setSwapWait: async (minutes, reason) => {
      const g = gate('waitSet'); if (g) return g;
      // The owner's number: whole minutes, 1 to 240 (the picker's sign-in lasts four hours). Nothing is suggested.
      if (!/^\d{1,3}$/.test(minutes.trim()) || Number(minutes) < 1 || Number(minutes) > 240) return no('needNumber');
      return map(call<SwapWait>('POST', '/v1/fulfilment/substitution-wait', { minutes: Number(minutes), ...(reason.trim() === '' ? {} : { reason: reason.trim() }) }), waitOf);
    },
  };
}
