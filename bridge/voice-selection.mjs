import {PocketVoice, validatePocketConfig} from './pocket-voice.mjs';
import {ResidentVoice, pathAttestationFailed, noCudaFailed, timedOutFailed, outOfMemoryFailed} from './resident-voice.mjs';
import {browserStartFailed} from './system-browser.mjs';
import {RemoteVoice, REMOTE_RETRY_DELAYS_MS} from './remote-voice.mjs';
import {parseServerAddress} from './omni-remote.mjs';
import {lacksNvidia, isSmallCard, underNeeded} from './gpu-vendors.mjs';
import {spillVerdict} from './gpu-memory.mjs';
import {OMNI_SOURCE_VARIABLE, OWN_PYTHON_VARIABLE, miopenWanted, omniPriority, ownPythonSummary, rocmWorkerEnvironment} from './omni-own-python.mjs';
import {priorityEnvironment, priorityGate} from './process-priority.mjs';
import {createVoiceProfileRegistry, isPlayerReference} from './voice-profile-registry.mjs';
import {abortable, cancelled, throwIfCancelled} from './transport-pool.mjs';
import {DEFAULT_OMNI_REFERENCE, OMNI_REFERENCES} from './voice-config-paths.mjs';
import {omniTagsFor, keepSpeechTags, stripSpeechTags} from './natural-speech.mjs';
import {pickVoiceKey, withoutVariants} from './voice-variants.mjs';
import {VHelperVoice} from './v-helper-voice.mjs';
import {closeConfirmed} from './worker-process.mjs';
import {accessViolationFailed, endedFromOutsideFailed, missingFilesFailed, pagingFileFailed, pocketIntegrityFailed, tailLines} from './voice-failures.mjs';

// Routing changes commit only at a conversation boundary. Model preparation
// can begin from a settings draft while that routing remains unchanged.
// CPU/CUDA workers retire through confirmed EOF before another backend starts.
// The Mistral cloud voice (Voxtral) is a choice of the Settings menu but not a backend, and it runs no local model at all: no Pocket,
// no OmniVoice, no worker of any kind starts while it is chosen (a running one is retired when the choice is committed, like any
// backend switch). It borrows only Pocket's ROUTE and audio packet format (the same packets feed the subtitles, the lip sync and
// the face), so its routing is Pocket's and only the synthesis of each reply differs (bridge/voxtral-voice.mjs). A reply it cannot
// deliver (asked again once with a longer limit) is not given to a local voice, and not to the Convai voice either (owner rule 2026-10-21: the
// Convai voice speaks only when the player chose it): the reply is shown as written text, with no key, in a limit's cool-down or in a language
// the voice does not speak too, and the voice comes back by itself.
// A LOCAL voice (OmniVoice, Pocket) that fails is never replaced by a cloud voice (owner rule 2026-10-21, after a player's report of surprise cloud
// use): the fallback is a local retry, the other local engine only if it is already loaded (none is loaded for this), else the route 'text' below
// (the reply is shown as written text and the game says so once). The voice comes back by itself when the local engine recovers.
// The Inworld cloud voice (bridge/inworld-voice.mjs, docs/INWORLD.md) is the same kind of choice on the player's own Inworld key: it speaks a reply with
// Inworld's text-to-speech in a voice cloned from the character's clip, and loads nothing locally either.
export const CLOUD_VOICES = Object.freeze(['voxtral','inworld']);
export const canonicalVoiceProvider = value => ['hybrid','omnivoice'].includes(value) ? 'omni' : CLOUD_VOICES.includes(value) ? 'pocket' : value;
export const cloudVoiceChoice = value => CLOUD_VOICES.includes(value) ? value : null;
// OmniVoice reads either its short (up to 10 s) or its long (up to 18 s) searched reference per character.
export const canonicalOmniReference = value => OMNI_REFERENCES.includes(value) ? value : null;
// The local voices, best first: OmniVoice (16 or 32 steps), Pocket TTS. The Settings menu lists Pocket first because it is the
// default. A choice that cannot run falls to the next entry of THIS list only when that engine is ALREADY loaded (an Omni choice that
// cannot run does not start Pocket for it), and otherwise to TEXT_ROUTE: no voice, the reply is written. 'convai' is a route only
// when the player chose the Convai voice: nothing falls to it, not a local voice and not the Voxtral cloud voice (owner rule 2026-10-21).
// A Python library the voice needs that Windows refused to load: Smart App Control, or a company's or a school's Application Control (WDAC) policy, blocks a
// file that is not signed by a publisher it trusts ("DLL load failed ... An Application Control policy has blocked this file", 2026-10-20 live record).
// Asking again cannot change that, and nothing in the mod can: the voice is not retried, and the Help row says what blocked it.
// Windows words the reason of a failed DLL load in the language of the PC, and Python prints it as it is: a Spanish PC says "Una directiva de Control de aplicaciones bloqueo este archivo" (27 Oct 2026
// report: OmniVoice and Pocket both refused by Smart App Control, retried every 45 s to 10 min because only the English words were known). A "DLL load failed" whose reason says that something BLOCKED
// the file, in any of the languages of the mod, is the same refusal: the other DLL failures say the module was not found, access was denied or the file is not a valid program.
const BLOCK_WORDS = /bloque|blockier|gesperrt|bloqu[eé]|bloccat|bloquead|заблокир|zablokow|blokov|tiltott|ブロック|차단|阻止|封鎖|封锁|engelle/i;
export const blockedByWindows = reason => {
  const text = String(reason ?? '');
  return /application control|policy has blocked|blocked this file|smart app control|code integrity|blocked by (?:the )?(?:group )?policy/i.test(text)
    || (/DLL load failed/i.test(text) && BLOCK_WORDS.test(text));
};
// A failure that will repeat on every try, in words for the log, or null: Windows blocked a file (above), a Pocket file is not the pinned one or is not
// there (a version mismatch, an incomplete or changed Runtime), a file or Python module the worker needs is missing. None of these is retried: each try is a
// rehash of hundreds of megabytes or a model load beside the game, and fails the same way. The Runtime update (or a repair) is what changes it.
// Windows ran out of memory it can promise (error 1455, "The paging file is too small", pagingFileFailed): the same on every try until the player enlarges the page file or closes programs.
export const permanentVoiceFailure = reason => blockedByWindows(reason) ? 'Windows blocked a file of the voice'
  : pagingFileFailed(reason) ? 'Windows ran out of memory for the voice (the paging file is too small)'
  : pocketIntegrityFailed(reason) ? 'a Pocket file is not the one this version pins (the Runtime needs its update)'
  : missingFilesFailed(reason) ? 'a file of the voice is missing from the install' : null;
// The cause of a voice failure as one word for the error report (bridge/error-events.mjs cleanVoice), so a triage can group them without reading the lines.
export const voiceFailureCause = reason => blockedByWindows(reason) ? 'windows-blocked' : browserStartFailed(reason) ? 'browser-failed' : pagingFileFailed(reason) ? 'virtual-memory' : noCudaFailed(reason) ? 'no-cuda'
  : outOfMemoryFailed(reason) ? 'out-of-memory' : timedOutFailed(reason) ? 'timeout' : pocketIntegrityFailed(reason) ? 'integrity' : missingFilesFailed(reason) ? 'missing-files' : 'unknown';
