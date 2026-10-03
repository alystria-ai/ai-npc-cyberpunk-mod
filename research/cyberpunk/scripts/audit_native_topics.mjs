// Read-only rule/catalog identity audit. Does not qualify native bytes, install,
// promote a new alias, infer game history, or contact a provider.
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateNarrativeTopicIdentities} from './narrative_topic_identity.mjs';

const research=resolve(dirname(fileURLToPath(import.meta.url)),'..'),project=resolve(research,'../..');
const read=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const files=(await readdir(resolve(research,'native-rules'))).filter(f=>f.endsWith('.json')).sort();
const sources=await Promise.all(files.map(async file=>{
 const bytes=await readFile(resolve(research,'native-rules',file));
 return {file,sha256:createHash('sha256').update(bytes).digest('hex'),pack:JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''))};
}));
const catalog=await read(resolve(research,'generated/quest-catalog.json'));
const decisions=new Map(catalog.quests.flatMap(q=>q.decisions.map(d=>[d.id,{...d,questKey:q.key}])));
const aliases=await read(resolve(research,'native-topic-aliases.json'));
const pack={rules:sources.flatMap(s=>s.pack.rules)};
const result=validateNarrativeTopicIdentities({pack,decisions,aliasDocument:aliases});
const fileOf=new Map(sources.flatMap(s=>s.pack.rules.map(r=>[r.id,s.file])));
const report={version:1,auditedAt:new Date().toISOString(),qualification:'authoring-identity-only-not-live',
 summary:{enabledRules:pack.rules.filter(r=>['source-verified','live-verified'].includes(r.status)).length,
  qualifiedLinks:result.proofs.length,exactTopics:result.proofs.filter(p=>p.qualification==='exact').length,
  reviewedAliases:result.proofs.filter(p=>p.qualification==='pinned-reviewed-alias').length,errors:result.errors.length},
 errors:result.errors,sources:sources.map(({file,sha256})=>({file,sha256})),
 aliases:result.proofs.filter(p=>p.qualification==='pinned-reviewed-alias').map(p=>({...p,file:fileOf.get(p.ruleId)}))};
const args=process.argv.slice(2);
if(args.length){
 if(args.length!==2||args[0]!=='--output')throw Error('Usage: audit_native_topics.mjs [--output runtime/new-file.json]');
 const path=resolve(project,args[1]),within=relative(resolve(project,'runtime'),path);
 if(within.startsWith('..')||isAbsolute(within)||!within.endsWith('.json'))throw Error('Audit output must be a new runtime JSON file');
 await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify(report.summary,null,2));
if(result.errors.length)process.exitCode=1;
