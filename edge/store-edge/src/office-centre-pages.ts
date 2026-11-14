// The Office centre's two pages on the store PC (CR-01 step 4 · OI-06 · OI-07 · OI-09): Users & roles, and Import & export.
// Server-sent shells; one small script on each reads the lists (GET …/state) and sends each act (POST, JSON, from this page
// only) with the person's own PIN, which it clears after every act. Every word is English with its Tamil twin. Nothing is
// written on open; every write is a press. The rules live in office-centre.ts and at head office (this PC's API).

import { OFFICE_CENTRE_PATHS as P } from './office-centre';

const STYLE = [
  'body{font:16px/1.5 system-ui,"Segoe UI","Nirmala UI",sans-serif;margin:0;background:#f5f6f2;color:#1b1f1c}',
  'header{background:#0f4d3a;color:#fff;padding:12px 16px;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between}',
  'header h1{margin:0;font-size:20px}header a{color:#fff}main{max-width:1000px;margin:0 auto;padding:16px;display:grid;gap:16px}',
  'section{background:#fff;border:1px solid #d5dbd5;border-radius:12px;padding:16px;display:grid;gap:10px;min-width:0}',
  'h2{margin:0;font-size:18px}.ta{color:#3e4a43}.note{color:#56635c;font-size:14px}',
  'label{display:grid;gap:4px;font-weight:600;font-size:14px;min-width:0}',
  'input,select{font:inherit;padding:8px 10px;border:1px solid #c7cfc8;border-radius:8px;min-height:44px;width:100%;min-width:0;background:#fff}',
  'button{font:inherit;font-weight:600;min-height:44px;padding:0 16px;border-radius:999px;border:1px solid #0f4d3a;background:#fff;color:#0f4d3a;cursor:pointer}',
  'button.go{background:#0f4d3a;color:#fff}button:disabled{opacity:.5}',
  '.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:10px;align-items:end}',
  '.item{border:1px solid #d5dbd5;border-radius:10px;padding:10px 12px;display:grid;gap:6px}',
  '.chip{display:inline-block;font-size:13px;font-weight:700;padding:2px 10px;border-radius:999px;background:#e6f1ea;color:#0f4d3a;margin:2px 4px 2px 0}',
  '.chip.no{background:#fbeee0;color:#8a4b00}',
  '#answer{padding:10px 12px;border-radius:8px;white-space:pre-wrap}#answer.ok{background:#e6f1ea;color:#0f4d3a}#answer.bad{background:#fbe9e7;color:#8a1f11}',
  '.pinbar{position:sticky;top:0;z-index:1;background:#fffbea;border:1px solid #e8d79a}',
  '[hidden]{display:none!important}',
].join('');

const head = (titleEn: string, titleTa: string): string => [
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  `<title>${titleEn}</title><style>${STYLE}</style></head><body>`,
  `<header><h1>${titleEn} <span lang="ta" class="ta-h">· ${titleTa}</span></h1>`,
  '<nav><a href="/manager/">Office menu <span lang="ta">· அலுவலகப் பட்டியல்</span></a></nav></header><main>',
  '<div id="answer" role="status" aria-live="polite" hidden></div>',
  '<section class="pinbar"><label for="pin">Your own PIN — asked again for every change <span lang="ta" class="ta">· ஒவ்வொரு மாற்றத்திற்கும் உங்கள் சொந்த PIN மீண்டும் கேட்கப்படும்</span>',
  '<input id="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></label></section>',
].join('');

/** The shared client: read state, send an act with the PIN, show the answer in both languages, clear the PIN. */
const CLIENT = [
  "'use strict';",
  'const $=(id)=>document.getElementById(id);',
  'function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}',
  "function show(o){const a=$('answer');a.hidden=false;a.textContent=(o.en||'')+(o.ta?'\\n'+o.ta:'');a.className=o.ok?'ok':'bad';a.scrollIntoView({block:'nearest'});}",
  'async function getState(path){try{const r=await fetch(path,{headers:{accept:\'application/json\'}});const j=await r.json();if(r.status===401){location.reload();}return j;}catch(e){return {ok:false,en:\'This PC did not answer.\',ta:\'இந்தக் கணினி பதிலளிக்கவில்லை.\'};}}',
  "async function send(path,body){const pin=$('pin');const b=Object.assign({},body,{pin:pin.value});pin.value='';",
  "try{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const j=await r.json();show(j);return j;}",
  "catch(e){const j={ok:false,en:'This PC did not answer. Nothing was done.',ta:'இந்தக் கணினி பதிலளிக்கவில்லை. எதுவும் செய்யப்படவில்லை.'};show(j);return j;}}",
].join('\n');

