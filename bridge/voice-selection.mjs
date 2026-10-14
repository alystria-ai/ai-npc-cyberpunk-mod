import {PocketVoice, validatePocketConfig} from './pocket-voice.mjs';
import {ResidentVoice} from './resident-voice.mjs';
import {createVoiceProfileRegistry} from './voice-profile-registry.mjs';
import {abortable, cancelled, throwIfCancelled} from './transport-pool.mjs';
import {DEFAULT_OMNI_REFERENCE, OMNI_REFERENCES} from './voice-config-paths.mjs';
import {omniTagsFor, keepSpeechTags, stripSpeechTags} from './natural-speech.mjs';
import {pickVoiceKey, withoutVariants} from './voice-variants.mjs';
import {VHelperVoice} from './v-helper-voice.mjs';

// Routing changes commit only at a conversation boundary. Model preparation
// can begin from a settings draft while that routing remains unchanged.
// CPU/CUDA workers retire through confirmed EOF before another backend starts.
// The Mistral cloud voice (Voxtral) is a choice of the Settings menu but not a backend, and it runs no local model at all: no Pocket,
// no OmniVoice, no worker of any kind starts while it is chosen (a running one is retired when the choice is committed, like any
// backend switch). It borrows only Pocket's ROUTE and audio packet format (the same packets feed the subtitles, the lip sync and
// the face), so its routing is Pocket's and only the synthesis of each reply differs (bridge/voxtral-voice.mjs). A reply it cannot
// deliver (asked again once with a longer limit) is not given to a local voice: the turn's voice is the Convai cloud voice when the
// cloud voice has no key at all, and otherwise the reply is shown as written text.
// The Inworld cloud voice (bridge/inworld-voice.mjs) is the same kind of choice: it speaks a reply with Inworld's
// text-to-speech in a cloned voice, on the player's own Inworld key, and loads nothing locally either.
export const CLOUD_VOICES = Object.freeze(['voxtral','inworld']);
export const canonicalVoiceProvider = value => ['hybrid','omnivoice'].includes(value) ? 'omni' : CLOUD_VOICES.includes(value) ? 'pocket' : value;
export const cloudVoiceChoice = value => CLOUD_VOICES.includes(value) ? value : null;
// OmniVoice reads either its short (up to 10 s) or its long (up to 18 s) searched reference per character.
export const canonicalOmniReference = value => OMNI_REFERENCES.includes(value) ? value : null;
// Fallback order, best first: OmniVoice (16 or 32 steps), Pocket TTS, Convai. The Settings menu lists Pocket first
// because it is the default, but a choice that cannot run still falls to the next entry of THIS list: an Omni
// choice (the optional pack missing, no CUDA) lands on Pocket, a Pocket failure lands on Convai, which is always
// runnable.
export const VOICE_FALLBACK_ORDER = Object.freeze(['omni','pocket','convai']);
const PACK_RECHECK_MS = 30_000;
// A cloud voice request that gave no audio in time (or lost its connection) is asked again once, with this longer wait for the first audio.
export const CLOUD_RETRY_AUDIO_MS = Object.freeze({voxtral: 10_000, inworld: 9_000});
const RETRY_KINDS = new Set(['timeout', 'network', 'request']);
// A chosen OmniVoice that fails or times out is not given up on. Routing falls to the next voice at once, then Omni
// is loaded again in the background after each of these waits (a first failure after 45 s, then 3 min, then 10 min);
// a fourth failure ends the retries until the player chooses Omni again. Nothing here runs per frame: the retry is
// due-checked from the 500 ms settings poll, and a due retry waits for a moment with no reply in flight.
export const OMNI_RETRY_DELAYS_MS = Object.freeze([45_000, 180_000, 600_000]);
// Voice playback Off: nothing is spoken, so a local voice worker holds memory (OmniVoice: VRAM) for no one. It is released this long after the
// player turned playback off, not at the click: playback is switched off and on again for a call or a recording, and OmniVoice takes about
// 45 s to load. Loading again begins on the poll after playback is turned back on. docs/RESOURCE_LIFECYCLE.md.
export const MUTED_RELEASE_MS = 120_000;
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
    // The Mistral cloud voice: `cloud` is the committed choice, `requestedCloud` the saved setting waiting for an idle boundary.
    this.cloud=this.requestedCloud=null;
    this.voxtral=options.voxtral||null;
    this.inworld=options.inworld||null;
    this.clock = options.clock || Date.now;
    this.cloudRetryAudioMs = {...CLOUD_RETRY_AUDIO_MS, ...options.cloudRetryAudioMs};
    this.packCheckedAt=0;this.refreshOmniPack();
    this.omniReference=this.requestedOmniReference=DEFAULT_OMNI_REFERENCE;
    this.activateOmni();
    // Voxtral clones each character from the OmniVoice long reference; it reports when it falls back or recovers.
    for(const cloud of [this.voxtral,this.inworld]){
      if(!cloud)continue;
      cloud.setReferences?.([this.omniVariants.long.registry,this.omniVariants.short.registry,pocketRegistry]);
      const previous=cloud.onChange;
      cloud.onChange=degraded=>{try{previous?.(degraded);}finally{if(!this.closed)this.publish();}};
    }
    this.options = options;
    // A draft must stay unchanged this long before it may prepare a model, so
    // cycling quickly through the choices never starts or retires a worker.
    // Zero keeps the preview immediate for callers that do not debounce.
    this.previewSettleMs = Number.isFinite(options.previewSettleMs) ? Math.max(0, options.previewSettleMs) : 0;
    this.previewSince = 0;
    this.phoneAnalysis=options.phoneAnalysis;
    this.factory = options.factory || ((settings, hooks) => new PocketVoice(settings, hooks));
    this.omniFactory=options.omniFactory||((settings,hooks)=>new ResidentVoice(settings,hooks));
    // V's typed line, while OmniVoice is the committed voice: a Pocket worker of its own on the CPU (bridge/v-helper-voice.mjs). It is
    // never the route of any character; `vHelperWanted` is the V setting (on, with clips), set by the bridge's settings poll.
    this.vHelperWanted=false;
    this.vHelper=options.vHelper||new VHelperVoice({wait:()=>this.retiring,log:message=>{try{this.options.onLog?.('[VHelper] '+message+'\n');}catch{}},
      create:onState=>this.factory(this.configs.pocket,{...this.options,keepPreparedVoices:this.keepPrepared,onState})});
    // omniRetry: {failures, nextAt} while a failed Omni is to be loaded again; candidate: the background Omni worker
    // loading beside the committed fallback (Pocket is CPU only, so the two never share VRAM). candidateExit
    // chains each retired candidate's confirmed exit; a new worker starts only after it, like any replacement.
    this.omniRetry=null;this.candidate=null;this.candidateExit=Promise.resolve();
    this.omniRetryDelays=options.omniRetryDelays||OMNI_RETRY_DELAYS_MS;
    // "Keep prepared voices" (default on): Pocket saves each voice's prepared state to disk; Omni warms at the
    // selected steps while the companion joins.
    this.keepPrepared=options.keepPreparedVoices!==false;
    this.provider = this.requestedProvider = 'pocket';
    // 16 steps is the default; the saved setting replaces it on the first poll.
    this.omniSteps=this.requestedOmniSteps=16;
    this.playbackEnabled=true;
    // When playback was turned Off (null while it is on): the local worker is released MUTED_RELEASE_MS later (see `mutedIdle`).
    this.mutedSince=null;this.mutedReleaseMs=Number.isFinite(options.mutedReleaseMs)?Math.max(0,options.mutedReleaseMs):MUTED_RELEASE_MS;
    // Voice variants ("<profile>-v2") are registry entries, not profiles: never a route key.
    this.routeKeys=withoutVariants(new Set([...Object.keys(this.configs.pocket.voices),
      ...OMNI_REFERENCES.flatMap(reference=>Object.keys(this.omniVariants[reference].snapshot.voices)),
      ...(options.profileKeys||[])])).sort();
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
    // Multilingual conversations: Pocket TTS speaks only English, so while it is on the fallback skips Pocket (an Omni
    // choice that cannot run lands on the cloud voice). Settings never pair the two; a hand-edited pairing also ends
    // on the cloud voice.
    this.multilingual=false;
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
    this.candidate?.client.setKeepPrepared?.(this.keepPrepared);
  }
  // A Pocket worker that failed earlier stays out of routing, except for a cloud voice: it runs no worker, so the failure is not its.
  backendUsable(backend){
    return backend==='convai'||(!!this.configuredByBackend[backend]&&this.availabilities[backend].size>0
      &&(!this.failedBackends.has(backend)||(backend==='pocket'&&this.cloudWanted)));
  }
  // The first usable entry at or below the requested one.
  resolve(provider){
    const start=VOICE_FALLBACK_ORDER.indexOf(provider);
    return VOICE_FALLBACK_ORDER.slice(Math.max(start,0))
      .find(backend=>this.backendUsable(backend)&&!(this.multilingual&&backend==='pocket'))||'convai';
  }
  get resolvedProvider(){return this.resolve(this.requestedProvider);}
  // The cloud voice speaks replies: chosen and committed; its route is Pocket's (packet format and routing only, no Pocket worker).
  get cloudEngine(){return this.cloud==='inworld'?this.inworld:this.cloud==='voxtral'?this.voxtral:null;}
  get cloudActive(){return !!this.cloudEngine&&this.provider==='pocket';}
  // The player chose a cloud voice (committed or waiting for the idle boundary). No local voice model is loaded for it.
  get cloudWanted(){return this.requestedCloud!==null;}
  // A cloud voice with no key cannot speak anything: the turn's voice is the Convai cloud voice (bridge: localChoice).
  get cloudKeyless(){return this.cloudActive&&!this.cloudEngine.hasKey;}
  // Why the cloud voice is not the one speaking, for the Settings status line and the one notice: no key, or its last
  // reply fell back (nothing is reported before a first failure, and it clears by itself with the next good reply).
  // Why the cloud voice cannot even be asked right now (no key, a limit or a refused key cooling down); null when it will be tried.
  // A timeout or a dropped connection on an earlier reply does not block the next one ("next reply tries again"), so it is not
  // reported here: the routing line is written before the reply is voiced and must not claim Pocket for a reply that then
  // spoke in the cloud voice (2026-10-13: the line said used=Pocket for a reply that was spoken by Voxtral from start to end).
  get cloudBlocked(){
    if(!this.cloudActive)return null;
    return !this.cloudEngine.hasKey||!this.cloudEngine.ready?this.cloudFallback:null;
  }
  // How the cloud voice's last attempt ended when it did not block this one ('timeout', 'network', ...), else null.
  get cloudLast(){
    return this.cloudActive&&!this.cloudBlocked?this.cloudEngine.degraded?.reason??null:null;
  }
  get cloudFallback(){
    if(!this.cloudActive)return null;
    const value={from:this.cloud,to:'convai'},engine=this.cloudEngine;
    if(!engine.hasKey)return {...value,temporary:false,reason:'no-key'};
    const degraded=engine.degraded;
    if(!degraded)return null;
    // A key that was refused, or a plan whose free allowance is used up, is not coming back by itself.
    return {...value,temporary:degraded.reason!=='key'&&degraded.reason!=='no-key'&&degraded.reason!=='quota',reason:degraded.reason};
  }
  // Set only once the fallback is the committed route, so the player is told
  // after the voice actually changed, never during a pending switch.
  // `temporary` marks an Omni that is being loaded again in the background; the voice returns by itself.
  get fallback(){
    const want=this.resolvedProvider;
    if(want===this.requestedProvider||this.provider!==want)return null;
    const value={from:this.requestedProvider,to:want};
    return this.requestedProvider==='omni'&&this.omniRetry?{...value,temporary:true}:value;
  }
  // Why a character is on Convai: chosen, or the local voice cannot serve it.
  convaiReason(profile){
    if(this.requestedProvider==='convai')return 'selected';
    const status=this.registries.pocket.status(profile);
    return status==='ready'?'unavailable':status;
  }
  // Can the chosen voice speak this character in a language other than English? Only OmniVoice can.
  languageOmni(profile){const usable=this.provider==='omni'&&this.usesProfile(profile);return {usable,ready:usable};}
  get registry(){return this.registries[this.provider];}
  get config(){return this.configs[this.provider]||{};}
  get configured(){return !!this.configuredByBackend[this.provider];}
  get availability(){return this.availabilities[this.provider];}
  get steps(){return this.provider==='omni'?this.omniSteps:undefined;}
  // Profiles only: the extra voices of a profile (bridge/voice-variants.mjs) stay in the registries and the workers.
  get profileKeys() { return withoutVariants(new Set([...this.registries.pocket.keys,...this.registries.omni.keys])).sort(); }
  hasProfile(key) { return this.registry.has(key) && this.availability.has(key); }
  usesProfile(key) { return local(this.provider) && this.configured && this.hasProfile(key); }
  // The voice that speaks one NPC of a local profile: the profile's own key, or one of its variants chosen from the
  // NPC's stable identity among the variants the current backend can speak. The caller decides once per turn and keeps
  // routing (usesProfile, profileReady, provider) on the BASE key. Anything not spoken locally keeps its key.
  voiceKeyFor(profile, seed) {
    if (!this.usesProfile(profile)) return profile;
    return pickVoiceKey(profile, seed, [...this.availability].filter(key => this.registry.has(key)));
  }
  // A cloud voice has no worker to wait for: a character is ready when it can be routed (its key and clip are checked per reply).
  profileReady(key) { return !this.closed&&this.usesProfile(key)&&(this.cloudActive||(this.clientBackend===this.provider
    &&!this.client?.failure&&!this.client?.closing&&this.client?.profileReady(key)===true)); }
  request(settings) {
    if(typeof settings?.voice==='boolean'&&settings.voice!==this.playbackEnabled){
      // A game that starts with playback Off never loads a worker (the first reading counts as long ago); a click does not release at once.
      this.mutedSince=settings.voice?null:this.playbackKnown?this.clock():this.clock()-this.mutedReleaseMs;
      this.playbackEnabled=settings.voice;this.routeRevision++;
      for(const key of this.routeKeys)this.routeChanges.add(key);
    }
    if(typeof settings?.voice==='boolean')this.playbackKnown=true;
    const chosen=canonicalVoiceProvider(settings?.voiceProvider);
    if(typeof settings?.voiceProvider==='string')this.requestedCloud=cloudVoiceChoice(settings.voiceProvider);
    if (['pocket','omni','convai'].includes(chosen)){
      // Choosing a provider again retries it, even if it failed earlier.
      if(chosen!==this.requestedProvider){
        this.failedBackends.delete(chosen);
        // Any change of or to Omni starts its retry story afresh (the normal start path takes over).
        if(chosen==='omni'||this.requestedProvider==='omni')this.endOmniRetry();
      }
      this.requestedProvider=chosen;
    }
    if ([16,32].includes(settings?.omniSteps))this.requestedOmniSteps=settings.omniSteps;
    if(typeof settings?.multilingualConversations==='boolean')this.multilingual=settings.multilingualConversations;
    const reference=canonicalOmniReference(settings?.omniReference);
    if(reference)this.requestedOmniReference=reference;
    // Prepared voices are always kept (Settings has no switch for it any more): a saved keepPreparedVoices is not read.
  }
  get pending() { return this.provider!==this.resolvedProvider||this.cloud!==this.requestedCloud
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
    this.tickVHelper();
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
    // A cloud voice loads no local model: only a settings draft that previews a local voice can ask for one.
    // Voice playback has been Off for the grace period: nothing is spoken, so the committed voice's worker is released (a settings draft
    // that previews a local voice still warms it: the player is choosing a voice).
    const candidates=[this.previewSettled&&this.preview&&this.resolve(this.preview.provider),
      ...(this.cloudWanted||this.mutedIdle?[]:[this.resolvedProvider,this.provider])];
    return candidates.find(candidate=>local(candidate)&&this.configuredByBackend[candidate]
      &&this.availabilities[candidate].size>0&&!this.failedBackends.has(candidate))||null;
  }
  // Playback Off for longer than the grace period: the committed local voice has no use for a loaded worker.
  get mutedIdle(){return this.playbackEnabled===false&&this.mutedSince!==null&&this.clock()-this.mutedSince>=this.mutedReleaseMs;}
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
    this.maintainOmniRetry();
    if (previewChanged && !applied) this.publish();
    return applied;
  }
  // The lip-sync analysis serves every voice that speaks through the Pocket route, the cloud voices too (it analyses audio; it is not a voice).
  get phoneWanted(){
    return (this.busy&&this.provider==='pocket'&&(this.clientBackend==='pocket'||this.cloudActive))
      ||(this.playbackEnabled!==false&&(this.targetBackend==='pocket'||(this.cloudWanted&&this.resolvedProvider==='pocket')));
  }
  reconcile() {
    const wanted=this.targetBackend;
    this.phoneAnalysis?.setWanted(this.phoneWanted);
    if(this.client&&(this.clientBackend!==wanted||(wanted==='omni'&&this.clientReference!==this.wantedReference))){
      // A settings draft queues warm-up immediately, but never stops the
      // model that still owns a submitted local turn. An Omni worker holds
      // one reference configuration; the other one needs a new worker.
      if(this.busy&&this.clientBackend===this.provider)return;
      this.retire();
    }
    this.adoptCandidate(wanted);
    if(this.clientBackend==='omni'&&wanted==='omni')this.client?.setSteps(this.warmSteps);
    if(wanted)void this.start().catch(()=>{});
    else if(this.client&&!this.busy)this.retire();
    this.tickVHelper();
  }
  publish(state = this.state, extra = {}) {
    this.state = state;
    const value = {...this.details, version: 1, state, provider: this.provider,
      requestedProvider: this.requestedProvider, fallback: this.fallback??this.cloudFallback, pending: this.pending,
      cloudVoice:this.cloudActive?this.cloud:null,
      voxtral:this.voxtral?{key:this.voxtral.hasKey,degraded:this.voxtral.degraded?.reason??null,spoke:this.voxtral.spoke,
        fellBack:this.voxtral.fellBack}:null,
      inworld:this.inworld?{key:this.inworld.hasKey,degraded:this.inworld.degraded?.reason??null,spoke:this.inworld.spoke,
        fellBack:this.inworld.fellBack,characters:this.inworld.chars}:null,
      playbackEnabled:this.playbackEnabled,
      omniSteps:this.omniSteps,requestedOmniSteps:this.requestedOmniSteps,
      omniReference:this.omniReference,requestedOmniReference:this.requestedOmniReference,
      previewOmniReference:this.preview?.omniReference,
      omniPack:{installed:this.omniPack.installed,missing:this.omniPack.missing},
      keepPreparedVoices:this.keepPrepared,
      multilingual:this.multilingual,
      workerBackend:this.clientBackend,preparationQueued:this.targetBackend!==this.clientBackend,
      omniRetry:this.omniRetry?{failures:this.omniRetry.failures,loading:!!this.candidate,
        nextInMs:this.candidate?0:Math.max(0,this.omniRetry.nextAt-this.clock())}:null,
      configured: this.configured, bridgePid: process.pid,
      configuredProfiles: this.profileKeys,
      availabilityPending: this.availabilityPending, routeRevision: this.routeRevision,
      routedProfiles: local(this.provider)?withoutVariants(this.availability).sort():[],
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
    this.cloud=this.requestedCloud;
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
    this.phoneAnalysis?.setWanted(this.phoneWanted);
    if (!this.wantsLocal) {
      this.publish(this.releasing ? 'releasing' : (this.provider === 'convai'||this.cloudWanted ? 'remote' : this.mutedIdle ? 'stopped' : 'disabled'));
      return Promise.resolve();
    }
    const backend=this.targetBackend;
    if(this.clientBackend===backend&&this.client?.failure)return Promise.reject(this.client.failure);
    if(this.client&&(this.clientBackend!==backend||(backend==='omni'&&this.clientReference!==this.wantedReference))){
      if(this.busy&&this.clientBackend===this.provider)return this.starting||Promise.resolve();
      this.retire();
    }
    // A background Omni that finished loading takes the empty slot: no second load of the same model.
    if(this.adoptCandidate(backend))return this.starting;
    if (this.starting) return this.starting;
    // A new Omni worker is about to load: a background one that could not be adopted (another reference) must exit first.
    if(backend==='omni'&&this.candidate)void this.dropCandidate();
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
    // Pocket's work folder has one lock: V's helper Pocket worker (beside OmniVoice) is gone before this worker starts.
    const helperExit=backend==='pocket'?this.vHelper.release():undefined;
    this.starting = Promise.all([this.retiring,this.candidateExit,helperExit]).then(async () => {
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
    if(backend==='omni')this.scheduleOmniRetry(client.failure?.message);
    this.reconcile();
    this.publish();
  }
  log(message){try{this.options.onLog?.(`[OmniRetry] ${message}\n`);}catch{}}
  // The next Omni attempt, if the player still wants Omni and attempts remain. `fallback.temporary` follows it.
  scheduleOmniRetry(reason){
    const failures=(this.omniRetry?.failures??0)+1,delay=this.omniRetryDelays[failures-1];
    if(this.closed||this.requestedProvider!=='omni'||this.omniPack.installed===false||delay===undefined){
      if(this.omniRetry||delay===undefined)this.log(`giving up after ${failures} failed attempts${reason?` (${reason})`:''}`);
      this.omniRetry=null;return;
    }
    this.omniRetry={failures,nextAt:this.clock()+delay};
    this.log(`attempt ${failures} failed${reason?` (${reason})`:''}; trying again in ${Math.round(delay/1000)} s`);
  }
  endOmniRetry(){this.omniRetry=null;void this.dropCandidate();}
  // Due-checked from update() (the 500 ms settings poll): no timer, no loop. Waits for a moment with no reply in
  // flight, so the load never competes with a reply's own work, and for the previous worker's confirmed exit.
  maintainOmniRetry(){
    if(this.closed)return;
    // A background worker for a reference the player no longer wants (loading, or loaded and waiting for its idle
    // commit) is released; the normal start path loads the wanted one after its confirmed exit.
    if(this.candidate&&(this.requestedProvider!=='omni'||this.candidate.reference!==this.requestedOmniReference||this.mutedIdle))void this.dropCandidate();
    if(!this.omniRetry)return;
    if(this.requestedProvider!=='omni'||this.omniPack.installed===false){this.endOmniRetry();return;}
    if(this.candidate)return;
    // A committed Omni (re)starting through the normal path is its own retry. No load while voice playback is off.
    if(this.busy||this.playbackEnabled===false||this.clientBackend==='omni'||this.clock()<this.omniRetry.nextAt)return;
    this.startCandidate();
  }
  startCandidate(){
    const reference=this.requestedOmniReference,variant=this.omniVariants[reference];
    if(!variant.configured){this.omniRetry=null;return;}
    const entry={reference,client:null,loaded:false,lastState:null};
    const hooks={...this.options,keepPreparedVoices:this.keepPrepared,configPath:variant.path,
      pythonExecutable:this.options.omniPythonExecutable,lowPriority:true,onState:value=>{
        if(this.closed)return;
        if(this.candidate===entry){
          entry.lastState=value;
          if(value.state==='error')queueMicrotask(()=>this.candidateFailed(entry));
          return;
        }
        // Adopted: from here on it is the committed worker and reports like any other.
        if(this.client!==entry.client)return;
        if(value.state==='error')queueMicrotask(()=>this.backendFailed('omni',entry.client));
        if(value.state==='ready')this.stageAvailability(entry.client,'omni');
        this.details=value;this.publish(value.state);
      }};
    entry.client=this.omniFactory(variant.snapshot,hooks);
    entry.client.setSteps?.(this.requestedOmniSteps);
    entry.client.setKeepPrepared?.(this.keepPrepared);
    this.candidate=entry;
    this.log(`loading OmniVoice in the background (retry ${this.omniRetry.failures})`);
    entry.starting=Promise.all([this.retiring,this.candidateExit]).then(()=>{
      if(this.candidate!==entry||this.closed)throw cancelled('Background voice load was dropped');
      return entry.client.start();
    }).then(()=>this.candidateReady(entry),()=>this.candidateFailed(entry));
    this.publish();
  }
  candidateReady(entry){
    if(this.candidate!==entry||this.closed)return;
    entry.loaded=true;
    const registry=this.omniVariants[entry.reference].registry;
    this.verifiedAvailabilities.set(this.verifiedKey('omni',entry.reference),
      new Set(registry.keys.filter(key=>entry.client.hasProfile(key))));
    // Omni is routable again. The commit (provider back to Omni, the fallback worker retired, this one adopted)
    // belongs to the next idle poll, never to this callback, so a reply in flight keeps its voice.
    this.omniRetry=null;this.failedBackends.delete('omni');
    this.log('OmniVoice is ready; it takes over at the next idle reply boundary');
    this.publish();
  }
  candidateFailed(entry){
    if(this.candidate!==entry||this.closed)return;
    this.candidate=null;
    // Also when it dies after finishing but before the idle commit: Omni leaves routing again, the fallback stays.
    this.failedBackends.add('omni');
    void this.retireCandidate(entry).catch(()=>{this.omniRetry=null;});
    this.scheduleOmniRetry(entry.client.failure?.message);
    this.publish();
  }
  retireCandidate(entry){
    const closing=Promise.resolve().then(()=>entry.client.close());
    this.candidateExit=this.candidateExit.then(()=>closing);
    this.candidateExit.catch(()=>{});
    return this.candidateExit;
  }
  dropCandidate(){
    const entry=this.candidate;
    if(entry){this.candidate=null;this.retireCandidate(entry);}
    return this.candidateExit;
  }
  // The loaded background worker becomes the committed one once the fallback worker is gone.
  adoptCandidate(wanted){
    const entry=this.candidate;
    if(!entry?.loaded||this.client||wanted!=='omni'||entry.reference!==this.wantedReference||entry.client.failure||entry.client.closing)return false;
    this.candidate=null;
    this.client=entry.client;this.clientBackend='omni';this.clientReference=entry.reference;
    this.starting=Promise.resolve();
    this.details=entry.lastState||this.details;
    return true;
  }
  retire() {
    const client = this.client;
    const backend=this.clientBackend;
    this.client = this.starting = this.clientBackend = this.clientReference = null;
    this.tickVHelper();
    if (!client) { this.publish(this.releasing ? 'releasing' : (this.closed||this.mutedIdle ? 'stopped' : 'remote')); return this.retiring; }
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
        this.publish(this.closed||this.mutedIdle ? 'stopped' : 'remote');
      }
    });
    const completed = this.retiring;
    this.retiring.catch(() => this.publish('error', {detail: 'Could not release local voices. Restart the voice service.'}));
    return this.retiring;
  }
  // ---- V's helper voice (bridge/v-helper-voice.mjs) ----
  // It exists only while OmniVoice is the committed, loaded voice (never beside a cloud voice, the Pocket voice, the Convai voice or a
  // muted playback), the V setting is on, and Pocket is configured. Due-checked where routing already changes; nothing runs on a timer.
  get vHelperDue() {
    return this.vHelperWanted&&!this.closed&&this.playbackEnabled!==false&&this.provider==='omni'&&!this.cloudActive
      &&this.clientBackend==='omni'&&this.client?.loaded===true&&!this.client.failure&&!this.client.closing
      &&this.provider===this.requestedProvider&&!!this.configuredByBackend.pocket;
  }
  tickVHelper() {
    if (this.vHelperDue) this.vHelper.start(); else void this.vHelper.release();
  }
  setVHelperWanted(value) {
    value = value === true;
    if (value === this.vHelperWanted) return;
    this.vHelperWanted = value; this.tickVHelper();
  }
  /** Could V's helper speak this key (Pocket's configuration has it)? True while OmniVoice is committed; says nothing about being loaded. */
  vHelperSpeaks(key) {
    return this.provider==='omni'&&!this.cloudActive&&!!this.configuredByBackend.pocket&&this.registries.pocket.has(key)&&this.availabilities.pocket.has(key);
  }
  /** Is the helper loaded and ready for this key? Also asks it to load when it is due and not yet running, so a missed trigger heals itself. */
  vHelperReady(key) { this.tickVHelper(); return this.vHelper.ready(key); }
  vHelperStream(key, text, options = {}) { return this.vHelper.stream(key, stripSpeechTags(text), options); }
  vHelperPrepare(key, options = {}) { return this.vHelper.prepare(key, options); }
  async synthesizeStream(profile, text, options = {}) {
    if (this.provider!=='pocket'||!this.usesProfile(profile))throw Error('This character does not use Pocket streaming');
    // Pocket cannot render voice tags and would read them aloud: a last line of defence behind the display strip. The same
    // goes for the cloud voice.
    const spoken = stripSpeechTags(text);
    // `utterance`/`role` (bridge/voice-utterance.mjs): this text is a piece of a reply voiced in more than one call (a streamed
    // first sentence, then the rest). One reply, one voice: the head decides, the tail follows.
    const {utterance, role, ...plain} = options;
    // A cloud voice never touches the local worker (none is running): see synthesizeCloud.
    if (this.cloudActive) return this.synthesizeCloud(profile, spoken, plain, utterance, role);
    await abortable(this.start(), options.signal); throwIfCancelled(options.signal);
    const client = this.client;
    if (!client || this.clientBackend!=='pocket'||!this.usesProfile(profile))throw Error('Voice selection changed before synthesis');
    utterance?.decide('pocket');
    return client.synthesizeStream(profile, spoken, plain);
  }
  // A reply spoken by the cloud voice. No local voice takes part, so there is no fallback voice here: a request that gave no audio in
  // time (or lost its connection) is asked again once with a longer wait (CLOUD_RETRY_AUDIO_MS), and a reply that still has no audio
  // throws, which ends it as written text (the caller shows the written reply with the one notice). The reply's engine is decided
  // by the first audio that reaches the player (bridge/voice-utterance.mjs); 'pocket' there only means "not a cloud voice".
  synthesizeCloud(profile, spoken, options, utterance, role) {
    if (utterance && role === 'tail') return this.synthesizeRest(profile, spoken, options, utterance);
    return this.synthesizeHead(profile, spoken, options, utterance);
  }
  async synthesizeHead(profile, spoken, options, utterance) {
    const name = this.cloud, engine = this.cloudEngine;
    let started = false;
    const onPcm = options.onPcm && (packet => {
      if (!started) { started = true; utterance?.decide(name); }
      return options.onPcm(packet);
    });
    const ask = extra => engine.synthesizeStream(profile, spoken, {...options, onPcm, ...extra});
    try {
      if (!engine.ready) throw Error(`The ${name} voice cannot be asked now (${engine.hasKey ? 'waiting out a limit' : 'no key'})`);
      try { return await ask(); }
      catch (error) {
        throwIfCancelled(options.signal);
        // The consumer's own failure, audio already played, or a failure that asking again cannot mend: never a second voice.
        if (error?.sink || started || !RETRY_KINDS.has(error?.kind) || !engine.ready) throw error;
      }
      engine.log?.('no audio for the first ask; asking again once with a longer wait');
      return await ask({firstAudioMs: this.cloudRetryAudioMs[name]});
    } finally {
      // The head always settles the reply's voice, so the rest waiting for it never waits for ever.
      utterance?.decide(started ? name : 'pocket');
    }
  }
  // The rest of a reply (the tail) whose first sentence was voiced by `synthesizeHead`. It is spoken by the engine that spoke the
  // first sentence, never by another one:
  //   - the cloud voice spoke the head: the cloud voice speaks the rest (Voxtral asks again once with longer limits,
  //     VoxtralVoice.fetchPartAgain); if that fails too, the error is thrown and the caller ends the reply after the head;
  //   - the head was not spoken (no audio): nothing speaks the rest.
  // The cloud request is sent at once, in parallel with the head, even before the head's first audio exists; what it delivers is
  // held until the head is known to have been the cloud voice, and dropped (the request cancelled) if it was not.
  async synthesizeRest(profile, spoken, options, utterance) {
    const unvoiced = async () => { utterance.decide('pocket'); throw Error('The cloud voice did not speak the first part of this reply'); };
    if (utterance.engine === 'pocket' || !this.cloudEngine.hasKey) return unvoiced();
    if (this.cloud === 'inworld') return this.synthesizeInworldRest(profile, spoken, options, utterance, unvoiced);
    // A reply never changes cloud voice partway: a head Inworld spoke is not continued by Voxtral (the reply ends after the head).
    if (utterance.engine === 'inworld') throw Error('The cloud voice changed during the reply');
    const own = new AbortController();
    const relay = () => own.abort(options.signal.reason);
    options.signal?.addEventListener('abort', relay, {once: true});
    if (options.signal?.aborted) relay();
    void utterance.decision.then(engine => { if (engine !== 'voxtral') own.abort(cancelled()); });
    const held = [];
    let open = utterance.engine === 'voxtral';
    const sink = packet => { if (open) return options.onPcm(packet); held.push(packet); return undefined; };
    // Once the head is known to be the cloud voice, what arrived early is handed on, in order, before anything newer.
    const opening = utterance.decision.then(async engine => {
      if (engine !== 'voxtral') { held.length = 0; return; }
      while (held.length) await options.onPcm(held.shift());
      open = true;
    });
    opening.catch(() => {});
    let cloud, failure;
    try { cloud = await this.voxtral.synthesizeStream(profile, spoken, {signal: own.signal, onPcm: sink, continuation: true}); }
    catch (error) { failure = error; }
    finally { options.signal?.removeEventListener('abort', relay); }
    throwIfCancelled(options.signal);
    // The head may not have decided yet (its first audio is still on the way): the rest waits for it.
    if (await utterance.decision !== 'voxtral') {
      if (failure?.sink) throw failure;
      return unvoiced();
    }
    await opening;
    if (failure) throw failure;
    return cloud;
  }
  // The rest of a reply whose first part was voiced by Inworld: it waits for the head's decision and follows it. A rest that
  // fails after Inworld began ends the reply early (what was spoken stands); nothing else continues it.
  async synthesizeInworldRest(profile, spoken, options, utterance, unvoiced) {
    const engine = await utterance.wait(options.signal);
    if (engine === 'pocket') return unvoiced();
    if (engine !== 'inworld') throw Error('The cloud voice changed during the reply');
    return this.inworld.synthesizeStream(profile, spoken, options);
  }
  // `language` (ISO 639-1, e.g. 'es') reaches the worker for a reply that is not in English.
  async synthesize(profile,text,options={}){
    if(this.provider!=='omni'||!this.usesProfile(profile))throw Error('This character does not use OmniVoice');
    const steps=options.steps??this.omniSteps;
    await abortable(this.start(),options.signal);throwIfCancelled(options.signal);
    const client=this.client;
    if(!client||this.clientBackend!=='omni'||this.provider!=='omni'||!this.usesProfile(profile))
      throw Error('Voice selection changed before synthesis');
    // Only the tags OmniVoice renders reach it; any other bracketed tag is removed.
    return client.synthesize(profile,keepSpeechTags(text,omniTagsFor(options.language)),{...options,steps});
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
      // Playback Off past its grace period: no worker is kept, and nobody is waited on for one. The character is ready to join; loading
      // begins when playback is turned on (the poll after it). `muted` lets the caller accept a receipt that has no loaded worker behind it.
      if (this.mutedIdle && this.usesProfile(profile)) return {provider: this.provider, ready: true, profile, muted: true};
      // A cloud voice has no local model to prepare: the character is ready when it is routed. Its reference clip is read, cut and
      // encoded now (the Inworld voice is found or cloned now), so the first reply is not waiting for it.
      if (this.cloudActive) {
        if (this.cloud === 'voxtral' && this.voxtral?.ready) void this.voxtral.reference(profile);
        if (this.cloud === 'inworld') this.inworld.warm?.(profile);
        return {provider: 'pocket', ready: true, profile, cloudVoice: this.cloud};
      }
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
    this.closed = true; this.preview = null; this.omniRetry = null;
    for (const waiter of this.routingWaiters) waiter.reject(Error('Voice service is closed'));
    this.routingWaiters.clear();
    return this.closing=Promise.all([this.retire(),this.phoneAnalysis?.close(),this.dropCandidate(),this.vHelper.release()]);
  }
}
