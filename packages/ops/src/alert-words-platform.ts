// OB-435: the words of head office's own observed-health alerts (services/platform/src/observed-health.ts) and of the alert
// lifecycle's own facts (cleared, updated), in English and Tamil. The English is word for word what it was before.

import { s, n, l, opt, type AlertTemplate } from './alert-text';

/** The state of a built-in alert rule, in Tamil (English keeps the state's own name, as it always did). */
const RULE_STATE_TA: Readonly<Record<string, string>> = { on: 'இயக்கத்தில்', edited: 'திருத்தப்பட்டது', off: 'அணைக்கப்பட்டது', no_owner: 'உரிமையாளர் இல்லை' };

export const PLATFORM_WORDS = {
  // ── the lifecycle's own facts ────────────────────────────────────────────────────────────────────────────────────
  'alert.cleared.notFiring': {
    en: (p) => `${s(p['component'])} is no longer at ${s(p['status'])} or worse`,
    ta: (p) => `${s(p['component'])} இப்போது "${s(p['status'])}" நிலையிலோ அதைவிட மோசமாகவோ இல்லை`,
    sample: { component: { kind: 'alert.component', params: { component: 'backup' } }, status: { kind: 'alert.status', params: { status: 'down' } } },
  },
  'alert.updated.members': {
    en: (p) => `now about ${l(p['now']).length === 0 ? 'nothing' : l(p['now']).join(', ')} (was ${l(p['was']).join(', ')})`,
    ta: (p) => `இப்போது ${l(p['now']).length === 0 ? 'எதைப் பற்றியும் இல்லை' : `${l(p['now']).join(', ')} பற்றியது`} (முன்பு: ${l(p['was']).join(', ')})`,
    sample: { now: ['store-1', 'store-2'], was: ['store-1'] },
  },

  // ── OB-95: separation of duties ─────────────────────────────────────────────────────────────────────────────────
  'access.sod': {
    en: (p) => `separation of duties (owner decision OB-95): ${l(p['people']).join('; ')} — given before head office refused it. Head office now refuses any grant that would do this; end the mix by removing one side (a joiner/mover change, or a leaver and a new sign-in for the other work), so the person who looks after the computers never also runs the shop`,
    ta: (p) => `பணிப் பிரிப்பு (உரிமையாளர் முடிவு OB-95): ${l(p['people']).join('; ')} — தலைமை அலுவலகம் இதை மறுக்கத் தொடங்கும் முன்பே வழங்கப்பட்டது. இனி இப்படி ஆகும் எந்த அனுமதியையும் தலைமை அலுவலகம் மறுக்கும்; ஒரு பக்கத்தை நீக்கி இந்தக் கலவையை முடியுங்கள் (சேர்தல்/இடமாற்றம் மாற்றம், அல்லது விலகல் செய்து மற்ற வேலைக்குப் புதிய உள்நுழைவு) — கணினிகளைப் பார்த்துக்கொள்பவர் ஒருபோதும் கடையையும் நடத்தக்கூடாது`,
    sample: { people: [{ kind: 'access.sod.person', params: { userId: 'u-1', itRoles: ['platform_admin'], businessRoles: ['store_manager'] } }] },
  },
  'access.sod.person': {
    en: (p) => `${s(p['userId'])} holds the IT/platform role (${l(p['itRoles']).join(', ')}) AND business role(s) (${l(p['businessRoles']).join(', ')})`,
    ta: (p) => `${s(p['userId'])} IT/தளப் பணியையும் (${l(p['itRoles']).join(', ')}) வணிகப் பணி(களை)யும் (${l(p['businessRoles']).join(', ')}) ஒருசேர வைத்திருக்கிறார்`,
    sample: { userId: 'u-1', itRoles: ['platform_admin'], businessRoles: ['store_manager'] },
  },

  // ── verifier r20 HW-2: the bill-number high-water waiting on an open transaction ──────────────────────────────────
  'box.highWater': {
    en: (p) => `bill-number high-water is waiting on an open database transaction since ${s(p['since'])} (${n(p['minutes'])} min): head office still counts every bill number correctly, but each count re-reads every bill since then and gets slower until that transaction ends. Ask the database administrator to find it — a session "idle in transaction" or a prepared transaction anywhere on the database server (pg_stat_activity, pg_prepared_xacts) — and end it`,
    ta: (p) => `பில் எண் கணக்கீடு ${s(p['since'])} முதல் (${n(p['minutes'])} நிமிடம்) திறந்திருக்கும் ஒரு தரவுத்தளப் பரிவர்த்தனைக்காகக் காத்திருக்கிறது: தலைமை அலுவலகம் இன்னும் ஒவ்வொரு பில் எண்ணையும் சரியாகவே எண்ணுகிறது, ஆனால் அந்தப் பரிவர்த்தனை முடியும் வரை ஒவ்வொரு எண்ணிக்கையும் அதன் பிறகான எல்லாப் பில்களையும் மீண்டும் படித்து மெதுவாகும். தரவுத்தள நிர்வாகியிடம் அதைக் கண்டுபிடித்து முடிக்கச் சொல்லுங்கள் — தரவுத்தள சேவையகத்தில் எங்காவது "idle in transaction" அமர்வு அல்லது prepared transaction (pg_stat_activity, pg_prepared_xacts)`,
    sample: { since: '2026-10-28T09:00:00Z', minutes: 7 },
  },

  // ── PA-12: a failed or missed backup ────────────────────────────────────────────────────────────────────────────
  'backup.latestFailed': {
    en: (p) => `the latest backup (${s(p['backupId'])}, ${s(p['at'])}) ${l(p['why']).join(', ')}; ${s(p['then'])}`,
    ta: (p) => `கடைசி காப்புப் பிரதி (${s(p['backupId'])}, ${s(p['at'])}): ${l(p['why']).join(', ')}; ${s(p['then'])}`,
    sample: { backupId: 'b-7', at: '2026-10-28T02:00:00Z', why: [{ kind: 'backup.why.notCompleted' }, { kind: 'backup.why.noOffsite' }], then: { kind: 'health.backup.recent', params: { ageSeconds: 3_700 } } },
  },
  'backup.why.notCompleted': { en: () => 'did not complete', ta: () => 'முடியவில்லை', sample: {} },
  'backup.why.notEncrypted': { en: () => 'is not encrypted', ta: () => 'மறையாக்கம் (encryption) செய்யப்படவில்லை', sample: {} },
  'backup.why.noOffsite': { en: () => 'has no off-site copy', ta: () => 'கடைக்கு வெளியே நகல் இல்லை', sample: {} },
  'backup.missed.never': {
    en: (p) => `MISSED — no good backup has reported since backups became expected (${s(p['since'])}); one was due by ${s(p['due'])}. A backup that does not report is treated as not taken`,
    ta: (p) => `தவறிவிட்டது — காப்புப் பிரதி எதிர்பார்க்கப்படத் தொடங்கியதிலிருந்து (${s(p['since'])}) எந்த நல்ல காப்புப் பிரதியும் தெரிவிக்கப்படவில்லை; ${s(p['due'])} க்குள் ஒன்று வந்திருக்க வேண்டும். தெரிவிக்காத காப்புப் பிரதி எடுக்கப்படாததாகவே கருதப்படும்`,
    sample: { since: '2026-10-27T00:00:00Z', due: '2026-10-28T00:00:00.000Z' },
  },
  'backup.missed.due': {
    en: (p) => `MISSED — the next good backup was due by ${s(p['due'])} (the last good one was ${s(p['lastId'])} at ${s(p['lastAt'])})`,
    ta: (p) => `தவறிவிட்டது — அடுத்த நல்ல காப்புப் பிரதி ${s(p['due'])} க்குள் வந்திருக்க வேண்டும் (கடைசி நல்லது ${s(p['lastId'])}, ${s(p['lastAt'])})`,
    sample: { due: '2026-10-28T02:00:00.000Z', lastId: 'b-6', lastAt: '2026-10-27T02:00:00Z' },
  },
  'backup.missed.withPrevious': {
    en: (p) => `${s(p['missed'])}; ${s(p['then'])}`,
    ta: (p) => `${s(p['missed'])}; ${s(p['then'])}`,
    sample: { missed: { kind: 'backup.missed.due', params: { due: '2026-10-28T02:00:00.000Z', lastId: 'b-6', lastAt: '2026-10-27T02:00:00Z' } }, then: { kind: 'health.backup.overdue', params: { ageSeconds: 200_000 } } },
  },

  // ── round 31-39 · OB-114/115/124/130/134: the built-in alert rules, as the owner's notice says them ───────────────
  'rules.owners': {
    en: (p) => (l(p['ids']).length === 0 ? 'the owner (nobody holds the owner role now)' : l(p['ids']).length === 1 ? `the owner (${l(p['ids'])[0]})` : `every owner (all ${l(p['ids']).length}: ${l(p['ids']).join(', ')})`),
    ta: (p) => (l(p['ids']).length === 0 ? 'உரிமையாளர் (இப்போது யாரும் உரிமையாளர் பணியில் இல்லை)' : l(p['ids']).length === 1 ? `உரிமையாளர் (${l(p['ids'])[0]})` : `ஒவ்வொரு உரிமையாளரும் (மொத்தம் ${l(p['ids']).length}: ${l(p['ids']).join(', ')})`),
    sample: { ids: ['u-owner-1', 'u-owner-2'] },
  },
  'rules.redirectGone': {
    en: (p) => `the owner's edit redirects it to ${s(p['name'])} (${s(p['id'])}) only, but ${s(p['id'])} no longer holds any role that may see alerts, so it goes to the owners instead — until the owner removes this edit, or ${s(p['id'])} is given a role that may see alerts again, when it goes back to ${s(p['name'])} by itself (OB-115, OB-134). Saving the rule as shown here ("every owner") keeps the edit; to stop it going back, the owner removes the edit (sends the rules without it)`,
    ta: (p) => `உரிமையாளரின் திருத்தம் இதை ${s(p['name'])} (${s(p['id'])}) க்கு மட்டும் அனுப்புகிறது, ஆனால் ${s(p['id'])} இப்போது எச்சரிக்கைகளைப் பார்க்கக்கூடிய எந்தப் பணியிலும் இல்லை; அதனால் இது உரிமையாளர்களுக்குச் செல்கிறது — உரிமையாளர் இந்தத் திருத்தத்தை நீக்கும் வரை, அல்லது ${s(p['id'])} க்கு மீண்டும் எச்சரிக்கை பார்க்கும் பணி கொடுக்கப்படும் வரை; அப்போது இது தானாகவே ${s(p['name'])} க்குத் திரும்பும் (OB-115, OB-134). இங்கே காட்டியபடியே ("ஒவ்வொரு உரிமையாளரும்") விதியைச் சேமித்தால் திருத்தம் அப்படியே இருக்கும்; திரும்பாமல் நிறுத்த, உரிமையாளர் திருத்தத்தை நீக்க வேண்டும் (அது இல்லாமல் விதிகளை அனுப்புதல்)`,
    sample: { name: 'Store Manager One', id: 'u-mgr-1' },
  },
  'rules.recipients.ownersRedirectGone': {
    en: (p) => `${s(p['owners'])} — ${s(p['gone'])}`,
    ta: (p) => `${s(p['owners'])} — ${s(p['gone'])}`,
    sample: { owners: { kind: 'rules.owners', params: { ids: ['u-owner-1'] } }, gone: { kind: 'rules.redirectGone', params: { name: 'Store Manager One', id: 'u-mgr-1' } } },
  },
  'rules.recipients.redirect': {
    en: (p) => `${s(p['name'])} (${s(p['id'])}) ONLY — redirected by the owner's edit (OB-115); ${l(p['owners']).length === 0 ? 'nobody holds the owner role now' : `${l(p['owners']).join(', ')} ${l(p['owners']).length === 1 ? 'does' : 'do'} NOT get it`}`,
    ta: (p) => `${s(p['name'])} (${s(p['id'])}) க்கு மட்டும் — உரிமையாளரின் திருத்தத்தால் திருப்பி அனுப்பப்பட்டது (OB-115); ${l(p['owners']).length === 0 ? 'இப்போது யாரும் உரிமையாளர் பணியில் இல்லை' : `${l(p['owners']).join(', ')} க்கு இது செல்லாது`}`,
    sample: { name: 'Store Manager One', id: 'u-mgr-1', owners: ['u-owner-1'] },
  },
  'rules.editWords': {
    en: (p) => `to ${s(p['recipients'])}, at ${s(p['firesAt'])}, answered within ${n(p['ackWithinMinutes'])} minutes${opt(p['escalatesTo']) === undefined ? '' : `, escalating to ${s(p['escalatesTo'])}`}`,
    ta: (p) => `${s(p['recipients'])} க்கு, "${s(p['firesAt'])}" நிலையில், ${n(p['ackWithinMinutes'])} நிமிடங்களுக்குள் பதில்${opt(p['escalatesTo']) === undefined ? '' : `, ${s(p['escalatesTo'])} க்கு மேலே அனுப்பப்படும்`}`,
    sample: { recipients: { kind: 'rules.owners', params: { ids: ['u-owner-1'] } }, firesAt: 'down', ackWithinMinutes: 60, escalatesTo: 'u-owner-2' },
  },
  'rules.change.off': { en: (p) => `turned ${s(p['id'])} OFF`, ta: (p) => `${s(p['id'])} அணைக்கப்பட்டது`, sample: { id: 'built-in:store-computer-checks-stuck' } },
  'rules.change.on': { en: (p) => `turned ${s(p['id'])} back on`, ta: (p) => `${s(p['id'])} மீண்டும் இயக்கப்பட்டது`, sample: { id: 'built-in:store-computer-checks-stuck' } },
  'rules.change.removedEdit': {
    en: (p) => `removed the owner's edit of ${s(p['id'])} (it goes back to the built-in rule, to ${s(p['owners'])})`,
    ta: (p) => `${s(p['id'])} இன் உரிமையாளர் திருத்தம் நீக்கப்பட்டது (இது உள்ளமைந்த விதிக்கே திரும்புகிறது, ${s(p['owners'])} க்கு)`,
    sample: { id: 'built-in:store-computer-checks-stuck', owners: { kind: 'rules.owners', params: { ids: ['u-owner-1'] } } },
  },
  'rules.change.edited': {
    en: (p) => `edited ${s(p['id'])}: it would go ${s(p['words'])}`,
    ta: (p) => `${s(p['id'])} திருத்தப்பட்டது: இது இனி செல்லும் விதம் — ${s(p['words'])}`,
    sample: { id: 'built-in:store-computer-checks-stuck', words: { kind: 'rules.editWords', params: { recipients: 'the owner (u-owner-1)', firesAt: 'down', ackWithinMinutes: 30 } } },
  },
  'rules.change.changedEdit': {
    en: (p) => `changed the edit of ${s(p['id'])}: from ${s(p['from'])} to ${s(p['to'])}`,
    ta: (p) => `${s(p['id'])} இன் திருத்தம் மாற்றப்பட்டது: முன்பு ${s(p['from'])}; இப்போது ${s(p['to'])}`,
    sample: { id: 'built-in:store-computer-checks-stuck', from: { kind: 'rules.editWords', params: { recipients: 'the owner (u-owner-1)', firesAt: 'down', ackWithinMinutes: 60 } }, to: { kind: 'rules.editWords', params: { recipients: 'the owner (u-owner-1)', firesAt: 'down', ackWithinMinutes: 30 } } },
  },
  'rules.desc.checks': {
    en: (p) => `tells ${s(p['owners'])} when the store computer checks stay "being prepared" (or the saved history cannot be sealed) for more than ${n(p['minutes'])} minutes (owner decisions OB-114, OB-124)`,
    ta: (p) => `கடை கணினிச் சோதனைகள் ${n(p['minutes'])} நிமிடங்களுக்கு மேல் "தயாராகிக்கொண்டிருக்கிறது" என்றே இருந்தால் (அல்லது சேமித்த வரலாற்றை முத்திரையிட முடியாவிட்டால்) ${s(p['owners'])} க்குச் சொல்லும் (உரிமையாளர் முடிவுகள் OB-114, OB-124)`,
    sample: { owners: { kind: 'rules.owners', params: { ids: ['u-owner-1'] } }, minutes: 60 },
  },
  'rules.desc.clock': {
    en: (p) => `tells ${s(p['owners'])} when any store computer's clock is 5 minutes or more out, so new prices and offers are held there — which store, by how many minutes, and what is held; not at the 2-minute warning; cleared when its clock is back in step (owner decisions OB-403, OB-409)`,
    ta: (p) => `ஏதாவது கடை கணினியின் கடிகாரம் 5 நிமிடமோ அதற்கு மேலோ தவறி, அங்கே புதிய விலைகளும் சலுகைகளும் நிறுத்தப்பட்டால் ${s(p['owners'])} க்குச் சொல்லும் — எந்தக் கடை, எத்தனை நிமிடம், எது நிறுத்தப்பட்டது; 2 நிமிட எச்சரிக்கையில் அல்ல; கடிகாரம் சரியானதும் நீங்கும் (உரிமையாளர் முடிவுகள் OB-403, OB-409)`,
    sample: { owners: { kind: 'rules.owners', params: { ids: ['u-owner-1'] } } },
  },
  'rules.desc.off': {
    en: (p) => `${s(p['base'])} — TURNED OFF${opt(p['by']) === undefined ? '' : ` (last changed by ${s(p['by'])} at ${s(p['at'])})`}`,
    ta: (p) => `${s(p['base'])} — அணைக்கப்பட்டுள்ளது${opt(p['by']) === undefined ? '' : ` (கடைசியாக மாற்றியவர் ${s(p['by'])}, ${s(p['at'])})`}`,
    sample: { base: { kind: 'rules.desc.clock', params: { owners: { kind: 'rules.owners', params: { ids: ['u-owner-1'] } } } }, by: 'u-owner-1', at: '2026-10-28T09:00:00Z' },
  },
  'rules.desc.editNoOwner': {
    en: (p) => `${s(p['base'])} — the owner's edit is NOT in force: nobody holds the owner role${s(p['why'])}`,
    ta: (p) => `${s(p['base'])} — உரிமையாளரின் திருத்தம் நடைமுறையில் இல்லை: யாரும் உரிமையாளர் பணியில் இல்லை${s(p['why'])}`,
    sample: { base: { kind: 'rules.desc.checks', params: { owners: { kind: 'rules.owners', params: { ids: [] } }, minutes: 60 } }, why: '' },
  },
  'rules.desc.edited': {
    en: (p) => `${s(p['base'])} — edited: answered within ${n(p['ackWithinMinutes'])} minutes, at ${s(p['firesAt'])}${opt(p['escalatesTo']) === undefined ? '' : `, escalating to ${s(p['escalatesTo'])}`}${s(p['why'])}`,
    ta: (p) => `${s(p['base'])} — திருத்தப்பட்டது: ${n(p['ackWithinMinutes'])} நிமிடங்களுக்குள் பதில், "${s(p['firesAt'])}" நிலையில்${opt(p['escalatesTo']) === undefined ? '' : `, ${s(p['escalatesTo'])} க்கு மேலே அனுப்பப்படும்`}${s(p['why'])}`,
    sample: { base: { kind: 'rules.desc.checks', params: { owners: { kind: 'rules.owners', params: { ids: ['u-owner-1'] } }, minutes: 60 } }, ackWithinMinutes: 30, firesAt: 'down', escalatesTo: 'u-owner-2', why: '' },
  },
  'rules.why.gone': { en: (p) => `; ${s(p['gone'])}`, ta: (p) => `; ${s(p['gone'])}`, sample: { gone: { kind: 'rules.redirectGone', params: { name: 'Store Manager One', id: 'u-mgr-1' } } } },
  'rules.why.legacy': {
    en: (p) => `; this edit was saved before round 36 naming ${s(p['id'])} — it is read as going to every owner (to send it to one person only, the owner saves the edit again naming that person)`,
    ta: (p) => `; இந்தத் திருத்தம் ${s(p['id'])} ஐப் பெயரிட்டு முன்பே (round 36 க்கு முன்) சேமிக்கப்பட்டது — இது ஒவ்வொரு உரிமையாளருக்கும் செல்வதாகவே படிக்கப்படுகிறது (ஒருவருக்கு மட்டும் அனுப்ப, உரிமையாளர் அந்த நபரைப் பெயரிட்டுத் திருத்தத்தை மீண்டும் சேமிக்க வேண்டும்)`,
    sample: { id: 'u-owner-old' },
  },
  'rules.desc.redirected': {
    en: (p) => `the owner's edit of this rule sends it to ${s(p['recipients'])}, when the store computer checks stay "being prepared" (or the saved history cannot be sealed) for more than ${n(p['minutes'])} minutes (owner decisions OB-114, OB-115)`,
    ta: (p) => `கடை கணினிச் சோதனைகள் ${n(p['minutes'])} நிமிடங்களுக்கு மேல் "தயாராகிக்கொண்டிருக்கிறது" என்றே இருந்தால் (அல்லது சேமித்த வரலாற்றை முத்திரையிட முடியாவிட்டால்), உரிமையாளரின் திருத்தம் இந்த விதியை ${s(p['recipients'])} க்கு அனுப்புகிறது (உரிமையாளர் முடிவுகள் OB-114, OB-115)`,
    sample: { recipients: { kind: 'rules.recipients.redirect', params: { name: 'Store Manager One', id: 'u-mgr-1', owners: ['u-owner-1'] } }, minutes: 60 },
  },
  'rules.desc.noOwner': {
    en: (p) => `${s(p['base'])} — NOT in force: nobody holds the owner role`,
    ta: (p) => `${s(p['base'])} — நடைமுறையில் இல்லை: யாரும் உரிமையாளர் பணியில் இல்லை`,
    sample: { base: { kind: 'rules.desc.checks', params: { owners: { kind: 'rules.owners', params: { ids: [] } }, minutes: 60 } } },
  },
  'rules.notice': {
    en: (p) => `a built-in alert rule was changed by ${s(p['by'])} at ${s(p['at'])} (rules version ${n(p['version'])}): ${l(p['changes']).join('; ')}. Now: ${l(p['now']).join('; ')}. If you did not make this change, check GET /v1/platform/alert-rules and ask who did (owner decision OB-115)`,
    ta: (p) => `ஓர் உள்ளமைந்த எச்சரிக்கை விதியை ${s(p['by'])} ${s(p['at'])} அன்று மாற்றினார் (விதிகள் பதிப்பு ${n(p['version'])}): ${l(p['changes']).join('; ')}. இப்போது: ${l(p['now']).join('; ')}. இந்த மாற்றத்தை நீங்கள் செய்யவில்லை என்றால், எச்சரிக்கை விதிகள் பக்கத்தைப் (GET /v1/platform/alert-rules) பார்த்து, யார் செய்தார் என்று கேளுங்கள் (உரிமையாளர் முடிவு OB-115)`,
    sample: { by: 'u-owner-1', at: '2026-10-28T09:00:00Z', version: 4, changes: [{ kind: 'rules.change.off', params: { id: 'built-in:store-computer-clock-out' } }], now: [{ kind: 'rules.notice.now', params: { id: 'built-in:store-computer-clock-out', state: 'off', description: 'tells the owner (u-owner-1) …' } }] },
  },
  'rules.notice.now': {
    en: (p) => `${s(p['id'])} is ${s(p['state'])}: ${s(p['description'])}`,
    ta: (p) => `${s(p['id'])} — ${RULE_STATE_TA[s(p['state'])] ?? s(p['state'])}: ${s(p['description'])}`,
    sample: { id: 'built-in:store-computer-clock-out', state: 'on', description: { kind: 'rules.desc.clock', params: { owners: { kind: 'rules.owners', params: { ids: ['u-owner-1'] } } } } },
  },
  /** A sentence that is several sentences joined (the English joins them as they always were). */
  'words.joined': {
    en: (p) => l(p['parts']).join(s(p['by'])),
    ta: (p) => l(p['parts']).join(s(p['by'])),
    sample: { parts: [{ kind: 'health.queue.empty' }, { kind: 'health.deadLetter.none' }], by: '; ' },
  },
} as const satisfies Readonly<Record<string, AlertTemplate>>;
