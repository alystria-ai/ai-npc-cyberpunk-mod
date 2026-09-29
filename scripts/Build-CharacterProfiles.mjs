import {readFile, readdir, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = async file => JSON.parse((await readFile(resolve(root,file),'utf8')).replace(/^\uFEFF/,''));
const contacts = await read('characters/phone-contacts.json');
const managerCharacters = await read('characters/manager-characters.json');
const characterModels = [...contacts, ...managerCharacters];
const previous = await read('characters/roster.json');
const voices = await read('characters/kokoro-voices.json');
const settings = await read('characters/profile-settings.json');
// Once the reviewed dossier corpus is adopted, every rebuild must use it.
// Falling back to the old combined biographies would silently restore future
// quest outcomes to the static character prompt.
if (settings.profileSource === 'research/cyberpunk/dossiers') {
  const {buildResearch} = await import('../research/cyberpunk/scripts/build_research.mjs');
  await buildResearch({applyProfiles: true});
  process.exit(process.exitCode || 0);
}
const model = settings.model;
if (!model) throw Error('The verified reference model setting is missing.');
const catalog = new Map();
for (const value of voices.voices) {
  if (value.voice_value?.startsWith('convai-kokoro-')) catalog.set(value.name.split(' ')[0], value);
}
const cast = {
  Anna:['alex','ana-friedman','songbird','babs-okoye','briana-dolson','sandra-dorsett'],
  Sarah:['meredith-stout','dakota-smith','carol-emeka','rogue-amendiares','regina-jones','t-bug','spider-murphy'],
  Emily:['blue-moon','cynthia-najarro','resident-female','r3n0'],
  Katie:['panam-palmer','claire-russell','iris-tanner'],
  Laura:['lina-malina'], Linda:['mama-welles','wakako-okada'],
  Julia:['judy-alvarez','lizzy-wizzy','rachel-casich','8ug8ear','evelyn-parker'],
  Helen:['misty-olszewski','joss-kutcher'],
  Noah:['jackie-welles','coach-fred','muamar-reyes','jefferson-peralez'],
  Ethan:['resident-male','jake-estevez','chang-hoon-nam','river-ward','bill-mitchell','liam-northom','steven-santos'],
  Lucas:['robert-wilson','life-coach','pepe-najarro','dennis-cranmer'],
  Ryan:['paco-torres','jesse','dino-dinovic','jim-jarry'], Logan:['kerry-eurodyne','aaron','ozob-bozo','johnny-silverhand'],
  Henry:['cassidy-righter'], Freya:['hanako-arasaka'], Rachel:['elizabeth-peralez','nele-springer'],
  Mark:['arthur-jenkins','dexter-deshawn','saul-bright','yorinobu-arasaka'],
  Cole:['bob-sagan','mitch-anderson','nix','santiago','shank'],
  John:['viktor-vektor','solomon-reed','padre-ibarra','placide','takemura','adam-smasher'],
  Arthur:['sergei-karasinsky','mark-bana'],
  Harry:['mr-hands','alan-noel','frank-nostra','thompson'],
  Amelia:['nancy-hartley']
};
const casting = new Map(Object.entries(cast).flatMap(([voice,keys])=>keys.map(key=>[key,voice])));
// These are three independent Convai character fields. The provisioner maps
// speakingStyleDescription -> speaking_style_description and
// speakingStyleSampleDialogues -> speaking_style_sample_dialogues. Do not append
// either field to backstory: the readable export below is only a local document.
const sharedSpeakingStyle = `Speak as yourself in first person to V, in natural spoken language. Normally answer in one or two short sentences; give more detail when asked. Do not narrate gestures, use markdown, or quote these instructions. The dialogue samples are original examples of delivery, not memories of completed events or reproduced game dialogue.
In a group, respond to the message as yourself. Only the final scheduled speaker may ask V a follow-up question; other speakers leave room for the group.`;
const sharedKnowledgeRules = `Established history and relationships provide your background. A fact marked conditional is a possible quest branch, not a record of this save. Do not volunteer unrevealed quest secrets, deaths, betrayals or endings. Discuss conditional events only after V or verified current-save context establishes them. Do not assume V's gender, lifepath or a romance. Friendship, trust, attraction and an active relationship are different states.
Current-save context outranks remembered claims. Being present as a summoned companion does not prove that a quest was completed, a dead character revived, or an old acquaintance met in this timeline. Do not invent missing canon to fill gaps. Never claim to grant items, move vehicles, complete missions or change the world unless an advertised game action reports success.
In a group, acknowledge only statements you actually heard. Do not reveal private conversation history.`;

// Research summaries mix identity and editorial delivery guidance. Keep the
// exact research in roster.summary; only its factual introduction belongs in
// the API biography. Later prose stays intact in the speaking-style field.
const summaryStyleStarts = {
  'coach-fred':'Play Fred', 'cynthia-najarro':'Her voice should',
  'dakota-smith':'Dakota should sound', 'dennis-cranmer':'Play Dennis',
  'dexter-deshawn':'His relaxed charm', 'dino-dinovic':'Give Dino',
  'elizabeth-peralez':'Play Elizabeth', 'evelyn-parker':"Evelyn's polish",
  'frank-nostra':'Portray that dependence', 'hanako-arasaka':'Her courtesy should',
  'iris-tanner':'Iris should sound', 'jackie-welles':'Jackie should be',
  'jake-estevez':'Play Jake', 'jefferson-peralez':'His public confidence',
  'jesse':'Treat his embarrassment', 'jim-jarry':'His usable identity',
  'life-coach':'His calm, professionally reassuring delivery',
  'mark-bana':'The restrained professional voice'
};
function splitSummary(profile) {
  const marker=summaryStyleStarts[profile.key];
  const index=marker ? profile.summary.indexOf(marker)
    : profile.summary.search(/Editorial voice:|Editorially\b|(?:His|Her|The) editorial voice\b/);
  if(index<=0)throw Error('Review the biography/style boundary for '+profile.key);
  return {identity:profile.summary.slice(0,index).trim(),style:profile.summary.slice(index).trim()};
}
function splitUncertainty(profile) {
  const knowledge=[],style=[];
  for(const note of profile.uncertainty||[]){
    // A few research notes qualify the original examples or editorial voice.
    // Their neighboring factual limits still belong in the biography.
    for(const sentence of note.split(/(?<=[.;])\s+/)){
      const styleNote=/editorial|original samples|dialogue examples|speaking style|performance guidance|shared quest-page derivation/i.test(sentence);
      (styleNote?style:knowledge).push(sentence);
    }
  }
  return {knowledge,style};
}
const words=value=>value.trim().split(/\s+/).length;
const sampleText=(name,samples)=>samples.map(s=>`V: ${s.user}\n${name}: ${s.character}`).join('\n\n');
const ownershipMarker=key=>`[CyberpunkConvai profile v2:${key}]`;

const files=(await readdir(resolve(root,'characters/research'))).filter(f=>/^contacts-[a-e]\.json$/.test(f) || f==='manager-extras.json').sort();
const research=(await Promise.all(files.map(f=>read('characters/research/'+f)))).flat();
const expected=new Map(characterModels.filter(c=>c.key&&c.record).map(c=>[c.key,c]));
const actual=new Map();
for(const p of research){
  if(actual.has(p.key)||!expected.has(p.key))throw Error('Duplicate or unexpected researched key: '+p.key);
  if(!p.summary||!Array.isArray(p.facts)||!p.facts.length||!p.sources?.length||!Array.isArray(p.sampleDialogue)||p.sampleDialogue.length<5||!p.speakingRules?.length)throw Error('Incomplete research: '+p.key);
  for(const fact of p.facts)if(!fact.text||typeof fact.conditional!=='boolean'||!fact.sources?.length)throw Error('Uncited fact: '+p.key);
  for(const sample of p.sampleDialogue)if(!sample.user?.trim()||!sample.character?.trim())throw Error('Incomplete dialogue sample: '+p.key);
  actual.set(p.key,p);
}
const missing=[...expected.keys()].filter(k=>!actual.has(k));
if(missing.length)throw Error('Missing character research: '+missing.join(', '));
const built=[];
for(const [key,p] of [...actual].sort(([a],[b])=>a.localeCompare(b))){
  const old=previous.find(o=>o.key===key);
  const voice=catalog.get(casting.get(key));
  if(!voice)throw Error('No reviewed Kokoro casting for '+key);
  if(p.gender?.toUpperCase()!==voice.gender?.toUpperCase())throw Error('Voice gender mismatch: '+key);
  const name=expected.get(key).name;
  const summary=splitSummary(p);
  const uncertainty=splitUncertainty(p);
  const known=p.facts.filter(f=>!f.conditional).map(f=>f.text);
  const conditional=p.facts.filter(f=>f.conditional).map(f=>f.text);
  const backstory=[`IDENTITY\nYou are ${name}. ${summary.identity}`,
    'BACKGROUND\n'+known.join('\n'),
    'CONDITIONAL STORY KNOWLEDGE — NOT COMPLETED SAVE EVENTS\n'+(conditional.join('\n')||'No additional verified quest branches are supplied.'),
    'RELATIONSHIPS\n'+p.relationships.map(r=>`${r.name} — ${r.relationship}. ${r.conditional?'Conditional on the current save: ':''}${r.detail}`).join('\n'),
    'CURRENT SAVE AND KNOWLEDGE RULES\n'+sharedKnowledgeRules,
    'KNOWLEDGE LIMITS — INTERNAL GUIDANCE\n'+(uncertainty.knowledge.join('\n')||'Do not invent additional biographical details.'),
    ownershipMarker(key)].join('\n\n');
  const speakingStyleDescription=[sharedSpeakingStyle,summary.style,p.speakingRules.join('\n'),uncertainty.style.join('\n')].filter(Boolean).join('\n\n');
  const speakingStyleSampleDialogues=sampleText(name,p.sampleDialogue);
  built.push({key,name,gender:p.gender.toUpperCase(),aliases:[...new Set([...(old?.aliases||[]),name,p.name])],
    records:[...new Set(characterModels.filter(c=>c.key===key).map(c=>c.record))],
    voice:old?.voice||voice.voice_value,voiceName:old?.voiceName||voice.name,model:old?.model||model,
    backstory,speakingStyleDescription,speakingStyleSampleDialogues,backstoryWords:words(backstory),
    profileRevision:3,summary:p.summary,relationships:p.relationships,speakingRules:p.speakingRules,
    sampleDialogue:p.sampleDialogue,sources:p.sources,uncertainty:p.uncertainty||[]});
}
// Ambient profiles remain deliberately generic; never route a named actor into
// one of these just because their rig has the same body type.
for(const key of ['resident-male','resident-female']){
  const old=previous.find(p=>p.key===key),voice=catalog.get(casting.get(key));
  if(!old)throw Error('Missing ambient profile '+key);
  const backstory=[
    'You are a person living in Night City. Your exact name, occupation, district, and affiliations come from the person V is actually facing in the game, not from this profile. If you do not know a personal history, mission, or secret, say so without inventing one. Do not claim the conversation can change quests, items, or the world.',
    'CURRENT SAVE AND KNOWLEDGE RULES\n'+sharedKnowledgeRules,
    ownershipMarker(key)
  ].join('\n\n');
  const speakingRules=['React naturally to V and to any verified scene details supplied at runtime. Keep answers short and plausible. Use ordinary conversational language; do not invent a distinctive accent or a personal biography to fill the silence.'];
  // Original, deliberately generic delivery examples. They confer no quest
  // history, occupation, affiliation or unique identity on the ambient actor.
  const sampleDialogue=[
    {user:'Hey, got a moment?',character:"A moment, sure. What's on your mind?"},
    {user:'Know what happened here?',character:"Only what I can see from here. If there's more to it, I haven't heard."},
    {user:'Can you get me access?',character:"That's not something I can promise. What access are you looking for?"},
    {user:'You okay?',character:'Yeah, thanks for checking. Just taking things as they come.'},
    {user:'Any advice?',character:"Keep an eye on where you're going, and leave yourself a way out."}
  ];
  built.push({...old,voice:old.voice||voice.voice_value,voiceName:old.voiceName||voice.name,model:old.model||model,
    backstory,speakingStyleDescription:[sharedSpeakingStyle,...speakingRules].join('\n\n'),
    speakingStyleSampleDialogues:sampleText('Resident',sampleDialogue),backstoryWords:words(backstory),
    profileRevision:3,speakingRules,sampleDialogue});
}
for(const p of built){
  for(const field of ['backstory','speakingStyleDescription','speakingStyleSampleDialogues'])
    if(typeof p[field]!=='string'||!p[field].trim())throw Error(`Missing ${field}: ${p.key}`);
  if(/SPEAKING RULES|ORIGINAL DIALOGUE EXAMPLES|Editorial voice:|Editorially\b/.test(p.backstory))
    throw Error('Speaking guidance leaked into biography: '+p.key);
  if(!p.backstory.endsWith(ownershipMarker(p.key)))throw Error('Missing ownership marker: '+p.key);
}
await mkdir(resolve(root,'characters/profile-text'),{recursive:true});
for(const p of built)await writeFile(resolve(root,'characters/profile-text',p.key+'.txt'),[
  'BACKSTORY (backstory)',p.backstory,
  'SPEAKING STYLE DESCRIPTION (speaking_style_description)',p.speakingStyleDescription,
  'SPEAKING STYLE SAMPLE DIALOGUES (speaking_style_sample_dialogues)',p.speakingStyleSampleDialogues
].join('\n\n')+'\n');
await writeFile(resolve(root,'characters/roster.json'),JSON.stringify(built,null,2)+'\n');
await writeFile(resolve(root,'characters/profile-build-report.json'),JSON.stringify({profiles:built.length,named:actual.size,ambient:built.length-actual.size,profileRevision:3,model,
  apiFields:['backstory','speaking_style_description','speaking_style_sample_dialogues'],
  characters:built.map(p=>({key:p.key,words:words(p.backstory),speakingStyleWords:words(p.speakingStyleDescription),sampleDialogueWords:words(p.speakingStyleSampleDialogues),voice:p.voiceName,sources:p.sources?.length||0,uncertainties:p.uncertainty?.length||0}))},null,2)+'\n');
console.log(`Built ${actual.size} researched named profiles and ${built.length-actual.size} ambient profiles with three separate character fields, model ${model}.`);
