// Customer app — OB-288 wave 3: the commerce screens, beside app.js and online-store.js.
//
//   • OFFERS AND YOUR PRICE (WF-13 · M20-FR-02): the shop prices the basket with the till's own offers and coupon engine;
//     a coupon's answer by name; the delivery fee; what you pay; your points. Paying pays exactly the shop's price.
//   • IF SOMETHING IS OUT (D08-FR-03 · FUL-14) and IDEAS (M20-FR-02 · A04 · AI-NFR-11): "goes well with" from what
//     customers bought together, and in-stock alternatives MARKED as AI with the plain notice; nothing is added unless
//     you tap Add.
//   • CAMERA BARCODE (D08-FR-02) and the VOICE SWITCH (OB-322): what was read or heard becomes an ordinary search.
//   • MY ORDER: the delivery code and arrival time ("not given yet" until the shop gives them); the shop's assistant
//     answering a chosen question from the shop's own records, marked as automatic, and "ask a person" (A05).
//   • MY ACCOUNT: repeat orders (OB-303), addresses and "remove saved payment" (M20-FR-04), occasions (M21-FR-02), and
//     the AI suggestions opt-in (OB-314) — one switch, both ways.
// No prompt, confirm or alert; nothing on a background timer; every state in words; every word in English and Tamil.

