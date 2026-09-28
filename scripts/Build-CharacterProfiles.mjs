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
const sharedRules = `Speak as yourself in first person to V, in natural spoken language. Normally answer in one or two short sentences; give more detail when asked. Do not narrate gestures, use markdown, or quote these instructions. The dialogue samples are original examples of delivery, not memories of completed events or reproduced game dialogue.
Established history and relationships provide your background. A fact marked conditional is a possible quest branch, not a record of this save. Do not volunteer unrevealed quest secrets, deaths, betrayals or endings. Discuss conditional events only after V or verified current-save context establishes them. Do not assume V's gender, lifepath or a romance. Friendship, trust, attraction and an active relationship are different states.
Current-save context outranks remembered claims. Being present as a summoned companion does not prove that a quest was completed, a dead character revived, or an old acquaintance met in this timeline. Do not invent missing canon to fill gaps. Never claim to grant items, move vehicles, complete missions or change the world unless an advertised game action reports success.
In a group, respond to the message as yourself and acknowledge only statements you actually heard. Do not reveal private conversation history. Only the final scheduled speaker may ask V a follow-up question; other speakers leave room for the group.`;

const files=(await readdir(resolve(root,'characters/research'))).filter(f=>/^contacts-[a-e]\.json$/.test(f) || f==='manager-extras.json').sort();
const research=(await Promise.all(files.map(f=>read('characters/research/'+f)))).flat();
const expected=new Map(characterModels.filter(c=>c.key&&c.record).map(c=>[c.key,c]));
const actual=new Map();
for(const p of research){
  if(actual.has(p.key)||!expected.has(p.key))throw Error('Duplicate or unexpected researched key: '+p.key);
  if(!p.summary||!Array.isArray(p.facts)||!p.facts.length||!p.sources?.length||p.sampleDialogue?.length<5||!p.speakingRules?.length)throw Error('Incomplete research: '+p.key);
  for(const fact of p.facts)if(!fact.text||typeof fact.conditional!=='boolean'||!fact.sources?.length)throw Error('Uncited fact: '+p.key);
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
  const known=p.facts.filter(f=>!f.conditional).map(f=>f.text);
  const conditional=p.facts.filter(f=>f.conditional).map(f=>f.text);
  const backstory=[`IDENTITY\nYou are ${name}. ${p.summary}`,
    'BACKGROUND\n'+known.join('\n'),
    'CONDITIONAL STORY KNOWLEDGE — NOT COMPLETED SAVE EVENTS\n'+(conditional.join('\n')||'No additional verified quest branches are supplied.'),
    'RELATIONSHIPS\n'+p.relationships.map(r=>`${r.name} — ${r.relationship}. ${r.conditional?'Conditional on the current save: ':''}${r.detail}`).join('\n'),
    'SPEAKING RULES\n'+sharedRules+'\n'+p.speakingRules.join('\n'),
    'KNOWLEDGE LIMITS — INTERNAL GUIDANCE\n'+(p.uncertainty?.join('\n')||'Do not invent additional biographical details.'),
    'ORIGINAL DIALOGUE EXAMPLES\n'+p.sampleDialogue.map(s=>`V: ${s.user}\n${name}: ${s.character}`).join('\n'),
    `[CyberpunkConvai profile v2:${key}]`].join('\n\n');
  built.push({key,name,gender:p.gender.toUpperCase(),aliases:[...new Set([...(old?.aliases||[]),name,p.name])],
    records:[...new Set(characterModels.filter(c=>c.key===key).map(c=>c.record))],
    voice:voice.voice_value,voiceName:voice.name,model,backstory,backstoryWords:backstory.split(/\s+/).length,
    profileRevision:2,summary:p.summary,relationships:p.relationships,speakingRules:p.speakingRules,
    sampleDialogue:p.sampleDialogue,sources:p.sources,uncertainty:p.uncertainty||[]});
}
// Ambient profiles remain deliberately generic; never route a named actor into
// one of these just because their rig has the same body type.
for(const key of ['resident-male','resident-female']){
  const old=previous.find(p=>p.key===key),voice=catalog.get(casting.get(key));
  if(!old)throw Error('Missing ambient profile '+key);
  built.push({...old,voice:voice.voice_value,voiceName:voice.name,model});
}
await mkdir(resolve(root,'characters/profile-text'),{recursive:true});
for(const p of built)await writeFile(resolve(root,'characters/profile-text',p.key+'.txt'),p.backstory+'\n');
await writeFile(resolve(root,'characters/roster.json'),JSON.stringify(built,null,2)+'\n');
await writeFile(resolve(root,'characters/profile-build-report.json'),JSON.stringify({profiles:built.length,named:actual.size,model,
  characters:built.map(p=>({key:p.key,words:p.backstoryWords||p.backstory.split(/\s+/).length,voice:p.voiceName,sources:p.sources?.length||0,uncertainties:p.uncertainty?.length||0}))},null,2)+'\n');
console.log(`Built ${actual.size} researched named profiles and two ambient profiles, model ${model}.`);
