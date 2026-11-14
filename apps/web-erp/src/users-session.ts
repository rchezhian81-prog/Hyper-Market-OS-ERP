// Users & roles (Round 4c · M02-FR-01/02/04 · §28 · OB-615 · OB-15-c · P-04 · hard rule #4) — the page where a role is GIVEN
// and TAKEN BACK, always by two people, over head office's own routes. A tested, DOM-free session; the page lays out what it
// is told. Nothing is written on open; every write is an explicit press, in the signed-in person's OWN session, and head
// office re-checks every permission and every rule (the `may` flags only shape what is offered).
//
//   • WHO HOLDS WHAT — `GET /v1/identity/grants` (identity.role.request — the person who asks): the live grants, from the
//     ledger, with the role catalogue; the owner also reads the catalogue and what waits for him (identity.role.read).
//   • GIVE A ROLE — the maker asks (`POST /v1/identity/grants`, identity.role.request; never for themselves); the second
//     person approves or rejects it here (`…/grants/:id/approve|reject`, identity.role.grant — the owner), never their own.
//   • TAKE A ROLE BACK — a "mover" change through the joiner/mover/leaver route (`POST /v1/access/lifecycle/:id`): the maker
//     asks for approval of exactly the change (kind `access_change`, the other roles the person keeps as the target); the
//     owner approves it on the Approvals page; the maker then applies it here. The person's sessions close so it takes
//     effect now. Taking back a person's ONLY role is a leaver (their sign-in ends too) — offered as its own act.
//   • LIMIT A ROLE (M02-FR-02) — to some departments (`department_scope_change`) or suppliers, categories or locations
//     (`role_scope_change`), asked, approved by the owner, then applied here; never one's own.
//   • ROLES WAITING FOR THE OWNER (OB-615) — the four roadmap §28 roles with every word they would carry and why; nobody can
//     be given one until the owner approves it.
// Head office's own sentences stay in English (OB-553); every word this page adds has a Tamil twin.

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const USERS_COPY = {
  en: {
    title: 'Users & roles',
    lead: 'Who may do what in the shop. A role is given and taken back by two people: one asks, the owner approves — never for themselves. Every change is recorded.',
    holdersH: 'Who holds which role', holdersLead: 'Every role a person holds now, and where. Take a role back here; the owner approves it.',
    pendingH: 'Waiting for a second person', pendingLead: 'Roles somebody asked to give. The owner approves or rejects each one — never their own request.',
    giveH: 'Give a role', giveLead: 'Ask for a role for a member of staff. It is given only when the owner approves it.',
    mineH: 'My changes', mineLead: 'Take-backs and limits you asked for. Once the owner approves one on the Approvals page, apply it here.',
    waitingH: 'Roles waiting for the owner\'s approval', waitingLead: 'Written from the roadmap, not live yet. Nobody can be given one until the owner reads these permissions and approves them in writing.',
    limitH: 'Limit a role', limitLead: 'Narrow a person\'s role to some departments, suppliers, categories or locations. Asked here, approved by the owner, then applied.',
    person: 'Person (their sign-in id)', role: 'Role', stores: 'Stores (ids, comma between; or "all")', reason: 'Why',
    give: 'Ask for this role', approve: 'Approve', reject: 'Reject', takeBack: 'Take back', leaver: 'They have left',
    apply: 'Apply now', reload: 'Read again from head office', limit: 'Ask to limit',
    dimension: 'Limit to', values: 'Which (ids, comma between; or "all" to lift the limit)',
    departments: 'departments', suppliers: 'suppliers', categories: 'categories', locations: 'locations',
    askedBy: 'asked by', at: 'at', where: 'where', all: 'all stores',
    nobodyHolds: 'Nobody holds a role yet.', nothingPending: 'Nothing is waiting for a second person.', nothingMine: 'You have asked for no change yet.',
    yourOwn: 'You asked for this, so someone else decides it.',
    scopeLabel: 'Scope', mayLabel: 'May', mustNotLabel: 'Must not', limitedBy: 'Narrowed by', wordsLabel: 'Permissions it would carry', withheldLabel: 'Left out on purpose', questionsLabel: 'For the owner to settle',
    statusWaiting: 'waiting for the owner', statusApproved: 'approved — apply it now', statusRejected: 'rejected', statusExpired: 'approval ran out — ask again', statusUsed: 'done',
    kind_access_change: 'Take back a role / leaving', kind_department_scope_change: 'Limit to departments', kind_role_scope_change: 'Limit to suppliers, categories or locations',
    asked: 'Asked. The owner approves it on the Approvals page; then press “Apply now” here.',
    given: 'Asked. It is given once the owner approves it.', approved: 'Approved — the role is given.', rejected: 'Rejected.', applied: 'Done — recorded.',
    blocked: 'Head office did not apply it:',
    nobody: 'Nobody is signed in on this screen, so nothing can be done here.',
    cannotRead: 'Your role cannot see who holds which role.', cannotAsk: 'Your role cannot ask for a role change.', cannotDecide: 'Only the owner approves a role.',
    needPerson: 'Type the person\'s sign-in id.', needRole: 'Choose a role.', needStores: 'Name the stores, or type "all".', needReason: 'Say why.',
    yourself: 'Nobody asks for a change to their own access. Ask somebody else to do it.',
    waitingRole: 'That role waits for the owner\'s approval (OB-615) — nobody can be given it yet.',
    onlyRole: 'This is their only role. Taking it back means they have left — use “They have left”.',
    needValues: 'Name the ids, or type "all" to lift the limit.', notReady: 'That change is not approved yet.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or sent.', reading: 'Reading from head office…',
    signInsH: 'Sign-ins', signInsLead: 'Give a new person their own sign-in (one person, one sign-in). What they may do is asked for above and approved by the owner.',
    pinNeeded: 'Type your own PIN again to confirm. Nothing was changed.',
    pinAskGive: 'Type your own PIN again to ask for this role.', pinAskApprove: 'Type your own PIN again to approve this role.',
    pinAskReject: 'Type your own PIN again to reject this request.', pinAskAdd: 'Type your own PIN again to add this person.',
    addH: 'Add a person on this store PC', addLead: 'A new member of staff, for this store PC and its tills only (no office or phone login). Adding the name gives them nothing: then ask for a role for them (a second person approves) and set their till PIN.',
    addName: 'Their full name', addStaffId: 'Their staff id (a–z, 0–9, . _ -)', addBtn: 'Add this person', added: 'Added — for this store PC only. Now ask for a role for them.',
    needName: 'Type the person\'s full name.', needStaffId: 'Type their staff id: 3 to 64 of a–z, 0–9, . _ -',
    storePcOnly: 'On this store PC, each with your own PIN: add a person, ask for a role, approve or reject, take a role back or record a leaver (a second person approves), and set, change or cancel a till PIN. Limiting a role needs the head-office link.',
    takeBacksH: 'Take-backs waiting for a second person', takeBacksLead: 'A role taken back, or a person who left. When a second person approves with their PIN, it is done at once; a leaver\'s till PIN stops working.',
    nothingTakeBack: 'No take-back is waiting.', yourTakeBack: 'You asked for this, so someone else decides it.',
    takeBackAsked: 'Asked. A second person approves it here with their PIN; then it is done at once.', takeBackDone: 'Approved and done.', takeBackRejected: 'Rejected — nobody\'s access changed.',
    pinsH: 'Till PINs', pinsLead: 'Set a new PIN for a member of staff (they type it themselves, twice, hidden), cancel a PIN, or change your own. You can do this only for people who hold no more authority than you.',
    pinStaff: 'Staff id', pinSetBtn: 'Set a new PIN', pinCancelBtn: 'Cancel their PIN', pinOwnBtn: 'Change my own PIN',
    pinSetDone: 'The new PIN is set. It works now; the old one has stopped.', pinCancelDone: 'The PIN is cancelled. They cannot sign in until a new one is set.', pinOwnDone: 'Your PIN is changed. Use the new one from now on.',
    pinAskTakeBack: 'Type your own PIN again to ask for this.', pinAskSet: 'Type YOUR own PIN to allow a new PIN for this person.', pinAskCancel: 'Type your own PIN again to cancel their PIN.',
    pinAskCurrent: 'Type your CURRENT PIN.', pinAskNew: 'Hand over the keyboard. The person types their NEW 6-digit PIN.', pinAskNewAgain: 'Type the same new PIN again.',
    newPinMismatch: 'The new PIN must be 6 digits, the same twice. Nothing was changed.', needStaffIdPin: 'Type the staff id.',
    notOnStorePc: 'Not on this store PC yet. Nothing was changed.',
    pinOk: 'Confirm', pinCancel: 'Cancel',
  },
  ta: {
    title: 'பயனர்களும் பங்குகளும்',
    lead: 'கடையில் யார் என்ன செய்யலாம். ஒரு பங்கு இருவரால் வழங்கப்பட்டு திரும்பப் பெறப்படுகிறது: ஒருவர் கேட்கிறார், உரிமையாளர் அனுமதிக்கிறார் — தனக்காக ஒருபோதும் இல்லை. ஒவ்வொரு மாற்றமும் பதிவு செய்யப்படுகிறது.',
    holdersH: 'யார் எந்தப் பங்கை வகிக்கிறார்', holdersLead: 'ஒவ்வொருவரும் இப்போது வகிக்கும் பங்குகள், எங்கே. இங்கே ஒரு பங்கைத் திரும்பப் பெறலாம்; உரிமையாளர் அனுமதிக்கிறார்.',
    pendingH: 'இரண்டாவது நபருக்காகக் காத்திருப்பவை', pendingLead: 'யாரோ வழங்கக் கேட்ட பங்குகள். உரிமையாளர் ஒவ்வொன்றையும் அனுமதிக்கிறார் அல்லது மறுக்கிறார் — தன் சொந்தக் கோரிக்கையை ஒருபோதும் இல்லை.',
    giveH: 'ஒரு பங்கை வழங்கு', giveLead: 'ஒரு பணியாளருக்கு ஒரு பங்கைக் கேளுங்கள். உரிமையாளர் அனுமதித்த பிறகே வழங்கப்படும்.',
    mineH: 'என் மாற்றங்கள்', mineLead: 'நீங்கள் கேட்ட திரும்பப் பெறுதல்களும் வரம்புகளும். உரிமையாளர் ஒப்புதல்கள் பக்கத்தில் அனுமதித்ததும், இங்கே செயல்படுத்துங்கள்.',
    waitingH: 'உரிமையாளரின் ஒப்புதலுக்காகக் காத்திருக்கும் பங்குகள்', waitingLead: 'திட்ட வரைவிலிருந்து எழுதப்பட்டவை, இன்னும் நடைமுறையில் இல்லை. உரிமையாளர் இந்த அனுமதிகளைப் படித்து எழுத்தில் ஒப்புதல் தரும் வரை யாருக்கும் வழங்க முடியாது.',
    limitH: 'ஒரு பங்கை வரம்பிடு', limitLead: 'ஒருவரின் பங்கைச் சில துறைகள், சப்ளையர்கள், வகைகள் அல்லது இடங்களுக்குக் குறுக்குங்கள். இங்கே கேட்கப்பட்டு, உரிமையாளர் அனுமதித்து, பின் செயல்படுத்தப்படும்.',
    person: 'நபர் (அவரது உள்நுழைவு அடையாளம்)', role: 'பங்கு', stores: 'கடைகள் (அடையாளங்கள், காற்புள்ளியுடன்; அல்லது "all")', reason: 'ஏன்',
    give: 'இந்தப் பங்கைக் கேள்', approve: 'அனுமதி', reject: 'மறு', takeBack: 'திரும்பப் பெறு', leaver: 'அவர் வெளியேறிவிட்டார்',
    apply: 'இப்போது செயல்படுத்து', reload: 'தலைமை அலுவலகத்திலிருந்து மீண்டும் படி', limit: 'வரம்பிடக் கேள்',
    dimension: 'வரம்பு', values: 'எவை (அடையாளங்கள், காற்புள்ளியுடன்; வரம்பை நீக்க "all")',
    departments: 'துறைகள்', suppliers: 'சப்ளையர்கள்', categories: 'வகைகள்', locations: 'இடங்கள்',
    askedBy: 'கேட்டவர்', at: 'நேரம்', where: 'எங்கே', all: 'எல்லாக் கடைகளும்',
    nobodyHolds: 'இன்னும் யாரும் பங்கு வகிக்கவில்லை.', nothingPending: 'இரண்டாவது நபருக்காக எதுவும் காத்திருக்கவில்லை.', nothingMine: 'நீங்கள் இன்னும் எந்த மாற்றமும் கேட்கவில்லை.',
    yourOwn: 'இதை நீங்கள் கேட்டீர்கள், எனவே வேறொருவர் முடிவு செய்வார்.',
    scopeLabel: 'எல்லை', mayLabel: 'செய்யலாம்', mustNotLabel: 'செய்யக்கூடாது', limitedBy: 'குறுக்குவது', wordsLabel: 'இதில் இருக்கும் அனுமதிகள்', withheldLabel: 'வேண்டுமென்றே விடப்பட்டவை', questionsLabel: 'உரிமையாளர் முடிவு செய்ய வேண்டியவை',
    statusWaiting: 'உரிமையாளருக்காகக் காத்திருக்கிறது', statusApproved: 'அனுமதிக்கப்பட்டது — இப்போது செயல்படுத்துங்கள்', statusRejected: 'மறுக்கப்பட்டது', statusExpired: 'அனுமதி காலாவதியானது — மீண்டும் கேளுங்கள்', statusUsed: 'முடிந்தது',
    kind_access_change: 'பங்கைத் திரும்பப் பெறுதல் / வெளியேறுதல்', kind_department_scope_change: 'துறைகளுக்கு வரம்பிடு', kind_role_scope_change: 'சப்ளையர்கள், வகைகள் அல்லது இடங்களுக்கு வரம்பிடு',
    asked: 'கேட்கப்பட்டது. உரிமையாளர் ஒப்புதல்கள் பக்கத்தில் அனுமதிப்பார்; பின் இங்கே “இப்போது செயல்படுத்து” அழுத்துங்கள்.',
    given: 'கேட்கப்பட்டது. உரிமையாளர் அனுமதித்ததும் வழங்கப்படும்.', approved: 'அனுமதிக்கப்பட்டது — பங்கு வழங்கப்பட்டது.', rejected: 'மறுக்கப்பட்டது.', applied: 'முடிந்தது — பதிவு செய்யப்பட்டது.',
    blocked: 'தலைமை அலுவலகம் இதைச் செயல்படுத்தவில்லை:',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை, எனவே இங்கே எதுவும் செய்ய முடியாது.',
    cannotRead: 'யார் எந்தப் பங்கை வகிக்கிறார் என்று உங்கள் பங்கு பார்க்க முடியாது.', cannotAsk: 'உங்கள் பங்கு பங்கு மாற்றத்தைக் கேட்க முடியாது.', cannotDecide: 'உரிமையாளர் மட்டுமே ஒரு பங்கை அனுமதிக்கிறார்.',
    needPerson: 'நபரின் உள்நுழைவு அடையாளத்தைத் தட்டச்சு செய்யுங்கள்.', needRole: 'ஒரு பங்கைத் தேர்ந்தெடுங்கள்.', needStores: 'கடைகளைக் குறிப்பிடுங்கள், அல்லது "all" எனத் தட்டச்சு செய்யுங்கள்.', needReason: 'ஏன் என்று சொல்லுங்கள்.',
    yourself: 'யாரும் தன் சொந்த அணுகலுக்கு மாற்றம் கேட்பதில்லை. வேறொருவரிடம் கேளுங்கள்.',
    waitingRole: 'அந்தப் பங்கு உரிமையாளரின் ஒப்புதலுக்காகக் காத்திருக்கிறது (OB-615) — இன்னும் யாருக்கும் வழங்க முடியாது.',
    onlyRole: 'இது அவரது ஒரே பங்கு. அதைத் திரும்பப் பெறுவது என்றால் அவர் வெளியேறிவிட்டார் — “அவர் வெளியேறிவிட்டார்” பயன்படுத்துங்கள்.',
    needValues: 'அடையாளங்களைக் குறிப்பிடுங்கள், அல்லது வரம்பை நீக்க "all" எனத் தட்டச்சு செய்யுங்கள்.', notReady: 'அந்த மாற்றம் இன்னும் அனுமதிக்கப்படவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, அனுப்பப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
    signInsH: 'உள்நுழைவுகள்', signInsLead: 'புதிய நபருக்கு அவருக்கே உரிய உள்நுழைவைக் கொடுங்கள் (ஒருவருக்கு ஒன்று). அவர் என்ன செய்யலாம் என்பது மேலே கேட்கப்பட்டு உரிமையாளரால் அனுமதிக்கப்படுகிறது.',
    pinNeeded: 'உறுதிசெய்ய உங்கள் சொந்த PIN-ஐ மீண்டும் உள்ளிடுங்கள். எதுவும் மாற்றப்படவில்லை.',
    pinAskGive: 'இந்தப் பங்கைக் கேட்க உங்கள் சொந்த PIN-ஐ மீண்டும் உள்ளிடுங்கள்.', pinAskApprove: 'இந்தப் பங்கை அனுமதிக்க உங்கள் சொந்த PIN-ஐ மீண்டும் உள்ளிடுங்கள்.',
    pinAskReject: 'இந்தக் கோரிக்கையை மறுக்க உங்கள் சொந்த PIN-ஐ மீண்டும் உள்ளிடுங்கள்.', pinAskAdd: 'இந்த நபரைச் சேர்க்க உங்கள் சொந்த PIN-ஐ மீண்டும் உள்ளிடுங்கள்.',
    addH: 'இந்தக் கடைக் கணினியில் ஒரு நபரைச் சேர்', addLead: 'புதிய பணியாளர், இந்தக் கடைக் கணினிக்கும் அதன் கவுண்டர்களுக்கும் மட்டும் (அலுவலக அல்லது கைபேசி உள்நுழைவு இல்லை). பெயரைச் சேர்ப்பது அவருக்கு எதையும் தராது: பிறகு அவருக்குப் பங்கு கேளுங்கள் (இரண்டாவது நபர் அனுமதிப்பார்), அவரது PIN-ஐ அமையுங்கள்.',
    addName: 'அவரது முழுப் பெயர்', addStaffId: 'அவரது பணியாளர் எண் (a–z, 0–9, . _ -)', addBtn: 'இந்த நபரைச் சேர்', added: 'சேர்க்கப்பட்டார் — இந்தக் கடைக் கணினிக்கு மட்டும். இப்போது அவருக்குப் பங்கு கேளுங்கள்.',
    needName: 'நபரின் முழுப் பெயரைத் தட்டச்சு செய்யுங்கள்.', needStaffId: 'அவரது பணியாளர் எண்ணைத் தட்டச்சு செய்யுங்கள்: a–z, 0–9, . _ - இல் 3 முதல் 64',
    storePcOnly: 'இந்தக் கடைக் கணினியில், ஒவ்வொன்றும் உங்கள் PIN-உடன்: நபரைச் சேர்த்தல், பங்கு கேட்டல், அனுமதித்தல் அல்லது மறுத்தல், பங்கைத் திரும்பப் பெறுதல் அல்லது வெளியேறியவரைப் பதிதல் (இரண்டாவது நபர் அனுமதிப்பார்), PIN அமைத்தல், மாற்றுதல், ரத்து செய்தல். பங்கை வரம்பிட தலைமை அலுவலக இணைப்பு தேவை.',
    takeBacksH: 'இரண்டாவது நபருக்காகக் காத்திருக்கும் திரும்பப் பெறுதல்கள்', takeBacksLead: 'திரும்பப் பெறப்படும் பங்கு, அல்லது வெளியேறிய நபர். இரண்டாவது நபர் தன் PIN-உடன் அனுமதித்ததும் உடனே நடக்கும்; வெளியேறியவரின் PIN வேலை செய்யாது.',
    nothingTakeBack: 'எந்தத் திரும்பப் பெறுதலும் காத்திருக்கவில்லை.', yourTakeBack: 'இதை நீங்கள் கேட்டீர்கள், எனவே வேறொருவர் முடிவு செய்வார்.',
    takeBackAsked: 'கேட்கப்பட்டது. இரண்டாவது நபர் இங்கே தன் PIN-உடன் அனுமதிப்பார்; பிறகு உடனே நடக்கும்.', takeBackDone: 'அனுமதிக்கப்பட்டு முடிந்தது.', takeBackRejected: 'மறுக்கப்பட்டது — யாருடைய அணுகலும் மாறவில்லை.',
    pinsH: 'PIN-கள்', pinsLead: 'ஒரு பணியாளருக்குப் புதிய PIN அமையுங்கள் (அவரே இருமுறை, மறைவாகத் தட்டச்சு செய்வார்), ஒரு PIN-ஐ ரத்து செய்யுங்கள், அல்லது உங்களுடையதை மாற்றுங்கள். உங்களைவிட அதிக அதிகாரம் இல்லாதவர்களுக்கு மட்டுமே இதைச் செய்யலாம்.',
    pinStaff: 'பணியாளர் எண்', pinSetBtn: 'புதிய PIN அமை', pinCancelBtn: 'அவரது PIN-ஐ ரத்து செய்', pinOwnBtn: 'என் PIN-ஐ மாற்று',
    pinSetDone: 'புதிய PIN அமைக்கப்பட்டது. இது இப்போது வேலை செய்யும்; பழையது நின்றுவிட்டது.', pinCancelDone: 'PIN ரத்து செய்யப்பட்டது. புதியது அமைக்கப்படும் வரை அவர் உள்நுழைய முடியாது.', pinOwnDone: 'உங்கள் PIN மாற்றப்பட்டது. இனி புதியதைப் பயன்படுத்துங்கள்.',
    pinAskTakeBack: 'இதைக் கேட்க உங்கள் சொந்த PIN-ஐ மீண்டும் உள்ளிடுங்கள்.', pinAskSet: 'இந்த நபருக்குப் புதிய PIN அனுமதிக்க உங்கள் சொந்த PIN-ஐ உள்ளிடுங்கள்.', pinAskCancel: 'அவரது PIN-ஐ ரத்து செய்ய உங்கள் சொந்த PIN-ஐ மீண்டும் உள்ளிடுங்கள்.',
    pinAskCurrent: 'உங்கள் தற்போதைய PIN-ஐ உள்ளிடுங்கள்.', pinAskNew: 'விசைப்பலகையைக் கொடுங்கள். அந்த நபர் தன் புதிய 6 இலக்க PIN-ஐத் தட்டச்சு செய்வார்.', pinAskNewAgain: 'அதே புதிய PIN-ஐ மீண்டும் உள்ளிடுங்கள்.',
    newPinMismatch: 'புதிய PIN 6 இலக்கங்களாக, இருமுறை ஒரே மாதிரி இருக்க வேண்டும். எதுவும் மாற்றப்படவில்லை.', needStaffIdPin: 'பணியாளர் எண்ணைத் தட்டச்சு செய்யுங்கள்.',
    notOnStorePc: 'இந்தக் கடைக் கணினியில் இன்னும் இல்லை. எதுவும் மாற்றப்படவில்லை.',
    pinOk: 'உறுதிசெய்', pinCancel: 'ரத்து',
  },
} as const;