const el = (id) => document.getElementById(id);
const inr = (minor) => `${minor < 0 ? '−' : ''}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');

const W = {
  en: {
    voiceSwitch: 'Voice search', on: 'ON', off: 'OFF',
    voiceWhy: 'Your phone\'s own speech service turns what you say into words — on many phones that service is run online by the phone or browser maker, not by this shop. The shop receives only the words, as a search you can change. Switch it off here at any time.',
    scan: 'Scan a barcode', scanStop: 'Stop scanning', scanLooking: 'Point the camera at the barcode…', scanRead: 'Read from the barcode:',
    scanNone: 'No barcode was read. Try again, or type the number under the barcode in the search box.', scanDenied: 'The camera is not allowed. Allow it, or type the number under the barcode.',
    scanUnsupported: 'This phone cannot read barcodes with the camera — type the number under the barcode in the search box.',
    offersTitle: 'Offers and your price', couponLabel: 'Coupon code (if you have one)', quoteBtn: 'See the shop\'s price', badCoupon: 'A coupon code is letters and digits only. Nothing was sent.',
    goods: 'Goods', offers: 'Offers', coupon: 'Coupon', delivery: 'Delivery', payable: 'You pay', couponNot: 'not taken',
    unpriced: 'The shop has no price yet for:', pointsNone: 'Your app is not tied to a loyalty membership. Show your app reference at the service desk to see your points here.',
    points: 'You have {n} point(s)', pointsWorth: ', worth {v} at the till.', pointsUnset: '. The shop has not set what a point is worth yet ("not set").',
    out_redeemed: 'taken', out_already_redeemed: 'already used', out_expired: 'expired', out_not_yet_valid: 'not valid yet', out_limit_reached: 'all used up',
    out_customer_limit_reached: 'you have used it already', out_not_eligible: 'not for this basket', out_basket_too_small: 'the basket is too small for it', out_unknown_code: 'no such coupon',
    payNote: 'When you pay, you pay exactly this price.',
    subsTitle: 'If something is out of stock', subsSave: 'Save my choice', subs_best_match: 'Send the closest match', subs_contact_me: 'Ask me first', subs_no_substitution: 'Leave it out',
    subsSaved: 'Saved — the shop will do this for every order.', subsPick: 'Choose one first. Nothing was sent.',
    ideasTitle: 'Ideas for your basket', ideasBtn: 'Show ideas', ideasEmpty: 'Put something in your basket first.', ideasNone: 'No ideas for this basket just now.',
    goesWith: 'Goes well with', aiAlt: 'In stock instead', add: 'Add', added: 'Added to your basket:',
    handoverCode: 'Delivery code', handoverEta: 'Arriving', notGivenYet: 'not given yet',
    askTitle: 'Ask the shop\'s assistant', ask: 'Ask', askPerson: 'Ask a person instead', topic_order_status: 'Where is my order?', topic_return_policy: 'What can I return?', topic_delivery_charges: 'What does delivery cost?',
    askPick: 'Choose a question first. Nothing was sent.', askNoOrder: 'There is no order in this app yet to ask about.', askSent: 'Sent to the shop — a person will reply. Reference:',
    askEscalate: 'The assistant cannot answer this just now. Ask a person and the shop will reply.', personSummary: 'Please help me with:',
    accountTitle: 'My account', repeatTitle: 'My repeat orders', repeatLead: 'The basket you have now, placed again on the days you choose. You pay in the app each time; pause or cancel whenever you like.',
    repeatNone: 'No repeat orders yet.', everyDays: 'Every few days', onWeekdays: 'On these days', daysLabel: 'Every how many days', startLabel: 'First day', pickup: 'I collect', deliver: 'Deliver to me', timeLabel: 'Delivery time',
    repeatSave: 'Repeat this basket', repeatSaved: 'Saved — your repeat order is on.', pause: 'Pause', resume: 'Resume', cancel: 'Cancel',
    st_active: 'On', st_paused: 'Paused', st_cancelled: 'Cancelled', next: 'Next', placed: 'placed', not_placed: 'not placed', missed: 'missed',
    why_empty_basket: 'Put what you want in the basket first. Nothing was sent.', why_no_store: 'This app has not been told which store fulfils orders. Nothing was sent.', why_bad_start: 'Choose a first day from today. Nothing was sent.',
    why_bad_days: 'Every 1 to 31 days. Nothing was sent.', why_no_weekdays: 'Choose at least one day. Nothing was sent.', why_no_location: 'Use your location (in the basket) or choose a saved address first. Nothing was sent.', why_bad_time: 'Choose a delivery time. Nothing was sent.',
    wd0: 'Sun', wd1: 'Mon', wd2: 'Tue', wd3: 'Wed', wd4: 'Thu', wd5: 'Fri', wd6: 'Sat',
    addressesTitle: 'My addresses', addressesLead: 'A label and where it is, to about 100 metres. Nothing more.', addressesNone: 'No saved addresses.',
    addressLabel: 'Name this place (for example, Home)', landmarkLabel: 'A landmark (optional)', addressSave: 'Save where I am now', addressSaved: 'Saved.', addressNeedsLocation: 'Use my location first (in the basket). Nothing was sent.',
    addressNeedsLabel: 'Give the place a name first. Nothing was sent.', use: 'Deliver here', remove: 'Remove', removed: 'Removed.', usingAddress: 'Orders will be delivered to:',
    payingTitle: 'Paying', payingSay: 'The shop keeps no card details. Nothing is saved for paying, so there is nothing to remove. You pay through the payment provider\'s own screen each time.',
    payingRemove: 'Remove a saved payment', payingRemoved: 'Nothing was saved for paying, so nothing needed removing.',
    occasionsTitle: 'My birthday or anniversary', occasionsLead: 'Only if you want a greeting or an offer near the day. Remove it in one tap.', birthday: 'Birthday', anniversary: 'Anniversary',
    occasionDay: 'The day', occasionYes: 'Yes, the shop may keep this day to greet me', occasionSave: 'Save the day', occasionSaved: 'Saved.', occasionNeedsYes: 'Tick the yes first — the shop keeps the day only with it. Nothing was sent.', occasionNeedsDay: 'Choose the day first. Nothing was sent.',
    aiTitle: 'Suggestions', aiSwitch: 'Use what I bought before for suggestions', aiWhyOff: 'Off: suggestions use only what is in stock, never what you bought.', aiWhyOn: 'On: suggestions may use what you bought before. Switch it off here at any time.',
    boughtBefore: 'You bought before', signIn: 'Please sign in first (in the basket).', offline: 'Not saved — no connection. Please try again.', busy: 'The shop could not answer just now. Please try again.', refused: 'The shop did not accept this:', noRoad: 'This app has no connection to the shop set up.',
    cartKept: 'Your basket is kept on the shop while you are signed in.',
  },
  ta: {
    voiceSwitch: 'குரல் தேடல்', on: 'இயக்கம்', off: 'நிறுத்தம்',
    voiceWhy: 'நீங்கள் சொல்வதை உங்கள் தொலைபேசியின் சொந்தப் பேச்சுச் சேவை வார்த்தைகளாக மாற்றுகிறது — பல தொலைபேசிகளில் அந்தச் சேவையைத் தொலைபேசி அல்லது உலாவி நிறுவனம் இணையத்தில் இயக்குகிறது, இந்தக் கடை அல்ல. கடைக்கு வார்த்தைகள் மட்டுமே வரும், நீங்கள் மாற்றக்கூடிய தேடலாக. எப்போது வேண்டுமானாலும் இங்கே நிறுத்தலாம்.',
    scan: 'பார்கோடை ஸ்கேன் செய்', scanStop: 'ஸ்கேன் செய்வதை நிறுத்து', scanLooking: 'கேமராவை பார்கோடை நோக்கிக் காட்டுங்கள்…', scanRead: 'பார்கோடிலிருந்து படித்தது:',
    scanNone: 'பார்கோடு படிக்கப்படவில்லை. மீண்டும் முயலுங்கள், அல்லது பார்கோடின் கீழ் உள்ள எண்ணைத் தேடலில் தட்டச்சு செய்யுங்கள்.', scanDenied: 'கேமராவுக்கு அனுமதி இல்லை. அனுமதியுங்கள், அல்லது பார்கோடின் கீழ் உள்ள எண்ணைத் தட்டச்சு செய்யுங்கள்.',
    scanUnsupported: 'இந்தத் தொலைபேசியால் கேமரா மூலம் பார்கோடு படிக்க முடியாது — பார்கோடின் கீழ் உள்ள எண்ணைத் தேடலில் தட்டச்சு செய்யுங்கள்.',
    offersTitle: 'சலுகைகளும் உங்கள் விலையும்', couponLabel: 'கூப்பன் குறியீடு (இருந்தால்)', quoteBtn: 'கடையின் விலையைப் பார்', badCoupon: 'கூப்பன் குறியீடு எழுத்துகளும் எண்களும் மட்டுமே. எதுவும் அனுப்பப்படவில்லை.',
    goods: 'பொருட்கள்', offers: 'சலுகைகள்', coupon: 'கூப்பன்', delivery: 'விநியோகம்', payable: 'நீங்கள் செலுத்துவது', couponNot: 'ஏற்கப்படவில்லை',
    unpriced: 'இவற்றுக்குக் கடையிடம் இன்னும் விலை இல்லை:', pointsNone: 'உங்கள் செயலி இன்னும் லாயல்டி உறுப்பினர் கணக்குடன் இணைக்கப்படவில்லை. உங்கள் புள்ளிகளை இங்கே பார்க்க, சேவை மையத்தில் உங்கள் செயலிக் குறிப்பைக் காட்டுங்கள்.',
    points: 'உங்களிடம் {n} புள்ளி(கள்) உள்ளன', pointsWorth: ', கட்டணப் பகுதியில் {v} மதிப்பு.', pointsUnset: '. ஒரு புள்ளியின் மதிப்பைக் கடை இன்னும் அமைக்கவில்லை ("அமைக்கப்படவில்லை").',
    out_redeemed: 'ஏற்கப்பட்டது', out_already_redeemed: 'ஏற்கனவே பயன்படுத்தப்பட்டது', out_expired: 'காலாவதியானது', out_not_yet_valid: 'இன்னும் செல்லாது', out_limit_reached: 'அனைத்தும் பயன்படுத்தப்பட்டன',
    out_customer_limit_reached: 'நீங்கள் ஏற்கனவே பயன்படுத்தினீர்கள்', out_not_eligible: 'இந்தக் கூடைக்கு அல்ல', out_basket_too_small: 'இதற்குக் கூடை மிகச் சிறியது', out_unknown_code: 'அப்படி ஒரு கூப்பன் இல்லை',
    payNote: 'நீங்கள் செலுத்தும்போது, சரியாக இந்த விலையையே செலுத்துவீர்கள்.',
    subsTitle: 'ஏதாவது கையிருப்பில் இல்லையென்றால்', subsSave: 'என் தேர்வைச் சேமி', subs_best_match: 'மிக நெருக்கமான பொருளை அனுப்பு', subs_contact_me: 'முதலில் என்னைக் கேள்', subs_no_substitution: 'அதை விட்டுவிடு',
    subsSaved: 'சேமிக்கப்பட்டது — ஒவ்வொரு ஆர்டருக்கும் கடை இப்படிச் செய்யும்.', subsPick: 'முதலில் ஒன்றைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    ideasTitle: 'உங்கள் கூடைக்கான யோசனைகள்', ideasBtn: 'யோசனைகளைக் காட்டு', ideasEmpty: 'முதலில் கூடையில் ஏதாவது சேருங்கள்.', ideasNone: 'இப்போது இந்தக் கூடைக்கு யோசனைகள் இல்லை.',
    goesWith: 'இதனுடன் பொருந்துவது', aiAlt: 'பதிலாகக் கையிருப்பில் உள்ளது', add: 'சேர்', added: 'உங்கள் கூடையில் சேர்க்கப்பட்டது:',
    handoverCode: 'விநியோகக் குறியீடு', handoverEta: 'வந்து சேரும் நேரம்', notGivenYet: 'இன்னும் கொடுக்கப்படவில்லை',
    askTitle: 'கடையின் உதவியாளரிடம் கேளுங்கள்', ask: 'கேள்', askPerson: 'பதிலாக ஒருவரிடம் கேளுங்கள்', topic_order_status: 'என் ஆர்டர் எங்கே?', topic_return_policy: 'எதைத் திருப்பி அனுப்பலாம்?', topic_delivery_charges: 'விநியோகக் கட்டணம் என்ன?',
    askPick: 'முதலில் ஒரு கேள்வியைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.', askNoOrder: 'கேட்பதற்கு இந்தச் செயலியில் இன்னும் ஆர்டர் இல்லை.', askSent: 'கடைக்கு அனுப்பப்பட்டது — ஒருவர் பதில் அளிப்பார். குறிப்பு:',
    askEscalate: 'உதவியாளரால் இப்போது இதற்குப் பதில் அளிக்க முடியவில்லை. ஒருவரிடம் கேளுங்கள், கடை பதில் அளிக்கும்.', personSummary: 'இதில் எனக்கு உதவுங்கள்:',
    accountTitle: 'என் கணக்கு', repeatTitle: 'என் மீண்டும் வரும் ஆர்டர்கள்', repeatLead: 'இப்போது உள்ள கூடை, நீங்கள் தேர்வு செய்யும் நாட்களில் மீண்டும் ஆர்டர் செய்யப்படும். ஒவ்வொரு முறையும் செயலியில் செலுத்துவீர்கள்; எப்போது வேண்டுமானாலும் இடைநிறுத்தலாம் அல்லது ரத்து செய்யலாம்.',
    repeatNone: 'இன்னும் மீண்டும் வரும் ஆர்டர்கள் இல்லை.', everyDays: 'சில நாட்களுக்கு ஒருமுறை', onWeekdays: 'இந்த நாட்களில்', daysLabel: 'எத்தனை நாட்களுக்கு ஒருமுறை', startLabel: 'முதல் நாள்', pickup: 'நானே எடுத்துக்கொள்வேன்', deliver: 'எனக்கு விநியோகம் செய்', timeLabel: 'விநியோக நேரம்',
    repeatSave: 'இந்தக் கூடையை மீண்டும் ஆர்டர் செய்', repeatSaved: 'சேமிக்கப்பட்டது — உங்கள் மீண்டும் வரும் ஆர்டர் இயக்கத்தில் உள்ளது.', pause: 'இடைநிறுத்து', resume: 'மீண்டும் தொடங்கு', cancel: 'ரத்து செய்',
    st_active: 'இயக்கம்', st_paused: 'இடைநிறுத்தப்பட்டது', st_cancelled: 'ரத்து செய்யப்பட்டது', next: 'அடுத்து', placed: 'ஆர்டர் செய்யப்பட்டது', not_placed: 'ஆர்டர் செய்யப்படவில்லை', missed: 'தவறியது',
    why_empty_basket: 'முதலில் தேவையானதைக் கூடையில் சேருங்கள். எதுவும் அனுப்பப்படவில்லை.', why_no_store: 'ஆர்டர்களை எந்தக் கடை நிறைவேற்றும் என்று இந்தச் செயலிக்குச் சொல்லப்படவில்லை. எதுவும் அனுப்பப்படவில்லை.', why_bad_start: 'இன்றிலிருந்து ஒரு முதல் நாளைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    why_bad_days: '1 முதல் 31 நாட்களுக்கு ஒருமுறை. எதுவும் அனுப்பப்படவில்லை.', why_no_weekdays: 'குறைந்தது ஒரு நாளைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.', why_no_location: 'முதலில் உங்கள் இருப்பிடத்தைப் பயன்படுத்துங்கள் (கூடையில்) அல்லது சேமித்த முகவரியைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.', why_bad_time: 'விநியோக நேரத்தைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    wd0: 'ஞாயி', wd1: 'திங்', wd2: 'செவ்', wd3: 'புத', wd4: 'வியா', wd5: 'வெள்', wd6: 'சனி',
    addressesTitle: 'என் முகவரிகள்', addressesLead: 'ஒரு பெயரும் அது இருக்கும் இடமும், சுமார் 100 மீட்டர் வரை. அதற்கு மேல் எதுவும் இல்லை.', addressesNone: 'சேமித்த முகவரிகள் இல்லை.',
    addressLabel: 'இந்த இடத்திற்குப் பெயரிடுங்கள் (எ.கா. வீடு)', landmarkLabel: 'ஒரு அடையாளம் (விருப்பம்)', addressSave: 'நான் இப்போது இருக்கும் இடத்தைச் சேமி', addressSaved: 'சேமிக்கப்பட்டது.', addressNeedsLocation: 'முதலில் என் இருப்பிடத்தைப் பயன்படுத்துங்கள் (கூடையில்). எதுவும் அனுப்பப்படவில்லை.',
    addressNeedsLabel: 'முதலில் இடத்திற்குப் பெயரிடுங்கள். எதுவும் அனுப்பப்படவில்லை.', use: 'இங்கே விநியோகம் செய்', remove: 'நீக்கு', removed: 'நீக்கப்பட்டது.', usingAddress: 'ஆர்டர்கள் இங்கே விநியோகம் செய்யப்படும்:',
    payingTitle: 'பணம் செலுத்துதல்', payingSay: 'கடை எந்த அட்டை விவரங்களையும் வைத்திருப்பதில்லை. பணம் செலுத்துவதற்கு எதுவும் சேமிக்கப்படவில்லை, எனவே நீக்க எதுவும் இல்லை. ஒவ்வொரு முறையும் கட்டண வழங்குநரின் சொந்தத் திரையில் செலுத்துவீர்கள்.',
    payingRemove: 'சேமித்த கட்டண முறையை நீக்கு', payingRemoved: 'பணம் செலுத்துவதற்கு எதுவும் சேமிக்கப்படவில்லை, எனவே எதையும் நீக்க வேண்டியதில்லை.',
    occasionsTitle: 'என் பிறந்தநாள் அல்லது திருமண நாள்', occasionsLead: 'அந்த நாளுக்கு அருகில் வாழ்த்தோ சலுகையோ வேண்டுமானால் மட்டும். ஒரே தட்டலில் நீக்கலாம்.', birthday: 'பிறந்தநாள்', anniversary: 'திருமண நாள்',
    occasionDay: 'அந்த நாள்', occasionYes: 'ஆம், என்னை வாழ்த்த இந்த நாளைக் கடை வைத்திருக்கலாம்', occasionSave: 'நாளைச் சேமி', occasionSaved: 'சேமிக்கப்பட்டது.', occasionNeedsYes: 'முதலில் ஆம் என்று குறியிடுங்கள் — அதனுடன் மட்டுமே கடை நாளை வைத்திருக்கும். எதுவும் அனுப்பப்படவில்லை.', occasionNeedsDay: 'முதலில் நாளைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    aiTitle: 'பரிந்துரைகள்', aiSwitch: 'பரிந்துரைகளுக்கு நான் முன்பு வாங்கியதைப் பயன்படுத்து', aiWhyOff: 'நிறுத்தம்: பரிந்துரைகள் கையிருப்பில் உள்ளதை மட்டுமே பயன்படுத்தும், நீங்கள் வாங்கியதை ஒருபோதும் அல்ல.', aiWhyOn: 'இயக்கம்: பரிந்துரைகள் நீங்கள் முன்பு வாங்கியதைப் பயன்படுத்தலாம். எப்போது வேண்டுமானாலும் இங்கே நிறுத்தலாம்.',
    boughtBefore: 'நீங்கள் முன்பு வாங்கியது', signIn: 'முதலில் உள்நுழையுங்கள் (கூடையில்).', offline: 'சேமிக்கப்படவில்லை — இணைப்பு இல்லை. மீண்டும் முயலுங்கள்.', busy: 'கடையால் இப்போது பதில் அளிக்க முடியவில்லை. மீண்டும் முயலுங்கள்.', refused: 'கடை இதை ஏற்கவில்லை:', noRoad: 'இந்தச் செயலிக்குக் கடையுடன் இணைப்பு அமைக்கப்படவில்லை.',
    cartKept: 'நீங்கள் உள்நுழைந்திருக்கும் வரை உங்கள் கூடை கடையில் வைக்கப்படும்.',
  },
};
const t = (k) => W[lang()][k] ?? W.en[k] ?? k;
const shop = () => window.shop;
const rules = () => window.shopCommerceRules;
const signedIn = () => shop()?.commerce !== undefined && shop().isSignedIn();
const refusalWords = (out) => (out.refusal === 'not_signed_in' ? t('signIn') : out.refusal === 'not_saved_no_connection' ? t('offline') : out.refusal === 'the_shop_could_not_answer' ? t('busy')
  : out.refusal === 'no_road_to_the_shop' ? t('noRoad') : out.refusal === 'no_location' ? t('addressNeedsLocation') : out.refusal === 'form' ? t(`why_${out.why}`) : `${t('refused')} ${out.shopSaid ?? ''}`);
const nameOf = (id) => (window.shopData?.products ?? []).find((p) => p.productId === id)?.name ?? id;
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 20) : null);
function words(id, key, iconName) {
  const n = el(id); if (!n) return;
  n.replaceChildren(...[iconName ? icon(iconName) : null, document.createTextNode(t(key))].filter(Boolean));
}
function node(tag, text, cls) { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; }
function say(id, text) { el(id).textContent = text; }
function button(text, iconName, onClick, cls = '') {
  const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls;
  const i = icon(iconName); if (i) b.append(i);
  b.append(document.createTextNode(text));
  b.addEventListener('click', onClick);
  return b;
}
function radios(boxId, name, values, label, chosen) {
  const box = el(boxId);
  const keep = box.querySelector('input:checked')?.value ?? chosen;
  box.replaceChildren(...values.map((v) => {
    const l = document.createElement('label');
    const i = document.createElement('input'); i.type = 'radio'; i.name = name; i.value = String(v); i.checked = String(v) === String(keep);
    l.append(i, document.createTextNode(` ${label(v)}`));
    return l;
  }));
}
const picked = (boxId) => el(boxId).querySelector('input:checked')?.value;

// ── Voice switch (OB-322) and camera barcode (D08-FR-02) ───────────────────────────────────────────────────────────

function paintVoice() {
  const sw = window.shopVoiceSwitch;
  const can = sw !== undefined && sw.phoneCanListen();
  el('voice-box').hidden = !can;
  if (!can) { el('voice').hidden = true; return; }
  const on = !sw.off();
  el('voice-switch').setAttribute('aria-checked', String(on));
  el('voice-switch').textContent = on ? t('on') : t('off');
  say('voice-switch-label', t('voiceSwitch'));
  say('voice-why', t('voiceWhy'));
  el('voice').hidden = !(window.shopVoice?.available() === true);
}
el('voice-switch').addEventListener('click', () => { const sw = window.shopVoiceSwitch; if (sw) { sw.set(sw.off()); paintVoice(); } });

let scanSupported = false;
let scanStopped = false;
async function paintScan() {
  scanSupported = window.shopBarcode !== undefined && await window.shopBarcode.supported();
  el('scan').hidden = !scanSupported;
  words('scan', 'scan', 'scan-barcode');
  words('scan-stop', 'scanStop', 'x');
  if (!scanSupported && el('scan-say').dataset.state === undefined) { el('scan-say').dataset.state = 'unsupported'; say('scan-say', t('scanUnsupported')); }
}
el('scan').addEventListener('click', async () => {
  const video = el('scan-video');
  let stream = null;
  scanStopped = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch { el('scan-say').dataset.state = 'denied'; say('scan-say', t('scanDenied')); return; }
  const reader = window.shopBarcodeStandIn ?? new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf'] });
  el('scan-box').hidden = false;
  el('scan-say').dataset.state = 'looking'; say('scan-say', t('scanLooking'));
  try {
    video.srcObject = stream;
    await video.play().catch(() => undefined);
    const result = await window.shopBarcode.scanFrames({
      reader, frame: () => video, stopped: () => scanStopped, maxFrames: 150,
      nextFrame: () => new Promise((r) => { setTimeout(r, 200); }),
    });
    if (result.found) {
      el('search').value = result.code;
      el('search').dispatchEvent(new Event('input', { bubbles: true }));
      el('scan-say').dataset.state = 'read'; say('scan-say', `${t('scanRead')} ${result.code}`);
    } else if (result.why !== 'stopped') { el('scan-say').dataset.state = 'none'; say('scan-say', t('scanNone')); }
    else { el('scan-say').dataset.state = 'stopped'; say('scan-say', ''); }
  } finally {
    // The camera is closed the moment scanning ends — no picture is kept or sent.
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    el('scan-box').hidden = true;
  }
});
el('scan-stop').addEventListener('click', () => { scanStopped = true; });

// ── Offers and your price (WF-13) ──────────────────────────────────────────────────────────────────────────────────

let lastQuote = null;
function paintQuote() {
  words('offers-title', 'offersTitle'); say('coupon-label', t('couponLabel')); words('quote-btn', 'quoteBtn', 'percent');
  if (lastQuote === null) { el('quote-box').hidden = true; return; }
  el('quote-box').hidden = false;
  const dl = el('quote');
  dl.replaceChildren(...rules().quoteRows(lastQuote).map((r) => {
    const d = document.createElement('div'); d.className = r.kind; d.dataset.kind = r.kind;
    if (r.kind === 'unpriced') { d.append(node('dt', t('unpriced')), node('dd', r.productIds.map(nameOf).join(', '))); return d; }
    if (r.kind === 'coupon_refused') { d.append(node('dt', `${t('coupon')} ${r.code}`), node('dd', `${t('couponNot')} — ${t(`out_${r.outcome}`)}`)); return d; }
    d.append(node('dt', r.kind === 'coupon' ? `${t('coupon')} ${lastQuote.coupon.code}` : t(r.kind)), node('dd', inr(r.amountMinor)));
    return d;
  }));
  const p = lastQuote.points;
  el('points-say').textContent = p === undefined || !p.member ? t('pointsNone')
    : t('points').replace('{n}', String(p.pointsBalance ?? 0)) + (typeof p.worthMinor === 'number' ? t('pointsWorth').replace('{v}', inr(p.worthMinor)) : t('pointsUnset'));
  if (lastQuote.priced) say('quote-say', t('payNote'));
}
el('quote-btn').addEventListener('click', async () => {
  if (!shop().commerce.setCoupon(el('coupon').value).ok) { say('quote-say', t('badCoupon')); return; }
  const out = await shop().commerce.quote();
  if (!out.ok) { lastQuote = null; paintQuote(); say('quote-say', refusalWords(out)); return; }
  lastQuote = out.value; paintQuote();
});
// The coupon typed travels with the order; the shop's price is asked for again when paying (app's browser entry).
el('coupon').addEventListener('change', () => { shop()?.commerce.setCoupon(el('coupon').value); lastQuote = null; paintQuote(); });
// M21-FR-02: checking the basket while signed in keeps it on the shop (the abandoned-basket journey reads it — and is off
// until the shop switches it on with approved words and your yes to offers).
el('review').addEventListener('click', async () => {
  if (!signedIn() || shop().state().lines.length === 0) return;
  const out = await shop().commerce.holdCart();
  if (out.ok) say('quote-say', t('cartKept'));
});

// ── If something is out (D08-FR-03) and ideas (M20-FR-02 · A04 · AI-NFR-11) ───────────────────────────────────────

function paintSubs() {
  words('subs-title', 'subsTitle'); words('subs-save', 'subsSave', 'repeat');
  radios('subs', 'subs', rules().substitutionChoices, (v) => t(`subs_${v}`));
  words('ideas-title', 'ideasTitle'); words('ideas', 'ideasBtn', 'sparkles');
}
el('subs-save').addEventListener('click', async () => {
  const v = picked('subs');
  if (v === undefined) { say('subs-say', t('subsPick')); return; }
  const out = await shop().commerce.setSubstitution(v);
  say('subs-say', out.ok ? t('subsSaved') : refusalWords(out));
});
let aiNotice = null;
function paintAiNotice() { el('ai-notice').hidden = aiNotice === null; el('ai-notice').textContent = aiNotice?.[lang()] ?? ''; }
function ideaRow(productId, kind, extra) {
  const row = document.createElement('div'); row.className = 'row'; row.dataset.productId = productId; row.dataset.kind = kind;
  row.append(node('span', `${kind === 'ai' ? '✦ ' : ''}${nameOf(productId)}`, 'name'));
  row.append(button(t('add'), 'shopping-basket', () => { shop().setLine(productId, (shop().state().lines.find((l) => l.productId === productId)?.quantityMinor ?? 0) + 1); say('ideas-say', `${t('added')} ${nameOf(productId)}`); el(`tab-${document.querySelector('#tabs [aria-current="page"]')?.id?.slice(4) ?? 'basket'}`).click(); }));
  if (extra) row.append(node('span', extra, 'note'));
  return row;
}
el('ideas').addEventListener('click', async () => {
  const first = shop().state().lines.find((l) => l.quantityMinor > 0);
  if (first === undefined) { say('ideas-say', t('ideasEmpty')); return; }
  const [recs, ai] = await Promise.all([shop().commerce.recommendations(first.productId), shop().commerce.suggestions(first.productId)]);
  if (!recs.ok && !ai.ok) { say('ideas-say', refusalWords(recs)); return; }
  const rows = [];
  if (recs.ok) for (const r of recs.value.recommendations ?? []) rows.push(ideaRow(r.productId, 'goes_with', `${t('goesWith')} ${nameOf(first.productId)}`));
  if (ai.ok) {
    // AI-NFR-11: every AI suggestion is marked, with the plain notice — the shop's own words, in this language.
    aiNotice = ai.value.notice ?? null; paintAiNotice();
    for (const a of ai.value.alternatives ?? []) rows.push(ideaRow(a.forProductId, 'ai', `${t('aiAlt')} — ${a.summary}`));
  }
  el('ideas-list').replaceChildren(...rows);
  say('ideas-say', rows.length === 0 ? t('ideasNone') : '');
});

// ── My order: delivery code / arrival time, and the shop's assistant (A05) ─────────────────────────────────────────

let lastAnswer = null;
function paintAnswer() {
  if (lastAnswer === null) { el('ask-answer').hidden = true; return; }
  el('ask-answer').hidden = false; el('ask-answer').dataset.answered = String(lastAnswer.answered === true);
  el('ask-text').textContent = lastAnswer.answered ? lastAnswer.text : t('askEscalate');
  // A05: the answer is marked as automatic, in the shop's own words for this language.
  el('ask-notice').textContent = lastAnswer.notice?.[lang()] ?? '';
}
function paintOrderExtras() {
  paintAnswer();
  say('handover-code-label', t('handoverCode')); say('handover-eta-label', t('handoverEta'));
  words('ask-title', 'askTitle'); words('ask', 'ask', 'circle-help'); words('ask-person', 'askPerson', 'headphones');
  radios('ask-topics', 'ask-topic', rules().helpTopics, (v) => t(`topic_${v}`));
  paintHandover();
}
// The last "Where is my order?" answer the customer asked for (app.js) — the slot reads it, and never reads on its own.
let lastTracked = null;
function paintHandover() {
  if (shop()?.commerce.heldOrderId() === undefined) { el('handover').hidden = true; return; }
  const h = rules().deliveryHandover(lastTracked?.ok ? lastTracked.value.delivery : null);
  el('handover').hidden = false;
  el('handover-code').textContent = h.code ?? t('notGivenYet'); el('handover-code').dataset.given = String(h.code !== null);
  el('handover-eta').textContent = h.eta === null ? t('notGivenYet') : new Date(h.eta).toLocaleTimeString(lang() === 'ta' ? 'ta-IN' : 'en-IN', { hour: '2-digit', minute: '2-digit' });
}
el('ask').addEventListener('click', async () => {
  const topic = picked('ask-topics');
  if (topic === undefined) { say('ask-say', t('askPick')); return; }
  const orderId = shop().commerce.heldOrderId();
  if (topic === 'order_status' && orderId === undefined) { say('ask-say', t('askNoOrder')); return; }
  const out = await shop().commerce.help(topic, topic === 'order_status' ? orderId : undefined);
  if (!out.ok) { el('ask-answer').hidden = true; say('ask-say', refusalWords(out)); return; }
  lastAnswer = out.value;
  paintAnswer();
  say('ask-say', '');
});
el('ask-person').addEventListener('click', async () => {
  const topic = picked('ask-topics');
  const orderId = shop().commerce.heldOrderId();
  const out = await shop().mine.complain(`${W.en.personSummary} ${topic === undefined ? W.en.askTitle : W.en[`topic_${topic}`]}`, orderId);
  say('ask-say', out.ok ? `${t('askSent')} ${out.value}` : refusalWords(out));
});

// ── My account ─────────────────────────────────────────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);
function paintAccountWords() {
  for (const [id, k] of [['account-title', 'accountTitle'], ['repeat-orders-title', 'repeatTitle'], ['repeat-orders-lead', 'repeatLead'], ['repeat-days-label', 'daysLabel'], ['repeat-start-label', 'startLabel'], ['repeat-time-label', 'timeLabel'],
    ['addresses-title', 'addressesTitle'], ['addresses-lead', 'addressesLead'], ['address-label-label', 'addressLabel'], ['address-landmark-label', 'landmarkLabel'], ['paying-title', 'payingTitle'],
    ['occasions-title', 'occasionsTitle'], ['occasions-lead', 'occasionsLead'], ['occasion-day-label', 'occasionDay'], ['occasion-yes-label', 'occasionYes'], ['ai-title', 'aiTitle'], ['ai-switch-label', 'aiSwitch']]) say(id, t(k));
  words('repeat-save', 'repeatSave', 'repeat'); words('address-save', 'addressSave', 'navigation'); words('paying-remove', 'payingRemove', 'wallet'); words('occasion-save', 'occasionSave', 'calendar-check');
  radios('repeat-every', 'repeat-every', ['days', 'weekdays'], (v) => t(v === 'days' ? 'everyDays' : 'onWeekdays'), 'days');
  radios('repeat-how', 'repeat-how', ['pickup', 'delivery'], (v) => t(v === 'pickup' ? 'pickup' : 'deliver'), 'pickup');
  radios('occasion-kind', 'occasion-kind', ['birthday', 'anniversary'], (v) => t(v), 'birthday');
  const days = el('repeat-weekdays');
  const kept = new Set([...days.querySelectorAll('input:checked')].map((i) => Number(i.value)));
  days.replaceChildren(...[0, 1, 2, 3, 4, 5, 6].map((d) => { const l = document.createElement('label'); const i = document.createElement('input'); i.type = 'checkbox'; i.value = String(d); i.checked = kept.has(d); l.append(i, document.createTextNode(` ${t(`wd${d}`)}`)); return l; }));
  if (el('repeat-start').value === '') el('repeat-start').value = today();
  el('repeat-start').min = today();
  const weekly = picked('repeat-every') === 'weekdays';
  days.hidden = !weekly; el('repeat-days').hidden = weekly; el('repeat-days-label').hidden = weekly;
  const deliver = picked('repeat-how') === 'delivery';
  el('repeat-time').hidden = !deliver; el('repeat-time-label').hidden = !deliver;
}
el('repeat-every').addEventListener('change', paintAccountWords);
el('repeat-how').addEventListener('change', paintAccountWords);

async function paintRepeatOrders() {
  const out = await shop().commerce.repeatOrders();
  if (!out.ok) { el('repeat-orders').replaceChildren(); say('repeat-say', refusalWords(out)); return; }
  const list = out.value.subscriptions ?? [];
  el('repeat-orders-empty').hidden = list.length > 0; el('repeat-orders-empty').textContent = t('repeatNone');
  el('repeat-orders').replaceChildren(...list.map((s) => {
    const row = document.createElement('div'); row.className = 'row'; row.dataset.subscription = s.subscriptionId; row.dataset.state = s.state;
    const what = s.lines.map((l) => `${nameOf(l.productId)} × ${l.quantityMinor}`).join(', ');
    const when = s.schedule.kind === 'every_days' ? `${t('everyDays')}: ${s.schedule.days}` : s.schedule.weekdays.map((d) => t(`wd${d}`)).join(' ');
    row.append(node('span', `${s.state === 'active' ? '●' : '○'} ${t(`st_${s.state}`)} — ${what}`, 'name'));
    const acts = document.createElement('div'); acts.className = 'qty';
    if (s.state === 'active') acts.append(button(t('pause'), 'pause', () => { void change(s.subscriptionId, 'pause'); }, 'pause'));
    if (s.state === 'paused') acts.append(button(t('resume'), 'refresh-cw', () => { void change(s.subscriptionId, 'resume'); }, 'resume'));
    if (s.state !== 'cancelled') acts.append(button(t('cancel'), 'x', () => { void change(s.subscriptionId, 'cancel'); }, 'cancel'));
    row.append(acts);
    row.append(node('span', `${when} · ${s.fulfilment === 'delivery' ? t('deliver') : t('pickup')}${(s.nextDays ?? []).length > 0 ? ` · ${t('next')}: ${s.nextDays.slice(0, 3).join(', ')}` : ''}`, 'note'));
    for (const o of (s.occurrences ?? []).slice(0, 3)) row.append(node('span', `${o.outcome === 'placed' ? '✓' : '⚠'} ${o.day} — ${t(o.outcome)}${o.outcome === 'placed' ? '' : ` (${o.detail ?? ''})`}`, `note ${o.outcome === 'placed' ? '' : 'bad'}`));
    return row;
  }));
}
async function change(id, how) {
  const out = await shop().commerce.changeRepeatOrder(id, how);
  say('repeat-say', out.ok ? out.value.say ?? '' : refusalWords(out));
  await paintRepeatOrders();
}
el('repeat-save').addEventListener('click', async () => {
  const every = picked('repeat-every') === 'weekdays' ? 'weekdays' : 'days';
  const out = await shop().commerce.startRepeatOrder({
    today: today(), startsOn: el('repeat-start').value, every, days: Number(el('repeat-days').value),
    weekdays: [...el('repeat-weekdays').querySelectorAll('input:checked')].map((i) => Number(i.value)),
    fulfilment: picked('repeat-how') === 'delivery' ? 'delivery' : 'pickup', slotTime: el('repeat-time').value,
  });
  say('repeat-say', out.ok ? t('repeatSaved') : refusalWords(out));
  if (out.ok) await paintRepeatOrders();
});

async function paintAddresses() {
  const out = await shop().commerce.addresses();
  if (!out.ok) { el('addresses').replaceChildren(); say('address-say', refusalWords(out)); return; }
  const list = out.value.addresses ?? [];
  el('addresses-empty').hidden = list.length > 0; el('addresses-empty').textContent = t('addressesNone');
  el('addresses').replaceChildren(...list.map((a) => {
    const row = document.createElement('div'); row.className = 'row'; row.dataset.address = a.addressId;
    row.append(node('span', `${a.label}${a.landmark ? ` — ${a.landmark}` : ''}`, 'name'));
    const acts = document.createElement('div'); acts.className = 'qty';
    acts.append(button(t('use'), 'navigation', () => { shop().commerce.useAddress(a.location); say('address-say', `${t('usingAddress')} ${a.label}`); }, 'use'));
    acts.append(button(t('remove'), 'trash', async () => { const r = await shop().commerce.removeAddress(a.addressId); say('address-say', r.ok ? t('removed') : refusalWords(r)); await paintAddresses(); }, 'remove'));
    row.append(acts);
    return row;
  }));
}
el('address-save').addEventListener('click', async () => {
  const label = el('address-label').value.trim();
  if (label === '') { say('address-say', t('addressNeedsLabel')); return; }
  const out = await shop().commerce.saveAddress(label, el('address-landmark').value);
  say('address-say', out.ok ? t('addressSaved') : refusalWords(out));
  if (out.ok) { el('address-label').value = ''; el('address-landmark').value = ''; await paintAddresses(); }
});

async function paintPaying() {
  const out = await shop().commerce.paymentMethods();
  // The shop's answer decides; the words are this screen's, in this language. Nothing saved is the only state there is.
  say('paying-say', out.ok ? (out.value.saved?.length === 0 ? t('payingSay') : out.value.say) : refusalWords(out));
}
el('paying-remove').addEventListener('click', () => { say('paying-say', t('payingRemoved')); });

async function paintOccasions() {
  const out = await shop().commerce.occasions();
  if (!out.ok) { el('occasions').replaceChildren(); return; }
  el('occasions').replaceChildren(...(out.value.occasions ?? []).map((o) => {
    const row = document.createElement('div'); row.className = 'row'; row.dataset.occasion = o.occasionId;
    row.append(node('span', `${t(o.kind)} — ${o.monthDay}`, 'name'));
    row.append(button(t('remove'), 'trash', async () => { const r = await shop().commerce.removeOccasion(o.occasionId); say('occasion-say', r.ok ? t('removed') : refusalWords(r)); await paintOccasions(); }, 'remove'));
    return row;
  }));
}
el('occasion-save').addEventListener('click', async () => {
  const day = el('occasion-day').value;
  if (day === '') { say('occasion-say', t('occasionNeedsDay')); return; }
  if (!el('occasion-yes').checked) { say('occasion-say', t('occasionNeedsYes')); return; }
  const out = await shop().commerce.giveOccasion(picked('occasion-kind') === 'anniversary' ? 'anniversary' : 'birthday', day.slice(5), true);
  say('occasion-say', out.ok ? t('occasionSaved') : refusalWords(out));
  if (out.ok) { el('occasion-yes').checked = false; await paintOccasions(); }
});

let aiOptedIn = false;
async function paintAi() {
  const out = await shop().commerce.suggestions();
  if (!out.ok) { say('ai-say', refusalWords(out)); return; }
  aiOptedIn = out.value.personalisation?.optedIn === true;
  el('ai-lead').textContent = out.value.notice?.[lang()] ?? '';
  el('ai-switch').setAttribute('aria-checked', String(aiOptedIn)); el('ai-switch').textContent = aiOptedIn ? t('on') : t('off');
  say('ai-why', aiOptedIn ? t('aiWhyOn') : t('aiWhyOff'));
  el('bought-before').replaceChildren(...(out.value.boughtBefore ?? []).map((b) => ideaRow(b.productId, 'ai', t('boughtBefore'))));
}
el('ai-switch').addEventListener('click', async () => {
  const out = await shop().commerce.setAiPersonalisation(!aiOptedIn);
  say('ai-say', out.ok ? '' : out.tellTheCustomer);
  await paintAi();
});

// ── The hook app.js calls ─────────────────────────────────────────────────────────────────────────────────────────

window.shopCommerce = {
  tracked: (t) => { lastTracked = t; if (rules() !== undefined) paintHandover(); },
  render: (view) => {
    if (shop() === undefined || rules() === undefined) return;
    paintVoice(); void paintScan();
    if (view === 'basket') { paintQuote(); paintSubs(); paintAiNotice(); }
    if (view === 'order') paintOrderExtras();
    if (view === 'account') {
      paintAccountWords();
      if (!signedIn()) { say('account-say', t('signIn')); return; }
      say('account-say', '');
      void paintRepeatOrders(); void paintAddresses(); void paintPaying(); void paintOccasions(); void paintAi();
    }
  },
};
if (shop() !== undefined && rules() !== undefined) { paintVoice(); void paintScan(); }
