import {PocketVoice, validatePocketConfig} from './pocket-voice.mjs';
import {ResidentVoice} from './resident-voice.mjs';
import {createVoiceProfileRegistry} from './voice-profile-registry.mjs';
import {abortable, throwIfCancelled} from './transport-pool.mjs';
import {DEFAULT_OMNI_REFERENCE, OMNI_REFERENCES} from './voice-config-paths.mjs';
import {OMNI_TAGS, keepSpeechTags, stripSpeechTags} from './natural-speech.mjs';

// Routing changes commit only at a conversation boundary. Model preparation
// can begin from a settings draft while that routing remains unchanged.
// CPU/CUDA workers retire through confirmed EOF before another backend starts.
export const canonicalVoiceProvider = value => ['hybrid','omnivoice'].includes(value) ? 'omni' : value;
// OmniVoice reads either its short (up to 10 s) or its long (up to 18 s) searched reference per character.
export const canonicalOmniReference = value => OMNI_REFERENCES.includes(value) ? value : null;
// Fallback order, best first: OmniVoice (16 or 32 steps), Pocket TTS, Convai. The Settings menu lists Pocket first
// because it is the default, but a choice that cannot run still falls to the next entry of THIS list: an Omni
// choice (the optional pack missing, no CUDA) lands on Pocket, a Pocket failure lands on Convai, which is always
// runnable.
export const VOICE_FALLBACK_ORDER = Object.freeze(['omni','pocket','convai']);
const PACK_RECHECK_MS = 30_000;
const local = value => value === 'pocket' || value === 'omni';
const equalSet = (a,b) => a.size===b.size&&[...a].every(key=>b.has(key));
export class VoiceSelection {
  constructor(config = {}, options = {}) {
    const supplied = Object.keys(config).length > 0;
    const validated = supplied ? validatePocketConfig(config) : null;
    const empty=createVoiceProfileRegistry({}),pocketRegistry=validated?.registry||empty;
    const snapshot=(value,registry)=>Object.freeze({...value,voices:Object.freeze({...registry.profiles,
      ...Object.fromEntries(Object.entries(registry.unavailable).map(([key,status])=>[key,Object.freeze({status})]))}),
      preparation:registry.preparation});
    // OmniVoice has one reference configuration per choice (short, long); a caller with one config uses it for both.
    const omniInputs=options.omniConfigs||{short:options.omniConfig||{},long:options.omniConfig||{}};
    const omniPaths=options.omniConfigPaths||{short:options.omniConfigPath,long:options.omniConfigPath};
    this.omniVariants=Object.fromEntries(OMNI_REFERENCES.map(reference=>{
      const input=omniInputs[reference]||{},registry=createVoiceProfileRegistry(input);
      return [reference,{input,registry,snapshot:snapshot(input,registry),path:omniPaths[reference],
        configured:input.provider==='hybrid'&&registry.keys.length>0,availability:new Set(registry.keys)}];
    }));
    this.registries={pocket:pocketRegistry,convai:empty};
    this.configs={pocket:snapshot(validated,pocketRegistry)};
    this.configuredByBackend={pocket:!!validated&&pocketRegistry.keys.length>0};
    this.availabilities={pocket:new Set(pocketRegistry.keys),convai:new Set()};
    // The optional OmniVoice pack (worker Python, model weights): a function or a fixed {installed, missing}.
    this.omniPackSource=options.omniPack||(()=>({installed:true,missing:[]}));
    this.clock = options.clock || Date.now;
    this.packCheckedAt=0;this.refreshOmniPack();
    this.omniReference=this.requestedOmniReference=DEFAULT_OMNI_REFERENCE;
    this.activateOmni();
    this.options = options;
    // A draft must stay unchanged this long before it may prepare a model, so
    // cycling quickly through the choices never starts or retires a worker.
    // Zero keeps the preview immediate for callers that do not debounce.
    this.previewSettleMs = Number.isFinite(options.previewSettleMs) ? Math.max(0, options.previewSettleMs) : 0;
    this.previewSince = 0;
    this.phoneAnalysis=options.phoneAnalysis;
    this.factory = options.factory || ((settings, hooks) => new PocketVoice(settings, hooks));
    this.omniFactory=options.omniFactory||((settings,hooks)=>new ResidentVoice(settings,hooks));
    // "Keep prepared voices" (default on): Pocket saves each voice's prepared state to disk; Omni warms at the
    // selected steps while the companion joins.
    this.keepPrepared=options.keepPreparedVoices!==false;
    this.provider = this.requestedProvider = 'pocket';
    // 16 steps is the default; the saved setting replaces it on the first poll.
    this.omniSteps=this.requestedOmniSteps=16;
    this.playbackEnabled=true;
    this.routeKeys=[...new Set([...Object.keys(this.configs.pocket.voices),
      ...OMNI_REFERENCES.flatMap(reference=>Object.keys(this.omniVariants[reference].snapshot.voices)),
      ...(options.profileKeys||[])])].sort();
    this.retiring = Promise.resolve(); this.releasing = false;
    this.state = this.configured ? 'stopped' : 'disabled'; this.details = {};
    // The default choice is Pocket TTS, the voice that ships with the mod.
    this.requestedProvider='pocket';this.failedBackends=new Set();
    this.provider=this.resolve('pocket');
    this.state = this.configured ? 'stopped' : 'disabled';
    this.verifiedAvailabilities=new Map();this.busy=false;
    // failedBackends: local workers that could not start or died (no CUDA, load
    // error, crash) stay out of routing until the player chooses them again.
    this.routeRevision = 0; this.routeChanges = new Set(); this.routingWaiters = new Set();
    // Multilingual conversations: a second, OmniVoice-only worker that speaks the replies Pocket cannot (any
    // language but English) while Pocket stays the chosen voice. Started on the first such turn, never warmed
    // ahead (it holds GPU memory), and released when the setting or the chosen voice no longer needs it.
    this.multilingual=false;this.languageClient=null;this.languageFailed=false;this.languageState='stopped';
    this.languageRetiring=Promise.resolve();
  }
  // The optional OmniVoice pack. A machine without it keeps Omni out of routing (the choice falls to Pocket) and
  // the Settings menu says what is missing. A pack installed while the game runs is noticed within 30 s.
  refreshOmniPack(){
    this.packCheckedAt=this.clock();
    const found=typeof this.omniPackSource==='function'?this.omniPackSource():this.omniPackSource;
    const next={installed:found?.installed!==false,missing:[...(found?.missing||[])]};
    const changed=!this.omniPack||this.omniPack.installed!==next.installed;
    this.omniPack=Object.freeze(next);
    if(this.omniVariants&&this.omniReference)this.activateOmni();
    return changed;
  }
  // Point the shared 'omni' slots at the committed reference choice's configuration.
  activateOmni(){
    const variant=this.omniVariants[this.omniReference];
    this.registries.omni=variant.registry;this.configs.omni=variant.snapshot;
    this.configuredByBackend.omni=variant.configured&&this.omniPack.installed;
    this.availabilities.omni=variant.availability;
  }
  // Verified availability is per worker configuration: Omni short and long each have their own.
  verifiedKey(backend,reference=this.omniReference){return backend==='omni'?`omni:${reference}`:backend;}
  setAvailability(backend,set){
    if(backend==='omni'){this.omniVariants[this.omniReference].availability=set;this.availabilities.omni=set;}
    else this.availabilities[backend]=set;
  }
  // The reference the Omni worker should hold: the settled draft's, else the committed one.
  get wantedReference(){return this.previewSettled&&this.preview.provider==='omni'?this.preview.omniReference:this.omniReference;}
  setKeepPrepared(value){
    this.keepPrepared=value!==false;
    this.client?.setKeepPrepared?.(this.keepPrepared);
  }
  backendUsable(backend){
    return backend==='convai'||(!!this.configuredByBackend[backend]&&this.availabilities[backend].size>0
      &&!this.failedBackends.has(backend));
  }
  // The first usable entry at or below the requested one.
  resolve(provider){
    const start=VOICE_FALLBACK_ORDER.indexOf(provider);
    return VOICE_FALLBACK_ORDER.slice(Math.max(start,0)).find(backend=>this.backendUsable(backend))||'convai';
  }
  get resolvedProvider(){return this.resolve(this.requestedProvider);}
  // Set only once the fallback is the committed route, so the player is told
  // after the voice actually changed, never during a pending switch.
  get fallback(){
    const want=this.resolvedProvider;
    return want!==this.requestedProvider&&this.provider===want?{from:this.requestedProvider,to:want}:null;
  }
  // Why a character is on Convai: chosen, or the local voice cannot serve it.
  convaiReason(profile){
    if(this.requestedProvider==='convai')return 'selected';
    const status=this.registries.pocket.status(profile);
    return status==='ready'?'unavailable':status;
  }
  // ---- Multilingual conversations: OmniVoice for replies that are not in English ----------------------------
  setMultilingual(value){
    const next=value===true;
    if(next===this.multilingual)return false;
    this.multilingual=next;if(next)this.languageFailed=false;
    this.reconcileLanguage();this.publish();
    return true;
  }
  // The second worker is wanted while the setting is on, the chosen local voice is not already OmniVoice and the
  // pack and a configured Omni reference exist. With Omni chosen the main worker speaks every language itself.
  get languageOmniWanted(){
    const variant=this.omniVariants[this.omniReference];
    // Only one OmniVoice worker may hold the GPU model slot (resident-voice-worker.py model_admission): a draft
    // or a worker of the main voice on Omni always wins over this one.
    return !this.closed&&this.multilingual&&this.playbackEnabled!==false&&this.provider!=='omni'
      &&this.targetBackend!=='omni'&&this.clientBackend!=='omni'
      &&this.omniPack.installed&&variant.configured&&!this.languageFailed;
  }
  // Can OmniVoice speak this character in another language, and is that worker loaded now?
  languageOmni(profile){
    // With Omni chosen, the main worker already speaks every reply of the characters it voices.
    if(this.provider==='omni'){const usable=this.usesProfile(profile);return {usable,ready:usable};}
    const variant=this.omniVariants[this.omniReference];
    const usable=this.languageOmniWanted&&variant.registry.has(profile)&&variant.availability.has(profile);
    const client=this.languageClient;
    return {usable,ready:usable&&!!client?.loaded&&!client.failure&&!client.closing};
  }
  // Start the second worker (no-op when it is not wanted or already starting). Failures leave it out until the
  // setting is turned on again; the turn that needed it already chose the cloud voice or the written reply.
  warmLanguageOmni(){
    if(!this.languageOmniWanted||this.languageClient)return this.languageClient?.ready||Promise.resolve();
    const variant=this.omniVariants[this.omniReference];
    let client;
    client=this.languageClient=this.omniFactory(variant.snapshot,{...this.options,keepPreparedVoices:false,
      configPath:variant.path,pythonExecutable:this.options.omniPythonExecutable,onState:value=>{
        if(this.languageClient!==client||this.closed)return;
        if(value.state==='error')queueMicrotask(()=>this.languageWorkerFailed(client));
        if(this.languageState!==value.state){this.languageState=value.state;this.publish();}
      }});
    client.setSteps?.(this.requestedOmniSteps);
    // A main Omni worker that is still exiting keeps the model slot until it is gone.
    const starting=this.retiring.catch(()=>{}).then(()=>{
      if(this.languageClient!==client)throw Error('Multilingual voice was released');
      return client.start();
    });
    starting.catch(()=>this.languageWorkerFailed(client));
    this.languageState='loading';this.publish();
    return starting;
  }
  languageWorkerFailed(client){
    if(this.closed||this.languageClient!==client)return;
    this.languageFailed=true;this.retireLanguage();
  }
  retireLanguage(){
    const client=this.languageClient;
    if(!client)return Promise.resolve();
    this.languageClient=null;this.languageState='stopped';this.publish();
    const closing=Promise.resolve().then(()=>client.close()).catch(()=>{});
    // A main Omni worker starting next waits for this exit (one model slot).
    this.languageRetiring=Promise.all([this.languageRetiring,closing]).then(()=>{});
    return closing;
  }
  reconcileLanguage(){
    if(this.languageClient&&(!this.languageOmniWanted||this.languageClient.configPath!==undefined
      &&this.languageClient.configPath!==this.omniVariants[this.omniReference].path)){
      // A reply being spoken keeps its worker until the idle boundary.
      if(!this.busy)void this.retireLanguage();
    }
  }
  get registry(){return this.registries[this.provider];}
  get config(){return this.configs[this.provider]||{};}
  get configured(){return !!this.configuredByBackend[this.provider];}
  get availability(){return this.availabilities[this.provider];}
  get steps(){return this.provider==='omni'?this.omniSteps:undefined;}
  get profileKeys() { return [...new Set([...this.registries.pocket.keys,...this.registries.omni.keys])].sort(); }
  hasProfile(key) { return this.registry.has(key) && this.availability.has(key); }
  usesProfile(key) { return local(this.provider) && this.configured && this.hasProfile(key); }
  profileReady(key) { return !this.closed&&this.usesProfile(key)&&this.clientBackend===this.provider
    &&!this.client?.failure&&!this.client?.closing&&this.client?.profileReady(key)===true; }
  request(settings) {
    if(typeof settings?.voice==='boolean'&&settings.voice!==this.playbackEnabled){
      this.playbackEnabled=settings.voice;this.routeRevision++;
      for(const key of this.routeKeys)this.routeChanges.add(key);
    }
    const chosen=canonicalVoiceProvider(settings?.voiceProvider);
    if (['pocket','omni','convai'].includes(chosen)){
      // Choosing a provider again retries it, even if it failed earlier.
      if(chosen!==this.requestedProvider)this.failedBackends.delete(chosen);
      this.requestedProvider=chosen;
    }
    if ([16,32].includes(settings?.omniSteps))this.requestedOmniSteps=settings.omniSteps;
    const reference=canonicalOmniReference(settings?.omniReference);
    if(reference)this.requestedOmniReference=reference;
    if(typeof settings?.keepPreparedVoices==='boolean'&&settings.keepPreparedVoices!==this.keepPrepared)
      this.setKeepPrepared(settings.keepPreparedVoices);
  }
  get pending() { return this.provider!==this.resolvedProvider
    ||(this.provider==='omni'&&(this.omniSteps!==this.requestedOmniSteps||this.omniReference!==this.requestedOmniReference)); }
  get availabilityPending() { const verified=this.verifiedAvailabilities.get(this.verifiedKey(this.provider));
    return !!verified&&!equalSet(this.availability,verified); }
  get previewRoutingPending(){return local(this.provider)&&this.targetBackend!==null&&this.targetBackend!==this.provider;}
  consumeRouteChanges() { const value = [...this.routeChanges].sort(); this.routeChanges.clear(); return value; }
  stageAvailability(client,backend=this.clientBackend) {
    if (this.client !== client || this.closed || !client.loaded) return;
    const registry=backend==='omni'?this.omniVariants[this.clientReference].registry:this.registries[backend];
    this.verifiedAvailabilities.set(this.verifiedKey(backend,this.clientReference),
      new Set(registry.keys.filter(key=>client.hasProfile(key))));
  }
  routingSettled({signal} = {}) {
    throwIfCancelled(signal);
    if (this.closed) return Promise.reject(Error('Voice service is closed'));
    if (!this.pending && !this.availabilityPending&&!this.previewRoutingPending) return Promise.resolve();
    let waiter;
    const pending = new Promise((resolve, reject) => { waiter = {resolve, reject}; this.routingWaiters.add(waiter); });
    return abortable(pending, signal).finally(() => this.routingWaiters.delete(waiter));
  }
  settleRouting() {
    if (this.pending || this.availabilityPending||this.previewRoutingPending) return;
    for (const waiter of this.routingWaiters) waiter.resolve();
    this.routingWaiters.clear();
  }
  get wantsLocal() {
    // Provisional configured profiles keep initial warmup intact. Once an idle
    // commit proves every reference unavailable, residency serves no local
    // route; release it without creating an automatic replacement loop.
    return this.targetBackend!==null;
  }
  get targetBackend(){
    if(this.closed)return null;
    // An unloadable settings draft must not retire a usable committed worker.
    // Apply still changes routing normally and lets unsupported profiles use
    // Convai; a configured draft retains its existing warm-up/retirement path.
    const candidates=[this.previewSettled&&this.preview&&this.resolve(this.preview.provider),this.resolvedProvider,this.provider];
    return candidates.find(candidate=>local(candidate)&&this.configuredByBackend[candidate]
      &&this.availabilities[candidate].size>0&&!this.failedBackends.has(candidate))||null;
  }
  get previewSettled(){return !!this.preview&&this.clock()-this.previewSince>=this.previewSettleMs;}
  get warmSteps(){return this.previewSettled&&this.preview.provider==='omni'?this.preview.omniSteps:this.requestedOmniSteps;}
  setPreview(preview) {
    const chosen=canonicalVoiceProvider(preview?.provider),quality=preview?.omniSteps??preview?.steps??16;
    const reference=canonicalOmniReference(preview?.omniReference)||DEFAULT_OMNI_REFERENCE;
    const next=preview&&['pocket','omni','convai'].includes(chosen)&&(!['omni'].includes(chosen)||[16,32].includes(quality))
      ?{provider:chosen,...(chosen==='omni'?{omniSteps:quality,omniReference:reference}:{})}:null;
    const changed=this.preview?.provider!==next?.provider||this.preview?.omniSteps!==next?.omniSteps
      ||this.preview?.omniReference!==next?.omniReference;
    this.preview = next;
    if (changed) this.previewSince = this.clock();
    return changed;
  }
  prepare(preview) {
    if (this.closed) return;
    const changed = this.setPreview(preview);
    this.reconcile();
    if (changed) this.publish();
  }
  update(settings, preview, busy) {
    if (this.closed) return false;
    this.busy=!!busy;
    // A pack installed while the game runs becomes usable without a restart.
    if(!this.omniPack.installed&&this.clock()-this.packCheckedAt>=PACK_RECHECK_MS)this.refreshOmniPack();
    this.request(settings);
    const previewChanged = this.setPreview(preview);
    const applied = this.applyWhenIdle(busy);
    this.reconcile();
    if (previewChanged && !applied) this.publish();
    return applied;
  }
  reconcile() {
    const wanted=this.targetBackend;
    this.phoneAnalysis?.setWanted((this.busy&&this.clientBackend==='pocket'&&this.provider==='pocket')
      ||(this.playbackEnabled!==false&&wanted==='pocket'));
    if(this.client&&(this.clientBackend!==wanted||(wanted==='omni'&&this.clientReference!==this.wantedReference))){
      // A settings draft queues warm-up immediately, but never stops the
      // model that still owns a submitted local turn. An Omni worker holds
      // one reference configuration; the other one needs a new worker.
      if(this.busy&&this.clientBackend===this.provider)return;
      this.retire();
    }
    if(this.clientBackend==='omni'&&wanted==='omni')this.client?.setSteps(this.warmSteps);
    if(wanted)void this.start().catch(()=>{});
    else if(this.client&&!this.busy)this.retire();
    this.reconcileLanguage();
  }
  publish(state = this.state, extra = {}) {
    this.state = state;
    const value = {...this.details, version: 1, state, provider: this.provider,
      requestedProvider: this.requestedProvider, fallback: this.fallback, pending: this.pending,
      playbackEnabled:this.playbackEnabled,
      omniSteps:this.omniSteps,requestedOmniSteps:this.requestedOmniSteps,
      omniReference:this.omniReference,requestedOmniReference:this.requestedOmniReference,
      previewOmniReference:this.preview?.omniReference,
      omniPack:{installed:this.omniPack.installed,missing:this.omniPack.missing},
      keepPreparedVoices:this.keepPrepared,
      multilingual:this.multilingual,languageOmni:{state:this.languageClient?this.languageState:'stopped',
        resident:!!this.languageClient?.loaded,unavailable:this.languageFailed},
      workerBackend:this.clientBackend,preparationQueued:this.targetBackend!==this.clientBackend,
      configured: this.configured, bridgePid: process.pid,
      configuredProfiles: this.profileKeys,
      availabilityPending: this.availabilityPending, routeRevision: this.routeRevision,
      routedProfiles: local(this.provider)?[...this.availability].sort():[],
      previewActive: !!this.preview, previewProvider: this.preview?.provider,
      previewOmniSteps:this.preview?.omniSteps,
      preparationOnly:this.wantsLocal&&this.targetBackend!==this.provider,
      updated: Date.now(), ...extra};
    try { Promise.resolve(this.options.onState?.(value)).catch(() => {}); } catch {}
  }
  applyWhenIdle(busy) {
    if (this.closed) return false;
    this.busy=!!busy;
    if (!this.pending && !this.availabilityPending) { this.settleRouting(); return false; }
    if (busy) { this.reconcile(); this.publish(); return false; }
    const previous = new Set(this.profileKeys.filter(key => this.usesProfile(key)));
    // The reference choice commits with the rest; its own configuration and
    // verified availability replace the previous one's.
    this.omniReference=this.requestedOmniReference;this.activateOmni();
    // Verified availability can make the chosen backend unusable (every
    // reference gone); settle on the first entry that stays usable once it
    // is applied, so one commit reaches the final route.
    let target=this.resolvedProvider;
    for(let step=0;step<VOICE_FALLBACK_ORDER.length;step++){
      const verified=this.verifiedAvailabilities.get(this.verifiedKey(target));
      if(verified)this.setAvailability(target,new Set(verified));
      const next=this.resolvedProvider;
      if(next===target)break;
      target=next;
    }
    this.provider=target;
    this.omniSteps=this.requestedOmniSteps;
    if(this.clientBackend==='omni')this.client?.setSteps(this.omniSteps);
    const changedRoutes = this.profileKeys.filter(key => previous.has(key) !== this.usesProfile(key));
    if (changedRoutes.length) {
      this.routeRevision++;
      for (const key of changedRoutes) this.routeChanges.add(key);
    }
    this.reconcile();
    this.publish();
    this.settleRouting();
    return true;
  }
  start() {
    if (this.closed) return Promise.reject(Error('Voice service is closed'));
    this.phoneAnalysis?.setWanted((this.busy&&this.clientBackend==='pocket'&&this.provider==='pocket')
      ||(this.playbackEnabled!==false&&this.targetBackend==='pocket'));
    if (!this.wantsLocal) {
      this.publish(this.releasing ? 'releasing' : (this.provider === 'convai' ? 'remote' : 'disabled'));
      return Promise.resolve();
    }
    const backend=this.targetBackend;
    if(this.clientBackend===backend&&this.client?.failure)return Promise.reject(this.client.failure);
    if(this.client&&(this.clientBackend!==backend||(backend==='omni'&&this.clientReference!==this.wantedReference))){
      if(this.busy&&this.clientBackend===this.provider)return this.starting||Promise.resolve();
      this.retire();
    }
    if (this.starting) return this.starting;
    // The multilingual Omni worker gives the model slot to a main Omni worker.
    if(backend==='omni'&&this.languageClient)void this.retireLanguage();
    let client;
    this.clientBackend=backend;
    this.clientReference=backend==='omni'?this.wantedReference:null;
    const variant=backend==='omni'?this.omniVariants[this.clientReference]:null;
    const factory=backend==='omni'?this.omniFactory:this.factory;
    const hooks={...this.options,keepPreparedVoices:this.keepPrepared,...(backend==='omni'?{configPath:variant.path,
      pythonExecutable:this.options.omniPythonExecutable}:{}),onState: value => {
      if (this.client !== client || this.closed) return;
      if (value.state === 'error') queueMicrotask(()=>this.backendFailed(backend,client));
      if (value.state === 'ready') this.stageAvailability(client,backend);
      this.details = value; this.publish(value.state);
    }};
    client=this.client=factory(backend==='omni'?variant.snapshot:this.configs[backend],hooks);
    if(backend==='omni')client.setSteps(this.warmSteps);
    client.setKeepPrepared?.(this.keepPrepared);
    this.publish(this.releasing ? 'releasing' : 'loading');
    this.starting = this.retiring.then(()=>backend==='omni'?this.languageRetiring:undefined).then(async () => {
      if (this.client !== client || this.closed) return;
      await client.start();
      this.stageAvailability(client,backend);
    });
    this.starting.catch(() => this.backendFailed(backend,client));
    return this.starting;
  }
  // A worker that cannot start or has died leaves routing; the next poll
  // commits the fallback at an idle boundary like any other change.
  backendFailed(backend,client){
    if(this.closed||this.client!==client||this.failedBackends.has(backend))return;
    this.failedBackends.add(backend);
    this.reconcile();
    this.publish();
  }
  retire() {
    const client = this.client;
    const backend=this.clientBackend;
    this.client = this.starting = this.clientBackend = this.clientReference = null;
    if (!client) { this.publish(this.releasing ? 'releasing' : (this.closed ? 'stopped' : 'remote')); return this.retiring; }
    this.releasing = true;
    this.publish('releasing');
    // Signal EOF even during warmup. The worker owns its bounded physical
    // cleanup; waiting for readiness first could prevent shutdown forever.
    // An unconfirmed prior exit must continue blocking any replacement.
    const phoneRetirement=backend==='pocket'?this.phoneAnalysis?.retire().catch(()=>{}):undefined;
    const retirement = this.retiring.then(() => Promise.all([client.close(),phoneRetirement]));
    this.retiring = retirement.then(() => {
      if (this.retiring !== completed) return;
      this.releasing = false;
      if (!this.client) {
        this.details = {resident:false,gpuVramBytes:0,cudaAllocatedMiB:0,cudaReservedMiB:0};
        this.publish(this.closed ? 'stopped' : 'remote');
      }
    });
    const completed = this.retiring;
    this.retiring.catch(() => this.publish('error', {detail: 'Could not release local voices. Restart the voice service.'}));
    return this.retiring;
  }
  async synthesizeStream(profile, text, options = {}) {
    if (this.provider!=='pocket'||!this.usesProfile(profile))throw Error('This character does not use Pocket streaming');
    await abortable(this.start(), options.signal); throwIfCancelled(options.signal);
    const client = this.client;
    if (!client || this.clientBackend!=='pocket'||!this.usesProfile(profile))throw Error('Voice selection changed before synthesis');
    // Pocket cannot render voice tags and would read them aloud: a last line of defence behind the display strip.
    return client.synthesizeStream(profile, stripSpeechTags(text), options);
  }
  // `language` (ISO 639-1, e.g. 'es') reaches the worker; a non-English reply while Pocket is chosen is spoken by
  // the multilingual worker instead of the main one.
  async synthesize(profile,text,options={}){
    if(this.provider!=='omni'&&options.language&&options.language!=='en')return this.synthesizeLanguage(profile,text,options);
    if(this.provider!=='omni'||!this.usesProfile(profile))throw Error('This character does not use OmniVoice');
    const steps=options.steps??this.omniSteps;
    await abortable(this.start(),options.signal);throwIfCancelled(options.signal);
    const client=this.client;
    if(!client||this.clientBackend!=='omni'||this.provider!=='omni'||!this.usesProfile(profile))
      throw Error('Voice selection changed before synthesis');
    // Only the tags OmniVoice renders reach it; any other bracketed tag is removed.
    return client.synthesize(profile,keepSpeechTags(text,OMNI_TAGS),{...options,steps});
  }
  async synthesizeLanguage(profile,text,options={}){
    const client=this.languageClient;
    if(!this.languageOmni(profile).usable||!client)throw Error('OmniVoice cannot speak this reply');
    const steps=options.steps??this.requestedOmniSteps;
    await abortable(client.start(),options.signal);throwIfCancelled(options.signal);
    if(this.languageClient!==client)throw Error('Voice selection changed before synthesis');
    return client.synthesize(profile,keepSpeechTags(text,OMNI_TAGS),{...options,steps});
  }
  async prepareProfile(profile, options = {}) {
    const remote = reason => ({provider: 'convai', ready: true, reason});
    for (;;) {
      throwIfCancelled(options.signal);
      if (this.closed) throw Error('Voice service is closed');
      await this.routingSettled(options);
      throwIfCancelled(options.signal);
      if (this.closed) throw Error('Voice service is closed');
      if (this.provider === 'convai') return remote(this.convaiReason(profile));
      if (!this.configured || !this.registry.has(profile)) return remote(this.registry.status(profile));
      const startingBackend=this.provider;let startedClient;
      try {
        const starting=this.start();startedClient=this.client;
        await abortable(starting, options.signal);
      }
      catch (error) {
        throwIfCancelled(options.signal);
        if (!this.closed && this.provider === 'convai') return remote(this.convaiReason(profile));
        // The failed worker is now out of routing; wait for the fallback commit.
        await new Promise(resolve => setImmediate(resolve));
        if (!this.closed && this.failedBackends.has(startingBackend)) continue;
        throw error;
      }
      throwIfCancelled(options.signal);
      // A ready worker can discover a vanished reference during an owned turn.
      // The flight waits for the normal idle commit; no polling loop is held.
      await this.routingSettled(options);
      if (this.closed) throw Error('Voice service is closed');
      if (this.provider === 'convai') return remote(this.convaiReason(profile));
      if (!this.hasProfile(profile)) return remote('unavailable');
      const client = this.client;
      // Retry only a real ownership/selection transition. A fulfilled startup
      // with no loaded owner is a failure, not a resolved-await polling loop.
      if(this.provider!==startingBackend||client!==startedClient)continue;
      if(client?.failure)throw client.failure;
      if(!client?.loaded||client.closing||this.clientBackend!==this.provider)
        throw Error('Selected local voice backend did not become ready');
      let receipt;
      const phonePreparing=this.provider==='pocket'&&this.playbackEnabled!==false&&this.phoneAnalysis
        ?this.phoneAnalysis.prepare(options).catch(error=>{throwIfCancelled(options.signal);return{ready:false};}):null;
      phonePreparing?.catch(()=>{});
      try { receipt = await client.prepareProfile(profile, options); }
      catch (error) {
        throwIfCancelled(options.signal);
        if (!this.closed && this.provider === 'convai') return remote(this.convaiReason(profile));
        await new Promise(resolve => setImmediate(resolve));
        if (!this.closed && this.failedBackends.has(startingBackend)) continue;
        throw error;
      }
      throwIfCancelled(options.signal);
      if(phonePreparing)await phonePreparing;
      throwIfCancelled(options.signal);
      await this.routingSettled(options);
      if (this.closed) throw Error('Voice service is closed');
      if (this.provider === 'convai') return remote(this.convaiReason(profile));
      if (this.client !== client) continue;
      if (!this.hasProfile(profile)) return remote('unavailable');
      return {...receipt,provider:this.provider};
    }
  }
  close() {
    if (this.closed) return this.closing||this.retiring;
    this.closed = true; this.preview = null;
    for (const waiter of this.routingWaiters) waiter.reject(Error('Voice service is closed'));
    this.routingWaiters.clear();
    return this.closing=Promise.all([this.retire(),this.retireLanguage(),this.phoneAnalysis?.close()]);
  }
}