export type UsersCopyKey = keyof typeof USERS_COPY.en;
export const usersWords = (lang: Lang, key: string): string =>
  (USERS_COPY[lang] as Record<string, string>)[key] ?? (USERS_COPY.en as Record<string, string>)[key] ?? key;

type Why = 'nobody' | 'cannotRead' | 'cannotAsk' | 'cannotDecide' | 'needPerson' | 'needRole' | 'needStores' | 'needReason'
  | 'yourself' | 'waitingRole' | 'onlyRole' | 'needValues' | 'notReady' | 'pinNeeded' | 'needName' | 'needStaffId' | 'notOnStorePc'
  | 'newPinMismatch' | 'needStaffIdPin';
type Done<T> = Promise<Outcome<T, Why>>;
export const usersOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => usersWords(lang, k), out);

/** A live role from the catalogue. */
export interface RoleRow { readonly id: string; readonly name: string; /** U3 (OB-699): the role's name in Tamil, as head office carries it. */ readonly nameTa?: string; readonly permissions: readonly string[] }
/** A role waiting for the owner's approval (OB-615), as head office lists it. */
export interface WaitingRole extends RoleRow {
  readonly roadmap: { readonly scope: string; readonly may: string; readonly mustNot: string };
  readonly limitedBy: readonly string[];
  readonly words: readonly { readonly permission: string; readonly why: string }[];
  readonly withheld: readonly { readonly permission: string; readonly why: string }[];
  readonly questions: readonly string[];
}
export type Scope = readonly string[] | 'all';
export interface Grant { readonly userId: string; readonly roleId: string; readonly branchScope: Scope }
export interface Holder { readonly userId: string; readonly grants: readonly Grant[] }
export interface PendingGrant extends Grant { readonly grantId: string; readonly requestedBy: string; readonly requestedAt: string; readonly reason: string; readonly mine: boolean }
export type RequestStatus = 'waiting' | 'approved' | 'rejected' | 'expired' | 'used';
export const CHANGE_KINDS = ['access_change', 'department_scope_change', 'role_scope_change'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export interface MyChange { readonly requestId: string; readonly kind: ChangeKind; readonly subjectRef: string; readonly summary: string; readonly status: RequestStatus; readonly details: Readonly<Record<string, unknown>>; readonly requestedAt: string }
export const LIMIT_DIMENSIONS = ['departments', 'suppliers', 'categories', 'locations'] as const;
export type LimitDimension = (typeof LIMIT_DIMENSIONS)[number];

export interface UsersSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly ask: boolean; readonly decide: boolean };
  readonly userId: string | null;
  roles(): Done<{ readonly live: readonly RoleRow[]; readonly waiting: readonly WaitingRole[] }>;
  holders(): Done<readonly Holder[]>;
  pending(): Done<readonly PendingGrant[]>;
  mine(): Done<readonly MyChange[]>;
  give(input: { readonly userId: string; readonly roleId: string; readonly stores: string; readonly reason: string }, waiting: readonly string[]): Done<{ readonly grantId: string }>;
  decide(grantId: string, decision: 'approve' | 'reject', reason: string): Done<{ readonly decided: 'approved' | 'rejected' }>;
  /** Ask to take one grant back (a mover keeping the rest), or — `leaver` — for the person's leaving. */
  askTakeBack(holder: Holder, grant: Grant | 'leaver', reason: string): Done<{ readonly requestId: string }>;
  askLimit(input: { readonly userId: string; readonly roleId: string; readonly dimension: LimitDimension; readonly values: string; readonly reason: string }): Done<{ readonly requestId: string }>;
  /** Apply an approved change of mine, with exactly the details that were approved. */
  apply(change: MyChange): Done<{ readonly applied: true; readonly blockers?: readonly string[] }>;
  /** CR-01 step 4b-1: true on the store PC with the head-office link off — the page offers only what works there. */
  readonly onStorePc: boolean;
  /** CR-01 step 4b-1 (OB-733 "A"): add a store-PC person — their name and staff id, by the asker's PIN. Store PC only. */
  addPerson(input: { readonly userId: string; readonly displayName: string }): Done<{ readonly userId: string }>;
  /** CR-01 step 4b-2 (OB-735): the take-backs waiting for a second person, and the viewer's own. Store PC only. */
  takeBacks(): Done<readonly TakeBackRow[]>;
  /** CR-01 step 4b-2 (OB-735): approve (done at once) or reject a take-back, by PIN, with a reason. Store PC only. */
  decideTakeBack(approvalId: string, decision: 'approve' | 'reject', reason: string): Done<{ readonly decided: 'approved' | 'rejected'; readonly words: string }>;
  /** CR-01 step 4b-2 (OB-734 · OB-737): set or cancel somebody's till PIN, or change your own. Store PC only. */
  tillPin(action: 'set' | 'cancel' | 'own', staffId: string): Done<{ readonly done: 'set' | 'cancel' | 'own' }>;
}

