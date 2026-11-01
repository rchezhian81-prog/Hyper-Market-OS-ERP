// Shelf and floor setup (Wave 2 · M04-FR-02/03/04 · SCREEN-GAP Round D): a THIN CLIENT over head office's shelf map,
// planograms and floor plan for one store. The registers are the shared office parts (window.sreOffice: summary cards,
// registers with a record drawer, states); every figure is head office's answer or "Not known". Each publish sends the
// WHOLE new version — head office numbers it, keeps the old one, and refuses an inconsistent one by name. Nothing is
// written on open. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const who = window.spaceSetupData && typeof window.spaceSetupData === 'object' ? window.spaceSetupData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayRead = named && perms.has('planogram.compliance.read');
const mayFloor = named && perms.has('merchandising.space.read');
const mayPublish = named && perms.has('planogram.publish');
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Shelf and floor setup',
    lead: 'Set up where things go in this store: the shelf places, what each shelf should hold (the planogram), and where each area sits on the floor. The Shelves and space page, "Which areas earn most" and "Shelves against the plan" all read what is published here. Every change is kept as a new version; nothing is overwritten.',
    store: 'Store', read: 'Read this store\'s setup',
    kPlaces: 'Shelf places', kMapV: 'Shelf map version', kPlans: 'Planograms', kInForce: 'Planogram in force today', kAreas: 'Floor areas', kStale: 'Planograms made on an older shelf map',
    nPlaces: 'places head office holds', nMapV: 'each change is a new version', nPlans: 'newest version of each', nInForce: 'the one shelves are checked against', nAreas: 'on the floor plan in force', nStale: 'publish them again to check them against today\'s map',
    none: 'None yet', noneInForce: 'None in force',
    mapH: '1. Shelf places', mapLead: 'Every place on a shelf, by aisle, rack, bay, shelf and position. A picker\'s route and the refill tasks follow these places.',
    cPlace: 'Shelf place', cAisle: 'Aisle', cRack: 'Rack', cBay: 'Bay', cShelf: 'Shelf', cPos: 'Position', cZone: 'Kept', cLabel: 'Name on the shelf',
    mapEmpty: 'No shelf places yet', mapEmptyDetail: 'Head office holds no shelf map for this store. Add the shelf places below; nothing on the shelf pages can be checked until then.',
    takeOff: 'Take this place off the shelf map', takenOff: 'Taken off. Head office kept the earlier version.',
    addH: 'Add shelf places', addLead: 'One bay at a time: its shelves are numbered from the bottom (1) up, and the places along each shelf from the left (1). Each place gets a code like A3-R1-B2-S1-P1.',
    aisle: 'Aisle', rack: 'Rack', bay: 'Bay', shelves: 'Shelves in the bay', positions: 'Places on each shelf', zone: 'Kept', label: 'Name on the shelf (optional)',
    ambient: 'Ambient', chilled: 'Chilled', frozen: 'Frozen', secure: 'Locked case', addGo: 'Add these places to the shelf map',
    added: 'Added {n} place(s). Shelf map version {v} is now in force.', allThere: 'Every one of those places is already on the shelf map. Nothing was sent.', needBay: 'Write the aisle, rack and bay as whole numbers from 1. Nothing was sent.',
    planH: '2. Planograms — what goes on each shelf', planLead: 'A planogram says which product sits on which shelf place and how many the place holds. A change is a new version from the date you choose; the one in force today is what the shelves are checked against.',
    cPlan: 'Planogram', cVersion: 'Version', cFrom: 'In force from', cFacings: 'Facings', cState: 'Where it stands', cMapV: 'Checked against shelf map',
    inForce: 'In force today', coming: 'Starts later', replaced: 'Not the one in force', stale: 'Made on an older shelf map',
    planEmpty: 'No planogram yet', planEmptyDetail: 'Head office holds no planogram for this store. Make one below once the shelf places are in.',
    editThis: 'Change this planogram (a new version)', versions: 'Versions kept', publishedBy: 'Published by', publishedAt: 'Published',
    editH: 'Make or change a planogram', gid: 'Planogram name (letters, numbers, dashes)', gfrom: 'In force from', fproduct: 'Product code', fplace: 'Shelf place', fcap: 'Holds (units)', fprimary: 'Its main place in this store',
    fAdd: 'Add this facing', remove: 'Remove', facing: '{product} on {place}, holds {cap}{primary}', primaryMark: ' — main place', noFacings: 'No facings yet. Add each product\'s shelf place above.',
    needFacing: 'Write the product code, choose its shelf place and how many it holds.', needPlan: 'Write the planogram name and the date it is in force from, and add at least one facing. Nothing was sent.',
    planGo: 'Publish this planogram', planSaved: 'Planogram {id} version {v} published (in force from {from}).', noPlaces: 'No shelf places yet',
    floorH: '3. Floor plan — where each area sits', floorLead: 'The shop floor seen from above, with the entrance at the bottom. Each area names the shelf places in it; its size gives the sales and margin per square foot on "Which areas earn most".',
    cArea: 'Area', cName: 'Name', cX: 'From the left wall (ft)', cY: 'From the entrance (ft)', cSize: 'Size (ft)', cSqft: 'Sq ft', cPlaces: 'Shelf places',
    floorEmpty: 'No floor plan yet', floorEmptyDetail: 'Head office holds no floor plan for this store. Write the shop\'s size and add each area below, then publish.',
    sizeH: 'The shop floor', flw: 'Width (feet, side to side)', fld: 'Depth (feet, entrance to back)', areaH: 'Add an area', areaLead: 'Areas may not overlap, must sit inside the floor, and each shelf place may be in one area only — head office checks.',
    aid: 'Area code', aname: 'Name', anameta: 'Name in Tamil (optional)', ax: 'Feet from the left wall', ay: 'Feet from the entrance', aw: 'Width (feet)', ad: 'Depth (feet)', aplaces: 'Shelf places in it (codes, separated by commas)', aAdd: 'Add this area',
    areaLine: '{name} — {w} × {d} ft at {x}, {y}; places: {places}', noAreas: 'No areas yet. Add them above.', needArea: 'Write the area code, its name, where it sits and its size. Nothing was added.', removeArea: 'Remove this area',
    floorGo: 'Publish the floor plan', floorSaved: 'Floor plan version {v} published with {n} area(s).', needFloor: 'Write the shop\'s width and depth and add at least one area. Nothing was sent.', fromPlan: 'This is the floor plan in force (version {v}). Change it and publish to make the next version.',
    needStore: 'Write the store first.', readOnly: 'You can read this store\'s setup. Publishing it is for the person who keeps the shelf plans.',
    noRight: 'This account may not read the shelf plans.', nobody: 'Nobody is signed in on this computer, so nothing can be shown.',
    refused: 'Head office refused:', unreachable: 'Head office could not be reached. Nothing was changed — try again.', notKnown: 'Not known',
  },
  ta: {
    lang: 'English', title: 'அலமாரி மற்றும் தள அமைப்பு',
    lead: 'இந்தக் கடையில் எது எங்கே என்பதை அமையுங்கள்: அலமாரி இடங்கள், ஒவ்வொரு அலமாரியிலும் எது இருக்க வேண்டும் (அலமாரித் திட்டம்), தளத்தில் ஒவ்வொரு பகுதியும் எங்கே. அடுக்குகளும் இடமும் பக்கம், "எந்தப் பகுதிகள் அதிகம் ஈட்டுகின்றன", "திட்டத்துடன் அலமாரிகள்" — இவை அனைத்தும் இங்கு வெளியிடப்பட்டதையே படிக்கின்றன. ஒவ்வொரு மாற்றமும் புதிய பதிப்பாக வைக்கப்படும்; எதுவும் மேலெழுதப்படாது.',
    store: 'கடை', read: 'இந்தக் கடையின் அமைப்பைப் படி',
    kPlaces: 'அலமாரி இடங்கள்', kMapV: 'அலமாரி வரைபடப் பதிப்பு', kPlans: 'அலமாரித் திட்டங்கள்', kInForce: 'இன்று நடைமுறையில் உள்ள திட்டம்', kAreas: 'தளப் பகுதிகள்', kStale: 'பழைய அலமாரி வரைபடத்தில் செய்த திட்டங்கள்',
    nPlaces: 'தலைமை அலுவலகம் வைத்துள்ள இடங்கள்', nMapV: 'ஒவ்வொரு மாற்றமும் புதிய பதிப்பு', nPlans: 'ஒவ்வொன்றின் புதிய பதிப்பு', nInForce: 'அலமாரிகள் இதனுடன் ஒப்பிடப்படுகின்றன', nAreas: 'நடைமுறைத் தளத் திட்டத்தில்', nStale: 'இன்றைய வரைபடத்துடன் சரிபார்க்க மீண்டும் வெளியிடுங்கள்',
    none: 'இன்னும் இல்லை', noneInForce: 'நடைமுறையில் எதுவும் இல்லை',
    mapH: '1. அலமாரி இடங்கள்', mapLead: 'வரிசை, ரேக், பகுதி, அலமாரி, நிலை வாரியாக ஒவ்வொரு அலமாரி இடமும். எடுப்பவரின் வழியும் நிரப்புதல் பணிகளும் இந்த இடங்களைப் பின்பற்றுகின்றன.',
    cPlace: 'அலமாரி இடம்', cAisle: 'வரிசை', cRack: 'ரேக்', cBay: 'பகுதி', cShelf: 'அலமாரி', cPos: 'நிலை', cZone: 'வைப்பு', cLabel: 'அலமாரியில் பெயர்',
    mapEmpty: 'இன்னும் அலமாரி இடங்கள் இல்லை', mapEmptyDetail: 'இந்தக் கடைக்குத் தலைமை அலுவலகத்திடம் அலமாரி வரைபடம் இல்லை. கீழே அலமாரி இடங்களைச் சேருங்கள்; அதுவரை அலமாரிப் பக்கங்களில் எதையும் சரிபார்க்க முடியாது.',
    takeOff: 'இந்த இடத்தை அலமாரி வரைபடத்திலிருந்து நீக்கு', takenOff: 'நீக்கப்பட்டது. தலைமை அலுவலகம் முந்தைய பதிப்பை வைத்துள்ளது.',
    addH: 'அலமாரி இடங்களைச் சேர்', addLead: 'ஒரு நேரத்தில் ஒரு பகுதி: அதன் அலமாரிகள் கீழிருந்து (1) மேல்நோக்கி எண்ணப்படும், ஒவ்வொரு அலமாரியிலும் இடங்கள் இடமிருந்து (1). ஒவ்வொரு இடத்துக்கும் A3-R1-B2-S1-P1 போன்ற குறியீடு கிடைக்கும்.',
    aisle: 'வரிசை', rack: 'ரேக்', bay: 'பகுதி', shelves: 'பகுதியில் உள்ள அலமாரிகள்', positions: 'ஒவ்வொரு அலமாரியிலும் இடங்கள்', zone: 'வைப்பு', label: 'அலமாரியில் பெயர் (விருப்பம்)',
    ambient: 'சாதாரண வெப்பநிலை', chilled: 'குளிர்ந்த', frozen: 'உறைந்த', secure: 'பூட்டிய பெட்டி', addGo: 'இந்த இடங்களை அலமாரி வரைபடத்தில் சேர்',
    added: '{n} இடம்(கள்) சேர்க்கப்பட்டன. அலமாரி வரைபடப் பதிப்பு {v} இப்போது நடைமுறையில்.', allThere: 'அந்த இடங்கள் அனைத்தும் ஏற்கனவே அலமாரி வரைபடத்தில் உள்ளன. எதுவும் அனுப்பப்படவில்லை.', needBay: 'வரிசை, ரேக், பகுதியை 1 முதல் முழு எண்களாக எழுதுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    planH: '2. அலமாரித் திட்டங்கள் — ஒவ்வொரு அலமாரியிலும் எது', planLead: 'எந்தப் பொருள் எந்த அலமாரி இடத்தில், அந்த இடம் எத்தனை வைக்கும் என்பதை அலமாரித் திட்டம் சொல்கிறது. மாற்றம் நீங்கள் தேர்ந்தெடுக்கும் தேதியிலிருந்து புதிய பதிப்பு; இன்று நடைமுறையில் உள்ளதுடன் அலமாரிகள் ஒப்பிடப்படுகின்றன.',
    cPlan: 'அலமாரித் திட்டம்', cVersion: 'பதிப்பு', cFrom: 'நடைமுறைக்கு வரும் தேதி', cFacings: 'இடங்கள்', cState: 'நிலை', cMapV: 'ஒப்பிட்ட அலமாரி வரைபடம்',
    inForce: 'இன்று நடைமுறையில்', coming: 'பின்னர் தொடங்கும்', replaced: 'நடைமுறையில் உள்ளது அல்ல', stale: 'பழைய அலமாரி வரைபடத்தில் செய்தது',
    planEmpty: 'இன்னும் அலமாரித் திட்டம் இல்லை', planEmptyDetail: 'இந்தக் கடைக்குத் தலைமை அலுவலகத்திடம் அலமாரித் திட்டம் இல்லை. அலமாரி இடங்கள் சேர்ந்ததும் கீழே ஒன்றைச் செய்யுங்கள்.',
    editThis: 'இந்தத் திட்டத்தை மாற்று (புதிய பதிப்பு)', versions: 'வைக்கப்பட்ட பதிப்புகள்', publishedBy: 'வெளியிட்டவர்', publishedAt: 'வெளியிட்டது',
    editH: 'அலமாரித் திட்டத்தைச் செய் அல்லது மாற்று', gid: 'திட்டப் பெயர் (எழுத்துகள், எண்கள், கோடுகள்)', gfrom: 'நடைமுறைக்கு வரும் தேதி', fproduct: 'பொருள் குறியீடு', fplace: 'அலமாரி இடம்', fcap: 'வைக்கும் அளவு (அலகுகள்)', fprimary: 'இந்தக் கடையில் இதன் முதன்மை இடம்',
    fAdd: 'இந்த இடத்தைச் சேர்', remove: 'நீக்கு', facing: '{place} இல் {product}, {cap} வைக்கும்{primary}', primaryMark: ' — முதன்மை இடம்', noFacings: 'இன்னும் இடங்கள் இல்லை. மேலே ஒவ்வொரு பொருளின் அலமாரி இடத்தையும் சேருங்கள்.',
    needFacing: 'பொருள் குறியீட்டை எழுதி, அதன் அலமாரி இடத்தையும் எத்தனை வைக்கும் என்பதையும் தேர்ந்தெடுங்கள்.', needPlan: 'திட்டப் பெயரையும் நடைமுறைக்கு வரும் தேதியையும் எழுதி, குறைந்தது ஒரு இடத்தைச் சேருங்கள். எதுவும் அனுப்பப்படவில்லை.',
    planGo: 'இந்தத் திட்டத்தை வெளியிடு', planSaved: 'திட்டம் {id} பதிப்பு {v} வெளியிடப்பட்டது ({from} முதல் நடைமுறை).', noPlaces: 'இன்னும் அலமாரி இடங்கள் இல்லை',
    floorH: '3. தளத் திட்டம் — ஒவ்வொரு பகுதியும் எங்கே', floorLead: 'மேலிருந்து பார்க்கும் கடைத் தளம், நுழைவாயில் கீழே. ஒவ்வொரு பகுதியும் அதிலுள்ள அலமாரி இடங்களைக் குறிக்கிறது; அதன் அளவு "எந்தப் பகுதிகள் அதிகம் ஈட்டுகின்றன" பக்கத்தில் சதுர அடிக்கு விற்பனையையும் லாபத்தையும் தருகிறது.',
    cArea: 'பகுதி', cName: 'பெயர்', cX: 'இடச் சுவரிலிருந்து (அடி)', cY: 'நுழைவாயிலிலிருந்து (அடி)', cSize: 'அளவு (அடி)', cSqft: 'சதுர அடி', cPlaces: 'அலமாரி இடங்கள்',
    floorEmpty: 'இன்னும் தளத் திட்டம் இல்லை', floorEmptyDetail: 'இந்தக் கடைக்குத் தலைமை அலுவலகத்திடம் தளத் திட்டம் இல்லை. கடையின் அளவை எழுதி, கீழே ஒவ்வொரு பகுதியையும் சேர்த்து வெளியிடுங்கள்.',
    sizeH: 'கடைத் தளம்', flw: 'அகலம் (அடி, பக்கத்திலிருந்து பக்கம்)', fld: 'ஆழம் (அடி, நுழைவாயிலிலிருந்து பின்புறம்)', areaH: 'ஒரு பகுதியைச் சேர்', areaLead: 'பகுதிகள் ஒன்றின் மேல் ஒன்று வரக்கூடாது, தளத்துக்குள் இருக்க வேண்டும், ஒவ்வொரு அலமாரி இடமும் ஒரு பகுதியில் மட்டும் — தலைமை அலுவலகம் சரிபார்க்கும்.',
    aid: 'பகுதிக் குறியீடு', aname: 'பெயர்', anameta: 'தமிழில் பெயர் (விருப்பம்)', ax: 'இடச் சுவரிலிருந்து அடி', ay: 'நுழைவாயிலிலிருந்து அடி', aw: 'அகலம் (அடி)', ad: 'ஆழம் (அடி)', aplaces: 'அதிலுள்ள அலமாரி இடங்கள் (குறியீடுகள், காற்புள்ளியால் பிரித்து)', aAdd: 'இந்தப் பகுதியைச் சேர்',
    areaLine: '{name} — {w} × {d} அடி, {x}, {y} இல்; இடங்கள்: {places}', noAreas: 'இன்னும் பகுதிகள் இல்லை. மேலே சேருங்கள்.', needArea: 'பகுதிக் குறியீடு, பெயர், இருப்பிடம், அளவை எழுதுங்கள். எதுவும் சேர்க்கப்படவில்லை.', removeArea: 'இந்தப் பகுதியை நீக்கு',
    floorGo: 'தளத் திட்டத்தை வெளியிடு', floorSaved: 'தளத் திட்டப் பதிப்பு {v}, {n} பகுதி(கள்) உடன் வெளியிடப்பட்டது.', needFloor: 'கடையின் அகலமும் ஆழமும் எழுதி, குறைந்தது ஒரு பகுதியைச் சேருங்கள். எதுவும் அனுப்பப்படவில்லை.', fromPlan: 'இது நடைமுறையில் உள்ள தளத் திட்டம் (பதிப்பு {v}). மாற்றி வெளியிட்டால் அடுத்த பதிப்பு உருவாகும்.',
    needStore: 'முதலில் கடையை எழுதுங்கள்.', readOnly: 'இந்தக் கடையின் அமைப்பை நீங்கள் படிக்கலாம். வெளியிடுவது அலமாரித் திட்டங்களைப் பராமரிப்பவரின் பணி.',
    noRight: 'இந்தக் கணக்கு அலமாரித் திட்டங்களைப் படிக்க முடியாது.', nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் மாற்றப்படவில்லை — மீண்டும் முயலவும்.', notKnown: 'தெரியவில்லை',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;
const both = (k) => ({ en: WORDS.en[k] ?? k, ta: WORDS.ta[k] ?? WORDS.en[k] ?? k });
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const office = () => window.sreOffice ?? null;
const shopToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const shopTime = (iso) => { try { return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; } };

const newKey = () => `space-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
async function call(method, path, body) {
  try {
    const res = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'idempotency-key': newKey() }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch { return { ok: false, status: 0, body: null }; }
}
const tell = (el, good, text) => { el.className = `status ${good ? 'good' : 'err'}`; el.textContent = text; };
const refusal = (out) => (out.status === 0 ? t('unreachable') : `${t('refused')} ${out.body?.error?.whatHappened ?? out.status}`);
/** A read that is not ok, as the register's state: no link → offline; not your role → denied; anything else → error. */
const stateOf = (out) => (out.status === 0 ? 'offline' : out.status === 401 || out.status === 403 ? 'denied' : 'error');

// ── what was read ───────────────────────────────────────────────────────────────────────────────────────────────────
let store = (typeof who?.storeId === 'string' ? who.storeId : '');
let map = undefined;      // { version, locations[], publishedBy, publishedAt } | null (none) | undefined (not read)
let mapOut = null;
let plans = undefined;    // GET planograms body | undefined
let plansOut = null;
let floor = undefined;    // plan | null | undefined
let floorOut = null;
let facings = [];         // the planogram being made: [{ productId, locationId, capacityMinor, primary }]
let areas = [];           // the floor plan being made: [{ areaId, name, nameTa?, x, y, width, depth, locationIds[] }]
let registers = { map: null, plan: null, floor: null };

async function readAll() {
  if (store.trim() === '') { tell($('page-status'), false, t('needStore')); return; }
  const s = encodeURIComponent(store.trim());
  const [m, p, f] = await Promise.all([
    call('GET', `/v1/merchandising/stores/${s}/shelf-map`), call('GET', `/v1/merchandising/stores/${s}/planograms`),
    mayFloor ? call('GET', `/v1/merchandising/stores/${s}/floor-plan`) : Promise.resolve({ ok: false, status: 403, body: null }),
  ]);
  map = m.ok ? m.body.shelfMap : m.status === 404 ? null : undefined; mapOut = m;
  plans = p.ok ? p.body : undefined; plansOut = p;
  floor = f.ok ? f.body.plan : f.status === 404 ? null : undefined; floorOut = f;
  if (floor) { $('fl-w').value = String(floor.widthFt); $('fl-d').value = String(floor.depthFt); areas = floor.areas.map((a) => ({ ...a })); } else areas = [];
  const st = $('page-status');
  const failed = [m, p, f].find((x) => !x.ok && x.status !== 404);
  if (failed !== undefined && !(failed === f && !mayFloor)) tell(st, false, refusal(failed));
  else if (!mayPublish) { st.className = 'status'; st.textContent = t('readOnly'); } else st.textContent = '';
  paint();
}

// ── painting ────────────────────────────────────────────────────────────────────────────────────────────────────────
function planState(p) {
  const inForceId = plans?.inForce?.planogramId ?? null;
  if (inForceId === p.planogramId && plans.inForce.version === p.version) return 'inForce';
  return p.effectiveFrom > shopToday() ? 'coming' : 'replaced';
}

function paintCards() {
  const o = office(); if (o === null) return;
  const stale = plans?.staleAgainstShelfMap ?? null;
  o.cards($('cards'), [
    { label: both('kPlaces'), value: map === undefined ? null : map === null ? 0 : map.locations.length, note: both('nPlaces'), tone: map === null ? 'pending' : undefined, icon: 'layout-grid' },
    { label: both('kMapV'), value: map === undefined ? null : map === null ? t('none') : map.version, note: both('nMapV') },
    { label: both('kPlans'), value: plans === undefined ? null : plans.plans.length, note: both('nPlans'), tone: plans !== undefined && plans.plans.length === 0 ? 'pending' : undefined },
    { label: both('kInForce'), value: plans === undefined ? null : plans.inForce === null ? t('noneInForce') : `${plans.inForce.planogramId} v${plans.inForce.version}`, note: both('nInForce'), tone: plans !== undefined && plans.inForce === null ? 'pending' : undefined },
    { label: both('kAreas'), value: floor === undefined ? null : floor === null ? 0 : floor.areas.length, note: both('nAreas'), tone: floor === null ? 'pending' : undefined },
    { label: both('kStale'), value: stale === null ? null : stale.length, note: both('nStale'), tone: stale !== null && stale.length > 0 ? 'degraded' : undefined },
  ]);
}

function ensureRegisters() {
  const o = office(); if (o === null) return false;
  if (registers.map === null || !document.getElementById('shelf-places-table')) {
    registers.map = o.table($('map-register'), {
      id: 'shelf-places', label: both('mapH'), bodyId: 'place-rows', pageSize: 10, rows: null,
      rowKey: (l) => l.locationId, rowData: (l) => ({ place: l.locationId }),
      empty: { title: both('mapEmpty'), detail: both('mapEmptyDetail') },
      columns: [
        { key: 'locationId', label: both('cPlace'), sort: 'text' },
        { key: 'aisle', label: both('cAisle'), sort: 'number', filter: true, align: 'end' },
        { key: 'rack', label: both('cRack'), sort: 'number', align: 'end' },
        { key: 'bay', label: both('cBay'), sort: 'number', align: 'end' },
        { key: 'shelf', label: both('cShelf'), sort: 'number', align: 'end' },
        { key: 'position', label: both('cPos'), sort: 'number', align: 'end' },
        { key: 'zone', label: both('cZone'), filter: true, value: (l) => both(l.zone ?? 'ambient') },
        { key: 'label', label: both('cLabel'), value: (l) => l.label ?? '' },
      ],
      drawer: {
        title: (l) => l.locationId,
        body: (l) => {
          const box = document.createElement('div');
          box.append(o.facts([[both('cAisle'), l.aisle], [both('cRack'), l.rack], [both('cBay'), l.bay], [both('cShelf'), l.shelf], [both('cPos'), l.position], [both('cZone'), t(l.zone ?? 'ambient')], [both('cLabel'), l.label ?? '']]));
          if (mayPublish) {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn sre-btn-danger'; b.dataset.action = 'take-off'; b.textContent = t('takeOff');
            b.addEventListener('click', async () => { o.closeDrawer(); await publishMap(map.locations.filter((x) => x.locationId !== l.locationId), t('takenOff')); });
            box.append(b);
          }
          return box;
        },
      },
    });
  }
  if (registers.plan === null || !document.getElementById('planograms-table')) {
    registers.plan = o.table($('plan-register'), {
      id: 'planograms', label: both('planH'), bodyId: 'plan-rows', pageSize: 10, rows: null,
      rowKey: (p) => p.planogramId, rowData: (p) => ({ plan: p.planogramId, state: planState(p) }),
      empty: { title: both('planEmpty'), detail: both('planEmptyDetail') },
      columns: [
        { key: 'planogramId', label: both('cPlan'), sort: 'text' },
        { key: 'version', label: both('cVersion'), sort: 'number', align: 'end' },
        { key: 'effectiveFrom', label: both('cFrom'), sort: 'text' },
        { key: 'facings', label: both('cFacings'), sort: 'number', align: 'end', value: (p) => p.assignments.length },
        { key: 'state', label: both('cState'), filter: true, value: (p) => both(planState(p)), render: (p) => o.chip(planState(p) === 'inForce' ? 'ok' : planState(p) === 'coming' ? 'pending' : 'idle', both(planState(p))) },
        { key: 'shelfMapVersion', label: both('cMapV'), sort: 'number', align: 'end', render: (p) => ((plans?.staleAgainstShelfMap ?? []).includes(p.planogramId) ? o.chip('degraded', both('stale')) : String(p.shelfMapVersion)) },
      ],
      drawer: {
        title: (p) => `${p.planogramId} v${p.version}`,
        body: (p) => {
          const box = document.createElement('div');
          box.append(o.facts([[both('cFrom'), p.effectiveFrom], [both('versions'), p.versions], [both('publishedBy'), p.createdBy], [both('publishedAt'), shopTime(p.publishedAt)], [both('cMapV'), p.shelfMapVersion]]));
          const ul = document.createElement('ul'); ul.className = 'rows';
          for (const a of p.assignments) { const li = document.createElement('li'); li.textContent = facingWords(a); ul.append(li); }
          box.append(ul);
          if (mayPublish) {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn sre-btn-primary'; b.dataset.action = 'edit-plan'; b.textContent = t('editThis');
            b.addEventListener('click', () => {
              o.closeDrawer();
              $('g-id').value = p.planogramId; $('g-from').value = p.effectiveFrom > shopToday() ? p.effectiveFrom : shopToday();
              facings = p.assignments.map((a) => ({ productId: a.productId, locationId: a.locationId, capacityMinor: a.capacityMinor, primary: a.primary }));
              paintFacings(); $('plan-form').scrollIntoView({ block: 'start' });
            });
            box.append(b);
          }
          return box;
        },
      },
    });
  }
  if (registers.floor === null || !document.getElementById('floor-areas-table')) {
    registers.floor = o.table($('floor-register'), {
      id: 'floor-areas', label: both('floorH'), bodyId: 'area-rows', pageSize: 10, rows: null,
      rowKey: (a) => a.areaId, rowData: (a) => ({ area: a.areaId }),
      empty: { title: both('floorEmpty'), detail: both('floorEmptyDetail') },
      columns: [
        { key: 'areaId', label: both('cArea'), sort: 'text' },
        { key: 'name', label: both('cName'), sort: 'text', value: (a) => (lang === 'ta' && a.nameTa ? a.nameTa : a.name) },
        { key: 'x', label: both('cX'), sort: 'number', align: 'end' },
        { key: 'y', label: both('cY'), sort: 'number', align: 'end' },
        { key: 'size', label: both('cSize'), value: (a) => `${a.width} × ${a.depth}` },
        { key: 'squareFeet', label: both('cSqft'), sort: 'number', align: 'end' },
        { key: 'places', label: both('cPlaces'), value: (a) => a.locationIds.join(', ') },
      ],
      drawer: {
        title: (a) => a.name,
        body: (a) => o.facts([[both('cArea'), a.areaId], [both('cName'), a.name], [both('anameta'), a.nameTa ?? ''], [both('cX'), a.x], [both('cY'), a.y], [both('cSize'), `${a.width} × ${a.depth}`], [both('cSqft'), a.squareFeet], [both('cPlaces'), a.locationIds.join(', ')]]),
      },
    });
  }
  return true;
}

function paintRegisters() {
  if (!ensureRegisters()) return;
  const set = (reg, rows, out, readable) => {
    if (!readable) reg.setState('denied', { detail: t(named ? 'noRight' : 'nobody') });
    else if (rows !== undefined) reg.setRows(rows);
    else if (out !== null) reg.setState(stateOf(out), { detail: refusal(out) });
    else reg.setRows(null);
  };
  set(registers.map, map === undefined ? undefined : map === null ? [] : map.locations, mapOut, mayRead);
  set(registers.plan, plans === undefined ? undefined : plans.plans, plansOut, mayRead);
  set(registers.floor, floor === undefined ? undefined : floor === null ? [] : floor.areas, floorOut, mayFloor);
}

const facingWords = (a) => fill(t('facing'), { product: a.productId, place: a.locationId, cap: a.capacityMinor, primary: a.primary ? t('primaryMark') : '' });
function itemWithRemove(text, onRemove, label) {
  const li = document.createElement('li');
  const span = document.createElement('span'); span.textContent = text; li.append(span);
  if (mayPublish) { const b = document.createElement('button'); b.type = 'button'; b.textContent = t('remove'); b.setAttribute('aria-label', `${label}: ${text}`); b.addEventListener('click', onRemove); li.append(b); }
  return li;
}
function paintFacings() {
  const ul = $('facings');
  ul.replaceChildren(...(facings.length === 0 ? [Object.assign(document.createElement('li'), { textContent: t('noFacings') })]
    : facings.map((a, i) => itemWithRemove(facingWords(a), () => { facings.splice(i, 1); paintFacings(); }, t('remove')))));
  const sel = $('f-place'); const keep = sel.value;
  const locs = map ? map.locations : [];
  sel.replaceChildren(...(locs.length === 0 ? [Object.assign(document.createElement('option'), { value: '', textContent: t('noPlaces') })] : locs.map((l) => Object.assign(document.createElement('option'), { value: l.locationId, textContent: l.label ? `${l.locationId} (${l.label})` : l.locationId }))));
  if (locs.some((l) => l.locationId === keep)) sel.value = keep;
}
function paintAreas() {
  $('areas').replaceChildren(...(areas.length === 0 ? [Object.assign(document.createElement('li'), { textContent: t('noAreas') })]
    : areas.map((a, i) => itemWithRemove(fill(t('areaLine'), { name: a.name, w: a.width, d: a.depth, x: a.x, y: a.y, places: a.locationIds.join(', ') }), () => { areas.splice(i, 1); paintAreas(); }, t('removeArea')))));
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['l-store', 'store'], ['read', 'read'], ['map-h', 'mapH'], ['map-lead', 'mapLead'], ['add-h', 'addH'], ['add-lead', 'addLead'],
    ['l-aisle', 'aisle'], ['l-rack', 'rack'], ['l-bay', 'bay'], ['l-shelves', 'shelves'], ['l-positions', 'positions'], ['l-zone', 'zone'], ['l-label', 'label'], ['add-places-go', 'addGo'],
    ['plan-h', 'planH'], ['plan-lead', 'planLead'], ['edit-h', 'editH'], ['l-gid', 'gid'], ['l-gfrom', 'gfrom'], ['l-fproduct', 'fproduct'], ['l-fplace', 'fplace'], ['l-fcap', 'fcap'], ['l-fprimary', 'fprimary'], ['f-add', 'fAdd'], ['plan-go', 'planGo'],
    ['floor-h', 'floorH'], ['floor-lead', 'floorLead'], ['size-h', 'sizeH'], ['l-flw', 'flw'], ['l-fld', 'fld'], ['area-h', 'areaH'], ['area-lead', 'areaLead'], ['l-aid', 'aid'], ['l-aname', 'aname'], ['l-anameta', 'anameta'],
    ['l-ax', 'ax'], ['l-ay', 'ay'], ['l-aw', 'aw'], ['l-ad', 'ad'], ['l-aplaces', 'aplaces'], ['a-add', 'aAdd'], ['floor-go', 'floorGo']]) { const el = $(id); if (el) el.textContent = t(k); }
  for (const z of ['ambient', 'chilled', 'frozen', 'secure']) { const opt = $('p-zone').querySelector(`option[value="${z}"]`); if (opt) opt.textContent = t(z); }
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  $('read').disabled = !mayRead;
  for (const id of ['add-places', 'plan-form', 'floor-form']) $(id).hidden = !mayPublish;
  paintCards(); paintRegisters(); paintFacings(); paintAreas();
}

// ── writes ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const whole = (v, min = 1) => { const n = Number(v); return Number.isInteger(n) && n >= min ? n : null; };
const strip = (l) => ({ locationId: l.locationId, aisle: l.aisle, rack: l.rack, bay: l.bay, shelf: l.shelf, position: l.position, ...(l.zone ? { zone: l.zone } : {}), ...(l.label ? { label: l.label } : {}) });

async function publishMap(locations, goodWords) {
  const st = $('map-status');
  const out = await call('PUT', `/v1/merchandising/stores/${encodeURIComponent(store.trim())}/shelf-map`, { locations: locations.map(strip) });
  if (!out.ok) { tell(st, false, refusal(out)); return; }
  await readAll();
  tell($('map-status'), true, typeof goodWords === 'function' ? goodWords(out.body.shelfMap) : goodWords);
}

$('add-places').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('map-status');
  const aisle = whole($('p-aisle').value); const rack = whole($('p-rack').value); const bay = whole($('p-bay').value);
  const shelves = whole($('p-shelves').value) ?? 1; const positions = whole($('p-positions').value) ?? 1;
  if (aisle === null || rack === null || bay === null || store.trim() === '') { tell(st, false, store.trim() === '' ? t('needStore') : t('needBay')); return; }
  const have = new Set((map?.locations ?? []).map((l) => l.locationId));
  const label = $('p-label').value.trim(); const zone = $('p-zone').value;
  const fresh = [];
  for (let s = 1; s <= Math.min(shelves, 12); s += 1) for (let p = 1; p <= Math.min(positions, 20); p += 1) {
    const locationId = `A${aisle}-R${rack}-B${bay}-S${s}-P${p}`;
    if (!have.has(locationId)) fresh.push({ locationId, aisle, rack, bay, shelf: s, position: p, zone, ...(label === '' ? {} : { label }) });
  }
  if (fresh.length === 0) { tell(st, false, t('allThere')); return; }
  await publishMap([...(map?.locations ?? []), ...fresh], (m) => fill(t('added'), { n: fresh.length, v: m.version }));
});

$('f-add').addEventListener('click', () => {
  const st = $('plan-status');
  const productId = $('f-product').value.trim(); const locationId = $('f-place').value; const cap = whole($('f-cap').value);
  if (productId === '' || locationId === '' || cap === null) { tell(st, false, t('needFacing')); return; }
  facings.push({ productId, locationId, capacityMinor: cap, primary: $('f-primary').checked });
  $('f-product').value = ''; $('f-cap').value = ''; st.textContent = '';
  paintFacings();
});

$('plan-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('plan-status');
  const id = $('g-id').value.trim(); const from = $('g-from').value;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id) || from === '' || facings.length === 0) { tell(st, false, t('needPlan')); return; }
  const out = await call('PUT', `/v1/merchandising/stores/${encodeURIComponent(store.trim())}/planograms/${encodeURIComponent(id)}`, { effectiveFrom: from, assignments: facings });
  if (!out.ok) { tell(st, false, refusal(out)); return; }
  facings = [];
  await readAll();
  tell($('plan-status'), true, fill(t('planSaved'), { id, v: out.body.planogram.version, from }));
});

$('a-add').addEventListener('click', () => {
  const st = $('floor-status');
  const areaId = $('a-id').value.trim(); const name = $('a-name').value.trim(); const nameTa = $('a-nameta').value.trim();
  const x = whole($('a-x').value, 0); const y = whole($('a-y').value, 0); const width = whole($('a-w').value); const depth = whole($('a-d').value);
  if (areaId === '' || name === '' || x === null || y === null || width === null || depth === null) { tell(st, false, t('needArea')); return; }
  const locationIds = $('a-places').value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  areas = [...areas.filter((a) => a.areaId !== areaId), { areaId, name, ...(nameTa === '' ? {} : { nameTa }), x, y, width, depth, locationIds }];
  for (const id of ['a-id', 'a-name', 'a-nameta', 'a-x', 'a-y', 'a-w', 'a-d', 'a-places']) $(id).value = '';
  st.textContent = '';
  paintAreas();
});

$('floor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('floor-status');
  const widthFt = whole($('fl-w').value); const depthFt = whole($('fl-d').value);
  if (widthFt === null || depthFt === null || areas.length === 0) { tell(st, false, t('needFloor')); return; }
  // The area's own square feet are head office's to work out from its size unless the plan in force named them.
  const body = { widthFt, depthFt, areas: areas.map((a) => ({ areaId: a.areaId, name: a.name, ...(a.nameTa ? { nameTa: a.nameTa } : {}), x: a.x, y: a.y, width: a.width, depth: a.depth, locationIds: a.locationIds })) };
  const out = await call('POST', `/v1/merchandising/stores/${encodeURIComponent(store.trim())}/floor-plan`, body);
  if (!out.ok) { tell(st, false, refusal(out)); return; }
  await readAll();
  tell($('floor-status'), true, fill(t('floorSaved'), { v: out.body.plan.version, n: out.body.plan.areas.length }));
});

$('pick').addEventListener('submit', (e) => { e.preventDefault(); store = $('store').value.trim(); void readAll(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
document.addEventListener('sre:chrome', () => { paintCards(); paintRegisters(); });

$('store').value = store;
$('g-from').value = shopToday();
paint();
if (named && !mayRead) tell($('page-status'), false, t('noRight'));
if (mayRead && store.trim() !== '') void readAll();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it is not kept for offline use */ });
}
