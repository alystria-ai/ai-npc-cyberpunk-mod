// Read-only ownership audit. This script never contacts the game or edits saves.
// It writes one reproducible, reviewable JSON artifact inside the project.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,join,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import fengari from 'fengari';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const game=process.env.CYBERPUNK_GAME_ROOT||'E:/SteamLibrary/steamapps/common/Cyberpunk 2077';
const output=resolve(root,'research/cyberpunk/fact-identity-audit.json');
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
const sha=data=>createHash('sha256').update(data).digest('hex');
const portable=path=>path.replaceAll('\\','/');
function fnv1a32(value){let result=0x811c9dc5;for(const byte of Buffer.from(value,'utf8'))result=Math.imul(result^byte,0x01000193)>>>0;return result;}
function files(path,filter){
  if(!existsSync(path))throw new Error(`Required audit input missing: ${path}`);
  const out=[];
  for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    if(entry.isSymbolicLink())continue;
    const full=join(path,entry.name);
    if(entry.isDirectory())out.push(...files(full,filter));
    else if(entry.isFile()&&filter(full))out.push(full);
  }
  return out;
}
function driverNames(){
  const state=lauxlib.luaL_newstate();lualib.luaL_openlibs(state);
  const source=readFileSync(join(root,'mod/fact-identity.lua'),'utf8');
  const rc=lauxlib.luaL_dostring(state,to_luastring(`return (function()\n${source}\nend)().factNames`));
  if(rc!==lua.LUA_OK)throw new Error(to_jsstring(lua.lua_tostring(state,-1)));
  const names=[];
  for(let index=1;index<=lua.lua_rawlen(state,-1);index++){
    lua.lua_rawgeti(state,-1,index);names.push(to_jsstring(lua.lua_tostring(state,-1)));lua.lua_pop(state,1);
  }
  lua.lua_close(state);return names;
}
const factNames=driverNames();
if(factNames.length!==43||new Set(factNames).size!==43)throw new Error('Unexpected driver manifest');
const corpus=new Map(),sources=[];
function add(name,source){
  if(typeof name!=='string'||!name||name.length>512)return;
  if(!corpus.has(name))corpus.set(name,new Set());corpus.get(name).add(source);
}
const gameCache=join(root,'research/cyberpunk/cache/game');
const dictionaries=[join(gameCache,'index/facts-dictionary.json'),
  ...files(join(gameCache,'scene-evidence'),p=>portable(p).endsWith('/index/facts-dictionary.json'))];
for(const path of dictionaries){
  const bytes=readFileSync(path),data=JSON.parse(bytes);const label=portable(relative(root,path));
  if(data.version!==1||!Array.isArray(data.facts))throw new Error(`Invalid facts dictionary: ${label}`);
  for(const fact of data.facts){
    if(Number(fact.hash32)!==fnv1a32(fact.name))throw new Error(`Fact hash mismatch in ${label}`);
    add(fact.name,label);
  }
  sources.push({kind:'extracted-dictionary',path:label,sha256:sha(bytes),facts:data.facts.length});
}

// Only complete literal first arguments are counted. Concatenated/dynamic
// expressions remain an explicit coverage gap, not guessed names.
const literalFact=/\b(?:GetFactStr|GetFact|SetFactStr|SetFact|RegisterFactListener|RegisterListener)\s*\(\s*(?:n\s*)?(["'])([^"'\r\n\\]*)\1\s*[,)]/g;
function literals(text,label){let count=0;for(const match of text.matchAll(literalFact)){add(match[2],label);count++;}return count;}
const repo=join(root,'vendor/reference-game-scripts');
const revision=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
const tracked=execFileSync('git',['-C',repo,'ls-files','*.script'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).filter(Boolean);
const matches=execFileSync('git',['-C',repo,'grep','--no-color','-n','-E',
  '(GetFactStr|GetFact|SetFactStr|SetFact|RegisterFactListener|RegisterListener)[[:space:]]*\\(',
  'HEAD','--','*.script'],{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
let referenceLiterals=0;
for(const line of matches.split(/\r?\n/)){
  const match=/^HEAD:(.*?):(\d+):(.*)$/.exec(line);
  if(match)referenceLiterals+=literals(match[3],`reference-game-scripts/${match[1]}`);
}
sources.push({kind:'game-script-literals',repository:'CDPR-Modding-Documentation/Cyberpunk-Scripts',
  revision,trackedScriptFiles:tracked.length,matchedLiterals:referenceLiterals,matchDigest:sha(matches)});
const installedRoots=[['r6/scripts',p=>p.endsWith('.reds')],
  ['bin/x64/plugins/cyber_engine_tweaks/mods',p=>p.endsWith('.lua')]];
const installed=[];
for(const [subdir,filter] of installedRoots){
  for(const path of files(join(game,subdir),filter)){
    const bytes=readFileSync(path);if(bytes.length>8*1024*1024)throw new Error('Oversized installed source');
    const label=`installed/${portable(relative(game,path))}`;
    const matchedLiterals=literals(bytes.toString('utf8'),label);
    installed.push({path:label,sha256:sha(bytes),matchedLiterals});
  }
}
sources.push({kind:'installed-script-literals',fileCount:installed.length,
  matchedLiterals:installed.reduce((n,s)=>n+s.matchedLiterals,0),manifest:installed});
const hashes=new Map();
for(const [name,locations] of corpus){const hash=fnv1a32(name);if(!hashes.has(hash))hashes.set(hash,[]);hashes.get(hash).push({name,locations:[...locations].sort()});}
const collisions=[],manifest=factNames.map(name=>({name,hash32:fnv1a32(name)}));
for(let index=0;index<manifest.length;index++){
  const candidate=manifest[index];
  for(const match of hashes.get(candidate.hash32)||[])collisions.push({candidate,...match,kind:'known-fact'});
  for(const prior of manifest.slice(0,index))if(prior.hash32===candidate.hash32)collisions.push({candidate,prior,kind:'internal'});
}
const sortedNames=[...corpus.keys()].sort();
const report={version:1,storage:'quest-facts-v1',factNames,manifest,knownFactCount:corpus.size,
  collisionCount:collisions.length,completeWithinScope:true,corpusDigest:sha(JSON.stringify({sortedNames,sources})),
  scope:'All indexed base/DLC quest/journal fact dictionaries and currently extracted scene dictionaries; literal fact API calls in pinned game scripts and installed redscript/CET Lua sources.',
  coverageGaps:[
    'Not a complete enumeration of the engine fact database; zero GetFact is not absence evidence.',
    'Unextracted scene/archive resources and dynamic/composed fact names are not enumerated.',
    'Binary plugins and future mods can introduce names not represented by source literals.',
    'A reviewed manifest must be regenerated after supported resource or mod-source changes.'
  ],qualification:{nativeWrites:false,restoreObserver:false,saveLoadRoundtrip:false,cloudPromotion:false},
  sources,collisions};
writeFileSync(output,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({output:portable(relative(root,output)),factNames:factNames.length,knownFacts:corpus.size,
  dictionaries:dictionaries.length,referenceScriptFiles:tracked.length,installedSourceFiles:installed.length,
  collisions:collisions.length,corpusDigest:report.corpusDigest}));
if(collisions.length)process.exitCode=1;