export const VOICE_FALLBACK_ORDER = Object.freeze(['omni','pocket']);
// The route of a reply that no voice speaks because the chosen LOCAL voice cannot run right now. Never a cloud voice.
export const TEXT_ROUTE = 'text';
// Remote OmniVoice (docs/REMOTE_OMNIVOICE.md, Settings > Voices > Custom voices): while the setting `remoteOmni` is on, the OmniVoice worker is a bridge/remote-voice.mjs client of a
// server on another PC (or another card): nothing of OmniVoice loads on this PC, the local pack, card and memory checks do not apply, and a server that cannot be reached
// or fails in a reply is the same case as a failed local voice: the reply is written (TEXT_ROUTE) and the server is asked again after a short wait. Pocket is not started in its
// place (the remote voice is chosen on purpose), and no failure of it files an error report (the player's own network is not a bug of the mod).
const PACK_RECHECK_MS = 30_000;
// A cloud voice request that gave no audio in time (or lost its connection) is asked again once, with this longer wait for the first audio.
export const CLOUD_RETRY_AUDIO_MS = Object.freeze({voxtral: 6000, inworld: 9000});
const RETRY_KINDS = new Set(['timeout', 'network', 'request']);
export const CLOUD_WAIT_OUT_MS = 1500;
// A chosen OmniVoice that fails or times out is not given up on. Routing falls to the next voice at once, then Omni
// is loaded again in the background after each of these waits (a first failure after 45 s, then 3 min, then 10 min);
// a fourth failure ends the retries until the player chooses Omni again. Nothing here runs per frame: the retry is
// due-checked from the 500 ms settings poll, and a due retry waits for a moment with no reply in flight.
// The first retry after a memory fault of the worker comes this soon, with the CUDA graph off (scheduleOmniRetry).
export const OMNI_FAULT_RETRY_MS = 5000;
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
    this.registries={pocket:pocketRegistry,convai:empty,[TEXT_ROUTE]:empty};
    this.configs={pocket:snapshot(validated,pocketRegistry)};
    // What a worker is started with never changes: its configuration file is the start-up one, and what it holds is checked against that.
    // The voices a player changes later (setVoices) replace the routing registries above and are sent to the running workers.
    this.snapshotOf=snapshot;this.pocketBase=validated;
    this.baseConfigs={pocket:this.configs.pocket,omni:Object.fromEntries(OMNI_REFERENCES.map(reference=>[reference,this.omniVariants[reference].snapshot]))};
    this.live=null;this.pendingVoices=null;
    this.configuredByBackend={pocket:!!validated&&pocketRegistry.keys.length>0};
    this.availabilities={pocket:new Set(pocketRegistry.keys),convai:new Set(),[TEXT_ROUTE]:new Set()};
    // The optional OmniVoice pack (worker Python, model weights): a function or a fixed {installed, missing}.
    this.omniPackSource=options.omniPack||(()=>({installed:true,missing:[]}));
    // Remote OmniVoice: `omniRemoteAddress()` is the saved server address (text or {host, port}); `remoteWanted` follows the setting `remoteOmni`.
    this.remoteAddressSource=typeof options.omniRemoteAddress==='function'?options.omniRemoteAddress:()=>null;this.remoteWanted=false;this.remoteSeen='';this.clientRemote='';this.amdMiopen=true;this.ownWorkerSeen='';
    // A character the player made (bridge/custom-characters.mjs) has a voice of its own only when it was given a clip before the service
    // started; `aliases(key)` names the voice that speaks it until then and when it has none (the resident voice of its gender).
    this.aliases=typeof options.aliases==='function'?options.aliases:null;
    // The Mistral cloud voice: `cloud` is the committed choice, `requestedCloud` the saved setting waiting for an idle boundary.
    this.cloud=this.requestedCloud=null;
    this.voxtral=options.voxtral||null;
    this.inworld=options.inworld||null;
    // The language packs (bridge/voice-language-packs.mjs): a reply in a language that has one is cloned from the pack's clip of the character
    // (OmniVoice here, the Mistral voice in bridge/voxtral-voice.mjs). Pocket speaks English only and never asks.
    this.languagePacks=options.languagePacks||null;
    // Pack clips the OmniVoice worker was asked to prepare ahead of a reply (warmOmniLanguage): voice|language|hash -> the worker that has it.
    this.omniLanguageWarm=new Map();
    // keepsReference: key => boolean (the bridge): a voice whose reference a pack's clip must not replace although it is not the player's own clip (V with a V voice mod's reference, docs/V_VOICE.md).
    this.keepsReference=typeof options.keepsReference==='function'?options.keepsReference:()=>false;
    // The PocketTTS models (bridge/pocket-language-models.mjs): with a model and the voice pack of a reply's language, the local Pocket voice speaks that language
    // cloned from the pack's clip; without them Pocket speaks English only.
    this.pocketLanguages=options.pocketLanguages||null;
    this.clock = options.clock || Date.now;
    this.cloudRetryAudioMs = {...CLOUD_RETRY_AUDIO_MS, ...options.cloudRetryAudioMs};
    // A cloud voice that is cooling down for no longer than this is waited for, not skipped (synthesizeHead).
    this.cloudWaitOutMs = Number.isFinite(options.cloudWaitOutMs) ? options.cloudWaitOutMs : CLOUD_WAIT_OUT_MS;
    this.sleep = options.sleep || ((ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? cancelled()); };
      if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, {once: true});
    }));
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
    // While this says true (the bridge: Mature content is on) no cloud voice speaks and none is wanted: a saved Voxtral choice is Pocket, and a
    // reply that still reaches the committed cloud voice before the switch is not sent to it (the written reply stands). Owner decision 2026-10-20.
    this.cloudBarred = typeof options.cloudBarred === 'function' ? () => { try { return options.cloudBarred() === true; } catch { return false; } } : () => false;
    // A draft must stay unchanged this long before it may prepare a model, so
    // cycling quickly through the choices never starts or retires a worker.
    // Zero keeps the preview immediate for callers that do not debounce.
    this.previewSettleMs = Number.isFinite(options.previewSettleMs) ? Math.max(0, options.previewSettleMs) : 0;
    this.previewSince = 0;
    this.phoneAnalysis=options.phoneAnalysis;
    this.factory = options.factory || ((settings, hooks) => new PocketVoice(settings, hooks));
    this.omniFactory=options.omniFactory||((settings,hooks)=>{
      const remote=this.omniRemote;
      return remote?new RemoteVoice(settings,{endpoint:remote,referenceRoots:this.options.omniReferenceRoots??[],onState:hooks.onState,onLog:hooks.onLog,
        playerVoiceDirectory:settings.playerVoiceDirectory??undefined}):new ResidentVoice(settings,hooks);
    });
    // V's typed line, while OmniVoice is the committed voice: a Pocket worker of its own on the CPU (bridge/v-helper-voice.mjs). It is
    // never the route of any character; `vHelperWanted` is the V setting (on, with clips), set by the bridge's settings poll.
    this.vHelperWanted=false;
    // The game's title screen: V's helper (a Python process importing torch, about 25 s of CPU and thousands of files at normal priority, on the drive the game
    // loads from) does not load while it is up, because the screen that waits for a key press is the one place a stalled game frame loses the press. The bridge
    // says true until the game has a world (or a long wait has passed); nothing is held without it (a test, a standalone service).
    this.startHold=typeof options.startHold==='function'?()=>{try{return options.startHold()===true;}catch{return false;}}:()=>false;
    this.vHelper=options.vHelper||new VHelperVoice({wait:()=>this.retiring,onReady:()=>this.options.onVHelperReady?.(),log:message=>{try{this.options.onLog?.('[VHelper] '+message+'\n');}catch{}},
      onFailure:reason=>this.noteFailure('v-helper',reason,undefined,this.vHelper?.client?.stderrTail),
      clock:()=>this.clock(),retryDelays:options.vHelperRetryDelays,noRetry:permanentVoiceFailure,busy:()=>this.busy,
      closeWorker:client=>this.closeWorker(client),
      create:onState=>this.primed(this.factory(this.baseConfigs.pocket,{...this.options,keepPreparedVoices:this.keepPrepared,onState}),'pocket')});
    // omniRetry: {failures, nextAt} while a failed Omni is to be loaded again; candidate: the background Omni worker
    // loading beside the committed fallback (Pocket is CPU only, so the two never share VRAM). candidateExit
    // chains each retired candidate's confirmed exit; a new worker starts only after it, like any replacement.
    this.omniRetry=null;this.candidate=null;this.candidateExit=Promise.resolve();this.omniGraphOff=false;
    this.omniRetryDelays=options.omniRetryDelays||OMNI_RETRY_DELAYS_MS;
    // The graphics card vendors (bridge/gpu-vendors.mjs: ['nvidia','amd',...], or null until the card list is read): the start line names them, and the
    // menu says OmniVoice needs an NVIDIA card when none is there. omniNoCuda: a worker told us this PC has no CUDA; Omni is not started again until restart.
    this.gpuVendorsSource=typeof options.gpuVendors==='function'?options.gpuVendors:()=>null;this.gpuAmdRouteSource=typeof options.gpuAmdRoute==='function'?options.gpuAmdRoute:()=>false;this.omniNoCuda=false;
    // The memory of the NVIDIA card (MiB, or null until the same lazy card list is read) and omniNoMemory: Omni ran out of its time with its graphics memory spilled into shared
    // memory, or on a card of 8 GB or less (not enough graphics memory next to the game). Like omniNoCuda, it is for the life of the service: Omni is not tried again,
    // and Pocket speaks in its place (resolve), told once (fallback.reason 'omni-memory').
    this.gpuMemorySource=typeof options.gpuMemoryMiB==='function'?options.gpuMemoryMiB:()=>null;this.omniMemoryFailed=false;this.omniCardNoted=false;
    // Windows ran out of memory it can promise (pagingFileFailed): for OmniVoice, then Pocket takes its place; for Pocket, the reply is written. Neither is started again until the player chooses it again.
    this.omniPagingFailed=false;this.pocketPagingFailed=false;
    // pocketRetry: {failures, nextAt} while a failed Pocket is to be loaded again
    this.pocketRetry=null;this.heldPocketFailure=null;this.pocketRetryDelays=options.pocketRetryDelays||POCKET_RETRY_DELAYS_MS;
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
  }
  // The optional OmniVoice pack. A machine without it keeps Omni out of routing (the replies are written, never given to a cloud voice) and
  // the Settings menu says what is missing. A pack installed while the game runs is noticed within 30 s.
  refreshOmniPack(){
    this.packCheckedAt=this.clock();
    // The OmniVoice pack is not needed on this PC while the voice is rendered on a server.
    const found=this.remoteWanted?{installed:true,missing:[]}:typeof this.omniPackSource==='function'?this.omniPackSource():this.omniPackSource;
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
    this.configuredByBackend.omni=variant.configured&&this.omniPack.installed&&!this.omniRemoteUnset;
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
  // ---- Remote OmniVoice ----
  /** {host, port} of the saved server while the setting is on and the address is a valid one, else null. */
  get omniRemote(){
    if(!this.remoteWanted)return null;
    try{
      const found=this.remoteAddressSource(),parsed=typeof found==='string'?parseServerAddress(found):found;
      return parsed?.host&&Number.isInteger(parsed.port)?{host:parsed.host,port:parsed.port}:null;
    }catch{return null;}
  }
  /** The setting is on but no usable address is saved: OmniVoice cannot speak (the reply is written), and nothing local starts in its place. */
  get omniRemoteUnset(){return this.remoteWanted&&!this.omniRemote;}
  get remoteKey(){const remote=this.omniRemote;return remote?`${remote.host}:${remote.port}`:'';}
  // The worker held was made for another server (or for this PC while the setting changed): it is replaced at the next idle moment, like a change of reference.
  // What an OmniVoice worker was made for: the server (Remote OmniVoice), and with a tested own or AMD-setup Python that Python and, on ROCm, the MIOpen choice.
  // A worker made for another one is replaced at the next idle moment, so a new MIOpen choice or a Python set up in the game takes effect without a restart.
  get workerKey(){
    const own=this.remoteWanted?null:this.omniOwnPython;
    if(!(own?.used===true&&own.path&&own.source))return this.remoteKey;
    return `${this.remoteKey}|${own.path}|${own.backend==='rocm'?(miopenWanted(own,this.amdMiopen)?'miopen':'own-convolutions'):''}`;
  }
  clientStale(backend){return backend==='omni'&&this.clientRemote!==this.workerKey;}
  // Called with every settings poll: a Python that newly passed its test (the AMD setup finished, or omni-python.txt was fixed) undoes "no CUDA" for the session,
  // so OmniVoice is tried with it at once instead of after a restart.
  checkOwnWorker(){
    const own=this.remoteWanted?null:this.omniOwnPython;
    const key=own?.used===true&&own.path?own.path:'';
    if(key===this.ownWorkerSeen)return;
    this.ownWorkerSeen=key;
    if(!key||!(this.omniNoCuda||this.failedBackends.has('omni')))return;
    this.omniNoCuda=false;this.failedBackends.delete('omni');this.endOmniRetry();
    this.log(`OmniVoice is tried again with ${own.managed?'the AMD setup':'the player\'s own Python'}`);
  }
  // Called with every settings poll after the setting is read: a change of the setting or of the address starts the OmniVoice story afresh.
  checkRemote(){
    const key=this.remoteWanted?`on:${this.remoteKey}`:'off';
    if(key===this.remoteSeen)return;
    const first=this.remoteSeen==='';
    this.remoteSeen=key;
    if(first&&!this.remoteWanted)return;
    this.omniLanguageWarm.clear();
    this.failedBackends.delete('omni');this.endOmniRetry();
    this.refreshOmniPack();
    this.log(this.remoteWanted?(this.omniRemote?'OmniVoice is rendered on a server of the network':'Remote OmniVoice is on, but no server address is saved'):'OmniVoice is rendered on this PC again','OmniRemote');
  }
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
      if (this.client?.prepared?.has(key) || this.voxtral?.hasCachedReference?.(key) || this.inworld?.hasCachedReference?.(key)) warm.add(key);
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
    for (const cloud of [this.voxtral, this.inworld]) {
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
  // A local voice that failed earlier stays out of routing, except for a cloud voice: it runs no worker, so the failure is not its.
  // Only local voices are usable backends: the Convai voice is a route the player chooses, never a stand-in (see resolve).
  backendUsable(backend){
    return !!this.configuredByBackend[backend]&&this.availabilities[backend].size>0
      &&(!this.failedBackends.has(backend)||(backend==='pocket'&&this.cloudWanted));
  }
  // The engine is loaded, ready and healthy right now: the only way a voice other than the chosen one may take over (it is never loaded for that).
  loadedBackend(backend){
    return this.clientBackend===backend&&!!this.client&&this.client.loaded===true&&!this.client.failure&&!this.client.closing;
  }
  // The route for a chosen voice. The Convai voice only when it was chosen. A local voice that cannot run is replaced by the other local voice only
  // if that one is already loaded, and otherwise by TEXT_ROUTE (the reply is written). A cloud voice (Voxtral) that has no route at all is
  // written too: it never falls to the Convai voice, and it never loads a local model.
  resolve(provider){
    if(provider==='convai')return 'convai';
    // Omni that does not get the graphics memory it needs beside the game is replaced by Pocket, which is loaded for it (a local voice, never a cloud one).
    if(provider==='omni'&&!this.cloudWanted&&this.omniNoMemory)provider='pocket';
    const start=VOICE_FALLBACK_ORDER.indexOf(provider);
    const found=VOICE_FALLBACK_ORDER.slice(Math.max(start,0))
      .find(backend=>(backend===provider||this.loadedBackend(backend))&&this.backendUsable(backend));
    return found||TEXT_ROUTE;
  }
  // May the Convai voice speak a reply of this installation? Only when the player chose it. Never because a local voice failed, and never because
  // the Voxtral cloud voice cannot be asked (no key, a limit, a language it does not speak): those replies are written.
  get convaiVoiceAllowed(){return this.provider==='convai';}
  // True while no voice speaks the replies: the chosen local voice cannot run and nothing local stands in for it.
  get textOnly(){return this.provider===TEXT_ROUTE;}
  get resolvedProvider(){return this.resolve(this.requestedProvider);}
  // The cloud voice speaks replies: chosen and committed; its route is Pocket's (packet format and routing only, no Pocket worker).
  get cloudEngine(){return this.cloud==='inworld'?this.inworld:this.cloud==='voxtral'?this.voxtral:null;}
  get cloudActive(){return !!this.cloudEngine&&this.provider==='pocket';}
  // The player chose a cloud voice (committed or waiting for the idle boundary). No local voice model is loaded for it.
  get cloudWanted(){return this.requestedCloud!==null;}
  // A cloud voice that cannot be asked right now (no key, or a refused key or a limit cooling down) cannot speak anything: the turn is written
  // (bridge: localChoice, planTurnVoice 'none'), never given to the Convai voice. The order is: the cloud voice (asked again quickly for a
  // hiccup, VoxtralVoice.fetchPart, and once more with a longer wait, synthesizeHead), then written text. A reply already on its way when the
  // cloud voice fails is shown as written text too: one reply is never given two voices. The voice comes back by itself when it can be asked.
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
    const value={from:this.cloud,to:TEXT_ROUTE},engine=this.cloudEngine;
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
    // `reason: 'omni-no-nvidia'`: OmniVoice cannot run on this PC at all (no CUDA), so the game says that instead of a generic "unavailable".
    // `reason: 'omni-memory'`: it ran out of its time without enough graphics memory beside the game; Pocket speaks (the game says so once).
    // `reason: 'virtual-memory'`: Windows ran out of memory for the voice (the paging file is too small), for OmniVoice (Pocket speaks or the reply is written) or for Pocket itself.
    const paging=!this.requestedCloud&&((this.requestedProvider==='omni'&&(this.omniPagingFailed||this.pocketPagingFailed))||(this.requestedProvider==='pocket'&&this.pocketPagingFailed));
    const reason=this.requestedCloud?null:paging&&!this.omniNoCuda?'virtual-memory':this.requestedProvider!=='omni'?null:this.remoteWanted?'omni-remote':this.omniNoCuda?'omni-no-nvidia':this.omniNoMemory?'omni-memory':null;
    const value={from:this.requestedCloud??this.requestedProvider,to:want,...(reason?{reason}:{})};
    return (this.requestedProvider==='omni'&&this.omniRetry)||(this.requestedProvider==='pocket'&&this.pocketRetry)?{...value,temporary:true}:value;
  }
  // Why a character has no local voice: the Convai voice was chosen, or the local voice cannot serve it (its reply is then written).
  remoteReason(profile){
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
    // A cloud voice is never wanted while it is barred (Mature content on): the saved Voxtral choice is read as Pocket, the local default.
    const saved=this.cloudBarred()&&cloudVoiceChoice(settings?.voiceProvider)?'pocket':settings?.voiceProvider;
    // Remote OmniVoice is read first: with it on (and a server address saved) a local voice choice is rendered by the server, whichever of the entries is chosen
    // (Pocket as well as the four OmniVoice qualities, 2026-10-28: a player had to pick the right entry before the server was used). A cloud voice stays what the player chose.
    if(typeof settings?.remoteOmni==='boolean')this.remoteWanted=settings.remoteOmni;
    let chosen=canonicalVoiceProvider(saved);
    if(typeof saved==='string'&&chosen==='pocket'&&!cloudVoiceChoice(saved)&&this.remoteWanted&&this.omniRemote!==null)chosen='omni';
    if(typeof saved==='string')this.requestedCloud=cloudVoiceChoice(saved);
    if (['pocket','omni','convai'].includes(chosen)){
      // Choosing a provider again retries it, even if it failed earlier.
      if(chosen!==this.requestedProvider){
        // Choosing OmniVoice again after it ran out of memory retries it once (a failure for want of memory is for the session otherwise, and V would stay mute with it): one more
        // attempt, and a second failure for memory sets the flag again. No CUDA is a fact about the PC and stays.
        if(chosen==='omni'&&this.omniMemoryFailed&&!this.omniNoCuda){this.omniMemoryFailed=false;this.log('OmniVoice was chosen again: trying it once more after the memory failure');}
        if(chosen==='omni'&&this.omniPagingFailed){this.omniPagingFailed=false;this.log('OmniVoice was chosen again: trying it once more after Windows ran out of memory');}
        if(chosen==='pocket'&&this.pocketPagingFailed){this.pocketPagingFailed=false;this.log('Pocket was chosen again: trying it once more after Windows ran out of memory','PocketRetry');}
        if(!(chosen==='omni'&&this.omniNoCuda))this.failedBackends.delete(chosen);
        // Any change of or to Omni starts its retry story afresh (the normal start path takes over).
        if(chosen==='omni'||this.requestedProvider==='omni')this.endOmniRetry();
        if(chosen==='pocket'||this.requestedProvider==='pocket')this.pocketRetry=null;
      }
      this.requestedProvider=chosen;
    }
    // Settings > Voices > OmniVoice for AMD: MIOpen's convolutions on (the default) or off. Read only for a ROCm worker (omniWorkerHooks).
    if(typeof settings?.amdMiopen==='boolean')this.amdMiopen=settings.amdMiopen;
    if ([16,32].includes(settings?.omniSteps))this.requestedOmniSteps=settings.omniSteps;
    const reference=canonicalOmniReference(settings?.omniReference);
    if(reference)this.requestedOmniReference=reference;
    // Prepared voices are always kept (Settings has no switch for it any more): a saved keepPreparedVoices is not read.
  }
  get pending() { return this.provider!==this.resolvedProvider||this.cloud!==this.requestedCloud
    ||(this.provider==='omni'&&(this.omniSteps!==this.requestedOmniSteps||this.omniReference!==this.requestedOmniReference))
    ||(this.provider==='omni'&&this.client!=null&&this.clientBackend==='omni'&&this.clientStale('omni')); }
  get availabilityPending() { const verified=this.verifiedAvailabilities.get(this.verifiedKey(this.provider));
    return !!verified&&!equalSet(this.availability,verified); }
  get previewRoutingPending(){return local(this.provider)&&this.targetBackend!==null&&this.targetBackend!==this.provider;}
  consumeRouteChanges() { const value = [...this.routeChanges].sort(); this.routeChanges.clear(); return value; }
  stageAvailability(client,backend=this.clientBackend) {
    if (this.client !== client || this.closed || !client.loaded) return;
    if(backend==='pocket'&&this.pocketRetry){this.pocketRetry=null;this.releasePocketFailure(false);this.log('Pocket is ready again','PocketRetry');}
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
      &&this.availabilities[candidate].size>0&&!this.failedBackends.has(candidate)&&!(candidate==='omni'&&this.omniCardPending))||null;
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
    this.checkRemote();
    this.checkOwnWorker();
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
    if(this.client&&(this.clientBackend!==wanted||(wanted==='omni'&&(this.clientReference!==this.wantedReference||this.clientStale('omni'))))){
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
      // The cloud voice is reported as unavailable (replies written) only when it really cannot be asked (no key, a refused key, a limit cooling down:
      // `cloudBlocked`). One reply that timed out or lost its connection is not that: the next reply asks again, and the game must not say that
      // companions "are using the Convai voice for now" (the 2026-10-20 live test: a first ask timed out, the second one spoke, the notice appeared).
      // `voxtral.degraded` below still carries the reason for the support report.
      requestedProvider: this.requestedProvider, fallback: this.fallback??this.cloudBlocked, pending: this.pending,
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
      omniRemote:this.remoteWanted?{set:this.omniRemote!==null,connected:this.clientBackend==='omni'&&this.client?.loaded===true&&!this.client.failure}:null,
      gpuVendors:this.graphicsVendors,omniNoNvidia:this.omniNoNvidia,omniAmdRoute:this.omniAmdRoute,omniSmallCard:this.omniSmallCard,omniPython:ownPythonSummary(this.omniOwnPython),
      keepPreparedVoices:this.keepPrepared,
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
    for(let step=0;step<=VOICE_FALLBACK_ORDER.length;step++){
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
      this.publish(this.releasing ? 'releasing' : (this.provider === 'convai'||this.cloudWanted ? 'remote' : this.provider === TEXT_ROUTE ? 'disabled' : this.silent ? 'stopped' : 'disabled'));
      return Promise.resolve();
    }
    const backend=this.targetBackend;
    if(this.clientBackend===backend&&this.client?.failure)return Promise.reject(this.client.failure);
    if(this.client&&(this.clientBackend!==backend||(backend==='omni'&&(this.clientReference!==this.wantedReference||this.clientStale('omni'))))){
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
    this.clientRemote=backend==='omni'?this.workerKey:'';
    const variant=backend==='omni'?this.omniVariants[this.clientReference]:null;
    const factory=backend==='omni'?this.omniFactory:this.factory;
    const hooks={...this.options,keepPreparedVoices:this.keepPrepared,...(backend==='omni'?{configPath:variant.path,
      ...this.omniWorkerHooks()}:{}),onState: value => {
      if (this.client !== client || this.closed) return;
      if (value.state === 'error') queueMicrotask(()=>this.backendFailed(backend,client));
      if (value.state === 'ready') this.stageAvailability(client,backend);
      this.details = value; this.publish(value.state);
    }};
    client=this.client=this.primed(factory(backend==='omni'?this.baseConfigs.omni[this.clientReference]:this.baseConfigs[backend],hooks),backend,this.clientReference);
    if(backend==='omni'){client.setSteps(this.warmSteps);this.log(`starting OmniVoice (${this.graphicsNote})`,'OmniVoice');}
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
    // A Pocket start that timed out is told only if its retry fails too: on a cold disk or under a scanner the first import can pass the 240 s bound and the retry, with the files
    // cached, is ready in seconds (3 of 5 reports of 3a653672677b28c6 in 0.3.4 healed that way, and the voice works).
    if(backend==='pocket'&&/startup timed out/i.test(String(client.failure?.message??''))){
      this.heldPocketFailure=[backend,client.failure?.message,client.failure?.gpu,client.stderrTail];
    } else {
      this.releasePocketFailure();
      this.noteFailure(backend,client.failure?.message,client.failure?.gpu,client.stderrTail);
    }
    if(backend==='omni')this.scheduleOmniRetry(client.failure?.message,client.failure?.gpu);
    if(backend==='pocket'){this.schedulePocketRetry(client.failure?.message);if(!this.pocketRetry)this.releasePocketFailure();}
    this.reconcile();
    this.publish();
  }
  // A voice that could not start, told to whoever listens (the bridge records it for an error report, bridge/error-events.mjs). Never throws.
  // `gpu` ({dedicatedMiB, sharedMiB}): the worker's graphics memory when a render ran out of time, when it was read.
  // `tail`: the worker's last stderr (its client keeps 6,000 characters of it). Everything else a triage asks first is gathered here, where the state is: which voice the player chose
  // (`requested`), which one speaks now (`active`), where the replies go now that this one failed (`fellBackTo`: another voice, 'text', or for V's own Pocket worker 'silent'), and the cause as one word.
  // A worker with no CUDA (an AMD or Intel card with OmniVoice chosen) is reported too since 0.3.3: those players had no voice and no report told us (a 9070 XT player, 27 Oct 2026).
  noteFailure(engine,reason,gpu,tail){
    if(engine==='omni'&&this.remoteWanted)return;
    // A worker that Windows ended from outside because the game closed or the session ended is no failure of the voice (reports 24332da7 and 8df15641 fell on the second the game ended).
    if(endedFromOutsideFailed(reason))return;
    try{this.options.onFailure?.({engine,reason:String(reason??'unknown').slice(0,200),...(gpu?{gpu}:{}),cause:voiceFailureCause(reason),
      requested:this.requestedProvider,active:this.provider,fellBackTo:engine==='v-helper'?'silent':this.resolvedProvider,silent:this.silent,tail:tailLines(tail),
      // OmniVoice without CUDA on a PC whose card is AMD is the expected case: the settings offer "OmniVoice for AMD" and Pocket speaks, so the bridge files no row for it (bridge/error-events.mjs voiceFailed).
      ...(engine==='omni'&&noCudaFailed(reason)&&this.omniAmdCard?{amdCard:true}:{})});}catch{}
  }
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
  // `cause: 'virtual-memory'` when Windows ran out of memory for it (pagingFileFailed): the row says to enlarge the paging file or close programs.
  // `cause: 'missing-files'` when a file or Python module of the voice is not on the disk (missingFilesFailed; report 0b8367fd0ebd2f2f, "No module named 'urllib'"): the row says to reinstall the Full download.
  withCause(problem){return blockedByWindows(problem.reason)?{...problem,cause:'blocked'}:pagingFileFailed(problem.reason)?{...problem,cause:'virtual-memory'}:missingFilesFailed(problem.reason)?{...problem,cause:'missing-files'}:problem;}
  log(message,tag='OmniRetry'){try{this.options.onLog?.(`[${tag}] ${message}\n`);}catch{}}
  // The next Omni attempt, if the player still wants Omni and attempts remain. `fallback.temporary` follows it.
  scheduleOmniRetry(reason,gpu){
    const remote=this.omniRemote!==null;
    // A server on the player's network is asked again soon and for as long as the voice is wanted (the last wait repeats): it is usually only starting or briefly away.
    const failures=(this.omniRetry?.failures??0)+1,delay=remote?REMOTE_RETRY_DELAYS_MS[Math.min(failures-1,REMOTE_RETRY_DELAYS_MS.length-1)]:this.omniRetryDelays[failures-1];
    if(remote){
      if(this.closed||this.requestedProvider!=='omni'){this.omniRetry=null;return;}
      this.omniRetry={failures,nextAt:this.clock()+delay};
      this.log(`attempt ${failures} failed${reason?` (${reason})`:''}; asking the server again in ${Math.round(delay/1000)} s`,'OmniRemote');
      return;
    }
    // A worker that loaded both models and then could not confirm its paths fails the same way on every try, and each try loads the models again (a
    // minute or more of CPU and graphics memory, beside Local AI and the game): the paths are fixed for the life of the service, so it is not tried again.
    // A worker whose PyTorch has no CUDA (an AMD or Intel card) fails the same way on every try: it is not tried again, and Omni is not started again
    // until the service restarts (request() keeps the failure when the player chooses Omni again).
    if(noCudaFailed(reason)){
      this.omniNoCuda=true;
      this.log(`not trying again: OmniVoice needs an NVIDIA graphics card and this PC has none that works (${this.graphicsNote})`);
      this.omniRetry=null;return;
    }
    // A worker that ran out of its time (or of graphics memory) while the card was too small or spilled into shared memory fails the same way on every try, and each try loads
    // both models again beside Local AI and the game: not tried again, Pocket speaks in its place.
    const short=this.omniMemoryShort(reason,gpu);
    if(short&&this.requestedProvider==='omni'&&!this.cloudWanted){
      this.omniMemoryFailed=true;
      this.log(`not trying again: not enough graphics memory for OmniVoice next to the game (${short}); Pocket is used instead`);
      this.omniRetry=null;return;
    }
    // A plain timeout (a big card, nothing spilled) is tried once more: a second one is not a load that was merely slow.
    if(timedOutFailed(reason)&&failures>1){
      this.log(`giving up after a second timeout${reason?` (${reason})`:''}`);
      this.omniRetry=null;return;
    }
    if(pathAttestationFailed(reason)){
      this.log(`not trying again: the worker did not confirm its asset and data paths, and they do not change until the game is restarted${reason?` (${reason})`:''}`);
      this.omniRetry=null;return;
    }
    const permanent=permanentVoiceFailure(reason);
    if(permanent){
      this.log(`not trying again: ${permanent}${reason?` (${reason})`:''}`);
      // Pocket (a local voice, loaded beside nothing else of the voice) takes its place as for too little graphics memory, and the game says what happened.
      if(pagingFileFailed(reason)&&this.requestedProvider==='omni'&&!this.cloudWanted)this.omniPagingFailed=true;
      this.omniRetry=null;return;
    }
    if(this.closed||this.requestedProvider!=='omni'||this.omniPack.installed===false||delay===undefined){
      if(this.omniRetry||delay===undefined)this.log(`giving up after ${failures} failed attempts${reason?` (${reason})`:''}`);
      this.omniRetry=null;return;
    }
    // A worker that died on a memory fault (exit 3221225477) is tried once more at once with the CUDA graph off, before the normal waits: the graph is the first suspect,
    // and a second fault without it falls into the usual backoff with the graph left off.
    if(accessViolationFailed(reason)&&!this.omniGraphOff){
      this.omniGraphOff=true;
      this.log('the worker died on a memory fault; trying again in 5 s with the CUDA graph turned off');
      this.omniRetry={failures,nextAt:this.clock()+OMNI_FAULT_RETRY_MS};return;
    }
    this.omniRetry={failures,nextAt:this.clock()+delay};
    this.log(`attempt ${failures} failed${reason?` (${reason})`:''}; trying again in ${Math.round(delay/1000)} s`);
  }
  // Omni is the chosen voice or a worker for it is starting or running: the only time the card list is asked for (the source reads the PC when first asked, never at start-up).
  get omniWanted(){return this.requestedProvider==='omni'||this.clientBackend==='omni'||this.targetBackend==='omni';}
  // The memory of the NVIDIA card in MiB (the same lazy card list), or null while unknown.
  get graphicsMiB(){try{const found=Number(this.gpuMemorySource(this.omniWanted));return found>0?found:null;}catch{return null;}}
  /**
   * Why an Omni failure is too little graphics memory next to the game, in words for the log, or null: a timeout (or an out-of-memory error) together with graphics memory that
   * spilled into shared system memory (the worker's reading when its preparation ran out of time) or a card of 8 GB or less. A plain timeout on a big card is not.
   */
  omniMemoryShort(reason,gpu){
    if(!timedOutFailed(reason)&&!outOfMemoryFailed(reason))return null;
    if(gpu&&spillVerdict(gpu).spilled)return `spilled into shared memory: ${gpu.dedicatedMiB} MiB on the card, ${gpu.sharedMiB} MiB shared`;
    const card=this.graphicsMiB;
    return isSmallCard(card)?`the card has ${card} MiB`:null;
  }
  /**
   * OmniVoice is not started at all on a card of 8 GB or less (2026-10-22 reports: it took 4 minutes next to the game on an 8 GB card and then ran out of its time; the voice menu already says it needs 12 GB):
   * Omni that does not get the graphics memory it needs beside the game is replaced by Pocket (resolve), told once like a failed start (fallback.reason 'omni-memory'), without waiting for a timeout. The
   * saved choice stays OmniVoice, so a bigger card later just works. Only a card the list shows to be an NVIDIA one under 9,000 MiB counts; an unknown card claims nothing and starts Omni as before.
   */
  get omniCardTooSmall(){
    if(this.remoteWanted)return false;
    let card=null;
    try{const found=Number(this.gpuMemorySource(true));card=found>0?found:null;}catch{card=null;}
    const small=isSmallCard(card);
    if(small&&!this.omniCardNoted){this.omniCardNoted=true;this.log(`not starting OmniVoice: the card has ${card} MiB, not enough graphics memory for it next to the game; Pocket is used instead`);}
    return small;
  }
  // The card list is still being read (the source answers undefined, not null): Omni is not started until it is known whether the card is big enough. The read is a registry query of well under a second.
  get omniCardPending(){if(this.remoteWanted)return false;try{return this.gpuMemorySource(true)===undefined;}catch{return false;}}
  // Omni failed for want of graphics memory, or the card is known to be too small for it: Pocket speaks in its place.
  get omniNoMemory(){return !this.remoteWanted&&(this.omniMemoryFailed||this.omniPagingFailed||this.omniCardTooSmall);}
  // The menu hint "OmniVoice needs 12 GB": the NVIDIA card is known to be under 11 GB, or Omni already failed for want of memory. Unknown claims nothing.
  get omniSmallCard(){return !this.remoteWanted&&(this.omniMemoryFailed||underNeeded(this.graphicsMiB));}
  // The card vendors for the Omni start and failure lines: names only.
  get graphicsVendors(){try{const found=this.gpuVendorsSource(this.omniWanted);return Array.isArray(found)?found:null;}catch{return null;}}
  get graphicsNote(){if(this.remoteWanted)return 'remote server';const vendors=this.graphicsVendors;return vendors?.length?`graphics: ${vendors.join(', ')}`:'graphics: unknown';}
  // True when the game should say OmniVoice needs an NVIDIA card: a worker found no CUDA, or the cards are all known non-NVIDIA ones and no own Python with a
  // working GPU PyTorch (ROCm) is used or still to be tested (pending). Unknown claims nothing.
  get omniNoNvidia(){if(this.remoteWanted)return false;const own=this.omniOwnPython;return this.omniNoCuda||(lacksNvidia(this.graphicsVendors)&&!own?.used&&!own?.pending);}
  // True when the PC has a discrete AMD Radeon card and no NVIDIA one (bridge/gpu-vendors.mjs amdRoute) and no own Python is working or still being tested: the menu and
  // the Help page then point to the experimental AMD route (docs/OMNIVOICE_AMD.md) instead of "needs NVIDIA". Nothing is downloaded or started for it.
  // The card alone: a discrete AMD Radeon and no NVIDIA card (the AMD route applies to the PC), whether or not an own Python is in use or still being tested.
  get omniAmdCard(){if(this.remoteWanted)return false;try{return this.gpuAmdRouteSource(this.omniWanted)===true;}catch{return false;}}
  get omniAmdRoute(){if(this.remoteWanted)return false;const own=this.omniOwnPython;try{return this.gpuAmdRouteSource(this.omniWanted)===true&&!own?.used&&!own?.pending;}catch{return false;}}
  // The player's own Python for OmniVoice (bridge/omni-own-python.mjs resolveOwnPython), or null: without the file, and until its self-test has run.
  get omniOwnPython(){try{const found=this.options.omniOwnPython?.();return found?.configured?found:null;}catch{return null;}}
  // The python.exe and environment of an OmniVoice worker: the player's own Python only when its self-test passed (with OmniVoice's code from the pack,
  // and no CUDA graph on ROCm unless the worker is told otherwise), else the Runtime's, as before. The CUDA graph is off for the retry after a memory fault.
  // On ROCm (the self-test found torch.version.hip) the worker also gets MIOPEN_FIND_MODE=FAST and PyTorch's own convolutions instead of MIOpen's, each with an
  // override (omni-python.txt, docs/OMNIVOICE_AMD.md); nothing of that for NVIDIA or the Runtime's Python (rocmWorkerEnvironment).
  // The priority is one rule for both routes (docs/PROCESS_PRIORITY.md): High from the worker's start and for good (the `workerPriority` option, 'high' unless
  // the player's priority.txt says otherwise; omni-python.txt's `priority =` line wins for this worker). The bridge sets the child and the worker sets itself.
  // While the title-screen gate is closed (bridge/process-priority.mjs PriorityGate) a 'high' worker starts at normal, with no priority variable: ResidentVoice raises it when the
  // gate opens (`priority` stays the level asked for). 'below' and 'normal' ignore the gate. `priorityGate` (an option) is for tests; the shared gate is open by default.
  omniWorkerHooks(){
    const own=this.omniOwnPython,used=own?.used===true&&!!own.path&&!!own.source;
    const rocm=used?rocmWorkerEnvironment(own,this.options.processEnv??process.env,{miopen:this.amdMiopen}):{};
    const level=omniPriority(own,this.options.workerPriority);
    const extra={...(used?{[OWN_PYTHON_VARIABLE]:'1',[OMNI_SOURCE_VARIABLE]:own.source}:{}),...rocm,...priorityEnvironment((this.options.priorityGate??priorityGate).level(level)),...(this.omniGraphOff?{CYBERPUNK_CONVAI_CUDA_GRAPH:'0'}:{})};
    return {pythonExecutable:used?own.path:this.options.omniPythonExecutable,...(Object.keys(extra).length?{extraEnvironment:extra}:{}),priority:level,...(this.options.priorityGate?{gate:this.options.priorityGate}:{})};
  }
  endOmniRetry(){this.omniRetry=null;void this.dropCandidate();}
  // The AMD setup is about to be replaced or removed (bridge/omni-amd-setup.mjs): the OmniVoice workers are let go now, not at the next idle moment, unless a reply is
  // being spoken (that one is replaced when it is done). Resolves when they have exited.
  releaseOmniWorkers(){
    const exits=[this.dropCandidate()];
    if(this.clientBackend==='omni'&&!this.busy)exits.push(this.retire());
    return Promise.all(exits).then(()=>{},()=>{});
  }
  // Would routing speak with Pocket if it could run? Only when the player chose Pocket: an Omni that cannot run does not load Pocket in its
  // place. A cloud voice and the Convai voice want no Pocket worker.
  get pocketWanted(){
    if(this.cloudWanted)return false;
    // Pocket is also the voice of a player who chose Omni when Omni cannot get the graphics memory (omniNoMemory).
    return this.requestedProvider==='pocket'||(this.requestedProvider==='omni'&&this.omniNoMemory);
  }
  // The held start timeout (backendFailed) is told now, when no retry is left, or dropped when Pocket loaded again or is no longer wanted.
  releasePocketFailure(tell=true){
    const held=this.heldPocketFailure;this.heldPocketFailure=null;
    if(held&&tell&&!this.closed)this.noteFailure(...held);
  }
  // The next Pocket attempt, if the player still wants Pocket and attempts remain. `fallback.temporary` follows it.
  schedulePocketRetry(reason){
    const failures=(this.pocketRetry?.failures??0)+1,delay=this.pocketRetryDelays[failures-1];
    const permanent=permanentVoiceFailure(reason);
    if(permanent){
      this.log(`not trying again: ${permanent} (${reason})`,'PocketRetry');
      if(pagingFileFailed(reason)&&!this.cloudWanted)this.pocketPagingFailed=true;
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
    if(!this.pocketWanted){this.pocketRetry=null;this.releasePocketFailure(false);return;}
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
    if(this.candidate&&(this.requestedProvider!=='omni'||this.candidate.reference!==this.requestedOmniReference||this.candidate.remote!==this.workerKey||this.silent))void this.dropCandidate();
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
    const entry={reference,remote:this.workerKey,client:null,loaded:false,lastState:null};
    const hooks={...this.options,keepPreparedVoices:this.keepPrepared,configPath:variant.path,
      ...this.omniWorkerHooks(),lowPriority:true,onState:value=>{
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
    this.log(`loading OmniVoice in the background (retry ${this.omniRetry.failures}; ${this.graphicsNote})`);
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
    this.noteFailure('omni',entry.client.failure?.message,entry.client.failure?.gpu,entry.client.stderrTail);
    void this.retireCandidate(entry).catch(()=>{this.omniRetry=null;});
    this.scheduleOmniRetry(entry.client.failure?.message,entry.client.failure?.gpu);
    this.publish();
  }
  retireCandidate(entry){
    const closing=Promise.resolve().then(()=>this.closeWorker(entry.client));
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
    if(!entry?.loaded||this.client||wanted!=='omni'||entry.reference!==this.wantedReference||entry.remote!==this.workerKey||entry.client.failure||entry.client.closing)return false;
    this.candidate=null;
    this.client=entry.client;this.clientBackend='omni';this.clientReference=entry.reference;this.clientRemote=entry.remote;
    this.starting=Promise.resolve();
    this.details=entry.lastState||this.details;
    return true;
  }
  // The state published when no local worker is loaded: 'remote' for a voice that runs elsewhere, 'disabled' while the replies are written (the voice cannot run),
  // 'stopped' only when playback is Off or the service is closed. Never 'stopped' for a running bridge whose voice failed: the supervisor reads 'stopped' in this file as a bridge that is gone.
  idleState() { return this.closed ? 'stopped' : this.resolvedProvider===TEXT_ROUTE ? 'disabled' : this.silent ? 'stopped' : 'remote'; }
  retire() {
    const client = this.client;
    const backend=this.clientBackend;
    this.client = this.starting = this.clientBackend = this.clientReference = null;
    if (!client) { this.tickVHelper(); this.publish(this.releasing ? 'releasing' : this.idleState()); return this.retiring; }
    this.releasing = true;
    this.publish('releasing');
    // Signal EOF even during warmup. The worker owns its bounded physical
    // cleanup; waiting for readiness first could prevent shutdown forever.
    // An unconfirmed prior exit must continue blocking any replacement, but it never keeps THIS worker from being closed (a worker skipped
    // here would run on, unseen, beside the next one). An exit that could not be confirmed is looked at again before it counts as failed
    // (closeWorker), so one missed confirmation is not the end of every local voice for the session.
    const phoneRetirement=backend==='pocket'?this.phoneAnalysis?.retire().catch(()=>{}):undefined;
    const closeThis = () => Promise.all([this.closeWorker(client),phoneRetirement]);
    const retirement = this.retiring.then(closeThis, error => closeThis().then(() => { throw error; }));
    this.retiring = retirement.then(() => {
      if (this.retiring !== completed) return;
      this.releasing = false;
      if (!this.client) {
        this.details = {resident:false,gpuVramBytes:0,cudaAllocatedMiB:0,cudaReservedMiB:0};
        this.publish(this.idleState());
      }
    });
    const completed = this.retiring;
    // V's own Pocket worker may be due now that the Pocket worker is leaving; it waits for this exit (Pocket's one work-folder lock).
    this.tickVHelper();
    this.retiring.catch(() => this.publish('error', {detail: 'Could not release local voices. Restart the voice service.'}));
    return this.retiring;
  }
  // Closes a worker and confirms its exit; an exit that was not confirmed is checked again (bridge/worker-process.mjs) before it is a failure.
  closeWorker(client){return closeConfirmed(client,{log:message=>this.log(message,'Voices'),recoverMs:this.options.exitRecoverMs});}
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
    // Not at the title screen (see startHold). A helper that already runs is never held: only its first load waits.
    if(!this.vHelper.running&&this.startHold())return false;
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
  /** In the last steps of its load: a typed line may wait for it (bridge/v-voice.mjs). */
  vHelperNearlyReady(key) { return this.vHelper.nearlyReady(key); }
  vHelperWhenReady(key, options = {}) { return this.vHelper.whenReady(key, options); }
  vHelperStream(key, text, options = {}) { return this.vHelper.stream(key, stripSpeechTags(text), options); }
  vHelperPrepare(key, options = {}) { return this.vHelper.prepare(key, options); }
  // ---- V's typed line on OmniVoice (V's voice engine 'omni', docs/V_VOICE.md "V on OmniVoice") ----
  // The player's choice, offered only while OmniVoice is the companions' committed voice: V's line is one more job on the Omni worker
  // the companions already use. Nothing extra loads (no Pocket worker for V, no second Omni worker), so with any other companion voice, a
  // worker that is not loaded or voice playback Off there is simply no V line, with the reason. The worker does one job at a time and cannot
  // cancel a render that has started, so V's job goes in first (the bridge starts it when the line is sent) and the companion's render
  // queues behind it; a V job that is still queued when its turn ends is cancelled before it starts (ResidentVoice.synthesize).
  /** Why V's line cannot be rendered on OmniVoice right now, or null when it can. Quiet: starts nothing. */
  vOmniProblem(key) {
    if (this.closed) return 'the voice service is closed';
    if (!this.omniPack?.installed) return 'the OmniVoice pack is missing';
    if (this.provider !== 'omni' || !this.usesProfile(key)) return 'the companions are not on OmniVoice now';
    if (this.silent) return 'voice playback is off, so OmniVoice is not loaded';
    const client = this.client;
    if (this.clientBackend !== 'omni' || !client || client.failure || client.closing) return 'the OmniVoice worker is not running';
    if (client.loaded !== true) return 'the OmniVoice worker is still loading';
    return null;
  }
  /**
   * Renders V's line on the Omni worker: the whole WAV, queued behind whatever the worker is doing and ahead of anything asked later. 16
   * steps whatever the companions use (V's line is short; 32 steps cost about 0.6 s more first audio and the worker re-captures its graph for
   * a new text length either way). `signal` cancels a job that has not started.
   */
  vOmniRender(key, text, options = {}) {
    const spoken = stripSpeechTags(text);
    return this.synthesize(key, spoken, {...options, steps: 16});
  }
  /** Prepares V's voice on the Omni worker (the hidden warm-up render, about 0.8 s, once per worker): at the composer, not inside the first line. */
  vOmniPrepare(key, options = {}) {
    if (this.vOmniProblem(key) !== null) return Promise.resolve({ready: false});
    return this.client.prepareProfile(this.voiceOf(key), options);
  }
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
    // A reply in another language: the Pocket model of the language is made the resident one and the voice is the pack's clip of this character.
    if (options.language && options.language !== 'en') {
      const pocketLanguage = await this.pocketLanguageFor(profile, options.language);
      if (pocketLanguage) {
        try { return await client.synthesizeStream(profile, spoken, {...plain, pocketLanguage}); }
        catch (error) {
          // A model the worker refused (its files differ from the manifest, it would not load) is not tried again until its files change.
          if (error?.refused) this.pocketLanguages?.markFailed(options.language, error.message);
          throw error;
        }
      }
      // The model is installed but this character has no clip in the language's pack: never the English student reading foreign text.
      if (this.pocketLanguages?.has(options.language)) throw Error('Pocket has no voice of this character in this language');
    }
    return client.synthesizeStream(profile, spoken, plain);
  }
  /**
   * What the Pocket worker needs to speak `profile` in `language`: {tag, expected (the model's hashes), voices: {profile: descriptor}}, or null (no model, no voice pack, or no clip
   * of this character in the pack). The player's own clip for the character is used as it is (a pack never replaces it). In-memory lookups plus one hash of the clip, once.
   */
  async pocketLanguageFor(profile, language) {
    if (!language || language === 'en' || !this.pocketLanguages || !this.pocketLanguages.speaks(language)) return null;
    const model = this.pocketLanguages.model(language);
    let descriptor = null;
    try {
      if (this.hasPlayerClip(profile)) {
        const own = this.registries.pocket.profiles[profile];
        // Only the player's own clip is a language voice of Pocket's worker (it refuses any other path outside the language pack folder): a reference kept for a V voice mod is spoken by the English student.
        if (own && !isPlayerReference(own.reference)) return null;
        descriptor = own ? {reference: own.reference, sha256: own.sha256, transcript: own.transcript} : null;
      } else descriptor = await this.languagePacks?.omniDescriptor(language, profile) ?? null;
    } catch { descriptor = null; }
    return model && descriptor ? {tag: language, expected: model.expected, folder: model.language, voices: {[profile]: descriptor}} : null;
  }
  /** Swaps the language model in and prepares the voice ahead of the reply (the turn's language is known before its reply is written). Quiet: never starts the worker, never throws. */
  async warmPocketLanguage(profile, language) {
    try {
      if (this.provider !== 'pocket' || this.cloudActive || this.silent || this.clientBackend !== 'pocket' || !this.client?.loaded || !this.usesProfile(profile)) return null;
      const voice = this.voiceOf(profile), pocketLanguage = await this.pocketLanguageFor(voice, language);
      if (!pocketLanguage || this.provider !== 'pocket' || this.cloudActive) return null;
      return await this.client.prepareLanguage(voice, pocketLanguage, {urgent: true});   // the turn's reply waits for this swap: normal priority
    } catch { return null; }
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
      if (this.cloudBarred()) throw Error(`The ${name} voice is not used while Mature content is on`);
      // A cool-down of a moment (a 429 on a one-request-a-second key) is waited out: the reply is spoken a second late rather than written.
      const cooling = engine.cooldownMs;
      if (!engine.ready && engine.hasKey && cooling > 0 && cooling <= this.cloudWaitOutMs) { await this.sleep(cooling + 20, options.signal); throwIfCancelled(options.signal); }
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
    if (utterance.engine === 'pocket' || !this.cloudEngine.hasKey || this.cloudBarred()) return unvoiced();
    const own = new AbortController();
    const relay = () => own.abort(options.signal.reason);
    options.signal?.addEventListener('abort', relay, {once: true});
    if (options.signal?.aborted) relay();
    const name = this.cloud, engine = this.cloudEngine;
    void utterance.decision.then(decided => { if (decided !== name) own.abort(cancelled()); });
    const held = [];
    let open = utterance.engine === name;
    const sink = packet => { if (open) return options.onPcm(packet); held.push(packet); return undefined; };
    // Once the head is known to be the cloud voice, what arrived early is handed on, in order, before anything newer.
    const opening = utterance.decision.then(async decided => {
      if (decided !== name) { held.length = 0; return; }
      while (held.length) await options.onPcm(held.shift());
      open = true;
    });
    opening.catch(() => {});
    let cloud, failure;
    try { cloud = await engine.synthesizeStream(profile, spoken, {signal: own.signal, onPcm: sink, continuation: true, ahead: options.ahead === true, language: options.language}); }
    catch (error) { failure = error; }
    finally { options.signal?.removeEventListener('abort', relay); }
    throwIfCancelled(options.signal);
    // The head may not have decided yet (its first audio is still on the way): the rest waits for it.
    if (await utterance.decision !== name) {
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
    // The language pack's clip of this voice for the reply's language, when the pack has one (the worker checks it; a clip it refuses is spoken from
    // the English reference). In memory but for the clip's hash, read once per file.
    let languageReference;
    if(options.language&&options.language!=='en'&&this.languagePacks&&!this.hasPlayerClip(profile)){
      try{languageReference=(await this.languagePacks.omniDescriptor(options.language,profile))||undefined;}catch{languageReference=undefined;}
    }
    await abortable(this.start(),options.signal);throwIfCancelled(options.signal);
    const client=this.client;
    if(!client||this.clientBackend!=='omni'||this.provider!=='omni'||!this.usesProfile(profile))
      throw Error('Voice selection changed before synthesis');
    // Only the tags OmniVoice renders reach it; any other bracketed tag is removed.
    return client.synthesize(profile,keepSpeechTags(text,omniTagsFor(options.language)),{...options,steps,...(languageReference?{languageReference}:{})});
  }
  // Does the player's own clip speak this voice (docs/CHARACTER_EDITOR.md, "Voice clips"), or a reference of the player's own making that a language pack must not replace (V's V voice mod
  // reference, docs/V_VOICE.md: the player's clip, then the mod's reference, then the pack's clip, then the shipped one)? Neither is replaced by a pack clip in another language.
  hasPlayerClip(key){
    if(isPlayerReference(this.registry?.profiles?.[key]?.reference))return true;
    try{return this.keepsReference(key)===true;}catch{return false;}
  }
  /**
   * OmniVoice, a reply expected in `language` (not English) and a language pack with a clip of this character: the worker checks the clip and builds its
   * conditioning prompt now, while the reply is being written (or the composer is open), so the first line in that language does not do it (about half a second
   * to a second on a fast card, more on a slow one). Resolves true when the clip was prepared, false when there is nothing to prepare (the caller then prepares the
   * English voice as usual). Quiet: never throws, and asks the worker once per voice, language and worker.
   */
  async warmOmniLanguage(profile, language) {
    try {
      if (!language || language === 'en' || this.provider !== 'omni' || this.cloudActive || this.silent || !this.languagePacks) return false;
      const voice = this.voiceOf(profile);
      if (!this.usesProfile(voice) || this.hasPlayerClip(voice)) return false;
      const descriptor = await this.languagePacks.omniDescriptor(language, voice);
      if (!descriptor) return false;
      await this.start();
      const client = this.client, key = `${voice}|${language}|${descriptor.sha256}`;
      if (!client || this.clientBackend !== 'omni' || this.provider !== 'omni' || typeof client.prepareLanguage !== 'function' || !client.usesProfile?.(voice)) return false;
      if (this.omniLanguageWarm.get(key) === client) return true;
      const receipt = await client.prepareLanguage(voice, descriptor);
      if (receipt?.languageReference !== 'used') return false;
      this.omniLanguageWarm.set(key, client);
      while (this.omniLanguageWarm.size > 64) this.omniLanguageWarm.delete(this.omniLanguageWarm.keys().next().value);
      return true;
    } catch { return false; }
  }
  async prepareProfile(profile, options = {}) {
    // A character this installation does not voice locally: ready to join. Its replies use the Convai voice only when that was chosen; with any other
    // voice chosen (local or Voxtral) they are written ('text'), never given to a cloud voice.
    const remote = reason => ({provider: this.convaiVoiceAllowed ? 'convai' : TEXT_ROUTE, ready: true, reason});
    for (;;) {
      throwIfCancelled(options.signal);
      if (this.closed) throw Error('Voice service is closed');
      await this.routingSettled(options);
      throwIfCancelled(options.signal);
      if (this.closed) throw Error('Voice service is closed');
      if (this.provider === 'convai' || this.provider === TEXT_ROUTE) return remote(this.remoteReason(profile));
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
        if (this.cloud === 'inworld') this.inworld.warm?.(voice);
        return {provider: 'pocket', ready: true, profile, cloudVoice: this.cloud};
      }
      const startingBackend=this.provider;let startedClient;
      try {
        const starting=this.start();startedClient=this.client;
        await abortable(starting, options.signal);
      }
      catch (error) {
        throwIfCancelled(options.signal);
        if (!this.closed && (this.provider === 'convai' || this.provider === TEXT_ROUTE)) return remote(this.remoteReason(profile));
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
      if (this.provider === 'convai' || this.provider === TEXT_ROUTE) return remote(this.remoteReason(profile));
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
      try {
        // A Pocket language is resident (the last language stays loaded): the voice is prepared in that language's view, so no model is swapped out for a warm-up.
        // A character with no clip in that language's pack falls back to the English student (the client defers that one unless the caller requires it).
        const resident = this.provider === 'pocket' && !client.profileReady?.(voice) ? client.residentLanguage : null;
        const pocketLanguage = resident && typeof client.prepareLanguage === 'function' ? await this.pocketLanguageFor(voice, resident).catch(() => null) : null;
        throwIfCancelled(options.signal);
        receipt = pocketLanguage ? await client.prepareLanguage(voice, pocketLanguage, {signal: options.signal}) : await client.prepareProfile(voice, options);
      }
      catch (error) {
        throwIfCancelled(options.signal);
        if (!this.closed && (this.provider === 'convai' || this.provider === TEXT_ROUTE)) return remote(this.remoteReason(profile));
        await new Promise(resolve => setImmediate(resolve));
        if (!this.closed && this.failedBackends.has(startingBackend)) continue;
        throw error;
      }
      throwIfCancelled(options.signal);
      if(phonePreparing)await phonePreparing;
      throwIfCancelled(options.signal);
      await this.routingSettled(options);
      if (this.closed) throw Error('Voice service is closed');
      if (this.provider === 'convai' || this.provider === TEXT_ROUTE) return remote(this.remoteReason(profile));
      if (this.client !== client) continue;
      if (!this.hasProfile(profile)) return remote('unavailable');
      return {...receipt,provider:this.provider};
    }
  }
  close() {
    if (this.closed) return this.closing||this.retiring;
    this.closed = true; this.preview = null; this.omniRetry = null; this.pocketRetry = null; this.heldPocketFailure = null;
    for (const waiter of this.routingWaiters) waiter.reject(Error('Voice service is closed'));
    this.routingWaiters.clear();
    return this.closing=Promise.all([this.retire(),this.phoneAnalysis?.close(),this.dropCandidate(),this.vHelper.release()]);
  }
}
