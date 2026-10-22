import {isDeepStrictEqual} from 'node:util';
import {ConvaiMemoryAdapter} from './convai-memory.mjs';
import {QuestMemorySync, readMemoryQualification} from './quest-memory-sync.mjs';
import {isAmbientProfile} from './protocol.mjs';

const API = 'https://api.convai.com';
const CORE = new Set(['/character/list','/character/get']);
// Residents and generic NPC archetypes (npc-*) share one predicate (bridge/protocol.mjs).
const AMBIENT = {has: isAmbientProfile};
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value);
const profile = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const fail = code => Object.assign(new Error(`Knowledge cloud: ${code}`),{code});
const codeOf = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'CLOUD_OPERATION_FAILED';
const check = signal => {if(signal?.aborted) throw fail('CANCELLED');};

function bounded(promise,signal) {
  check(signal);
  return new Promise((resolve,reject)=>{
    const cleanup=()=>signal?.removeEventListener('abort',abort);
    const abort=()=>{cleanup();reject(fail('CANCELLED'));};
    signal?.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
function cancelBody(body) {try {Promise.resolve(body?.cancel()).catch(()=>{});} catch {}}
function normalizedPolicy(value={}) {
  return Object.freeze({version:value.version,enabled:value.enabled===true,nativeQualified:value.nativeQualified===true,
    providerQualified:value.providerQualified===true,
    ...(value.selectedModel!==undefined?{selectedModel:value.selectedModel}:{})});
}

/** Optional production composition. No construction/startup request is made.
 * Native qualification and the coordinator remain independently controlled.
 * request overrides Core JSON POST only; fetchImpl covers default Core + LTM.
 */
export class KnowledgeCloud {
  constructor({coordinator,key,ids={},policy={},qualificationPath,hostFactory,request,fetchImpl=globalThis.fetch,
    now=Date.now,maxEntries=4,maxDurationMs=15000,maxScanPages=4,requestTimeoutMs=15000,
    maxResponseBytes=4*1024*1024,cleanupTimeoutMs=2500}={}) {
    if(!coordinator || !plain(ids) || typeof fetchImpl!=='function' || typeof now!=='function'
        || (hostFactory!==undefined&&typeof hostFactory!=='function') || (request!==undefined&&typeof request!=='function')
        || !Number.isInteger(requestTimeoutMs)||requestTimeoutMs<10||requestTimeoutMs>60000
        || !Number.isInteger(maxResponseBytes)||maxResponseBytes<128||maxResponseBytes>8*1024*1024
        || !Number.isInteger(cleanupTimeoutMs)||cleanupTimeoutMs<10||cleanupTimeoutMs>10000) throw fail('INVALID_CONFIGURATION');
    Object.defineProperty(this,'_key',{value:typeof key==='string'?key:''});
    Object.assign(this,{coordinator,ids:Object.freeze(copy(ids)),policy:normalizedPolicy(policy),qualificationPath,
      now,maxDurationMs,requestTimeoutMs,maxResponseBytes,cleanupTimeoutMs,fetchImpl,requestOverride:request});
    this.hostFactory=hostFactory??(async()=>{const {RealtimeHost}=await import('./realtime-host.mjs');return new RealtimeHost();});
    this.adapter=this._key.trim()?new ConvaiMemoryAdapter({key:this._key,enabled:false,fetchImpl,
      timeoutMs:requestTimeoutMs,maxResponseBytes}):null;
    this.worker=new QuestMemorySync({service:coordinator,adapter:this.adapter,providerQualificationPath:qualificationPath,
      resolveCharacter:(key,options)=>this._resolve(key,options),registerScope:scope=>this._register(scope),
      enabled:false,nativeQualified:false,maxEntries,maxDurationMs,maxScanPages,now});
    this.running=null;this.operation=null;this.closed=false;this.last=null;this.policyEpoch=0;
    this.cleanupPending=null;this.cleanupFailure=null;
  }
  _gate() {
    if(this.closed)return 'CLOSED';
    if(this.policy.version!==1||!this.policy.enabled)return 'DISABLED';
    if(!this.policy.nativeQualified)return 'NATIVE_NOT_QUALIFIED';
    if(!this.policy.providerQualified)return 'PROVIDER_NOT_QUALIFIED';
    if(this.coordinator.cloudQualified!==true)return 'SERVICE_CLOUD_DISABLED';
    if(!this._key.trim())return 'KEY_UNAVAILABLE';
    if(this.cleanupFailure)return this.cleanupFailure;
    if(this.cleanupPending)return 'REGISTRATION_CLEANUP_PENDING';
    if(!this.coordinator.guard())return 'NATIVE_IDENTITY_UNAVAILABLE';
    return null;
  }
  setPolicy(value) {
    const next=normalizedPolicy(value);
    if(!isDeepStrictEqual(next,this.policy)){this.policy=next;this.policyEpoch++;this.cancel();}
  }
  cancel(){this.operation?.controller.abort();this.worker.cancel();}
  async _current(op,signal) {
    check(signal);
    if(this.operation!==op||op.policyEpoch!==this.policyEpoch||op.finished)throw fail('STALE_CLOUD_OPERATION');
    const gate=this._gate();if(gate)throw fail(gate);
    if(!await bounded(this.coordinator.current(op.guard),signal)||!this.coordinator.isCurrent(op.guard))throw fail('STALE_SCOPE');
    check(signal);
  }
  async _request(endpoint,body,{signal}={}) {
    if(!CORE.has(endpoint))throw fail('INVALID_CORE_ENDPOINT');
    check(signal);
    const timeout=new AbortController(),combined=signal?AbortSignal.any([signal,timeout.signal]):timeout.signal;
    const timer=setTimeout(()=>timeout.abort(),this.requestTimeoutMs);
    try {
      let data;
      if(this.requestOverride) {
        data=await bounded(Promise.resolve().then(()=>{check(combined);return this.requestOverride(endpoint,copy(body),{signal:combined});}),combined);
      } else {
        const fetching=Promise.resolve().then(()=>{check(combined);return this.fetchImpl(API+endpoint,{method:'POST',redirect:'error',
          headers:{'Content-Type':'application/json','CONVAI-API-KEY':this._key},body:JSON.stringify(body),signal:combined});});
        fetching.then(response=>{if(combined.aborted)cancelBody(response?.body);},()=>{});
        const response=await bounded(fetching,combined);
        if(!response?.ok){cancelBody(response?.body);throw fail('CORE_HTTP_ERROR');}
        const advertised=Number(response.headers?.get('content-length'));
        if(Number.isFinite(advertised)&&advertised>this.maxResponseBytes){cancelBody(response.body);throw fail('CORE_RESPONSE_TOO_LARGE');}
        const reader=response.body?.getReader();if(!reader)throw fail('CORE_INVALID_RESPONSE');
        const chunks=[];let size=0;
        try{for(;;){const {value,done}=await bounded(reader.read(),combined);if(done)break;
          size+=value.byteLength;if(size>this.maxResponseBytes)throw fail('CORE_RESPONSE_TOO_LARGE');chunks.push(value);}}
        catch(error){cancelBody(reader);throw error;}finally{reader.releaseLock();}
        try{data=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{throw fail('CORE_INVALID_RESPONSE');}
      }
      if(typeof data==='string'){try{data=JSON.parse(data);}catch{throw fail('CORE_INVALID_RESPONSE');}}
      if(!plain(data)||['ERROR','API_ERROR','INTERNAL_ERROR'].some(field=>data[field]))throw fail('CORE_API_REJECTED');
      if(Buffer.byteLength(JSON.stringify(data))>this.maxResponseBytes)throw fail('CORE_RESPONSE_TOO_LARGE');
      check(combined);return data;
    }catch(error){throw fail(timeout.signal.aborted?'CORE_TIMEOUT':signal?.aborted?'CANCELLED':codeOf(error));}
    finally{clearTimeout(timer);}
  }
  _mapped(profileKey) {
    const id=this.ids[profileKey];
    if(!profile(profileKey)||AMBIENT.has(profileKey)||!Object.hasOwn(this.ids,profileKey)||!token(id))throw fail('PROFILE_NOT_MAPPED');
    if(Object.entries(this.ids).filter(([key,value])=>profile(key)&&!AMBIENT.has(key)&&value===id).length!==1)throw fail('AMBIGUOUS_PROFILE_MAPPING');
    return id;
  }
  _owned(detail,profileKey,id) {
    const marker=`[CyberpunkConvai profile v2:${profileKey}]`;
    if(detail.character_id!==id||typeof detail.backstory!=='string'
        ||!detail.backstory.split(/\r?\n/u).some(line=>line.trim()===marker))throw fail('PROFILE_NOT_OWNED');
    if(!plain(detail.memory_settings)||typeof detail.memory_settings.enabled!=='boolean')throw fail('INVALID_MEMORY_READBACK');
    return detail;
  }
  async _listing(op,signal,{fresh=false}={}) {
    if(!op.listing||fresh){await this._current(op,signal);const value=await this._request('/character/list',{},{signal});
      if(!Array.isArray(value.characters)||value.characters.length>10000)throw fail('CORE_INVALID_LIST');
      op.listing=value.characters;}
    return op.listing;
  }
  async _model(op,id,signal,options) {
    const rows=(await this._listing(op,signal,options)).filter(row=>row?.character_id===id);
    if(rows.length!==1)throw fail('PROFILE_NOT_IN_ACCOUNT');
    const model=rows[0].personalised_prompt_config?.MODEL;
    if(model!==op.qualification.model||(this.policy.selectedModel!==undefined&&model!==this.policy.selectedModel))throw fail('MODEL_READBACK_MISMATCH');
    return model;
  }
  async _resolve(profileKey,{signal}={}) {
    const op=this.operation;if(!op)throw fail('CLOUD_NOT_RUNNING');
    await this._current(op,signal);
    if(op.certificates.has(profileKey))return copy(op.certificates.get(profileKey));
    const id=this._mapped(profileKey),model=await this._model(op,id,signal);
    await this._current(op,signal);
    const detail=this._owned(await this._request('/character/get',{charID:id},{signal}),profileKey,id);
    // The deployed provider rejects anonymous live sessions when this global
    // setting is true. Never enable or toggle it from an archive worker.
    if(detail.memory_settings.enabled!==false)throw fail('CHARACTER_AUTOMATIC_MEMORY_ENABLED');
    await this._current(op,signal);
    const result={profileKey,characterId:id,verified:true,owned:true,source:'convai-character-get',
      memoryEnabled:false,model,verifiedAt:this.now()};
    op.certificates.set(profileKey,result);return copy(result);
  }
  async _register(scope) {
    const op=this.operation;if(!op)throw fail('CLOUD_NOT_RUNNING');
    await this._current(op,scope.signal);
    if(!this.coordinator.isCurrent(scope.guard)||this._mapped(scope.profileKey)!==scope.characterId)throw fail('STALE_SCOPE');
    op.hostPromise??=Promise.resolve().then(()=>{check(scope.signal);return this.hostFactory({signal:scope.signal});});
    const host=await bounded(op.hostPromise,scope.signal);
    if(!host||typeof host.warm!=='function'||typeof host.close!=='function')throw fail('INVALID_REGISTRATION_HOST');
    await this._current(op,scope.signal);
    const config={key:this._key,characterId:scope.characterId,endUserId:scope.endUserId,
      scope:`memory-registration:${scope.channel==='group'?scope.audience.join(','):'private'}`,
      sessionId:'-1',ttsEnabled:false,endUserMetadata:{game:'cyberpunk2077',purpose:'memory-registration',
        channel:scope.channel,audience:[...scope.audience]}};
    const result=await bounded(host.warm(config,{signal:scope.signal}),scope.signal);
    await this._current(op,scope.signal);return result;
  }
  async _dispose(op) {
    if(!op.hostPromise)return null;
    const cleanup=op.hostPromise.then(host=>typeof host?.close==='function'?host.close():undefined,()=>undefined);
    this.cleanupPending=cleanup;
    cleanup.then(()=>{if(this.cleanupPending===cleanup)this.cleanupPending=null;},()=>{
      if(this.cleanupPending===cleanup)this.cleanupPending=null;this.cleanupFailure='REGISTRATION_CLEANUP_FAILED';});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.cleanupTimeoutMs);
    try{await bounded(cleanup,controller.signal);return null;}
    catch{return controller.signal.aborted?'REGISTRATION_CLEANUP_PENDING':'REGISTRATION_CLEANUP_FAILED';}
    finally{clearTimeout(timer);}
  }
  async _pump(op,signal) {
    let result;
    try{
      const gate=this._gate();if(gate)return {status:'disabled',processed:0,reasons:[gate],touchedScopes:[]};
      op.guard=copy(this.coordinator.guard());op.qualification=await bounded(readMemoryQualification(this.qualificationPath),signal);
      if(this.policy.selectedModel!==undefined&&this.policy.selectedModel!==op.qualification.model)throw fail('MODEL_NOT_QUALIFIED');
      await this._current(op,signal);
      this.adapter.enabled=true;this.worker.setPolicy({enabled:true,nativeQualified:true});
      result=await this.worker.pump({signal});
      // Stable IDs are an explicit REST archive only. Live sessions are
      // anonymous and receive locally selected context; never reconnect them
      // with this archive identity to request automatic cloud recall.
      result={...result,touchedScopes:(result.touchedScopes??[]).map(scope=>({...scope,
        conversationScopes:[],requiresIdleRefresh:false,archiveOnly:true}))};
    }catch(error){result={status:signal.aborted?'cancelled':'blocked',processed:0,reasons:[codeOf(error)],touchedScopes:[]};}
    finally{
      op.finished=true;this.worker.setPolicy({enabled:false,nativeQualified:false});if(this.adapter)this.adapter.enabled=false;
      const cleanup=await this._dispose(op);
      if(cleanup){result??={status:'blocked',processed:0,reasons:[],touchedScopes:[]};result.cleanup=cleanup;
        if(!result.reasons.includes(cleanup))result.reasons.push(cleanup);}
    }
    return result;
  }
  pump({signal}={}) {
    if(this.running)return Promise.resolve({status:'busy',processed:0,touchedScopes:[]});
    const controller=new AbortController(),op={controller,policyEpoch:this.policyEpoch,certificates:new Map(),finished:false};
    this.operation=op;
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const timer=setTimeout(()=>controller.abort(),this.maxDurationMs);
    this.running=this._pump(op,combined).then(result=>{this.last=copy(result);return result;}).finally(()=>{
      clearTimeout(timer);if(this.operation===op)this.operation=null;this.running=null;});
    return this.running;
  }
  status(){return {enabled:!this._gate(),reason:this._gate(),running:!!this.running,closed:this.closed,
    cleanupPending:!!this.cleanupPending,cleanupFailure:this.cleanupFailure,last:this.last?copy(this.last):null};}
  async close(){this.closed=true;this.cancel();await this.running;await this.worker.close();}
}
