// Read-only coverage planning. This never promotes a rule or infers game state.
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const enabled=new Set(['source-verified','live-verified']);
const key=(decision,outcome)=>`${decision}/${outcome}`;

export function planNativeGaps(catalog,parts,characters=[]){
  const mapped=new Map(),candidates=new Map();
  for(const part of parts)for(const rule of part.rules||[]){
    const destination=enabled.has(rule.status)?mapped:candidates;
    for(const link of rule.narrativeLinks||[]){
      const id=key(link.decisionId,link.outcomeKey);
      if(!destination.has(id))destination.set(id,[]);
      destination.get(id).push({id:rule.id,status:rule.status,notes:rule.notes||rule.reviewNotes||null});
    }
  }
  const selected=new Set(characters),rows=[];
  for(const quest of catalog.quests)for(const decision of quest.decisions)for(const outcome of decision.outcomes){
    const id=key(decision.id,outcome.key);
    const affected=[...new Set([...(outcome.affects||[]),...(quest.characters||[])])];
    if(selected.size&&!affected.some(character=>selected.has(character)))continue;
    rows.push({questKey:quest.key,title:quest.title,decisionId:decision.id,outcomeKey:outcome.key,
      description:outcome.description,characters:affected,knowledge:outcome.knowledge,
      enabledRules:(mapped.get(id)||[]).map(rule=>rule.id),candidates:candidates.get(id)||[],
      sourceIds:[...new Set([...(outcome.sourceIds||[]),...(decision.sourceIds||[])])]});
  }
  const byQuest=new Map();
  for(const row of rows){
    if(!byQuest.has(row.questKey))byQuest.set(row.questKey,{questKey:row.questKey,title:row.title,total:0,mapped:0,unmapped:0});
    const entry=byQuest.get(row.questKey);entry.total++;
    if(row.enabledRules.length)entry.mapped++;else entry.unmapped++;
  }
  return {version:1,qualification:'Planning only; source verification and live acceptance are separate.',
    selectedCharacters:characters,summary:{outcomes:rows.length,mapped:rows.filter(row=>row.enabledRules.length).length,
      unmapped:rows.filter(row=>!row.enabledRules.length).length},
    quests:[...byQuest.values()].sort((a,b)=>b.unmapped-a.unmapped||a.questKey.localeCompare(b.questKey)),
    gaps:rows.filter(row=>!row.enabledRules.length)};
}

async function main(){
  const args=process.argv.slice(2);
  if(args.includes('--help')){
    console.log('node plan_native_gaps.mjs [--characters judy-alvarez,panam-palmer] [--output path.json]');return;
  }
  const value=flag=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
  const characters=(value('--characters')||'').split(',').filter(Boolean);
  const catalog=JSON.parse(await readFile(resolve(root,'generated/quest-catalog.json'),'utf8'));
  const parts=await Promise.all((await readdir(resolve(root,'native-rules'))).filter(name=>name.endsWith('.json')).sort()
    .map(async name=>JSON.parse(await readFile(resolve(root,'native-rules',name),'utf8'))));
  const result=planNativeGaps(catalog,parts,characters),output=value('--output');
  if(output)await writeFile(resolve(output),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({summary:result.summary,quests:result.quests.slice(0,16),output:output||null},null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
