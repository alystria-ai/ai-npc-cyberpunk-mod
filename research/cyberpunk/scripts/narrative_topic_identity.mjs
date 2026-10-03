// Authoring qualification only. Runtime topic names and conflict logic are not
// rewritten here; compatible facets and sequential stages may need distinct IDs.
import {createHash} from 'node:crypto';

const enabled=r=>['source-verified','live-verified'].includes(r?.status);
const identifier=v=>typeof v==='string'&&v.length<=160&&/^[a-z0-9][a-z0-9_.-]*$/u.test(v);
const hash64=v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const key=(rule,decision,outcome)=>JSON.stringify([rule,decision,outcome]);
const policies=new Set(['identity-preserving-namespace','compatible-facet','compatible-stage','mutually-exclusive-stance']);
const canonical=value=>Array.isArray(value)?value.map(canonical):plain(value)
 ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const nativeRuleAuthorHash=rule=>createHash('sha256').update(JSON.stringify(canonical(rule)),'utf8').digest('hex');

export function validateNarrativeTopicIdentities({pack,decisions,aliasDocument={version:1,aliases:[]}}){
 const errors=[],proofs=[],acceptedLinks=new Set(),aliases=new Map(),aliasDomains=new Map();
 const ruleMap=new Map((pack.rules||[]).filter(enabled).map(r=>[r.id,r]));
 if(!plain(aliasDocument)||aliasDocument.version!==1||!Array.isArray(aliasDocument.aliases)||aliasDocument.aliases.length>256){
  return {errors:['Invalid reviewed narrative topic alias document'],proofs,acceptedLinks};
 }
 for(const row of aliasDocument.aliases){
  const fields=['ruleId','decisionId','outcomeKey','nativeTopic','catalogTopic','ruleSha256','policy','rationale','reviewRef','reviewed'];
  if(!plain(row)||Object.keys(row).some(k=>!fields.includes(k))||Object.keys(row).length!==fields.length
   ||![row.ruleId,row.decisionId,row.outcomeKey,row.nativeTopic,row.catalogTopic].every(identifier)
   ||!hash64(row.ruleSha256)||!policies.has(row.policy)||row.reviewed!==true
   ||typeof row.rationale!=='string'||!row.rationale.trim()||row.rationale.length>1200
   ||typeof row.reviewRef!=='string'||!/^native-reviews\/[a-z0-9-]+\.md$/u.test(row.reviewRef)){
   errors.push('Malformed or unreviewed narrative topic alias');continue;
  }
  const id=key(row.ruleId,row.decisionId,row.outcomeKey),rule=ruleMap.get(row.ruleId),decision=decisions.get(row.decisionId);
  if(aliases.has(id)){errors.push(`${row.ruleId}: duplicate narrative topic alias`);continue;}
  if(!rule||!decision||!rule.narrativeLinks?.some(l=>l.decisionId===row.decisionId&&l.outcomeKey===row.outcomeKey)
   ||!decision.outcomes?.some(o=>o.key===row.outcomeKey)||decision.questKey!==rule.questKey
   ||row.nativeTopic!==rule.topic||row.catalogTopic!==decision.topic||row.nativeTopic===row.catalogTopic
   ||row.ruleSha256!==nativeRuleAuthorHash(rule)){
   errors.push(`${row.ruleId}: stale or mismatched narrative topic alias`);continue;
  }
  aliases.set(id,row);
  if(!aliasDomains.has(row.decisionId))aliasDomains.set(row.decisionId,new Set());
  aliasDomains.get(row.decisionId).add(row.nativeTopic);
 }
 for(const rule of ruleMap.values())for(const link of rule.narrativeLinks||[]){
  const decision=decisions.get(link.decisionId),id=key(rule.id,link.decisionId,link.outcomeKey);
  // The ordinary outcome/quest verifier reports invalid links separately.
  if(!decision||decision.questKey!==rule.questKey||!decision.outcomes?.some(o=>o.key===link.outcomeKey))continue;
  if(!identifier(rule.topic)||!identifier(decision.topic)){
   errors.push(`${rule.id}: missing or invalid linked narrative topic`);continue;
  }
  const alias=aliases.get(id);
  // An exact catalog name is not a shortcut around an existing reviewed native
  // domain. A future alternative must join that domain or qualify its own
  // separate facet/stage; otherwise the runtime could miss a contradiction.
  if(rule.topic===decision.topic&&aliasDomains.has(link.decisionId)){
   errors.push(`${rule.id}: canonical topic bypasses reviewed native topic domain ${link.decisionId}`);continue;
  }
  if(rule.topic!==decision.topic&&!alias){
   errors.push(`${rule.id}: undeclared narrative topic mismatch ${rule.topic} / ${decision.topic}`);continue;
  }
  acceptedLinks.add(id);
  proofs.push({ruleId:rule.id,decisionId:link.decisionId,outcomeKey:link.outcomeKey,nativeTopic:rule.topic,
   catalogTopic:decision.topic,qualification:alias?'pinned-reviewed-alias':'exact',
   ...(alias?{policy:alias.policy,ruleSha256:alias.ruleSha256,reviewRef:alias.reviewRef}:{})});
 }
 return {errors,proofs,acceptedLinks};
}

export const narrativeTopicLinkKey=key;