export function peoplePage(): string {
  return [
    head('Users &amp; roles', 'பயனர்களும் பங்குகளும்'),
    '<p class="note">Who may do what in this shop. A role is given or taken back by two people: one asks, a second approves — never their own request. The IT role and a shop role never go to one person. Everything is recorded. <span lang="ta" class="ta">கடையில் யார் என்ன செய்யலாம். ஒரு பங்கு இருவரால் வழங்கப்படும் அல்லது திரும்பப் பெறப்படும்: ஒருவர் கேட்கிறார், இன்னொருவர் அனுமதிக்கிறார். IT பங்கும் கடைப் பங்கும் ஒருவருக்கு ஒருபோதும் இல்லை. எல்லாம் பதிவு செய்யப்படுகிறது.</span></p>',
    '<section id="decide"><h2>Waiting for you to decide <span lang="ta" class="ta">· உங்கள் முடிவுக்காகக் காத்திருப்பவை</span></h2><div id="decide-list"></div>',
    '<label>Why (for a rejection or a change decision) <span lang="ta" class="ta">· ஏன் (மறுப்புக்கு அல்லது மாற்ற முடிவுக்கு)</span><input id="decide-why"></label></section>',
    '<section id="holders"><h2>Who holds which role here <span lang="ta" class="ta">· இங்கே யார் எந்தப் பங்கு வகிக்கிறார்</span></h2><div id="holder-list"></div>',
    '<label>Why (to take a role back, or because they have left) <span lang="ta" class="ta">· ஏன் (பங்கைத் திரும்பப் பெற, அல்லது அவர் விலகியதால்)</span><input id="back-why"></label></section>',
    '<section id="give"><h2>Add a person, or give a role <span lang="ta" class="ta">· ஒரு நபரைச் சேர், அல்லது பங்கு கொடு</span></h2>',
    '<p class="note">A new person is added by asking for their first role here. It is given only when a second person approves it. <span lang="ta" class="ta">புதிய நபர் அவரது முதல் பங்கைக் கேட்பதன் மூலம் சேர்க்கப்படுகிறார். இரண்டாவது நபர் அனுமதித்தால் மட்டுமே வழங்கப்படும்.</span></p>',
    '<form id="give-form" class="row" autocomplete="off">',
    '<label>Staff ID <span lang="ta" class="ta">· பணியாளர் எண்</span><input id="give-user" placeholder="cashier-02"></label>',
    '<label>Full name <span lang="ta" class="ta">· முழுப் பெயர்</span><input id="give-name"></label>',
    '<label>Role <span lang="ta" class="ta">· பங்கு</span><select id="give-role"></select></label>',
    '<label>Why <span lang="ta" class="ta">· ஏன்</span><input id="give-why"></label>',
    '<button class="go" type="submit">Ask for this role <span lang="ta">· இந்தப் பங்கைக் கேள்</span></button></form></section>',
    '<section id="pinset"><h2>A new person sets their own PIN <span lang="ta" class="ta">· புதிய நபர் தன் சொந்த PIN-ஐ அமைக்கிறார்</span></h2>',
    '<p class="note">Hand the keyboard to the new person: they type their own six-digit PIN twice. You type yours above to confirm. Only a person with no PIN on this PC, and a role asked or given here, can set one. <span lang="ta" class="ta">விசைப்பலகையை புதிய நபரிடம் கொடுங்கள்: அவர் தன் PIN-ஐ இரண்டு முறை உள்ளிடுவார். உறுதிசெய்ய நீங்கள் மேலே உங்கள் PIN-ஐ உள்ளிடுங்கள்.</span></p>',
    '<form id="pin-form" class="row" autocomplete="off">',
    '<label>Staff ID <span lang="ta" class="ta">· பணியாளர் எண்</span><input id="pin-user"></label>',
    '<label>Their new PIN <span lang="ta" class="ta">· அவரது புதிய PIN</span><input id="pin-new" type="password" inputmode="numeric" maxlength="6"></label>',
    '<label>Their new PIN again <span lang="ta" class="ta">· மீண்டும்</span><input id="pin-again" type="password" inputmode="numeric" maxlength="6"></label>',
    '<button class="go" type="submit">Set their PIN <span lang="ta">· PIN அமை</span></button></form></section>',
    '<section id="mine"><h2>My changes <span lang="ta" class="ta">· என் மாற்றங்கள்</span></h2><p class="note">Once a second person approves one, apply it here. <span lang="ta" class="ta">இரண்டாவது நபர் அனுமதித்ததும் இங்கே செயல்படுத்துங்கள்.</span></p><div id="mine-list"></div></section>',
    `<script>${CLIENT}`,
    `const ACT=${JSON.stringify(P.peopleAct)},STATE=${JSON.stringify(P.peopleState)};`,
    'let roles=[];',
    "const roleName=(id)=>{const r=roles.find((x)=>x.id===id);return r?(r.name+(r.nameTa?' · '+r.nameTa:'')):id;};",
    'async function act(body){const j=await send(ACT,body);if(j.ok)await load();}',
    "function btn(label,fn,cls){const b=el('button',label,cls);b.type='button';b.addEventListener('click',fn);return b;}",
    'async function load(){const s=await getState(STATE);if(!s.ok){show(s);return;}roles=s.roles||[];',
    "const sel=$('give-role');sel.replaceChildren(el('option','Choose… · தேர்ந்தெடு'));sel.firstChild.value='';for(const r of roles){if((s.waitingRoles||[]).includes(r.id))continue;const o=el('option',roleName(r.id));o.value=r.id;sel.append(o);}",
    "const d=$('decide-list');d.replaceChildren();",
    "for(const p of s.pending||[]){const it=el('div',undefined,'item');it.append(el('div',p.userId+' — '+roleName(p.roleId)),el('div','Asked by · கேட்டவர்: '+p.requestedBy+' — '+p.reason,'note'));",
    "if(p.mine){it.append(el('div','You asked for this, so someone else decides it. · இதை நீங்கள் கேட்டீர்கள்; வேறொருவர் முடிவு செய்வார்.','note'));}else{it.append(btn('Approve · அனுமதி',()=>act({act:'approve',grantId:p.grantId}),'go'),btn('Reject · மறு',()=>act({act:'reject',grantId:p.grantId,reason:$('decide-why').value})));}d.append(it);}",
    "for(const c of s.toDecide||[]){const it=el('div',undefined,'item');it.append(el('div',c.summary),el('div','Asked by · கேட்டவர்: '+c.requestedBy+' — '+c.reason,'note'),btn('Approve · அனுமதி',()=>act({act:'decide-change',requestId:c.requestId,decision:'approved',reason:$('decide-why').value}),'go'),btn('Reject · மறு',()=>act({act:'decide-change',requestId:c.requestId,decision:'rejected',reason:$('decide-why').value})));d.append(it);}",
    "if(d.children.length===0)d.append(el('p','Nothing is waiting for you. · உங்களுக்காக எதுவும் காத்திருக்கவில்லை.','note'));",
    "const h=$('holder-list');h.replaceChildren();for(const p of s.people||[]){const it=el('div',undefined,'item');it.append(el('strong',p.userId));const chips=el('div');for(const g of p.grants){chips.append(el('span',roleName(g.roleId),'chip'));}",
    "chips.append(el('span',p.hasPin?'Has a PIN · PIN உள்ளது':'No PIN yet · PIN இல்லை','chip'+(p.hasPin?'':' no')));it.append(chips);",
    "if(p.userId!==s.userId&&s.may.ask){for(const g of p.grants){it.append(btn('Take back '+g.roleId+' · திரும்பப் பெறு',()=>act({act:'take-back',userId:p.userId,roleId:g.roleId,reason:$('back-why').value})));}it.append(btn('They have left · அவர் விலகிவிட்டார்',()=>act({act:'leaver',userId:p.userId,reason:$('back-why').value})));}h.append(it);}",
    "if(h.children.length===0)h.append(el('p','Nobody holds a role here yet. · இங்கே இன்னும் யாரும் பங்கு வகிக்கவில்லை.','note'));",
    "const m=$('mine-list');m.replaceChildren();for(const c of s.mine||[]){const it=el('div',undefined,'item');it.append(el('div',c.summary),el('span',c.status,'chip'+(c.status==='approved'?'':' no')));if(c.status==='approved')it.append(btn('Apply now · இப்போது செயல்படுத்து',()=>act({act:'apply',requestId:c.requestId}),'go'));m.append(it);}",
    "if(m.children.length===0)m.append(el('p','You have asked for no change yet. · நீங்கள் இன்னும் எந்த மாற்றமும் கேட்கவில்லை.','note'));",
    "$('give').hidden=!s.may.ask;$('pinset').hidden=!s.may.ask;$('decide').hidden=!s.may.decide&&(s.toDecide||[]).length===0;",
    '}',
    "$('give-form').addEventListener('submit',async(e)=>{e.preventDefault();await act({act:'give',userId:$('give-user').value.trim(),name:$('give-name').value.trim(),roleId:$('give-role').value,reason:$('give-why').value.trim()});});",
    "$('pin-form').addEventListener('submit',async(e)=>{e.preventDefault();const b={act:'set-pin',userId:$('pin-user').value.trim(),newPin:$('pin-new').value,newPinAgain:$('pin-again').value};$('pin-new').value='';$('pin-again').value='';await act(b);});",
    'load();</script></main></body></html>',
  ].join('');
}