/** A take-back on the store PC, as head office lists it for the person at the screen. */
export interface TakeBackRow {
  readonly approvalId: string; readonly userId: string; readonly event: 'mover' | 'leaver'; readonly summary: string; readonly reason: string;
  readonly requestedBy: string; readonly requestedAt: string; readonly status: RequestStatus; readonly mine: boolean;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const scopeOf = (v: unknown): Scope | undefined => (v === 'all' ? 'all' : Array.isArray(v) && v.every(isStr) ? v : undefined);
/** "all", or a comma list of ids (blank pieces dropped); undefined when nothing readable was typed. */
export function readIds(raw: string): Scope | undefined {
  const t = raw.trim();
  if (t.toLowerCase() === 'all') return 'all';
  const ids = [...new Set(t.split(',').map((x) => x.trim()).filter((x) => x !== ''))].sort();
  return ids.length === 0 ? undefined : ids;
}
const sameScope = (a: Scope, b: Scope): boolean => (a === 'all' || b === 'all' ? a === b : [...a].sort().join(',') === [...b].sort().join(','));
export const sameGrant = (a: Grant, b: Grant): boolean => a.userId === b.userId && a.roleId === b.roleId && sameScope(a.branchScope, b.branchScope);

/** The path an approved change is applied at, and the body: exactly the approved details without the ids in the path. */
export function applyCall(change: MyChange): { readonly path: string; readonly body: Record<string, unknown> } | undefined {
  const d = { ...change.details };
  const enc = encodeURIComponent;
  if (change.kind === 'access_change' && isStr(d['requestId'])) {
    const id = d['requestId']; delete d['requestId'];
    return { path: `/v1/access/lifecycle/${enc(id)}`, body: d };
  }
  if (change.kind === 'department_scope_change' && isStr(d['userId']) && isStr(d['roleId'])) {
    const u = d['userId']; const r = d['roleId']; delete d['userId']; delete d['roleId'];
    return { path: `/v1/identity/department-scopes/${enc(u)}/${enc(r)}`, body: d };
  }
  if (change.kind === 'role_scope_change' && isStr(d['userId']) && isStr(d['roleId']) && isStr(d['dimension'])) {
    const u = d['userId']; const r = d['roleId']; const dim = d['dimension']; delete d['userId']; delete d['roleId']; delete d['dimension'];
    return { path: `/v1/identity/role-scopes/${enc(u)}/${enc(r)}/${enc(dim)}`, body: d };
  }
  return undefined;
}

/**
 * CR-01 step 4a (OI-06 · ADR-0033 · OB-731 "A"): the page served by the store PC with the head-office link OFF. Asking for a
 * role and approving one go to the store PC's own privilege doors, the person's PIN asked again for each act (`askPin`;
 * null = they cancelled). The PIN goes to the store PC in that one request and is kept nowhere on the page.
 */
export interface OfficePrivilege {
  /** The store PC's door for asking for a role (`/office/privilege/grants`). */
  readonly grants: string;
  /** The door for approving one, with `{grantId}` in it (`/office/privilege/grants/{grantId}/approve`). */
  readonly approve: string;
  /** CR-01 step 4b-1: turning one down (`/office/privilege/grants/{grantId}/reject`), adding a person, and the lists. */
  readonly reject: string;
  readonly people: string;
  readonly view: string;
  /** CR-01 step 4b-2: asking for a take-back, deciding one (`{approvalId}` in it), and till PINs. */
  readonly accessChanges: string;
  readonly decide: string;
  readonly tillPins: string;
  readonly askPin: (what: PinAsk) => Promise<string | null>;
}
/** What the PIN box asks for. `newPin` / `newPinAgain` are the person's NEW till PIN, typed by them, twice. */
export type PinAsk = 'give' | 'approve' | 'reject' | 'add' | 'takeBack' | 'pinSet' | 'pinCancel' | 'pinCurrent' | 'newPin' | 'newPinAgain';

/** The store PC's doors from the page's injected global (`window.sreOfficePrivilege`), or undefined. */
export function officePrivilegeFrom(raw: unknown, askPin: OfficePrivilege['askPin']): OfficePrivilege | undefined {
  if (!isObj(raw)) return undefined;
  const doors = ['grants', 'approve', 'reject', 'people', 'view', 'accessChanges', 'decide', 'tillPins'] as const;
  if (!doors.every((d) => isStr(raw[d]) && (raw[d] as string).startsWith('/office/'))) return undefined;
  if (!(raw['approve'] as string).includes('{grantId}') || !(raw['reject'] as string).includes('{grantId}') || !(raw['decide'] as string).includes('{approvalId}')) return undefined;
  const d = (k: (typeof doors)[number]): string => raw[k] as string;
  return { grants: d('grants'), approve: d('approve'), reject: d('reject'), people: d('people'), view: d('view'), accessChanges: d('accessChanges'), decide: d('decide'), tillPins: d('tillPins'), askPin };
}

export function createUsersSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly newId?: (prefix: string) => string;
  /** CR-01 step 4a: present on the store PC with the head-office link off — give and approve go through its doors, by PIN. */
  readonly office?: OfficePrivilege;
}): UsersSession {
  const userId = input.viewer?.userId ?? null;
  const named = userId !== null;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('identity.role.read'), ask: named && held.has('identity.role.request'), decide: named && held.has('identity.role.grant') };
  const call = makeCaller({ keyPrefix: 'users', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const id = input.newId ?? newId;
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  /** One privilege act through the store PC's door: its answer in its own words (English; head office's sentence kept). */
  const viaStorePc = async (path: string, body: unknown): Promise<Outcome<Record<string, unknown>, never>> => {
    try {
      const res = await http(path, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || json['ok'] !== true) {
        const code = isStr(json['code']) ? json['code'] : isStr(json['refusedBecause']) ? json['refusedBecause'] : String(res.status);
        return { result: 'refused', status: res.status, code, whatHappened: isStr(json['en']) ? json['en'] : `status ${res.status}` };
      }
      return { result: 'ok', value: json };
    } catch { return { result: 'lost_link' }; }
  };
  /** CR-01 step 4b-1: the page's lists through the store PC (head office answers for the signed-in person, this store only). */
  const officeView = async (): Promise<Outcome<Record<string, unknown>, never>> => {
    try {
      const res = await http(input.office!.view, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || json['ok'] !== true) {
        const code = isStr(json['code']) ? json['code'] : isStr(json['refusedBecause']) ? json['refusedBecause'] : String(res.status);
        return { result: 'refused', status: res.status, code, whatHappened: isStr(json['en']) ? json['en'] : `status ${res.status}` };
      }
      return { result: 'ok', value: json };
    } catch { return { result: 'lost_link' }; }
  };
  const onStorePc = input.office !== undefined;
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'ask' | 'decide'): { result: 'invalid'; why: Why } | undefined =>
    !named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : need === 'ask' ? 'cannotAsk' : 'cannotDecide') : undefined;
  const askApproval = async (kind: ChangeKind, subjectRef: string, details: Record<string, unknown>, summary: string, reason: string): Done<{ readonly requestId: string }> => {
    const out = await call<{ requestId?: unknown }>('POST', '/v1/approvals/requests', { kind, subjectRef, details, valueMinor: null, summary, reason });
    if (out.result !== 'ok') return out;
    return isStr(out.value.requestId) ? { result: 'ok', value: { requestId: out.value.requestId } } : { result: 'lost_link' };
  };

  return {
    may, userId, onStorePc,
    takeBacks: async () => {
      const g = !named ? no('nobody') : !may.ask && !may.decide ? no('cannotAsk') : undefined; if (g) return g;
      if (!onStorePc) return no('notOnStorePc');
      const out = await officeView();
      if (out.result !== 'ok') return out;
      const rows = (Array.isArray(out.value['accessChanges']) ? out.value['accessChanges'] : []).flatMap((r): TakeBackRow[] => {
        if (!isObj(r) || !isStr(r['approvalId']) || !isStr(r['userId']) || (r['event'] !== 'mover' && r['event'] !== 'leaver')) return [];
        const status = (['waiting', 'approved', 'rejected', 'expired', 'used'] as const).find((x) => x === r['status']) ?? 'waiting';
        return [{ approvalId: r['approvalId'], userId: r['userId'], event: r['event'], summary: isStr(r['summary']) ? r['summary'] : '', reason: isStr(r['reason']) ? r['reason'] : '',
          requestedBy: isStr(r['requestedBy']) ? r['requestedBy'] : '', requestedAt: isStr(r['requestedAt']) ? r['requestedAt'] : '', status, mine: r['requestedBy'] === userId }];
      });
      return { result: 'ok', value: rows };
    },
    decideTakeBack: async (approvalId, decision, reason) => {
      const g = gate('decide'); if (g) return g;
      if (input.office === undefined) return no('notOnStorePc');
      if (reason.trim() === '') return no('needReason');
      const pin = await input.office.askPin(decision);
      if (pin === null || pin.trim() === '') return no('pinNeeded');
      const out = await viaStorePc(input.office.decide.replace('{approvalId}', encodeURIComponent(approvalId)), { pin, request: { decision: decision === 'approve' ? 'approved' : 'rejected', reason: reason.trim() } });
      return out.result === 'ok' ? { result: 'ok', value: { decided: decision === 'approve' ? 'approved' : 'rejected', words: isStr(out.value['en']) ? out.value['en'] : '' } } : out;
    },
    tillPin: async (action, staffId) => {
      if (!named) return no('nobody');
      if (input.office === undefined) return no('notOnStorePc');
      const who = action === 'own' ? userId! : staffId.trim().toLowerCase();
      if (action !== 'own') {
        if (!may.ask) return no('cannotAsk');
        if (who === '') return no('needStaffIdPin');
        if (who === userId) return no('yourself');
      }
      const pin = await input.office.askPin(action === 'own' ? 'pinCurrent' : action === 'set' ? 'pinSet' : 'pinCancel');
      if (pin === null || pin.trim() === '') return no('pinNeeded');
      let newPin: string | undefined; let newPinAgain: string | undefined;
      if (action !== 'cancel') {
        newPin = (await input.office.askPin('newPin')) ?? '';
        if (!/^[0-9]{6}$/.test(newPin)) return no('newPinMismatch');
        newPinAgain = (await input.office.askPin('newPinAgain')) ?? '';
        if (newPinAgain !== newPin) return no('newPinMismatch');
      }
      const out = await viaStorePc(input.office.tillPins, { pin, request: { action, ...(action === 'own' ? {} : { userId: who }), ...(newPin === undefined ? {} : { newPin, newPinAgain }) } });
      return out.result === 'ok' ? { result: 'ok', value: { done: action } } : out;
    },
    addPerson: async (p) => {
      const g = gate('ask'); if (g) return g;
      if (input.office === undefined) return no('notOnStorePc');
      const name = p.displayName.trim().replace(/\s+/g, ' '); const staffId = p.userId.trim().toLowerCase();
      if (name === '') return no('needName');
      if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(staffId)) return no('needStaffId');
      if (staffId === userId) return no('yourself');
      const pin = await input.office.askPin('add');
      if (pin === null || pin.trim() === '') return no('pinNeeded');
      const out = await viaStorePc(input.office.people, { pin, request: { userId: staffId, displayName: name } });
      return out.result === 'ok' ? { result: 'ok', value: { userId: staffId } } : out;
    },
    roles: async () => {
      // The owner reads the catalogue (identity.role.read); a maker (the store manager) reads it with who holds what.
      const g = !named ? no('nobody') : !may.read && !may.ask ? no('cannotRead') : undefined; if (g) return g;
      const out = onStorePc ? await officeView() as Outcome<{ roles?: unknown[]; awaitingOwnerApproval?: unknown[] }, never>
        : await call<{ roles?: unknown[]; awaitingOwnerApproval?: unknown[] }>('GET', may.read ? '/v1/identity/roles' : '/v1/identity/grants');
      if (out.result !== 'ok') return out;
      const row = (r: unknown): RoleRow | undefined => (isObj(r) && isStr(r['id']) && isStr(r['name']) && Array.isArray(r['permissions'])
        ? { id: r['id'], name: r['name'], ...(isStr(r['nameTa']) ? { nameTa: r['nameTa'] } : {}), permissions: (r['permissions'] as unknown[]).filter(isStr) } : undefined);
      const live = (out.value.roles ?? []).map(row).filter((r): r is RoleRow => r !== undefined);
      const waiting = (out.value.awaitingOwnerApproval ?? []).flatMap((r): WaitingRole[] => {
        const base = row(r);
        if (base === undefined || !isObj(r) || !isObj(r['roadmap'])) return [];
        const pairs = (v: unknown) => (Array.isArray(v) ? v : []).filter((w): w is { permission: string; why: string } => isObj(w) && isStr(w['permission']) && isStr(w['why']));
        const rm = r['roadmap'];
        return [{ ...base, roadmap: { scope: String(rm['scope'] ?? ''), may: String(rm['may'] ?? ''), mustNot: String(rm['mustNot'] ?? '') },
          limitedBy: (Array.isArray(r['limitedBy']) ? r['limitedBy'] : []).filter(isStr), words: pairs(r['words']), withheld: pairs(r['withheld']),
          questions: (Array.isArray(r['questions']) ? r['questions'] : []).filter(isStr) }];
      });
      return { result: 'ok', value: { live, waiting } };
    },
    holders: async () => {
      const g = gate('ask'); if (g) return g;
      const out = onStorePc ? await officeView() as Outcome<{ grants?: unknown[] }, never> : await call<{ grants?: unknown[] }>('GET', '/v1/identity/grants');
      if (out.result !== 'ok') return out;
      const by = new Map<string, Grant[]>();
      for (const raw of out.value.grants ?? []) {
        if (!isObj(raw) || !isStr(raw['userId']) || !isStr(raw['roleId'])) continue;
        const scope = scopeOf(raw['branchScope']); if (scope === undefined) continue;
        by.set(raw['userId'], [...(by.get(raw['userId']) ?? []), { userId: raw['userId'], roleId: raw['roleId'], branchScope: scope }]);
      }
      return { result: 'ok', value: [...by].sort(([a], [b]) => a.localeCompare(b)).map(([u, grants]) => ({ userId: u, grants })) };
    },
    pending: async () => {
      const g = gate('read'); if (g) return g;
      const out = onStorePc ? await officeView() as Outcome<{ pending?: unknown[] }, never> : await call<{ requests?: unknown[] }>('GET', '/v1/identity/grants/pending');
      if (out.result !== 'ok') return out;
      const listed = 'pending' in out.value ? out.value.pending : (out.value as { requests?: unknown[] }).requests;
      const rows = (listed ?? []).flatMap((r): PendingGrant[] => {
        if (!isObj(r) || !isStr(r['grantId']) || !isStr(r['userId']) || !isStr(r['roleId']) || !isStr(r['requestedBy'])) return [];
        const scope = scopeOf(r['branchScope']); if (scope === undefined) return [];
        return [{ grantId: r['grantId'], userId: r['userId'], roleId: r['roleId'], branchScope: scope, requestedBy: r['requestedBy'],
          requestedAt: isStr(r['requestedAt']) ? r['requestedAt'] : '', reason: isStr(r['reason']) ? r['reason'] : '', mine: r['requestedBy'] === userId }];
      });
      return { result: 'ok', value: rows };
    },
    mine: async () => {
      const g = gate('ask'); if (g) return g;
      if (onStorePc) return no('notOnStorePc'); // the approvals engine is head office's; take-backs on the store PC come in 4b-2
      const out = await call<{ mine?: unknown[] }>('GET', '/v1/approvals/requests');
      if (out.result !== 'ok') return out;
      const rows = (out.value.mine ?? []).flatMap((r): MyChange[] => {
        if (!isObj(r) || !isStr(r['requestId']) || !(CHANGE_KINDS as readonly string[]).includes(String(r['kind'])) || !isObj(r['details'])) return [];
        const status = (['waiting', 'approved', 'rejected', 'expired', 'used'] as const).find((s) => s === r['status']) ?? 'waiting';
        return [{ requestId: r['requestId'], kind: r['kind'] as ChangeKind, subjectRef: isStr(r['subjectRef']) ? r['subjectRef'] : '', summary: isStr(r['summary']) ? r['summary'] : '',
          status, details: r['details'], requestedAt: isStr(r['requestedAt']) ? r['requestedAt'] : '' }];
      });
      rows.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
      return { result: 'ok', value: rows };
    },
    give: async (g0, waiting) => {
      const g = gate('ask'); if (g) return g;
      const person = g0.userId.trim(); const stores = readIds(g0.stores);
      if (person === '') return no('needPerson');
      if (person === userId) return no('yourself');
      if (g0.roleId.trim() === '') return no('needRole');
      if (waiting.includes(g0.roleId.trim())) return no('waitingRole');
      if (stores === undefined) return no('needStores');
      if (g0.reason.trim() === '') return no('needReason');
      const grantId = id('grant');
      const request = { grantId, userId: person, roleId: g0.roleId.trim(), branchScope: stores, reason: g0.reason.trim() };
      if (input.office !== undefined) {
        const pin = await input.office.askPin('give');
        if (pin === null || pin.trim() === '') return no('pinNeeded');
        const out = await viaStorePc(input.office.grants, { pin, request });
        return out.result === 'ok' ? { result: 'ok', value: { grantId } } : out;
      }
      const out = await call<{ grantId?: unknown }>('POST', '/v1/identity/grants', request);
      return out.result === 'ok' ? { result: 'ok', value: { grantId } } : out;
    },
    decide: async (grantId, decision, reason) => {
      const g = gate('decide'); if (g) return g;
      if (decision === 'reject' && reason.trim() === '') return no('needReason');
      if (input.office !== undefined) {
        const pin = await input.office.askPin(decision);
        if (pin === null || pin.trim() === '') return no('pinNeeded');
        const door = (decision === 'reject' ? input.office.reject : input.office.approve).replace('{grantId}', encodeURIComponent(grantId));
        const out = await viaStorePc(door, decision === 'reject' ? { pin, request: { reason: reason.trim() } } : { pin });
        return out.result === 'ok' ? { result: 'ok', value: { decided: decision === 'approve' ? 'approved' : 'rejected' } } : out;
      }
      const out = await call('POST', `/v1/identity/grants/${encodeURIComponent(grantId)}/${decision}`, decision === 'reject' ? { reason: reason.trim() } : {});
      return out.result === 'ok' ? { result: 'ok', value: { decided: decision === 'approve' ? 'approved' : 'rejected' } } : out;
    },
    askTakeBack: async (holder, grant, reason) => {
      const g = gate('ask'); if (g) return g;
      if (holder.userId === userId) return no('yourself');
      if (reason.trim() === '') return no('needReason');
      const requestId = id('access');
      if (input.office !== undefined) {
        // CR-01 step 4b-2 (OB-735 "A"): through the store PC, by PIN — a second person approves it on this page.
        const rest = grant === 'leaver' ? [] : holder.grants.filter((x) => !sameGrant(x, grant));
        if (grant !== 'leaver' && rest.length === 0) return no('onlyRole');
        const pin = await input.office.askPin('takeBack');
        if (pin === null || pin.trim() === '') return no('pinNeeded');
        const request = { requestId, event: grant === 'leaver' ? 'leaver' : 'mover', userId: holder.userId, reason: reason.trim(), grants: rest.map((x) => ({ userId: x.userId, roleId: x.roleId, branchScope: x.branchScope })) };
        const out = await viaStorePc(input.office.accessChanges, { pin, request });
        return out.result === 'ok' ? { result: 'ok', value: { requestId } } : out;
      }
      if (grant === 'leaver') {
        const body = { event: 'leaver', userId: holder.userId, reason: reason.trim(), grants: [], ownedOpenItems: [] };
        return askApproval('access_change', requestId, { ...body, requestId }, `${holder.userId} has left: take back every role`, reason.trim());
      }
      const rest = holder.grants.filter((x) => !sameGrant(x, grant));
      if (rest.length === 0) return no('onlyRole');
      const body = { event: 'mover', userId: holder.userId, reason: reason.trim(), grants: rest.map((x) => ({ userId: x.userId, roleId: x.roleId, branchScope: x.branchScope })) };
      return askApproval('access_change', requestId, { ...body, requestId }, `Take the ${grant.roleId} role back from ${holder.userId}`, reason.trim());
    },
    askLimit: async (l) => {
      const g = gate('ask'); if (g) return g;
      if (onStorePc) return no('notOnStorePc');
      const person = l.userId.trim(); const values = readIds(l.values);
      if (person === '') return no('needPerson');
      if (person === userId) return no('yourself');
      if (l.roleId.trim() === '') return no('needRole');
      if (values === undefined) return no('needValues');
      if (l.reason.trim() === '') return no('needReason');
      const roleId = l.roleId.trim(); const reason = l.reason.trim();
      const said = values === 'all' ? 'lift the limit' : values.join(', ');
      if (l.dimension === 'departments') {
        return askApproval('department_scope_change', `${person}/${roleId}`, { departments: values, reason, userId: person, roleId }, `Limit ${person}'s ${roleId} role to departments: ${said}`, reason);
      }
      return askApproval('role_scope_change', `${person}/${roleId}/${l.dimension}`, { values, reason, userId: person, roleId, dimension: l.dimension }, `Limit ${person}'s ${roleId} role to ${l.dimension}: ${said}`, reason);
    },
    apply: async (change) => {
      const g = gate('ask'); if (g) return g;
      if (onStorePc) return no('notOnStorePc');
      if (change.status !== 'approved') return no('notReady');
      const c = applyCall(change);
      if (c === undefined) return no('notReady');
      const out = await call<{ applied?: unknown; blockers?: unknown }>('POST', c.path, { ...c.body, approvalId: change.requestId });
      if (out.result !== 'ok') return out;
      // A lifecycle change the engine BLOCKED records nothing — said, never shown as done.
      if (out.value.applied === false) return { result: 'refused', status: 200, code: 'blocked', whatHappened: (Array.isArray(out.value.blockers) ? out.value.blockers.filter(isStr) : []).join('; ') };
      return { result: 'ok', value: { applied: true } };
    },
  };
}
