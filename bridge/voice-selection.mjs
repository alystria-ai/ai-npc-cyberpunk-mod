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
export const CLOUD_VOICES = Object.freeze(['voxtral']);
// A settings file saved while a since-removed cloud voice existed still names it: it resolves to Pocket, the default voice (no error, no log).
const REMOVED_VOICES = Object.freeze(['inworld']);
export const canonicalVoiceProvider = value => ['hybrid','omnivoice'].includes(value) ? 'omni' : CLOUD_VOICES.includes(value) || REMOVED_VOICES.includes(value) ? 'pocket' : value;
export const cloudVoiceChoice = value => CLOUD_VOICES.includes(value) ? value : null;
// OmniVoice reads either its short (up to 10 s) or its long (up to 18 s) searched reference per character.
export const canonicalOmniReference = value => OMNI_REFERENCES.includes(value) ? value : null;
// Fallback order, best first: OmniVoice (16 or 32 steps), Pocket TTS, Convai. The Settings menu lists Pocket first
// because it is the default, but a choice that cannot run still falls to the next entry of THIS list: an Omni
// choice (the optional pack missing, no CUDA) lands on Pocket, a Pocket failure lands on Convai, which is always
// runnable.
// A Python library the voice needs that Windows refused to load: Smart App Control, or a company's or a school's Application Control (WDAC) policy, blocks a
// file that is not signed by a publisher it trusts ("DLL load failed ... An Application Control policy has blocked this file", 2026-10-20 live record).
// Asking again cannot change that, and nothing in the mod can: the voice is not retried, and the Help row says what blocked it.
export const blockedByWindows = reason => /application control|policy has blocked|blocked this file|smart app control|code integrity|blocked by (?:the )?(?:group )?policy/i.test(String(reason ?? ''));
export const VOICE_FALLBACK_ORDER = Object.freeze(['omni','pocket','convai']);
const PACK_RECHECK_MS = 30_000;
// A cloud voice request that gave no audio in time (or lost its connection) is asked again once, with this longer wait for the first audio.
export const CLOUD_RETRY_AUDIO_MS = Object.freeze({voxtral: 10_000});
const RETRY_KINDS = new Set(['timeout', 'network', 'request']);
// A chosen OmniVoice that fails or times out is not given up on. Routing falls to the next voice at once, then Omni
// is loaded again in the background after each of these waits (a first failure after 45 s, then 3 min, then 10 min);
// a fourth failure ends the retries until the player chooses Omni again. Nothing here runs per frame: the retry is
// due-checked from the 500 ms settings poll, and a due retry waits for a moment with no reply in flight.
export const OMNI_RETRY_DELAYS_MS = Object.freeze([45_000, 180_000, 600_000]);
// A chosen Pocket worker that fails (a start that stalls twice while the game loads, or a crash) is not given up on either: the same waits and
// the same end after the fourth failure, then the normal start loads it again (it has no background candidate, since the voice it falls to,
// Convai's, loads nothing). Due-checked from the poll like Omni's, never per turn; the story ends when the player no longer wants Pocket.
export const POCKET_RETRY_DELAYS_MS = Object.freeze([45_000, 180_000, 600_000]);
// Voice playback Off (user decision, 2026-10-14: "if they turn it off it should not be loaded"): the companions' voice worker is released at
// once, on the poll that reads the setting. The one thing kept is what V's typed line needs while V's voice is On (`vHelperWanted`): the
// Pocket worker (the chosen one, or V's helper beside OmniVoice). A cloud voice has no worker. Loading again begins on the poll after
// playback is turned back on. docs/RESOURCE_LIFECYCLE.md.
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
    // What a worker is started with never changes: its configuration file is the start-up one, and what it holds is checked against that.
    // The voices a player changes later (setVoices) replace the routing registries above and are sent to the running workers.
    this.snapshotOf=snapshot;this.pocketBase=validated;
    this.baseConfigs={pocket:this.configs.pocket,omni:Object.fromEntries(OMNI_REFERENCES.map(reference=>[reference,this.omniVariants[reference].snapshot]))};
    this.live=null;this.pendingVoices=null;
    this.configuredByBackend={pocket:!!validated&&pocketRegistry.keys.length>0};
    this.availabilities={pocket:new Set(pocketRegistry.keys),convai:new Set()};
    // The optional OmniVoice pack (worker Python, model weights): a function or a fixed {installed, missing}.
    this.omniPackSource=options.omniPack||(()=>({installed:true,missing:[]}));
    // A character the player made (bridge/custom-characters.mjs) has a voice of its own only when it was given a clip before the service
    // started; `aliases(key)` names the voice that speaks it until then and when it has none (the resident voice of its gender).
    this.aliases=typeof options.aliases==='function'?options.aliases:null;
    // The Mistral cloud voice: `cloud` is the committed choice, `requestedCloud` the saved setting waiting for an idle boundary.
    this.cloud=this.requestedCloud=null;
    this.voxtral=options.voxtral||null;
    this.clock = options.clock || Date.now;
    this.cloudRetryAudioMs = {...CLOUD_RETRY_AUDIO_MS, ...options.cloudRetryAudioMs};
    this.packCheckedAt=0;this.refreshOmniPack();
    this.omniReference=this.requestedOmniReference=DEFAULT_OMNI_REFERENCE;
    this.activateOmni();
    // Voxtral clones each character from the OmniVoice long reference; it reports when it falls back or recovers.
    for(const cloud of [this.voxtral]){
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
    this.vHelper=options.vHelper||new VHelperVoice({wait:()=>this.retiring,onReady:()=>this.options.onVHelperReady?.(),log:message=>{try{this.options.onLog?.('[VHelper] '+message+'\n');}catch{}},
      onFailure:reason=>this.noteFailure('v-helper',reason),
      clock:()=>this.clock(),retryDelays:options.vHelperRetryDelays,noRetry:blockedByWindows,busy:()=>this.busy,
      create:onState=>this.primed(this.factory(this.baseConfigs.pocket,{...this.options,keepPreparedVoices:this.keepPrepared,onState}),'pocket')});
    // omniRetry: {failures, nextAt} while a failed Omni is to be loaded again; candidate: the background Omni worker
    // loading beside the committed fallback (Pocket is CPU only, so the two never share VRAM). candidateExit
    // chains each retired candidate's confirmed exit; a new worker starts only after it, like any replacement.
    this.omniRetry=null;this.candidate=null;this.candidateExit=Promise.resolve();
    this.omniRetryDelays=options.omniRetryDelays||OMNI_RETRY_DELAYS_MS;
    // pocketRetry: {failures, nextAt} while a failed Pocket is to be loaded again
    this.pocketRetry=null;this.pocketRetryDelays=options.pocketRetryDelays||POCKET_RETRY_DELAYS_MS;
    this.failureReasons={};
    // "Keep prepared voices" (default on): Pocket saves each voice's prepared state to disk; Omni warms at the
    // selected steps while the companion joins.
    this.keepPrepared=options.keepPreparedVoices!==false;
    this.provider = this.requestedProvider = 'pocket';
    // 16 steps is the default; the saved setting replaces it on the first poll.
    this.omniSteps=this.requestedOmniSteps=16;
    this.playbackEnabled=true;
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
  // ---- Voices a player changes while the service runs (a clip given to a character or taken away: docs/CHARACTER_EDITOR.md, "Voice clips") ----
  // `update`: {pocket, omni: {short, long}, playerVoiceDirectory, changed: [keys]}. Each engine's `voices` is that configuration's whole `voices` object
  // as it should be now (the bridge builds it: bridge/live-voices.mjs); an engine left out is unchanged. It takes effect at the next moment no reply is
  // in flight (the settings poll), never in the middle of one: the routing registries, the cloud voices' references and the running workers all change
  // together. Nothing is reloaded: a worker is sent only the voices that differ, and only those characters lose what was prepared for them (a Pocket
  // prepared state, an OmniVoice prompt, a Voxtral reference); a character that was prepared is prepared again at once, in the
  // background, so its next line does not pay for it. Returns true when it was applied now, false when it waits for the next idle moment.
  setVoices(update = {}) {
    if (this.closed || !update || typeof update !== 'object') return false;
    const before = this.pendingVoices ?? {};
    this.pendingVoices = {pocket: update.pocket ?? before.pocket, omni: {short: update.omni?.short ?? before.omni?.short, long: update.omni?.long ?? before.omni?.long},
      playerVoiceDirectory: update.playerVoiceDirectory ?? before.playerVoiceDirectory ?? null, changed: [...new Set([...(before.changed ?? []), ...(update.changed ?? [])])]};
    return this.applyVoicesWhenIdle();
  }
  get voicesPending() { return !!this.pendingVoices; }
  applyVoicesWhenIdle() {
    const pending = this.pendingVoices;
    if (!pending || this.closed || this.busy) return false;
    this.pendingVoices = null;
    try { this.applyVoices(pending); } catch (error) { this.log(`the voice change was not applied: ${String(error?.message ?? error).slice(0, 160)}`, 'Voices'); return false; }
    return true;
  }
  applyVoices(pending) {
    const dir = pending.playerVoiceDirectory ?? this.live?.dir ?? null, changed = pending.changed ?? [];
    const lowered = value => ({mode: 'lazy', maxCachedProfiles: value?.maxCachedProfiles});
    const live = (backend, reference) => !!this.client && this.client.loaded === true && this.clientBackend === backend && (backend !== 'omni' || this.clientReference === reference);
    // What was prepared for the changed characters before this (the client's list, or a cloud voice's cached reference): prepared again after.
    const warm = new Set();
    for (const key of changed) {
      if (this.client?.prepared?.has(key) || this.voxtral?.hasCachedReference?.(key)) warm.add(key);
    }
    const next = {...(this.live ?? {pocket: undefined, omni: {}}), dir, omni: {...(this.live?.omni ?? {})}};
    if (pending.pocket && this.pocketBase) {
      const registry = createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice', voices: pending.pocket,
        preparation: {...lowered(this.pocketBase.preparation), startupProfiles: []}});
      next.pocket = pending.pocket;
      this.registries.pocket = registry;
      this.configs.pocket = this.snapshotOf({...this.pocketBase, registry}, registry);
      this.configuredByBackend.pocket = registry.keys.length > 0;
      if (!live('pocket')) { this.availabilities.pocket = new Set(registry.keys); this.verifiedAvailabilities.delete('pocket'); }
    }
    for (const reference of OMNI_REFERENCES) {
      const voices = pending.omni?.[reference], variant = this.omniVariants[reference];
      if (!voices || variant.input.provider !== 'hybrid' || (variant.input.version ?? 1) < 2 && Object.keys(variant.input.voices ?? {}).length) continue;
      const startup = (variant.input.preparation?.startupProfiles ?? []).filter(key => voices[key] && (voices[key].status ?? 'ready') === 'ready');
      const input = {...variant.input, version: 2, voices, preparation: {...lowered(variant.input.preparation), startupProfiles: startup}};
      const registry = createVoiceProfileRegistry(input);
      next.omni[reference] = voices;
      Object.assign(variant, {input, registry, snapshot: this.snapshotOf(input, registry), configured: input.provider === 'hybrid' && registry.keys.length > 0});
      if (!live('omni', reference)) { variant.availability = new Set(registry.keys); this.verifiedAvailabilities.delete(this.verifiedKey('omni', reference)); }
    }
    this.live = next;
    this.activateOmni();
    this.routeKeys = withoutVariants(new Set([...this.routeKeys, ...Object.keys(this.configs.pocket.voices ?? {}),
      ...OMNI_REFERENCES.flatMap(reference => Object.keys(this.omniVariants[reference].snapshot.voices ?? {}))])).sort();
    // The cloud voices read their clips through the same registries: they follow, and forget only the characters that changed.
    for (const cloud of [this.voxtral]) {
      cloud?.replaceReferences?.([this.omniVariants.long.registry, this.omniVariants.short.registry, this.registries.pocket], changed);
    }
    // Every running worker is sent the difference (behind whatever it is doing); the standard availability commit follows each answer.
    const push = (client, backend, reference) => {
      const voices = backend === 'omni' ? next.omni[reference] : next.pocket;
      if (!voices || typeof client?.setVoices !== 'function') return;
      Promise.resolve(client.setVoices(voices, {playerVoiceDirectory: dir})).then(() => { if (!this.closed) this.settleAfterVoices(client); },
        error => this.log(`a running voice did not take the change: ${String(error?.message ?? error).slice(0, 120)}`, 'Voices'));
    };
    if (this.client) push(this.client, this.clientBackend, this.clientReference);
    if (this.candidate?.client) push(this.candidate.client, 'omni', this.candidate.reference);
    if (this.vHelper?.client) push(this.vHelper.client, 'pocket');
    this.log(`voices changed while running (${changed.length} character${changed.length === 1 ? '' : 's'})`, 'Voices');
    this.publish();
    if (!this.silent) for (const key of warm) void this.prepareProfile(this.voiceKeyFor(key, key)).catch(() => {});
    return true;
  }
  // A worker confirmed a voice change: what it can speak is verified again (the committed one commits at the next idle moment, as ever).
  settleAfterVoices(client) {
    if (this.client === client) { this.stageAvailability(client, this.clientBackend); return; }
    const entry = this.candidate;
    if (entry?.client === client && entry.loaded) {
      this.verifiedAvailabilities.set(this.verifiedKey('omni', entry.reference), new Set(this.omniVariants[entry.reference].registry.keys.filter(key => client.hasProfile(key))));
    }
  }
  // A worker made for the configuration's voices is told the voices a player has changed since the service started.
  primed(client, backend, reference = null) {
    const voices = this.live && (backend === 'omni' ? this.live.omni[reference] : this.live.pocket);
    if (voices && typeof client?.setVoices === 'function') {
      Promise.resolve(client.setVoices(voices, {playerVoiceDirectory: this.live.dir})).catch(error => this.log(`a new voice did not take the change: ${String(error?.message ?? error).slice(0, 120)}`, 'Voices'));
    }
    return client;
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
  get cloudEngine(){return this.cloud==='voxtral'?this.voxtral:null;}
  get cloudActive(){return !!this.cloudEngine&&this.provider==='pocket';}
  // The player chose a cloud voice (committed or waiting for the idle boundary). No local voice model is loaded for it.
  get cloudWanted(){return this.requestedCloud!==null;}
  // A cloud voice that cannot be asked right now (no key, or a refused key or a limit cooling down) cannot speak anything: the turn's voice
  // is the Convai cloud voice (bridge: localChoice), so the conversation is not silent while it recovers. The order is: the cloud voice
  // (asked again quickly for a hiccup, VoxtralVoice.fetchPart), then the Convai voice, then written text (a reply already on its way
  // when the cloud voice fails is shown as written text: one reply is never given two voices).
  get cloudKeyless(){return this.cloudActive&&(!this.cloudEngine.hasKey||!this.cloudEngine.ready);}
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
  // `temporary` marks an Omni that is being loaded again in the background, or a Pocket that will be; the voice returns by itself.
  get fallback(){
    const want=this.resolvedProvider;
    if(want===this.requestedProvider||this.provider!==want)return null;
    const value={from:this.requestedProvider,to:want};
    return (this.requestedProvider==='omni'&&this.omniRetry)||(this.requestedProvider==='pocket'&&this.pocketRetry)?{...value,temporary:true}:value;
  }
  // Why a character is on Convai: chosen, or the local voice cannot serve it.
  convaiReason(profile){
    if(this.requestedProvider==='convai')return 'selected';
    const status=this.registries.pocket.status(this.voiceOf(profile,this.registries.pocket));
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
  // The key whose voice speaks `key`: itself, or (a key with no voice of its own that has an alias) the alias.
  voiceOf(key, registry = this.registry) {
    if (!this.aliases || registry.has(key)) return key;
    try { return this.aliases(key) || key; } catch { return key; }
  }
  hasProfile(key) { const voice = this.voiceOf(key); return this.registry.has(voice) && this.availability.has(voice); }
  usesProfile(key) { return local(this.provider) && this.configured && this.hasProfile(key); }
  // The voice that speaks one NPC of a local profile: the profile's own key, or one of its variants chosen from the
  // NPC's stable identity among the variants the current backend can speak. The caller decides once per turn and keeps
  // routing (usesProfile, profileReady, provider) on the BASE key. Anything not spoken locally keeps its key.
  voiceKeyFor(profile, seed) {
    if (!this.usesProfile(profile)) return profile;
    const voice = this.voiceOf(profile);
    // A character with no clip of its own keeps one voice of its alias for good: the seed is its own key, not the body that speaks today.
    return pickVoiceKey(voice, voice === profile ? seed : profile, [...this.availability].filter(key => this.registry.has(key)));
  }
  // True while preparing a character's voice means GPU work: OmniVoice speaks the companions and voice playback is on (a preparation is
  // one hidden render, 1 to 3 s of the card). Pocket prepares on the CPU, a cloud voice has no model, and playback Off prepares nothing.
  // Callers that prepare ahead for characters nobody has spoken to yet (bridge/nearby-warm.mjs) leave those to the first sign of a talk.
  get preparesOnGpu() { return !this.closed && this.provider === 'omni' && !this.silent; }
  // A cloud voice has no worker to wait for: a character is ready when it can be routed (its key and clip are checked per reply).
  profileReady(key) { return !this.closed&&this.usesProfile(key)&&(this.cloudActive||(this.clientBackend===this.provider
    &&!this.client?.failure&&!this.client?.closing&&this.client?.profileReady(this.voiceOf(key))===true)); }
  request(settings) {
    if(typeof settings?.voice==='boolean'&&settings.voice!==this.playbackEnabled){
      this.playbackEnabled=settings.voice;this.routeRevision++;
      for(const key of this.routeKeys)this.routeChanges.add(key);
    }
    const chosen=canonicalVoiceProvider(settings?.voiceProvider);
    if(typeof settings?.voiceProvider==='string')this.requestedCloud=cloudVoiceChoice(settings.voiceProvider);
    if (['pocket','omni','convai'].includes(chosen)){
      // Choosing a provider again retries it, even if it failed earlier.
      if(chosen!==this.requestedProvider){
        this.failedBackends.delete(chosen);
        // Any change of or to Omni starts its retry story afresh (the normal start path takes over).
        if(chosen==='omni'||this.requestedProvider==='omni')this.endOmniRetry();
        if(chosen==='pocket'||this.requestedProvider==='pocket')this.pocketRetry=null;
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
    if(backend==='pocket'&&this.pocketRetry){this.pocketRetry=null;this.log('Pocket is ready again','PocketRetry');}
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
    // Voice playback Off: the companions speak nothing, so the committed voice's worker is released, except a Pocket worker that V's typed
    // line uses while V's voice is On (a settings draft that previews a local voice still warms it: the player is choosing a voice).
    const committed=this.cloudWanted?[]:[this.resolvedProvider,this.provider];
    const candidates=[this.previewSettled&&this.preview&&this.resolve(this.preview.provider),
      ...(this.silent?committed.filter(candidate=>candidate==='pocket'&&this.vHelperWanted):committed)];
    return candidates.find(candidate=>local(candidate)&&this.configuredByBackend[candidate]
      &&this.availabilities[candidate].size>0&&!this.failedBackends.has(candidate))||null;
  }
  // Voice playback is Off: the companions' local voice has no use for a loaded worker.
  get silent(){return this.playbackEnabled===false;}
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
    // Voices a player changed while a reply was in flight take effect now (one null check when there is nothing waiting).
    const voicesApplied=this.applyVoicesWhenIdle();
    this.request(settings);
    const previewChanged = this.setPreview(preview);
    const applied = this.applyWhenIdle(busy)||voicesApplied;
    this.reconcile();
    this.maintainOmniRetry();
    this.maintainPocketRetry();
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
      pocketRetry:this.pocketRetry?{failures:this.pocketRetry.failures,loading:this.clientBackend==='pocket',
        nextInMs:this.clientBackend==='pocket'?0:Math.max(0,this.pocketRetry.nextAt-this.clock())}:null,
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
      this.publish(this.releasing ? 'releasing' : (this.provider === 'convai'||this.cloudWanted ? 'remote' : this.silent ? 'stopped' : 'disabled'));
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
    client=this.client=this.primed(factory(backend==='omni'?this.baseConfigs.omni[this.clientReference]:this.baseConfigs[backend],hooks),backend,this.clientReference);
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
    this.failureReasons[backend]=String(client.failure?.message??'unknown').slice(0,200);
    this.noteFailure(backend,client.failure?.message,client.failure?.gpu);
    if(backend==='omni')this.scheduleOmniRetry(client.failure?.message);
    if(backend==='pocket')this.schedulePocketRetry(client.failure?.message);
    this.reconcile();
    this.publish();
  }
  // A voice that could not start, told to whoever listens (the bridge records it for an error report, bridge/error-events.mjs). Never throws.
  // `gpu` ({dedicatedMiB, sharedMiB}): the worker's graphics memory when a render ran out of time, when it was read.
  noteFailure(engine,reason,gpu){try{this.options.onFailure?.({engine,reason:String(reason??'unknown').slice(0,200),...(gpu?{gpu}:{})});}catch{}}
  /**
   * What keeps the Pocket voice from speaking right now, for the Help page's setup check: null, or {engine: 'pocket'|'v-helper', reason}. The companions'
   * Pocket worker counts only while it is the voice they need (Pocket chosen, or OmniVoice that cannot run); V's own worker only while V's voice wants it.
   * A worker that failed and is waiting for its next try still counts; one that loaded again does not.
   */
  voiceProblem(){
    if(this.closed)return null;
    if(this.vHelperWanted&&this.vHelper.failed)return this.withCause({engine:'v-helper',reason:this.vHelper.failure??'unknown'});
    if(this.pocketWanted&&this.failedBackends.has('pocket'))return this.withCause({engine:'pocket',reason:this.failureReasons.pocket??'unknown'});
    return null;
  }
  // `cause: 'blocked'` when Windows refused to load a file of the voice (blockedByWindows); the Help row then says so, in plain words.
  withCause(problem){return blockedByWindows(problem.reason)?{...problem,cause:'blocked'}:problem;}
  log(message,tag='OmniRetry'){try{this.options.onLog?.(`[${tag}] ${message}\n`);}catch{}}
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
  // Would routing speak with Pocket if it could run? The player chose Pocket, or chose Omni and Omni cannot run now, so Pocket is the next
  // voice. A cloud voice, the Convai voice and Multilingual conversations (Pocket speaks English only) want no Pocket worker.
  get pocketWanted(){
    if(this.cloudWanted||this.multilingual)return false;
    return this.requestedProvider==='pocket'||(this.requestedProvider==='omni'&&!this.backendUsable('omni'));
  }
  // The next Pocket attempt, if the player still wants Pocket and attempts remain. `fallback.temporary` follows it.
  schedulePocketRetry(reason){
    const failures=(this.pocketRetry?.failures??0)+1,delay=this.pocketRetryDelays[failures-1];
    if(blockedByWindows(reason)){
      this.log(`not trying again: Windows blocked a file of the voice (${reason})`,'PocketRetry');
      this.pocketRetry=null;return;
    }
    if(this.closed||!this.pocketWanted||delay===undefined){
      if(this.pocketRetry||delay===undefined)this.log(`giving up after ${failures} failed attempts${reason?` (${reason})`:''}`,'PocketRetry');
      this.pocketRetry=null;return;
    }
    this.pocketRetry={failures,nextAt:this.clock()+delay};
    this.log(`attempt ${failures} failed${reason?` (${reason})`:''}; trying again in ${Math.round(delay/1000)} s`,'PocketRetry');
  }
  // Due-checked from update() (the 500 ms settings poll): no timer, no loop, nothing per turn. Once the wait is over, with no reply in flight,
  // the failure is cleared and the normal start loads Pocket again (the failed worker was released when it failed). No worker is loaded for a
  // voice that is no longer wanted (the story ends), and none while voice playback is Off, unless V's typed line uses Pocket.
  maintainPocketRetry(){
    if(this.closed||!this.pocketRetry)return;
    if(!this.pocketWanted){this.pocketRetry=null;return;}
    if(this.busy||this.clientBackend==='pocket'||this.clock()<this.pocketRetry.nextAt||(this.silent&&!this.vHelperWanted))return;
    this.failedBackends.delete('pocket');
    this.log(`loading Pocket again (retry ${this.pocketRetry.failures})`,'PocketRetry');
    this.reconcile();
    this.publish();
  }
  // Due-checked from update() (the 500 ms settings poll): no timer, no loop. Waits for a moment with no reply in
  // flight, so the load never competes with a reply's own work, and for the previous worker's confirmed exit.
  maintainOmniRetry(){
    if(this.closed)return;
    // A background worker for a reference the player no longer wants (loading, or loaded and waiting for its idle
    // commit) is released; the normal start path loads the wanted one after its confirmed exit.
    if(this.candidate&&(this.requestedProvider!=='omni'||this.candidate.reference!==this.requestedOmniReference||this.silent))void this.dropCandidate();
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
    entry.client=this.primed(this.omniFactory(this.baseConfigs.omni[reference],hooks),'omni',reference);
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
    this.noteFailure('omni',entry.client.failure?.message,entry.client.failure?.gpu);
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
    if (!client) { this.tickVHelper(); this.publish(this.releasing ? 'releasing' : (this.closed||this.silent ? 'stopped' : 'remote')); return this.retiring; }
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
        this.publish(this.closed||this.silent ? 'stopped' : 'remote');
      }
    });
    const completed = this.retiring;
    // V's own Pocket worker may be due now that the Pocket worker is leaving; it waits for this exit (Pocket's one work-folder lock).
    this.tickVHelper();
    this.retiring.catch(() => this.publish('error', {detail: 'Could not release local voices. Restart the voice service.'}));
    return this.retiring;
  }
  // ---- V's own Pocket worker (bridge/v-helper-voice.mjs) ----
  // V's voice engine is the player's choice (settings `vVoiceEngine`, default Pocket). With Pocket, V's line is spoken by the Pocket worker
  // the companions use when they use Pocket themselves (`pocketRoute`: one worker, one job at a time). With any other companion voice
  // (OmniVoice, a cloud voice, the Convai voice) V has a Pocket worker of its own: it is loaded only because V needs it (`vHelperWanted`:
  // the V setting is on, the engine is Pocket and clips exist), never beside the Pocket route (one work folder, one lock), and released,
  // with its exit confirmed, the moment that stops being true. A V engine that is a cloud voice (Voxtral) is never asked for here: with
  // it, and companions on a cloud voice or on the Convai voice, no Pocket worker exists at all. With playback Off OmniVoice is released and
  // the helper is all that stays loaded (V speaks whenever the V setting is on); a Pocket route with playback Off keeps its one worker for V.
  // Due-checked where routing already changes; nothing runs on a timer.
  /** The committed companion voice is the Pocket worker itself (not a cloud voice borrowing Pocket's route). */
  get pocketRoute() { return this.provider === 'pocket' && !this.cloudActive; }
  get vHelperDue() {
    if(!(this.vHelperWanted&&!this.closed&&!!this.configuredByBackend.pocket))return false;
    // The Pocket route speaks V itself, and a Pocket worker that exists (a settings preview warms one) holds the work folder's lock.
    if(this.pocketRoute||this.clientBackend==='pocket')return false;
    if(this.provider!=='omni')return true;
    // OmniVoice: the helper waits for it to be loaded (it is never started during OmniVoice's own load); with playback Off there is none.
    if(!(this.provider===this.requestedProvider))return false;
    if(this.silent)return true;
    if(this.client?.failure)return false;
    if(this.vHelper.running)return true;
    return this.clientBackend==='omni'&&this.client?.loaded===true&&!this.client.closing;
  }
  tickVHelper() {
    if (this.vHelperDue) this.vHelper.start(); else void this.vHelper.release();
  }
  setVHelperWanted(value) {
    value = value === true;
    if (value === this.vHelperWanted) return;
    this.vHelperWanted = value; this.tickVHelper();
  }
  /** Is V's own Pocket worker the one in charge for this key (Pocket's configuration has it, and the Pocket route is not speaking)? Says nothing about being loaded. */
  vHelperSpeaks(key) {
    return !this.pocketRoute&&!!this.configuredByBackend.pocket&&this.registries.pocket.has(key)&&this.availabilities.pocket.has(key);
  }
  /** Is the Pocket route (the companions' own worker) the one that speaks this key for V? Loaded or about to be: the call that follows starts it. */
  vRouteSpeaks(key) { return this.pocketRoute&&this.usesProfile(key); }
  /** Is the helper loaded and ready for this key? Also asks it to load when it is due and not yet running, so a missed trigger heals itself. */
  vHelperReady(key) { this.tickVHelper(); return this.vHelper.ready(key); }
  vHelperStream(key, text, options = {}) { return this.vHelper.stream(key, stripSpeechTags(text), options); }
  vHelperPrepare(key, options = {}) { return this.vHelper.prepare(key, options); }
  async synthesizeStream(profile, text, options = {}) {
    if (this.provider!=='pocket'||!this.usesProfile(profile))throw Error('This character does not use Pocket streaming');
    profile = this.voiceOf(profile);
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
        // A refusal the voice already asked again for (quickly, inside its own ask: VoxtralVoice.fetchPart) is not asked a third time.
        if (error?.sink || started || error?.retried || !RETRY_KINDS.has(error?.kind) || !engine.ready) throw error;
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
    try { cloud = await this.voxtral.synthesizeStream(profile, spoken, {signal: own.signal, onPcm: sink, continuation: true, ahead: options.ahead === true}); }
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
  // `language` (ISO 639-1, e.g. 'es') reaches the worker for a reply that is not in English.
  async synthesize(profile,text,options={}){
    if(this.provider!=='omni'||!this.usesProfile(profile))throw Error('This character does not use OmniVoice');
    profile=this.voiceOf(profile);
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
      const voice = this.voiceOf(profile);
      if (!this.configured || !this.registry.has(voice)) return remote(this.registry.status(voice));
      // Playback Off: no worker is kept for the companions, and nobody is waited on for one. The character is ready to join; loading
      // begins when playback is turned on (the poll after it). `muted` lets the caller accept a receipt that has no loaded worker behind it.
      // Not when V's voice is on and the voice is Pocket or a cloud voice: V's line uses it, so it is prepared (or warmed) as usual.
      if (this.silent && this.usesProfile(profile) && !(this.vHelperWanted && this.provider === 'pocket')) return {provider: this.provider, ready: true, profile, muted: true};
      // A cloud voice has no local model to prepare: the character is ready when it is routed. Its reference clip is read, cut and
      // encoded now, so the first reply is not waiting for it.
      if (this.cloudActive) {
        if (this.cloud === 'voxtral' && this.voxtral?.ready) void this.voxtral.reference(voice);
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
      try { receipt = await client.prepareProfile(voice, options); }
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
    this.closed = true; this.preview = null; this.omniRetry = null; this.pocketRetry = null;
    for (const waiter of this.routingWaiters) waiter.reject(Error('Voice service is closed'));
    this.routingWaiters.clear();
    return this.closing=Promise.all([this.retire(),this.phoneAnalysis?.close(),this.dropCandidate(),this.vHelper.release()]);
  }
}