export function importExportPage(): string {
  return [
    head('Import &amp; export', 'இறக்குமதி &amp; ஏற்றுமதி'),
    '<section id="import"><h2>Import from the old system <span lang="ta" class="ta">· பழைய அமைப்பிலிருந்து இறக்குமதி</span></h2>',
    '<p class="note">Read the old system\'s Excel reports, fix every gap here by the right person, and load the ready items by two people. <span lang="ta" class="ta">பழைய அமைப்பின் Excel அறிக்கைகளைப் படித்து, ஒவ்வொரு குறையையும் உரியவர் இங்கே சரிசெய்து, தயாரான பொருட்களை இருவர் ஏற்றுவார்கள்.</span></p>',
    `<p><a href="${P.importPrefix}">Open the old-system import <span lang="ta">· பழைய அமைப்பு இறக்குமதியைத் திற</span></a></p></section>`,
    '<section id="export"><h2>Take data out <span lang="ta" class="ta">· தரவை வெளியே எடு</span></h2>',
    '<p class="note">Every export is in your name and logged. Columns you may not see are hidden, not dropped. The file opens in Excel, with Tamil and ₹ intact. <span lang="ta" class="ta">ஒவ்வொரு ஏற்றுமதியும் உங்கள் பெயரில் பதிவு செய்யப்படுகிறது. நீங்கள் பார்க்கக்கூடாத நெடுவரிசைகள் மறைக்கப்படும். கோப்பு Excel-இல் தமிழுடனும் ₹-உடனும் திறக்கும்.</span></p>',
    '<form id="export-form" class="row" autocomplete="off">',
    '<label>What to export <span lang="ta" class="ta">· எதை ஏற்றுமதி செய்வது</span><select id="domain"></select></label>',
    '<label id="from-l" hidden>From <span lang="ta" class="ta">· முதல்</span><input id="from" type="date"></label>',
    '<label id="to-l" hidden>To <span lang="ta" class="ta">· வரை</span><input id="to" type="date"></label>',
    '<button class="go" type="submit">Export to Excel <span lang="ta">· Excel-க்கு ஏற்றுமதி</span></button></form>',
    '<h2>Recent exports <span lang="ta" class="ta">· சமீபத்திய ஏற்றுமதிகள்</span></h2><div id="log"></div></section>',
    `<script>${CLIENT}`,
    `const STATE=${JSON.stringify(P.ioState)},EXPORT=${JSON.stringify(P.ioExport)};let domains=[];`,
    "function save(name,text){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));a.download=name;document.body.append(a);a.click();a.remove();}",
    "function dated(){const d=domains.find((x)=>x.domain===$('domain').value);const on=!!(d&&d.period);$('from-l').hidden=!on;$('to-l').hidden=!on;}",
    'async function load(){const s=await getState(STATE);if(!s.ok){show(s);return;}',
    "$('import').hidden=!s.may.import;$('export').hidden=!s.may.exports;domains=s.domains||[];",
    "const sel=$('domain');sel.replaceChildren(el('option','Choose… · தேர்ந்தெடு'));sel.firstChild.value='';for(const d of domains){const o=el('option',d.domain+(d.period?' (dated · தேதியுடன்)':''));o.value=d.domain;sel.append(o);}",
    "const l=$('log');l.replaceChildren();for(const x of s.exports||[]){l.append(el('div',x.at+' — '+x.userId+' — '+x.domain+' — '+x.rowCount+' rows · வரிசைகள்'+((x.redactedColumns||[]).length?' — hidden · மறைக்கப்பட்டவை: '+x.redactedColumns.join(', '):''),'item'));}",
    "if(l.children.length===0)l.append(el('p','No exports yet. · இதுவரை இல்லை.','note'));",
    '}',
    "$('domain').addEventListener('change',dated);",
    "$('export-form').addEventListener('submit',async(e)=>{e.preventDefault();const j=await send(EXPORT,{domain:$('domain').value,from:$('from').value,to:$('to').value});if(j.ok&&j.csv){save(j.fileName,j.csv);await load();}});",
    'load();</script></main></body></html>',
  ].join('');
}
