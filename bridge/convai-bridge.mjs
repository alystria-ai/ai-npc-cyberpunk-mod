import {readFile, stat, mkdir} from 'node:fs/promises';
import {readFileSync, statSync} from 'node:fs';
import {decisionLedgerReader} from './game-dialogue.mjs';
import {witnessReceiptsReader} from './witness-receipts.mjs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {archetypeContext, isAmbientProfile, parseInput, profileFor} from './protocol.mjs';
import {configureKnowledgeParts} from './knowledge-parts.mjs';
import {audioReady, prepareSpeech} from './speech-audio.mjs';
import {createSpeechStateReader, audioAvailable} from './speech-state-cache.mjs';
import {buildFacialTimeline} from './facial-timeline.mjs';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';
import {encodeSegmentedFace} from './continuous-face-file.mjs';
import {timelineRecord, TIMELINE_PREFIX} from './expression-timeline.mjs';
import {PhoneticLipsync} from './phonetic-lipsync.mjs';
import {JaliFace} from './jali-face.mjs';
import {textExpressionSignal} from './text-emotion.mjs';
import {planSignal, phraseOffsets, traitFor} from './emotion-analysis.mjs';
import {EmotionSelection, waitLateEmotion} from './emotion-selector.mjs';
import {SpeechSlots, SpeechStream, splitSpeechText} from './speech-stream.mjs';
import {deliverPocketSpeech} from './pocket-speech.mjs';
import {ReplyStream} from './reply-stream.mjs';
import {hasEmotionTag} from './emotion-tags.mjs';
import {ownedPocketFace} from './pocket-facial-stream.mjs';
import {RealtimeHost} from './realtime-host.mjs';
import {CompanionVision} from './companion-vision.mjs';
import {VisionCapture} from './vision-capture.mjs';
import {MicrophoneSession} from './microphone-session.mjs';
import {createAddonVoice} from './addon-voice.mjs';
import {startVoiceKeyStream} from './voice-key-stream.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {conversationScope} from './group-context.mjs';
import {conversationContext as baseConversationContext, conversationContextBlocks as baseConversationBlocks, firstPersonReminder, voiceConversationBlocks} from './quest-context.mjs';
import {createIntrinsicConversationContext, loadIntrinsicCharacterContext} from './intrinsic-character-context.mjs';
import {battleTrigger, reactionLeaseProblem} from './battle-context.mjs';
import {GroupPrefetch, parsedInputIdentity, parsePrewarm} from './group-prefetch.mjs';
import {GroupLookahead, validateLookahead, waitUntil, BufferedPcm} from './group-lookahead.mjs';
import {abortable, throwIfCancelled} from './transport-pool.mjs';
import {PartyConnections, parsePartyConnections} from './party-connections.mjs';
import {NearbyWarm} from './nearby-warm.mjs';
import {CompanionInvitations} from './companion-invitations.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {VoxtralVoice} from './voxtral-voice.mjs';
import {InworldVoice} from './inworld-voice.mjs';
import {INWORLD_KEY_FILE, InworldKey} from './inworld-key.mjs';
import {createReferencePreparer} from './voxtral-reference.mjs';
import {VoiceRoutingLog, ROUTING_LOG_NAME, describeVoiceRoute} from './voice-routing-log.mjs';
import {variantSeed} from './voice-variants.mjs';
import {NaturalSpeech, OMNI_TAGS, omniTagsFor, speechPhrases} from './natural-speech.mjs';
import {FollowUp} from './follow-up.mjs';
import {VVoice, loadVVoiceReferences, extraVoices} from './v-voice.mjs';
import {MatureContent} from './mature-content.mjs';
import {warmMatureGuard} from './mature-guard.mjs';
import {detectMaturePack} from './mature-pack.mjs';
import {gearDiagnostic} from './player-gear.mjs';
import {turnContextDiagnostic} from './turn-context.mjs';
import {ExpressiveEmotions} from './expressive-emotions.mjs';
import {resolveVoiceConfigPaths} from './voice-config-paths.mjs';
import {detectOmniPack} from './omni-pack.mjs';
import {ResidentPhoneAnalysis} from './resident-phone-analysis.mjs';
import {VoicePreviewLease} from './voice-preview.mjs';
import {PhoneChat, parsePhoneState, phoneRecentConversationContext} from './phone-chat.mjs';
import {PhoneWarm} from './phone-warm.mjs';
import {GameLaunchIdentity, identifyGameLaunch} from './game-launch.mjs';
import {PlayerMemory} from './player-memory.mjs';
import {VendorMemory, vendorMemoryKey} from './vendor-memory.mjs';
import {PlayerMemoryApi} from './player-memory-api.mjs';
import {PlayerMemoryControl} from './player-memory-control.mjs';
import {SupportReportControl} from './support-report.mjs';
import {CharacterOverrides} from './character-overrides.mjs';
import {CharacterEditor} from './character-editor.mjs';
import {EditorServer} from './character-editor-server.mjs';
import {EditorControl} from './character-editor-control.mjs';
import {YouTubeTv} from './youtube-tv-host.mjs';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {PlayerPhoneKnowledge, playerPhoneGeneration} from './player-phone-knowledge.mjs';
import {atomicFile as atomic} from './guarded-file.mjs';
import {readWorldSession} from './world-session.mjs';
import {RelationshipRouting, retireRelationshipConnections} from './relationship-routing.mjs';
import {relationshipContext} from './romance-context.mjs';
import {MultilingualConversations, RETIRED_PROVIDER_KEY, multilingualTwins, planTurnVoice, replyVoice} from './multilingual.mjs';
import {CompanionActions} from './companion-actions.mjs';
import {RequestFileOwner, fileIdentity} from './request-ownership.mjs';
import {updateDialogueLevel, dialogueLevel} from './dialogue-level.mjs';
import {AudioOutputWatch, audioDelayMs, resolveDelayMs, setAudioDelayMs, settingDelay} from './audio-delay.mjs';
import {ConvaiKeys, OwnKeyControl, PLAYER_KEY_FILE, PLAYER_USER_FILE, memoryRecovery, withoutIdentity} from './convai-key.mjs';
import {QuotaWatch, classifyFailure} from './convai-quota.mjs';
import {readKeyFileText} from './key-codec.mjs';
import {AUTH_CONFIG_FILE, INSTALL_FILE, TokenSource, loadInstallId, readAuthSettings} from './convai-credential.mjs';
import {DAILY_LIMIT, LimitStore, SharedKeyGuard, UsageStore, limitFromEnvironment, machineId} from './shared-key-guard.mjs';
import {MISTRAL_KEY_FILE, MistralControl, MistralProvider} from './mistral-key.mjs';
import {TextProviderHost, attachTextProvider, isLocalUnavailable, localRoute, mistralRoute} from './text-provider-host.mjs';
import {MEMORY_FILE as MISTRAL_MEMORY_FILE} from './mistral-memory.mjs';
import {MemoryStore} from './memory-store.mjs';
import {mistralScheduler, PRIORITY} from './mistral-rate.mjs';
import {detectLocalAiPack} from './local-ai-pack.mjs';
import {LocalLlmServer, nvidiaTotalMiB} from './local-llm-server.mjs';
import {defaultModelIds, describeLocalModels, listLocalModels, normalisePin} from './local-model-choice.mjs';
import {CustomModelScanner} from './custom-models.mjs';
import {LlamaEmbedder} from './local-embed.mjs';
import {watchFiles, createWakeSignal} from './file-wake.mjs';
const leaseWake = createWakeSignal();
import {PersonaBook, joinBlocks} from './mistral-prompt.mjs';
import {LocalStt} from './local-stt.mjs';
import {LocalSttCapture, createLocalSpeech, hostBrowser} from './local-stt-capture.mjs';
import {DEFAULT_MODELS as MISTRAL_MODELS, DECISION_MODELS as MISTRAL_DECISION_MODELS, DEFAULT_MODEL as MISTRAL_MODEL, errorCodeFor as mistralCodeFor, warmConnection} from './mistral-client.mjs';
import {TurnClock, withClock, markStage} from './turn-clock.mjs';
import {AddonHost, LOCAL_REMARK_GAP_S, fixedProvider, rosterLookup, sharedMemory} from './addons.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDirectory = resolve(process.env.CYBERPUNK_CONVAI_STATE || resolve(project, 'runtime'));
const game = process.env.CYBERPUNK_CONVAI_GAME || 'E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077';
const runtime = resolve(game, 'bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/runtime');
const keyFile = process.env.CYBERPUNK_CONVAI_KEY_FILE || resolve(stateDirectory, 'convai-key.txt');
// Named characters, then the generic NPC archetypes (docs/NPC_ARCHETYPES.md). The archetype roster is optional:
// without it (or without their IDs in characters.json) unnamed NPCs simply have no profile.
const roster = [...JSON.parse(await readFile(resolve(project, 'characters/roster.json'), 'utf8')),
  ...JSON.parse(await readFile(resolve(project, 'characters/archetype-roster.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '[]';
    throw error;
  }))];
const ids = JSON.parse(await readFile(resolve(stateDirectory, 'characters.json'), 'utf8'));
// Add-on mods (docs/ADDON_API.md): each speaker an installed add-on brings becomes a roster row here. Add-on speakers never have a
// Convai character (their text comes only from Mistral or the local AI, runAddonTurn). With no add-on installed the host is empty and adds nothing.
const addonHost = await AddonHost.load({game, log: message => console.error('[Addons] ' + message)});
addonHost.extend(roster, ids);
addonHost.characterLookup = rosterLookup(roster);
// runtime/relationship-profiles.json (the retired alternate affectionate profiles) is no longer read: every character has one profile.
// Multilingual twins (docs/MULTILINGUAL_PROFILES.md): used only while "Multilingual conversations" is on. A missing
// map is an English-only installation; a twin that no longer clones the current profile is left out.
const multilingualProfiles = multilingualTwins(JSON.parse(await readFile(resolve(stateDirectory, 'multilingual-profiles.json'), 'utf8').catch(error => {
  if (error.code === 'ENOENT') return 'null';
  throw error;
})), {ordinaryIds: ids});
if (multilingualProfiles.skipped.length) console.error('[CyberpunkConvai] Multilingual profiles not used:', multilingualProfiles.skipped.join(', '));
const relationshipRoutes = new RelationshipRouting({ordinaryIds: ids, multilingual: multilingualProfiles.twins});
// Which voice configuration files are live is named by runtime/voice-configs.json (bridge/voice-config-paths.mjs):
// the searched references for Pocket and for OmniVoice's short and long choices, each falling back to the base file.
// Add-on voices are merged into copies of these files (addons.<name> in the state folder); without add-on voices the paths are unchanged.
// V's voice for typed lines (docs/V_VOICE.md): the two reference clips cut from the game's own V lines (released with the mod under
// voice-references/v-voice, or assets/v-voice in a source checkout) are merged here as the voices v-male and v-female, like an add-on's
// voice. They only sit in the configurations; nothing is prepared or loaded for them until a typed line is spoken in V's voice.
const referenceRoots = process.env.CYBERPUNK_CONVAI_OMNI_REFERENCES ? [process.env.CYBERPUNK_CONVAI_OMNI_REFERENCES]
  : [resolve(stateDirectory, 'voice-references'), resolve(project, 'runtime/voice-references')];
const vVoiceReferences = await loadVVoiceReferences([...referenceRoots.map(root => resolve(root, 'v-voice')), resolve(project, 'assets/v-voice')],
  {log: line => console.error('[VVoice] ' + line)});
const voiceConfigPaths = await addonHost.voiceConfigPaths(resolveVoiceConfigPaths(stateDirectory), {stateDirectory,
  roots: referenceRoots, extra: extraVoices(vVoiceReferences)});
for (const warning of voiceConfigPaths.warnings) console.error('[CyberpunkConvai] Voice configuration: ' + warning);
const readVoiceConfig = async path => JSON.parse(await readFile(path, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '{}';
  throw error;
}));
const localVoiceConfigPath = voiceConfigPaths.pocket;
const voiceConfig = await readVoiceConfig(localVoiceConfigPath);
const omniVoiceConfigs = {short: await readVoiceConfig(voiceConfigPaths.omni.short), long: await readVoiceConfig(voiceConfigPaths.omni.long)};
let voiceMetricsWriting = Promise.resolve();
const phoneAnalysisConfigPath=resolve(stateDirectory,'phone-analysis.json');
let phoneAnalysisConfig={};
try{phoneAnalysisConfig=JSON.parse(await readFile(phoneAnalysisConfigPath,'utf8'));}
catch(error){if(error.code!=='ENOENT')console.error('[CyberpunkConvai] Optional phone analyser configuration is unavailable.');}
let phoneMetricsWriting=Promise.resolve();
const phoneAnalysisOptions={configPath:phoneAnalysisConfigPath,
  onState:state=>{
    phoneMetricsWriting=phoneMetricsWriting.catch(()=>{}).then(()=>atomic(resolve(runtime,'phone-analysis-state.json'),JSON.stringify(state)));
    return phoneMetricsWriting;
  }};
let phoneAnalysis;
try{phoneAnalysis=new ResidentPhoneAnalysis(phoneAnalysisConfig,phoneAnalysisOptions);}
catch{console.error('[CyberpunkConvai] Optional phone analyser configuration failed validation.');
  phoneAnalysis=new ResidentPhoneAnalysis({},phoneAnalysisOptions);}
// Optional game-trained facial model (docs/GAME_LIPSYNC_MODEL.md). With local
// weights it drives Pocket, Omni and Convai mouths and the resident phone
// analyser is not started; without them the previous paths are unchanged.
const jaliFace = await JaliFace.load(resolve(stateDirectory, 'lipsync-model')).catch(error => {
  console.error('[CyberpunkConvai] Facial model unavailable:', error.message); return null;
});
// The Mistral cloud voice (docs/CLOUD_VOICE_VOXTRAL.md): an optional Companion voice that clones each character from its
// OmniVoice long reference on the player's Mistral key. Pocket stays loaded as the fallback for any reply it cannot deliver in time.
// The key is read from the Mistral provider on each call (it can be pasted or removed while the game runs); `mistral` is created below.
// The reference clip is sent with every request, so a smaller one is a shorter wait for the first sound (bridge/voxtral-reference.mjs):
// 24 kHz mono (the clone keeps only the bandwidth of its reference) and cut to about 8.5 s (Ogg Vorbis as well when ffmpeg is on the machine; MP3 stops at 11.3 kHz), prepared once per character and kept in <references>/prepared.
// CYBERPUNK_CONVAI_VOXTRAL_FULL_REFERENCE=1 sends the clips whole, as before.
// Reply streaming (bridge/reply-stream.mjs): on unless settings.json "replyStreaming": false or this variable is 0. Kept up here, beside the other
// environment reads, so the sections of this file that tests evaluate on their own never touch `process`.
const replyStreamingForcedOff = process.env.CYBERPUNK_CONVAI_REPLY_STREAM === '0';
let replyStreaming = !replyStreamingForcedOff;
const voxtralReferenceRoot = process.env.CYBERPUNK_CONVAI_OMNI_REFERENCES || resolve(stateDirectory, 'voice-references');
const voxtralVoice = new VoxtralVoice({getKey: () => { try { return mistral.apiKey ?? null; } catch { return null; } },
  referenceRoot: voxtralReferenceRoot,
  prepare: process.env.CYBERPUNK_CONVAI_VOXTRAL_FULL_REFERENCE === '1' ? undefined
    : createReferencePreparer({cacheDirectory: resolve(voxtralReferenceRoot, 'prepared'), onLog: message => process.stderr.write(`[Voxtral] ${message}\n`)}),
  onLog: message => process.stderr.write(message)});
// The Inworld cloud voice (docs/CLOUD_VOICE_INWORLD.md): the same kind of choice, on the player's own Inworld key (player-inworld-key.txt in
// the state folder, pasted in Settings). Each character is cloned once from the same reference clips; the voice ids are kept in
// player-inworld-voices.json in the state folder. `inworldKey` is loaded below with the other keys.
const inworldKey = await new InworldKey({keyPath: resolve(stateDirectory, INWORLD_KEY_FILE)}).load();
const inworldVoice = new InworldVoice({getKey: () => inworldKey.key, referenceRoot: voxtralReferenceRoot,
  storePath: resolve(stateDirectory, 'player-inworld-voices.json'), onLog: message => process.stderr.write(message)});
const localVoice = new VoiceSelection(voiceConfig, {project, configPath: localVoiceConfigPath,
  phoneAnalysis: jaliFace ? undefined : phoneAnalysis,
  pythonExecutable: voiceConfig.runtime?.pythonExecutable,
  omniConfigs:omniVoiceConfigs,omniConfigPaths:voiceConfigPaths.omni,previewSettleMs:1500,
  voxtral:voxtralVoice,inworld:inworldVoice,
  // The optional OmniVoice pack (worker Python, model weights, adapter); Settings greys Omni out without it.
  omniPack:()=>detectOmniPack({project,config:omniVoiceConfigs.long}),
  profileKeys:roster.map(profile=>profile.key),
  onState: state => {
    voiceMetricsWriting = voiceMetricsWriting.catch(() => {}).then(() => atomic(resolve(runtime, 'local-voice-state.json'), JSON.stringify(state)));
    return voiceMetricsWriting;
  },
  onLog: message => process.stderr.write('[LocalVoice] ' + message),
});
// A plain api-key=... file is a developer's or a player's own key. A packed file (bridge/key-codec.mjs) is the key the
// release package provides: that one, and only that one, is limited per day (bridge/shared-key-guard.mjs).
const keyFileContent = readKeyFileText(await readFile(keyFile, 'utf8'));
if (!keyFileContent) throw Error('Local Convai key file must contain api-key=...');
const key = keyFileContent.key;
await mkdir(runtime, {recursive: true});
// Which add-ons were found and why any was not loaded, for the game to tell the player (docs/ADDON_API.md). With none, a status
// file an earlier run left is removed and nothing is written. Then the add-on state and settings the game last wrote.
await addonHost.publishStatus(runtime).catch(error => console.error('[Addons] Status not written:', error.message));
for (const read of Object.values(addonHost.watchHandlers(runtime))) await read();
// Each speaker's recent lines and memories of earlier fights or rides (runtime/addon-journal.json); nothing without add-ons.
await addonHost.loadJournal(stateDirectory);
// The key conversations use: the one this installation provides, or the player's own (docs/OWN_CONVAI_KEY.md). It changes
// only at an idle boundary (applyKeyChoice). `quota` remembers a used-up plan for the settings page and the in-game notice.
// The sign-in backend (docs/CONVAI_AUTH_BACKEND.md, auth-backend/): OFF unless CYBERPUNK_CONVAI_AUTH_BACKEND=1 (or convai-auth.json
// says so) and an address and secret are set. When on, the shared account is reached with a short-lived token fetched in the
// background (never on a turn); a player's own key is untouched. If the backend cannot be reached the embedded key stands in
// (CYBERPUNK_CONVAI_AUTH_FALLBACK=0 removes that), reported in this log only.
const authSettings = await readAuthSettings({path: resolve(stateDirectory, AUTH_CONFIG_FILE)});
// The backend sets the daily limit (auth-backend/, POST /api/admin/config). A value that arrives before the guard exists waits here.
let backendDailyLimit = null, turnGuardRef = null;
if (authSettings.problem) console.error(`[CyberpunkConvai] Sign-in backend is off: ${authSettings.problem}`);
const modVersion = await readFile(resolve(project, 'package.json'), 'utf8').then(text => JSON.parse(text).version, () => undefined);
const tokenSource = authSettings.enabled ? new TokenSource({url: authSettings.url, secret: authSettings.secret,
  installId: await loadInstallId({path: resolve(stateDirectory, INSTALL_FILE)}),
  version: typeof modVersion === 'string' && /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(modVersion) ? modVersion : '0.0.0-dev',
  fallback: authSettings.fallback, log: message => console.error('[CyberpunkConvai] ' + message),
  onLimit: value => { backendDailyLimit = value; if (turnGuardRef?.setLimit(value)) console.error(`[CyberpunkConvai] Shared conversation allowance changed by the sign-in backend: ${value} turns a day`); }}) : null;
if (tokenSource) {
  console.error(`[CyberpunkConvai] Conversation sign-in: backend ${new URL(authSettings.url).host}, embedded-key fallback ${authSettings.fallback ? 'on' : 'off'}`);
  tokenSource.start(); // in the background, in parallel with the rest of start-up
}
const keys = await new ConvaiKeys({sharedKey: key, playerKeyPath: resolve(stateDirectory, PLAYER_KEY_FILE),
  playerUserPath: resolve(stateDirectory, PLAYER_USER_FILE), backend: tokenSource}).load();
const quota = new QuotaWatch({keys});
// The conversation provider (docs/MISTRAL.md): Convai, or the player's own free Mistral key for the text of a reply. The key
// is stored in this state folder only and is used for requests to api.mistral.ai and nothing else. The provider in use changes at
// an idle boundary (applyProviderChoice), like the Convai key.
// The fully local AI (docs/LOCAL_AI.md) is the same kind of choice: a text provider that answers through the shared host
// (bridge/text-provider-host.mjs). It is off until the setting names it. A saved setting of 'groq' (a provider removed on 2026-10-14)
// names no provider, so it is the default, Convai (MistralProvider.setPreference); player-groq-key.txt is never read.
const mistral = await new MistralProvider({keyPath: resolve(stateDirectory, MISTRAL_KEY_FILE), inworld: inworldKey}).load();
// The optional Local AI packs (standard and lite) and the supervisor of the model server. Nothing starts here: the server is
// started when the player chooses Local, and stops by itself after ten idle minutes. A developer points CYBERPUNK_CONVAI_LOCAL_AI_DEV
// at a folder of models (docs/LOCAL_AI.md).
let localPack = detectLocalAiPack({project});
// Omni (the OmniVoice pack) loads first and the model tier is chosen from the graphics memory left (docs/LOCAL_AI.md): a wait of
// at most two minutes inside the supervisor, then the tier that fits, else the cloud provider.
const omniSettled = () => localVoice.requestedProvider !== 'omni' || localVoice.provider === 'omni' || localVoice.omniPack?.installed === false;
// Which installed model loads (docs/LOCAL_AI.md, "Choosing the model"): the localModel setting (auto or one model) and Mature content, read
// when a start begins. A change while Local AI is the provider reloads at an idle moment (localModelChoiceChanged, on the settings poll).
let localModelPin = 'auto';
// Models the player added by hand (manifest.custom.json, docs/LOCAL_AI.md "Add your own model"): a few stats and one small JSON read, with
// the GGUF header read only for a file that changed. Looked at on the settings poll (at most every 5 s) and when a model is about to load.
const customScanner = new CustomModelScanner({project, log: message => console.error('[LocalAI] ' + message)});
let customScan = {models: [], problems: []}, cardTotalMiB = null, cardAskedAt = 0;
const scanCustomModels = () => (customScan = customScanner.scan({totalVramMiB: localServer.totalVramMiB ?? cardTotalMiB}));
const localModelSelection = () => { maturePackInstalled(true); return {pin: localModelPin, matureOn: matureContent.enabled, matureModels: maturePackModels, customModels: scanCustomModels().models}; };
const localServer = new LocalLlmServer({pack: localPack, stateFile: resolve(stateDirectory, 'local-ai-state.json'), selection: localModelSelection,
  beforeStart: async () => { for (let waited = 0; !omniSettled() && waited < 120000; waited += 500) await new Promise(done => setTimeout(done, 500)); },
  log: message => console.error('[LocalAI] ' + message)});
scanCustomModels();   // once now; then on the settings poll and when a model is about to load
localServer.on('failed', ({reason}) => mistral.noteLocalFailure(reason));
// A chosen model that is missing, does not fit or did not start: another was used (the event names it), and the game says so once per choice (not at every later start).
let localModelFallbackNoted = '';
localServer.on('model-fallback', ({pin, reason, model}) => {
  const key = pin + '|' + reason;
  if (key === localModelFallbackNoted) return;
  localModelFallbackNoted = key; mistral.noteLocalModelFallback(model);
});
localServer.on('state', () => { try { void mistralControl.publishStatus().catch(() => {}); } catch { /* the control is created further down */ } });
const localEmbedder = new LlamaEmbedder({pack: localPack, log: message => console.error('[LocalAI] ' + message)});
// The pack can be installed while the game runs: look again whenever Local is chosen and while the settings page asks.
let localPackCheckedAt = 0;
function refreshLocalPack(force = false) {
  if (!force && Date.now() - localPackCheckedAt < 5000) return localPack;
  localPackCheckedAt = Date.now();
  const next = detectLocalAiPack({project});
  if (JSON.stringify(next) !== JSON.stringify(localPack)) {
    localPack = next; localServer.pack = next; localServer.command = next.server; localEmbedder.pack = next; localEmbedder.command = next.server;
  }
  return localPack;
}
// The status the settings page shows: ready, warming up, not installed, not enough graphics memory, or unavailable.
function localAiStatus() {
  if (!refreshLocalPack().installed) return 'not-installed';
  const {state, reason} = localServer.status();
  if (state === 'failed') return reason === 'low-memory' ? 'no-memory' : reason === 'not-installed' ? 'not-installed' : 'failed';
  return state === 'starting' || state === 'warming' ? 'warming' : 'ready';
}
// Choosing Local: look for the pack, clear an earlier failure, and load the model in the background so the shader compile of a
// first start is over before the first conversation. A missing pack or a failed start falls back to the cloud provider with one notice.
function prepareLocal() {
  if (!refreshLocalPack(true).installed) { mistral.noteLocalFailure('not-installed'); return; }
  localServer.reset();
  void localServer.ensure({background: true}).catch(() => {});
}
// One memory for the text providers (bridge/memory-store.mjs): the last exchanges and a summary as before (the old Mistral file is
// migrated once), plus lasting records found by the embedding model on the CPU. Without the embedding model it behaves like the old one.
// Background work (summaries, facts) waits for a quiet moment: no combat for 30 s, nothing running or speaking, 20 s since the last turn.
let lastTurnAt = 0, lastFightingAt = 0;
const noteTurn = input => {
  lastTurnAt = Date.now();
  if (input?.battle?.status === 'fighting') lastFightingAt = Date.now();
};
const memoryQuiet = () => !stopped && !active && !streaming && !mic.current && !phone.active && Date.now() - lastTurnAt > 20000 && Date.now() - lastFightingAt > 30000;
const mistralMemory = await MemoryStore.open({dir: resolve(stateDirectory, 'local-memory'), legacyPath: resolve(stateDirectory, MISTRAL_MEMORY_FILE),
  embedder: localEmbedder, gate: memoryQuiet, log: message => console.error('[Memory] ' + message)});
// Daily cap and rate limit for the package's shared key; never applied to a player's own key. CYBERPUNK_CONVAI_DAILY_LIMIT
// sets the cap (a number) or switches the guard off (off); without it only the packaged key is limited, so a development
// checkout with a plain runtime/convai-key.txt is not. The count is saved twice (state folder, user profile), signed.
const dailyLimitPinned = typeof process.env.CYBERPUNK_CONVAI_DAILY_LIMIT === 'string' && process.env.CYBERPUNK_CONVAI_DAILY_LIMIT.trim() !== '';
// With the sign-in backend on, the cap is the backend's number: the last one it told this installation (kept in daily-limit.json), else 100,
// until the first answer arrives. Without the backend, or with the environment variable set, it stays what it was.
const limitStore = tokenSource && !dailyLimitPinned ? new LimitStore({machine: await machineId(), path: resolve(stateDirectory, 'daily-limit.json')}) : undefined;
const dailyLimit = limitFromEnvironment(process.env.CYBERPUNK_CONVAI_DAILY_LIMIT, keyFileContent.packed ? (await limitStore?.load() ?? DAILY_LIMIT) : 0);
const turnGuard = await new SharedKeyGuard({limit: dailyLimit, applies: () => keys.source === 'shared', limitStore, pinned: dailyLimitPinned,
  onLimit: () => { void ownKeyControl?.publishStatus().catch(() => {}); },
  store: dailyLimit > 0 ? new UsageStore({machine: await machineId(), paths: [resolve(stateDirectory, 'daily-usage.json'),
    resolve(process.env.LOCALAPPDATA || homedir(), 'CyberpunkConvai', 'daily-usage.json')]}) : undefined,
  onChange: () => { tokenSource?.noteTurn(); void ownKeyControl?.publishStatus().catch(() => {}); }}).load();
turnGuardRef = turnGuard;
if (backendDailyLimit !== null) turnGuard.setLimit(backendDailyLimit);
// What the hosts ask before a turn: the local gate as before, plus (backend mode only) the backend's own "daily allowance used"
// answer, shown with the same notice. Both are synchronous checks of memory; nothing here touches the network.
const hostGuard = tokenSource ? {check: () => { turnGuard.check(); keys.assertAllowed(); }, consume: () => turnGuard.consume()} : turnGuard;
if (dailyLimit > 0) console.error(`[CyberpunkConvai] Shared conversation allowance: ${dailyLimit} turns a day, ${turnGuard.snapshot()?.left ?? dailyLimit} left today`);
const currentKey = () => keys.current();
// A player's key is a free plan with one conversation connection at a time: no look-ahead, no pre-opened connections.
// With Mistral there is no Convai connection to pre-open or to speculate on either.
const singleSession = () => keys.singleSession || mistral.active;
const keyNotice = () => {
  const keyNotice = keys.takeNotice() ?? mistral.takeNotice({cloudVoice: localVoice.requestedProvider === 'convai'});
  // The fallback notice names the model that was used instead.
  return keyNotice ? {keyNotice, ...(keyNotice === 'local-model-fallback' && mistral.noticeModel ? {keyNoticeModel: mistral.noticeModel} : {})} : {};
};
// The game's notice for a failure (docs/NOTIFICATIONS.md). An automatic reaction that hit the daily cap just stops: no notice.
const keyFailure = (error, input) => {
  // A Mistral failure says what to do about it (key, free limit, model); an automatic reaction (battle, loot) just stops.
  // The local AI that could not start: the next turns use the cloud provider, and the game says so once (local-fallback).
  const errorCode = (input?.reaction ? undefined : isLocalUnavailable(error) ? 'local-fallback' : mistralCodeFor(error))
    ?? quota.codeFor(error, {automatic: !!input?.reaction});
  return errorCode ? {errorCode} : {};
};

const knowledgePack = JSON.parse(await readFile(resolve(project, 'characters/world-knowledge.json'), 'utf8'));
const questCatalog = JSON.parse(await readFile(resolve(project, 'research/cyberpunk/generated/quest-catalog.json'), 'utf8'));
const intrinsicHistory = await loadIntrinsicCharacterContext(project);
if (intrinsicHistory.unavailable.length) console.error('[CyberpunkConvai] Optional intrinsic topic packs unavailable:', intrinsicHistory.unavailable.join(', '));
// One local player ID is shared across all characters and saves. No save facts,
// branch IDs, manual memory archive or provider-ID pool participates in routing.
let worldSession = null, knowledgePolling = false, memoryQuiescing = 0;
const currentBoundary = () => worldSession?.ready === true
  && Date.now() - worldSession.updated < 5000
  ? {worldToken: worldSession.token, generation: worldSession.generation} : null;
const worldCurrent = boundary => {
  const current = currentBoundary();
  return !!current && current.worldToken === boundary.worldToken && current.generation === boundary.generation;
};
// Vendor memory (docs/PLAYER_MEMORY.md): a returning one-shop vendor remembers V. Local and bounded; no provider ID or call.
const vendorMemory = await VendorMemory.open({path: resolve(stateDirectory, 'vendor-memory.json'),
  onWarning: message => console.error('[CyberpunkConvai] Vendor memory: ' + message)});
let playerMemory;
const memoryProvider = new PlayerMemoryApi({key, characterIds: relationshipRoutes.providerIds, markerKeys: relationshipRoutes.markerKeys,
  credential: () => keys.credential(),
  historicalPairAllowed: ({profileKey, characterId}) => playerMemory?.hasContactedProviderPair(profileKey, characterId) === true});
// Backend mode: no key-only call (character list, character read, character update) runs from a player's machine. Ownership is the
// shipped id list; memory is switched on beforehand by scripts/Enable-CharacterMemory.mjs.
if (keys.usesBackend) memoryProvider.use({key, own: false, backend: true});
playerMemory = await PlayerMemory.open({path: resolve(stateDirectory, 'player-memory.json'),
  characterIds: relationshipRoutes.providerIds, characterFamilies: relationshipRoutes.providerFamilies,
  provider: memoryProvider, quiesce: quiescePlayerMemory, retired: providerKey => RETIRED_PROVIDER_KEY.test(providerKey)});
const knowledgeRouter = new PlayerKnowledge({playerMemory, pack: knowledgePack, questCatalog,
  isWorldCurrent: worldCurrent, getBoundary: currentBoundary,
  selectProfile: (profile, boundary) => relationshipRoutes.select(profile, boundary),
  // Off unless the game's decisionLedger setting writes the file (docs/QUEST_DECISIONS.md 4.4); one stat per turn when it does not exist.
  decisionLedger: decisionLedgerReader(resolve(stateDirectory, 'decision-ledger.json'), {readFile: path => readFileSync(path, 'utf8'), statFile: statSync}),
  // Off unless the game's witnessReceipts setting writes the file (docs/QUEST_DECISIONS.md 4.3); one stat per turn when it does not exist.
  witnessReceipts: witnessReceiptsReader(resolve(stateDirectory, 'witness-receipts.json'), {readFile: path => readFileSync(path, 'utf8'), statFile: statSync})});
const phoneKnowledge = new PlayerPhoneKnowledge({router: knowledgeRouter, getBoundary: currentBoundary});
// "Natural speech": the setting, and the display text of every reply with voice tags removed (bridge/natural-speech.mjs).
const naturalSpeech = new NaturalSpeech();
// "Expressive emotions": the character marks its own feelings inline; the marks drive the face (bridge/expressive-emotions.mjs).
const expressiveEmotions = new ExpressiveEmotions();
// The Inworld cloud voice speaks every reply with emotion, so its marks are asked for and kept whatever the player's Expressive emotions
// setting says (docs/CLOUD_VOICE_INWORLD.md). `localVoice` is created above; the function runs per turn, never per frame.
expressiveEmotions.forcedBy = () => localVoice.cloud === 'inworld';
// "Follow-up questions": the character sometimes shows interest in the player inside the reply it is already giving (bridge/follow-up.mjs).
const followUp = new FollowUp();
// Facial emotion selection (bridge/emotion-selector.mjs): player message + reply + character manner + Convai's own
// label; `emotionSelector: "legacy"` in settings.json returns to the reply-only planner.
const emotionSelection = new EmotionSelection();
const cleanReply = result => expressiveEmotions.process(naturalSpeech.process(result));
// "Multilingual conversations": the setting and the language the conversation was last in (bridge/multilingual.mjs).
const multilingual = new MultilingualConversations();
// A player's free plan allows very few memory users. When Convai refuses a new one ("LTM speaker limit reached") the
// turn is repeated with a memory user the account already has, which becomes the player's one id on that key
// (convai-key.mjs, adoptUser; saved, so later sessions reuse it). Only when the account has none to adopt does the turn
// repeat without an end-user identity and the key's conversations go on without long-term memory (a Convai character
// with memory on may refuse those too: "Missing end_user_id"). Nothing is guessed: only that exact refusal does any of
// this, and a different key starts again.
const memoryPolicy = config => keys.memoryBlocked && config ? withoutIdentity(config) : keys.identify(config);
// Sessions opened under another identity belong to it; the transcript the phone shows is not touched.
function retireIdentifiedSessions() {
  sessions.clear(); realtimeSessions.clear();
  void phone.forgetSessions().catch(() => {});
}
function memoryAdopted() {
  retireIdentifiedSessions();
  console.error('[CyberpunkConvai] The key\'s plan has no room for another memory user: conversations use the memory user the account already has');
}
// A path that cannot retry (a voice turn) was refused: the next turn uses the account's memory user, or runs anonymously.
async function adoptOrBlockMemory() {
  const adopted = await keys.adoptUser({refused: keys.memoryUser ?? undefined}).catch(() => null);
  if (adopted) memoryAdopted();
  else if (keys.blockMemory()) memoryBlocked();
}
function memoryBlocked() {
  retireIdentifiedSessions();
  console.error('[CyberpunkConvai] The key\'s plan has no room for another memory user: conversations continue without long-term memory');
  void ownKeyControl.publishStatus().catch(() => {});
}
const keyHostOptions = peers => ({exclusive: {enabled: singleSession, peers, retryMs: 1500},
  // The backend token replaces the key in the config sent to Convai (unchanged without backend mode or with a player's own key).
  credential: config => keys.credentialFor(config),
  onFailure: error => {
    const kind = quota.observe(error);
    if (kind === 'speaker') void adoptOrBlockMemory(); // a path that cannot retry (a voice turn): its next turn uses the account's memory user
    else if (kind === 'memory' && keys.unblockMemory()) void ownKeyControl.publishStatus().catch(() => {});
  },
  onSuccess: () => { quota.succeeded(); keys.settled(); },
  recover: memoryRecovery({keys, classify: classifyFailure, onBlocked: () => memoryBlocked(), onAdopted: () => memoryAdopted()})});
const phoneRealtime = new RealtimeHost({transformReply: cleanReply, guard: hostGuard, ...keyHostOptions(() => [realtime])});
const knowledgeTurns = new Map();
function rememberKnowledgeTurn(prepared) {
  const requestId = prepared.input.requestId || prepared.input.id;
  knowledgeTurns.set(requestId, {prepared, createdAt: Date.now()});
  for (const [id, item] of knowledgeTurns) if (Date.now() - item.createdAt > 180000 || knowledgeTurns.size > 64) knowledgeTurns.delete(id);
}
// exchange: {replyText?, userText?}, what vendor memory stores once the game confirms the reply was heard.
function noteKnowledgeTurn(prepared, exchange) {
  const entry = prepared && knowledgeTurns.get(prepared.input.requestId || prepared.input.id);
  if (entry?.prepared === prepared && exchange) entry.exchange = {...entry.exchange, ...Object.fromEntries(Object.entries(exchange).filter(([, value]) => value !== undefined))};
}
function stagedKnowledgeTurn(prepared, exchange) {
  const entry = knowledgeTurns.get(prepared.input.requestId || prepared.input.id);
  if (entry?.prepared === prepared) { entry.generated = true; noteKnowledgeTurn(prepared, exchange); }
}
async function cancelKnowledgeTurn(prepared) {
  if (!prepared) return;
  const entry = knowledgeTurns.get(prepared.input.requestId || prepared.input.id);
  if (entry?.delivered || entry?.cancelled) return;
  // Lua can finish audible playback and submit the next group speaker in one
  // tick, before the slower delivery poll. Preserve that already-heard reply
  // using the exact game receipt before retiring its request. World/memory
  // validation remains inside recordDelivery/knowledgeRouter.activity.
  if (entry?.generated) {
    const state = await readSpeechState();
    const age = Date.now() - state.updated;
    if (Number.isFinite(state.updated) && Number.isFinite(age) && age >= -1500 && age <= 5000
      && state.lastDelivery?.requestId === prepared.input.requestId) {
      await recordDelivery(state.lastDelivery);
    }
    if (entry.delivered || entry.cancelled) return;
  }
  if (entry) entry.cancelled = true;
  await knowledgeRouter.activity(prepared, 'cancelled-turn').catch(() => {});
}
async function cancelMicrophone() {
  const current = mic.current;
  if (current && companionActions.pending?.packet.requestId === current.requestId) void companionActions.revoke();
  if (current) await cancelKnowledgeTurn(microphoneKnowledge.get(current.requestId));
  await mic.cancel();
  microphoneKnowledge.clear();
  microphoneSpeech.clear();
}

const phoneInput = resolve(runtime, 'phone-chat-input.json');
const phoneOutput = resolve(runtime, 'phone-chat-output.json');
const phoneSessionPath = resolve(stateDirectory, 'phone-sessions.json');
let phoneSessions = {};
try { phoneSessions = JSON.parse(await readFile(phoneSessionPath, 'utf8')) || {}; } catch {}
const phone = new PhoneChat({
  failureCode: error => { const code = mistralCodeFor(error) ?? quota.codeFor(error); return code === 'daily-limit' || /^(mistral|local)-/.test(code ?? '') ? code : isLocalUnavailable(error) ? 'local-fallback' : undefined; },
  contacts: JSON.parse(await readFile(resolve(project, 'characters/phone-contacts.json'), 'utf8')), ids,
  resetFor: profileKey => memoryControl.chatResets.phoneState(profileKey),
  contextFor: options => phoneKnowledge.prepareContext(options),
  contextCurrent: context => phoneKnowledge.current(context),
  contextCurrentSync: context => phoneKnowledge.currentSync(context),
  reply: async options => {
    const prepared = await phoneKnowledge.preparedFor(options);
    preparedInputs.set(prepared.input, prepared);
    if (!await knowledgeRouter.current(prepared)) throw Error('Phone world changed');
    const remote = prepared.remoteConfig || {};
    if (options.characterId !== prepared.guard.characterId
        || options.endUserId !== remote.endUserId || options.scope !== prepared.scope
        || options.sessionKey !== prepared.sessionKey
        || options.remoteGeneration !== playerPhoneGeneration(prepared.guard)) throw Error('Phone memory binding changed');
    phoneWarm.interrupt(options.profileKey);
    const admitted = await admitPlayerConversation(prepared, {signal: options.signal});
    await knowledgeRouter.submitted(prepared);
    throwIfCancelled(options.signal);
    if (!await knowledgeRouter.current(prepared)) throw Error('Phone world changed');
    rememberKnowledgeTurn(prepared);
    void companionActions.revoke();
    const result = await phoneRealtime.reply(phoneWarm.claim(memoryPolicy({key: currentKey(), characterId: options.characterId,
      sessionId: admitted.reconnectRequired ? undefined : options.sessionId,
      scope: prepared.scope, ...remote,
      ...textProviderContext(prepared.input),
      text: options.input.text, ttsEnabled: false, local: localTurn(prepared.input, prepared)}), options.profileKey), {signal: options.signal});
    if (!await knowledgeRouter.current(prepared)) throw Error('Phone world changed');
    await knowledgeRouter.activity(prepared, 'generated-reply', {replyText: result.text});
    stagedKnowledgeTurn(prepared);
    return result;
  },
  publish: (value, options) => atomic(phoneOutput, JSON.stringify(value), options),
  sessions: phoneSessions, saveSessions: value => atomic(phoneSessionPath, JSON.stringify(value)),
});
// First-message latency (bridge/phone-warm.mjs): while a contact's Chat is open and V is still typing, check that
// character's memory and open its text connection, with the same route and transport identity the message will use.
// Never sends anything, writes no memory and creates no session; any failure leaves the old on-demand behaviour.
const phoneWarm = new PhoneWarm({
  enabled: () => !stopped && !memoryQuiescing && !singleSession() && !active && !mic.current && !micPolling
    && !voiceRouteReservation && !relationshipRouteReservation && !phone.active,
  profileFor: contact => phone.profileFor(contact),
  prepare: async (profileKey, {signal}) => {
    const boundary = currentBoundary();
    const route = boundary && knowledgeRouter.configFor(profileKey, 'phone', boundary);
    if (!route || !route.guard || route.providerMemory === 'session-only') return {config: null};
    const memory = await playerMemory.prepareCharacter({profileKey: route.route.providerProfileKey ?? route.route.profileKey,
      guard: route.guard, signal});
    throwIfCancelled(signal);
    // A character whose memory was only just enabled needs its old connection retired first. The message itself does
    // that (admitPlayerConversation); opening a page here would be thrown away.
    if (memory.reconnectRequired) return {config: null};
    const config = memoryPolicy({key: currentKey(), characterId: route.guard.characterId, scope: route.scope,
      ...(route.remoteConfig || {}), ttsEnabled: false});
    const again = currentBoundary() && knowledgeRouter.configFor(profileKey, 'phone', currentBoundary());
    if (!again || again.scope !== route.scope || again.sessionKey !== route.sessionKey) return {config: null};
    // A page that exists already holds a conversation; reconnecting it here could start a different session.
    if ((await phoneRealtime.readiness(config)).present) return {config};
    await phoneRealtime.warm(config, {signal});
    return {config, opened: true};
  },
  keepAlive: config => phoneRealtime.readiness(config, {keepAlive: true}),
  release: config => phoneRealtime.refreshIdle(config),
  onError: error => console.error('[CyberpunkConvai] Phone warm-up:', error.message),
});
let phonePolling = false;
const phoneLaunch = new GameLaunchIdentity({identify: () => identifyGameLaunch(game),
  publish: value => atomic(resolve(runtime, 'phone-game-launch.json'), JSON.stringify(value))});
async function pollPhone() {
  if (phonePolling || stopped || voiceRouteReservation || relationshipRouteReservation) return;
  phonePolling = true;
  try {
    const state = parsePhoneState(await readFile(phoneInput, 'utf8').catch(() => ''));
    await phoneLaunch.update(state).catch(() => {});
    if (stopped) return;
    if (state?.request) {
      // A service restart must not replay a reply already published to the mod.
      let prior; try { prior = JSON.parse(await readFile(phoneOutput, 'utf8')); } catch {}
      if (prior?.world === state.world && prior.id === state.request.id && ['reply', 'error'].includes(prior.state)) {
        state.request = undefined;
      }
    }
    await phone.accept(state);
    phoneWarm.observe(state);
  } finally { phonePolling = false; }
}

const inputPath = resolve(runtime, 'last-input.json');
// Requests name the world and journal parts the game publishes beside them (mod/knowledge-parts.lua); parseInput rebuilds them.
configureKnowledgeParts({runtimeDir: runtime});
const replyPath = resolve(runtime, 'reply.json');
const statusPath = resolve(runtime, 'bridge-status.json');
const prefetchPath = resolve(runtime, 'group-prefetch.json');
const prewarmPath = resolve(runtime, 'conversation-prewarm.json');
const partyPath = resolve(runtime, 'party-connections.json');
const nearbyPath = resolve(runtime, 'nearby-connections.json');
const sessions = new Map();
const realtimeSessions = new Map();
const audioDepot = resolve(game, 'r6/audioware/CyberpunkConvai');
const lipsync = new PhoneticLipsync({project});
const speechStateFile = async () => {
  try { return JSON.parse(await readFile(resolve(runtime, 'speech-state.json'), 'utf8')); } catch { return {}; }
};
// The game's heartbeat file: readSpeechState() reads it (receipts, the watchdog, the speech slots); readSpeechStateCached() answers a turn's
// questions from a read at most 1 s old (bridge/speech-state-cache.mjs).
const speechStateReader = createSpeechStateReader({read: speechStateFile});
const readSpeechState = () => speechStateReader.fresh();
const readSpeechStateCached = () => speechStateReader.cached();
const slots = new SpeechSlots({depot: audioDepot, readState: readSpeechState});
let streamWriting=Promise.resolve(),streaming=0;
function writeStreamManifest(document,current){
  const job=streamWriting.catch(()=>{}).then(async()=>{
    if(await current())await atomic(resolve(runtime,'speech-stream.json'),JSON.stringify(document),
      {isCurrent:current,isCurrentSync:current.sync});
  });streamWriting=job;return job;
}
const companionActions = new CompanionActions({createToken: () => 'drive-' + randomUUID(),
  publish: (packet, options) => atomic(resolve(runtime, 'companion-actions.json'), JSON.stringify(packet), options)});
// "Companions can see" (docs/COMPANION_VISION.md): on by default, Convai only. Every conversation turn carries a recent picture of
// V's surroundings from an in-memory buffer that native/vision fills out of process while someone is near and nobody is talking;
// it is published on the page ahead of the line. companionVision.attachToNextTurn(images) lets other features show the companion
// something (e.g. a TV picture).
const visionLog = message => console.error('[Vision] ' + message);
let speechPlayingAt = 0;
const companionVision = new CompanionVision({capture: new VisionCapture({log: visionLog}), isConvai: () => !mistral.active,
  isNear: () => !connections.stale && (connections.profiles.length > 0 || connections.nearby.length > 0 || connections.partners.length > 0),
  isConversing: () => !!(active || mic.current || micPolling || connections.composer) || Date.now() - speechPlayingAt < 1500,
  stageVoice: images => realtime.stageVoiceVision(images),
  stagePage: (config, images) => realtime.prestageVision(config, images), unstagePage: config => realtime.unstageVision(config),
  // YouTube on V's TV (setScreenSource below): the party's private pages get the video's frames while it plays.
  livePages: () => connections.stale ? [] : connections.profiles.filter(profile => connections.isKnown(profile)).slice(0, 3)
    .map(profile => connections.configFor(profile, 'private')),
  feedPage: (config, image) => realtime.liveVision(config, image), refreshPage: config => realtime.refreshVision(config),
  log: visionLog});
const realtime = new RealtimeHost({onCompanionAction: packet => companionActions.deliver(packet),
  transformReply: cleanReply, guard: hostGuard, vision: companionVision, ...keyHostOptions(() => [phoneRealtime])});
// Mistral route (docs/MISTRAL.md): the same text reply path as Convai, with the persona built from characters/*.json and a small
// local memory. attachMistral makes both hosts answer text turns through it while the provider is Mistral. `localTurn` names
// the character, the channel and (for an ordinary NPC) its conversation, so the host can recall the right history; the Convai path
// never sees it.
// One host serves Mistral and the local AI (bridge/text-provider-host.mjs); `mistral.route` says which answers a turn. The cache
// scope is a hash of the state folder, so the Mistral cache key never carries a secret or a name.
const textRoutes = {
  mistral: mistralRoute({provider: mistral, model: () => MISTRAL_MODELS, decisionModel: () => MISTRAL_DECISION_MODELS, scheduler: mistralScheduler, priorities: PRIORITY, cacheScope: createHash('sha256').update(stateDirectory).digest('hex').slice(0, 12)}),
  local: localRoute({server: localServer, provider: mistral, log: message => console.error('[TextProvider] ' + message)}),
};
const providerOfCharacter = new Map();
const profileOfCharacter = config => {
  if (!providerOfCharacter.size) for (const table of [ids, relationshipRoutes.providerIds ?? {}]) for (const [profile, id] of Object.entries(table)) if (typeof id === 'string') providerOfCharacter.set(id, profile);
  return providerOfCharacter.get(config?.characterId);
};
// The player's own edits of a character (docs/CHARACTER_EDITOR.md): read from disk once here, then a plain lookup on every turn.
const characterOverrides = await CharacterOverrides.open({dir: resolve(stateDirectory, 'character-overrides'), log: message => console.error('[Editor] ' + message)});
const personaBook = new PersonaBook(roster, {overrides: characterOverrides});
// "Mature content": read from the settings file when it changes (never per turn); only the local AI route ever uses it. The optional Mature
// pack (uncensored models) does not gate it: its marker is looked for at most every 5 s, on the settings poll, only so the setting's help text
// can say whether the uncensored models are installed (never per turn or per frame).
const matureContent = new MatureContent();
let maturePackCheckedAt = 0, maturePackModels = [];
function maturePackInstalled(force = false) {
  if (force || Date.now() - maturePackCheckedAt >= 5000) {
    maturePackCheckedAt = Date.now();
    const found = detectMaturePack({project});
    maturePackModels = found.installed ? found.models : [];
    matureContent.setPack(found.installed);
  }
  return matureContent.pack;
}
maturePackInstalled(true);
const mistralHost = new TextProviderHost({provider: mistral, memory: mistralMemory, personas: personaBook, routes: textRoutes, matureContent,
  transformReply: cleanReply, gate: memoryQuiet, resolveProfile: profileOfCharacter, log: message => console.error('[TextProvider] ' + message),
  // A companion action the reply asked for ("[DRIVE]", bridge/text-actions.mjs) reaches the game the way a Convai action does.
  deliverAction: message => companionActions.deliver(message)});
// The hook for local speech recognition (bridge/local-stt.mjs and local-stt-capture.mjs; docs/LOCAL_STT.md). While Mistral is the
// provider the voice key needs it: `available()` says whether this computer can recognise speech, `voiceChannel({reply})` returns
// a channel (beginVoice / finishVoice / heard / close, like RealtimeHost.voiceChannel) whose finished recording is answered
// through `reply(config)`. Without it the voice key tells the player that voice needs Convai for now. The recogniser worker runs
// only during and just after a recording; the Convai microphone route never touches it.
const mistralSpeech = createLocalSpeech({
  stt: new LocalStt({project, pythonExecutable: voiceConfig.runtime?.pythonExecutable}),
  capture: new LocalSttCapture({getBrowser: hostBrowser(realtime)}),
  // The input device, its level and the words (or why they were ignored) of every recording, one line each.
  log: line => console.error('[CyberpunkConvai] Microphone: ' + line)});
// Two side by side: the action decision and the reply of one turn are two requests at once (bridge/mistral-client.mjs, warmConnection).
const warmTurnConnections = options => warmConnection({...options, connections: 2});
for (const host of [realtime, phoneRealtime]) attachTextProvider(host, {provider: mistral, mistral: mistralHost, speech: mistralSpeech, prewarmVoice: () => host === realtime && localVoice.playbackEnabled !== false, warmCloud: warmTurnConnections});
// Add-on speakers (docs/ADDON_API.md) answer only through Mistral or the local AI, whatever the player's conversation provider is:
// one text host per route (and whether the local AI may fall back to Mistral), made the first time an add-on speaker needs it. They
// share the routes (one pacing per Mistral key), the persona book and the memory store; none exists without add-ons.
const addonTextHosts = new Map();
function addonTextHost(route, profileKey) {
  const allowsMistral = route === 'local' && addonHost.routeFor(profileKey, {applied: 'mistral', mistralKey: true}) === 'mistral';
  const cacheKey = `${route}:${allowsMistral}`;
  let host = addonTextHosts.get(cacheKey);
  if (!host) {
    host = new TextProviderHost({provider: fixedProvider(mistral, route), memory: sharedMemory(mistralMemory), personas: personaBook,
      routes: {[route]: textRoutes[route], ...(allowsMistral ? {mistral: textRoutes.mistral} : {})}, transformReply: cleanReply, gate: memoryQuiet,
      // The hard-limit guard (never the crude Mature persona layer) for an add-on speaker too: with the Mature setting on or an uncensored model loaded.
      matureContent, guardOnly: true,
      log: message => console.error('[Addons] ' + message)});
    addonTextHosts.set(cacheKey, host);
  }
  return host;
}
// What an add-on speaker's turn may use right now: the player's provider, a saved Mistral key that was not refused, a working Local AI pack.
const addonRouteState = () => {
  const local = addonHost.active ? localAiStatus() : 'not-installed';
  return {applied: mistral.applied, mistralKey: !!mistral.apiKey && mistral.limit?.kind !== 'invalid',
    localReady: !['not-installed', 'no-memory', 'failed'].includes(local)};
};
// The game asked to warm a speaker (handle:prepare): open the Mistral connection, or load the speaker's prompt into the local AI.
addonHost.onWarm = profileKey => {
  const route = addonHost.routeFor(profileKey, addonRouteState());
  if (route === 'mistral') void warmConnection({provider: 'mistral'}).catch(() => {});
  else if (route === 'local') void addonTextHost(route, profileKey).prewarm({local: {profileKey}});
};
function localTurn(input, prepared = preparedInputs.get(input)) {
  const route = prepared ?? routeFor(input);
  const channel = route?.route?.channel ?? (input.channel === 'phone' ? 'phone' : input.group ? 'group' : 'private');
  const ambient = isAmbientProfile(input.profileKey);
  return {profileKey: input.profileKey, name: profileFor(input, roster)?.name ?? input.name, channel,
    ...(ambient ? {ambientKey: route?.sessionKey ?? `${input.profileKey}:${input.entity ?? ''}`} : {})};
}
let observed = '', observedIdentity = null;
let lastAcceptedIdentity = '';
let polling = false, active = null, stopped = false;
let prefetchPolling = false, prefetchObserved = '', partyObserved = '', partyWasFresh = false;
let prewarmObserved = await readFile(prewarmPath, 'utf8').catch(() => '');
const latency = new Map();
// One TurnClock per request (bridge/turn-clock.mjs): the moment every stage of the turn was reached. `measure` writes its snapshot
// into the turn's record (`stages`) each time the record is written. Bounded like the records.
const turnClocks = new Map();
let metricsWriting = Promise.resolve();
let connectionMetricsWriting = Promise.resolve();

const preparedInputs = new WeakMap();
const intrinsicConversationContext = createIntrinsicConversationContext({baseContext: baseConversationContext, baseBlocks: baseConversationBlocks,
  intrinsic: intrinsicHistory, resolveAdmission: input => preparedInputs.get(input),
  isCurrentSync: prepared => knowledgeRouter.currentSync(prepared)});
// Natural speech: the devices the CURRENT voice engine can render, for spoken replies only. Phone chat is text,
// battle and loot reactions are short barks, and the Convai cloud voice cannot follow it (it would read tags aloud).
// The voice of each turn (bridge/multilingual.mjs). Decided once per submitted turn, the first time it is needed, so
// the context (tags or none), the Convai TTS flag and the delivery all agree. With Multilingual conversations off it
// is exactly the character's chosen voice; on (Settings keep the voice on OmniVoice or the cloud voice), a turn in
// another language never reaches Pocket, and a cloud-voice turn never gets tag instructions.
const turnVoices = new Map();
// A cloud voice with no key speaks nothing, so its turns go to the Convai cloud voice (a written reply under the Mistral provider,
// which has no Convai audio); the cloud voices load no local model, so no local voice is ever the fallback.
const localChoice = profile => ({uses: localVoice.usesProfile(profile) && !localVoice.cloudKeyless, provider: localVoice.provider});
function turnVoice(input) {
  const id = input?.requestId || input?.id, cacheKey = id ? JSON.stringify([id, input.profileKey]) : null;
  if (cacheKey && turnVoices.has(cacheKey)) return turnVoices.get(cacheKey);
  const profile = input.profileKey;
  const plan = planTurnVoice({enabled: multilingual.enabled,
    language: multilingual.enabled ? multilingual.expected(input.reaction ? '' : input.text) : 'en',
    local: localChoice(profile)});
  if (cacheKey) {
    turnVoices.set(cacheKey, plan);
    while (turnVoices.size > 64) turnVoices.delete(turnVoices.keys().next().value);
  }
  return plan;
}
const turnUsesLocal = input => turnVoice(input).engine !== 'convai';
// One line per spoken reply: the voice chosen, the voice that spoke and why they differ (bridge/voice-routing-log.mjs).
// Routing facts only, no dialogue; the file append is queued off the speech path. Never allowed to affect a reply.
function logVoiceRoute(input, profile, reply, extra = {}) {
  try {
    // The local voice that speaks (a variant of an ambient profile, decided once per turn); the profile key otherwise.
    const voiceKey = ['pocket', 'omni'].includes(reply?.engine) && typeof voiceKeyFor === 'function' ? voiceKeyFor(input) : undefined;
    // The Convai character the turn went to (the original or its multilingual twin).
    let character;
    try {
      const route = routeFor(input), characterId = route?.guard?.characterId;
      if (characterId) character = {key: route.route?.providerProfileKey ?? input.profileKey, id: characterId};
    } catch {}
    routingLog.record(describeVoiceRoute({voice: localVoice, input, profile, plan: turnVoice(input), reply,
      sources: voiceSources, voiceKey, character, ...extra}));
  } catch {}
}
// The local voice that speaks this turn: an ambient profile (unnamed NPC) may have several (bridge/voice-variants.mjs),
// chosen from the NPC's stable identity. Decided once per turn (the same turn's phrases, look-ahead and prefetch agree)
// and only when it is spoken; routing, readiness and the provider keep using the BASE profile key.
const turnVoiceKeys = new Map();
function voiceKeyFor(input) {
  const profile = input.profileKey, id = input?.requestId || input?.id;
  const cacheKey = id ? JSON.stringify([id, profile]) : null, provider = localVoice.provider;
  const cached = cacheKey ? turnVoiceKeys.get(cacheKey) : undefined;
  if (cached?.provider === provider) return cached.key;
  const key = localVoice.voiceKeyFor?.(profile, variantSeed(input)) ?? profile;
  if (cacheKey) {
    turnVoiceKeys.set(cacheKey, {provider, key});
    while (turnVoiceKeys.size > 64) turnVoiceKeys.delete(turnVoiceKeys.keys().next().value);
  }
  return key;
}
// Warm connections are prepared before any text exists: they follow the language of the last exchange.
const warmUsesConvaiVoice = profile => localVoice.playbackEnabled !== false && planTurnVoice({enabled: multilingual.enabled,
  language: multilingual.lastLanguage ?? 'en', local: localChoice(profile)}).engine === 'convai';
const routingLog = new VoiceRoutingLog({path: resolve(runtime, ROUTING_LOG_NAME)});
const voiceSources = {pocket: voiceConfig, omni: omniVoiceConfigs};
// Whether the Natural speech block went into the latest context built for each turn (for the log line below).
const naturalSpeechBlocks = new Map();
// The engine whose sounds Natural speech offers: the Inworld cloud voice uses Pocket's route but renders its own list of sounds.
const soundEngine = engine => engine === 'pocket' && localVoice.cloud === 'inworld' ? 'inworld' : engine;
const naturalSpeechContext = input => {
  const prepared = preparedInputs.get(input);
  const phone = input.channel === 'phone' || prepared?.route?.channel === 'phone';
  const spoken = !phone && !input.reaction && localVoice.playbackEnabled !== false;
  const engine = soundEngine(turnVoice(input).engine);
  const block = naturalSpeech.contextFor({engine, spoken, sessionId: realtimeSessions.get(sessionKey(input)),
    turn: input?.requestId || input?.id, trait: traitFor(input.profileKey), profile: input.profileKey,
    name: profileFor(input, roster)?.name, language: turnVoice(input).language});
  const id = input?.requestId || input?.id;
  if (id) {
    naturalSpeechBlocks.set(id, block !== '');
    while (naturalSpeechBlocks.size > 64) naturalSpeechBlocks.delete(naturalSpeechBlocks.keys().next().value);
  }
  return block;
};
// One line per spoken reply, so Natural speech can be verified without the game: the setting, the engine that speaks,
// whether the instructions went into this turn's context, and which devices (tags, pauses, fillers) the reply used.
// Routing facts only, no dialogue.
function logNaturalSpeech(input, result) {
  try {
    if (!naturalSpeech.enabled && !naturalSpeechBlocks.get(input?.requestId || input?.id)) return;
    const devices = result.naturalDevices ?? [], blockSent = naturalSpeechBlocks.get(input?.requestId || input?.id);
    console.error(`[NaturalSpeech] profile=${input.profileKey} engine=${turnVoice(input).engine} setting=${naturalSpeech.enabled ? 'on' : 'off'} `
      + `block=${blockSent ? 'sent' : 'none'} offered=${blockSent ? 'yes' : 'no'} reason=${naturalSpeech.reasonFor(input?.requestId || input?.id) ?? 'not-spoken'} devices=${devices.length ? devices.join(',') : '-'}`
      + `${result.speechText ? ' voiced-tags=yes' : ''}${input.reaction ? ' reaction=yes' : ''}`);
  } catch { /* a log line never affects a reply */ }
}
// Expressive emotions: spoken turns on a local voice, battle and loot barks included (they have a face). Not phone chat.
const expressiveEmotionsContext = input => {
  const prepared = preparedInputs.get(input);
  const phone = input.channel === 'phone' || prepared?.route?.channel === 'phone';
  const engine = turnVoice(input).engine;
  return expressiveEmotions.contextFor({engine, spoken: !phone && localVoice.playbackEnabled !== false});
};
// Follow-up questions: a short paragraph on the share of turns the bridge decides (bridge/follow-up.mjs). It only shapes the
// reply already being generated for this turn: no extra request, timer or turn. Off, nothing is read and nothing is added.
const followUpContext = input => {
  if (!followUp.enabled) return '';
  return followUp.contextFor({sessionId: sessionKey(input), turn: input?.requestId || input?.id, trait: traitFor(input.profileKey),
    text: input.text, reaction: !!input.reaction, battle: input.battle, group: !!input.group});
};
// One line per reply while the setting is on: whether a pull was offered and why, and whether the reply ended in a question
// (so the effect can be checked without the game). The reply's ending is also remembered: no pull right after a question.
// Routing facts only, no dialogue.
function logFollowUp(input, result) {
  try {
    const turn = input?.requestId || input?.id;
    if (!followUp.enabled && followUp.reasonFor(turn) === undefined) return;
    const asked = followUp.record(sessionKey(input), result?.text);
    console.error(`[FollowUp] profile=${input.profileKey} setting=${followUp.enabled ? 'on' : 'off'} offered=${followUp.offeredFor(turn) ? 'yes' : 'no'} `
      + `reason=${followUp.reasonFor(turn) ?? 'not-spoken'} ended-with-question=${asked ? 'yes' : 'no'}`);
  } catch { /* a log line never affects a reply */ }
}
// V's voice for typed lines (bridge/v-voice.mjs, docs/V_VOICE.md): the player's typed line is also spoken in V's cloned voice, by the voice
// the player chose (Pocket and OmniVoice locally, Mistral and Inworld in the cloud; never the Convai cloud voice, never a local model
// beside a cloud voice). It runs beside the companion's reply and never delays it. The plan for V's key is made the same way as a
// character's (localChoice), so a cloud voice with no key, or a language the voice cannot speak, simply gives no V line.
const vVoice = new VVoice({voices: vVoiceReferences.voices, log: line => console.error('[VVoice] ' + line),
  planFor: (input, key) => planTurnVoice({enabled: multilingual.enabled,
    language: multilingual.enabled ? multilingual.expected(input.text) : 'en', local: localChoice(key)}),
  // Voice playback Off silences the companions, not V: with the V setting on his line is spoken (docs/RESOURCE_LIFECYCLE.md).
  ready: key => localVoice.usesProfile(key),
  isLocal: () => !localVoice.cloudActive,
  stream: (key, text, options) => localVoice.synthesizeStream(key, text, options),
  render: (key, text, options) => localVoice.synthesize(key, text, options),
  prepare: (key, options) => localVoice.prepareProfile(key, options),
  play: (config, producer, options) => realtime.playVoiceLine(config, producer, options),
  warm: options => realtime.prewarmVoiceLine(options),
  // Beside OmniVoice, V's line is spoken by a Pocket worker of its own on the CPU (bridge/v-helper-voice.mjs), never rendered on
  // OmniVoice's one GPU worker. It is loaded in the background while the OmniVoice voice is committed and the setting is on.
  helper: {speaks: key => localVoice.vHelperSpeaks(key), ready: key => localVoice.vHelperReady(key),
    stream: (key, text, options) => localVoice.vHelperStream(key, text, options),
    prepare: (key, options) => localVoice.vHelperPrepare(key, options)},
  // One log line and one record per V line: what happened and when (V's own stage clock), no dialogue.
  report: (input, summary) => {
    try {
      console.error(`[VVoice] profile=${input.profileKey} voice=${summary.voice} engine=${summary.engine} result=${summary.result}`
        + `${summary.reason ? ' reason=' + summary.reason : ''} marks=${JSON.stringify(summary.marks)}`);
      void measure(input, {vVoice: summary}).catch(() => {});
    } catch { /* a log line never affects a reply */ }
  }});
// A returning shopkeeper's memory of V (bridge/vendor-memory.mjs): only private text/voice turns of a one-shop vendor.
const vendorMemoryContext = prepared => {
  const key = vendorMemoryKey(prepared);
  return key ? vendorMemory.contextFor({memoryKey: key, profileKey: prepared.route.profileKey}) : '';
};
// The blocks of a turn's context in the order Convai gets them, each tagged by how often it changes (see conversationContextBlocks in
// bridge/quest-context.mjs). Convai gets them joined in this order; the text providers (Mistral, local) lay them out stable to
// volatile (bridge/mistral-prompt.mjs, layout v2) so a prefix cache keeps working.
// YouTube on V's TV (docs/YOUTUBE_TV.md): set up with the other settings controls below; null until then.
let youtubeTv = null;
const conversationBlocks = input => {
  const prepared = preparedInputs.get(input), admitted = prepared && knowledgeRouter.currentSync(prepared);
  const block = (tier, text) => ({tier, text});
  return [...intrinsicConversationContext.blocks(input), block('world', archetypeContext(input)),
    block('world', admitted ? vendorMemoryContext(prepared) : ''),
    // Add-on context (docs/ADDON_API.md): an add-on speaker's own blocks, or what the add-ons tell companions; none without add-ons.
    ...addonHost.blocks(input),
    // YouTube on V's TV: while a video is open, a companion with V in person knows what they are watching (bridge/youtube-tv.mjs).
    block('volatile', youtubeTv ? youtubeTv.contextFor(input, {ambient: isAmbientProfile(input.profileKey),
      voice: addonHost.usesVoiceContext(input.profileKey)}) : ''),
    block('world', admitted ? relationshipContext(prepared.relationship, prepared.route.channel,
      {group: prepared.input.group, audience: prepared.route.audience,
        worldToken: prepared.worldToken, generation: prepared.generation}) : ''),
    block('volatile', admitted && prepared.route.channel === 'phone' ? phoneRecentConversationContext(prepared.input) : ''),
    // Follow-up questions go before the voice notes: after "keep the same length and content" they lost most of their effect
    // (scripts/Probe-FollowUp.mjs: a pull in 16 of 26 offered turns here, against 13 of 41 after them). The one-sentence
    // first-person reminder goes after the voice blocks, which pull a reply away from the base rule (docs/FIRST_PERSON_RULE.md).
    block('volatile', followUpContext(input)),
    // The Natural speech offer changes from turn to turn (it is dice and a place), so it is volatile; the Expressive emotion
    // notes are the same every turn for a given setting.
    block('volatile', naturalSpeechContext(input)), block('notes', expressiveEmotionsContext(input)),
    block('volatile', firstPersonReminder(input)),
    // Multilingual conversations: the reply language, last so it outweighs the English notes above.
    block('volatile', multilingual.contextFor(input.reaction ? '' : input.text))];
};
const joinedContext = blocks => blocks.map(item => item.text).filter(Boolean).join('\n\n');
const conversationContext = input => joinedContext(conversationBlocks(input));
// {now, notes, world, volatile} for the text providers' prompt layout; only built while one of them answers.
// `worldBlocks` lists the world blocks one by one (with their keys) so a small context can cut them in order of priority.
const contextPartsOf = blocks => ({...Object.fromEntries(['now', 'notes', 'world', 'volatile']
  .map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))])),
  worldBlocks: blocks.filter(item => item.tier === 'world' && item.text).map(item => ({key: item.key, text: item.text}))});
const textProviderContext = input => {
  noteTurn(input);
  const blocks = conversationBlocks(input);
  return {context: joinedContext(blocks), ...(mistral.active ? {contextParts: contextPartsOf(blocks)} : {})};
};
const boundaryFor = input => ({entity: input?.entity,
  worldToken: input?.worldKnowledge?.worldToken || worldSession?.token,
  generation: input?.worldKnowledge?.generation || worldSession?.generation});
const routeFor = input => preparedInputs.get(input)
  || knowledgeRouter.configFor(input.profileKey, conversationScope(input), boundaryFor(input));
const sessionKey = input => routeFor(input)?.sessionKey || JSON.stringify(['unavailable', input.profileKey, input.requestId]);
const completeContext = input => JSON.stringify([conversationContext(input), routeFor(input)?.guard?.characterId, realtimeSessions.get(sessionKey(input)) || null,
  turnUsesLocal(input) ? 'local' : 'convai']);
const realtimeConfig = input => memoryPolicy({key: currentKey(), characterId: routeFor(input)?.guard?.characterId, sessionId: realtimeSessions.get(sessionKey(input)),
  scope: routeFor(input)?.scope || conversationScope(input), ...(routeFor(input)?.remoteConfig || {}),
  ...textProviderContext(input), text: battleTrigger(input), reaction: input.reaction,
  companionAction: companionActions.configFor(input), local: localTurn(input),
  ...(companionVision.active && typeof input.requestId === 'string' ? {visionTurn: input.requestId} : {}),
  ttsEnabled: localVoice.playbackEnabled!==false&&!turnUsesLocal(input)});
const warmRoute = (profile, scope) => memoryQuiescing ? null : knowledgeRouter.configFor(profile, scope,
  {worldToken: worldSession?.token, generation: worldSession?.generation});
// The exact private route of one physical ambient NPC (a generic resident or npc-* archetype has no route without
// its entity). It has the transport identity of the turn later submitted to that NPC, so the page warmed while V
// types or looks at the NPC is the page that turn uses (docs/NPC_ARCHETYPES.md, "Latency").
const ambientWarmConfig = (profile, entity) => {
  if (memoryQuiescing || !isAmbientProfile(profile) || typeof entity !== 'string') return null;
  const route = knowledgeRouter.configFor(profile, 'private', {entity, worldToken: worldSession?.token, generation: worldSession?.generation});
  return route ? memoryPolicy({key: currentKey(), characterId: route.guard.characterId, scope: route.scope, ...(route.remoteConfig || {}),
    sessionId: realtimeSessions.get(route.sessionKey), ttsEnabled: warmUsesConvaiVoice(profile)}) : null;
};
const connections = new PartyConnections({host: realtime,
  canWarm: () => !stopped && !memoryQuiescing && !active && !mic.current && !micPolling && !lookahead.busy,
  // A single-session plan (own key) warms nothing in the background; only an invitation opens its companion's connection.
  deferWarm: singleSession,
  isKnown: profile => Object.hasOwn(ids, profile) && !!warmRoute(profile, 'private'),
  configFor: (profile, scope) => {
    const route = warmRoute(profile, scope);
    if (!route) throw Error('No current world for conversation warmup');
    return memoryPolicy({key: currentKey(), characterId: route.guard.characterId, scope: route.scope, ...(route.remoteConfig || {}),
      sessionId: realtimeSessions.get(route.sessionKey), ttsEnabled: warmUsesConvaiVoice(profile)});
  },
  onState: state => {
    connectionMetricsWriting = connectionMetricsWriting.catch(() => {}).then(() => atomic(resolve(runtime, 'party-connection-state.json'), JSON.stringify(state)));
    return connectionMetricsWriting;
  },
});
// The conversation pages a composer hint is about to use (its target's private page, or each speaker's group page), for staging
// the surroundings picture ahead of the line. Empty while vision is not active.
function composerPages(hint, config) {
  if (!companionVision.active) return [];
  try {
    if (hint.scope === 'private') return [config ?? connections.configFor(hint.audience[0], 'private')];
    return hint.audience.filter(profile => connections.isKnown(profile)).slice(0, 3).map(profile => connections.configFor(profile, hint.scope));
  } catch { return []; }
}
// "Auto-connect nearby characters": the game lists up to two characters it is looking at or
// standing near; their connection and local voice are prepared ahead (bridge/nearby-warm.mjs).
const nearbyWarm = new NearbyWarm({connections, isKnown: profile => Object.hasOwn(ids, profile), routeFor: ambientWarmConfig,
  canPrepare: () => !stopped && !memoryQuiescing && !active && !mic.current && !micPolling && !lookahead.busy
    && !voiceRouteReservation && !relationshipRouteReservation && !localVoice.pending && !localVoice.availabilityPending,
  prepareVoice: (profile, options) => localVoice.prepareProfile(profile, options),
  onError: error => console.error('[CyberpunkConvai] Nearby warm-up:', error.message)});
let voiceRouteSync = Promise.resolve();
// A warm connection's Convai TTS flag follows warmUsesConvaiVoice; when that changes (the setting, the language of
// the conversation), the page is replaced at the next idle boundary.
const warmVoices = new Map();
function refreshWarmVoices() {
  for (const profile of localVoice.routeKeys) {
    const next = warmUsesConvaiVoice(profile), previous = warmVoices.get(profile);
    warmVoices.set(profile, next);
    if (previous !== undefined && previous !== next) voiceRoutePending.set(profile, localVoice.routeRevision);
  }
}
const voiceRoutePending = new Map();
let voiceRouteReservation = false;
const voiceRouteWaiters = new Set();
let relationshipRouteSync = Promise.resolve(), relationshipRouteReservation = false;
const relationshipRoutePending = new Map();
function voiceBoundaryBusy() {
  return !!(active || streaming || polling || micPolling || mic.current || prefetchPolling || memoryQuiescing
    || phone.active || relationshipRouteReservation || lookahead.busy);
}
// Read-only observability for the Relationships setting: which profile variant
// the next turn of each supported character will use, and why. Rewritten only
// when a decision changes. It never contains provider IDs or native values.
let relationshipRoutesPublished = '';
function publishRelationshipRoutes() {
  const routes = relationshipRoutes.describe(currentBoundary()), signature = JSON.stringify(routes);
  if (signature === relationshipRoutesPublished) return;
  relationshipRoutesPublished = signature;
  void atomic(resolve(runtime, 'relationship-routing.json'), JSON.stringify({version: 1, updated: Date.now(), routes}))
    .catch(() => { relationshipRoutesPublished = ''; });
}
function syncRelationshipRoutes() {
  for (const profile of relationshipRoutes.consumeRouteChanges()) relationshipRoutePending.set(profile, relationshipRoutes.revision);
  if (relationshipRouteReservation) return relationshipRouteSync;
  if (!relationshipRoutePending.size || voiceBoundaryBusy() || voiceRouteReservation) return Promise.resolve();
  // A distinct reservation prevents an input from entering while old-ID pages
  // are being retired. Voice-quality/TTS changes keep their own namespace.
  relationshipRouteReservation = true;
  const operation = (async () => {
    try {
      while (relationshipRoutePending.size) {
        if (stopped) throw Error('Conversation service is closed');
        const changes = [...relationshipRoutePending];
        await retireRelationshipConnections(connections, changes.map(([profile]) => profile));
        prewarmObserved = ''; // A cleared completed request may have held the composer focus.
        for (const [profile, revision] of changes) {
          if (relationshipRoutePending.get(profile) === revision) relationshipRoutePending.delete(profile);
        }
      }
    } finally { relationshipRouteReservation = false; }
  })();
  operation.catch(() => {}); relationshipRouteSync = operation;
  return operation;
}
function settleVoiceRouteWaiters(error) {
  if (!error && voiceRoutePending.size) return;
  for (const waiter of voiceRouteWaiters) error ? waiter.reject(error) : waiter.resolve();
  voiceRouteWaiters.clear();
}
function syncVoiceRoutes({wait = false, signal} = {}) {
  throwIfCancelled(signal);
  if (stopped) return Promise.reject(Error('Voice service is closed'));
  for (const profile of localVoice.consumeRouteChanges()) voiceRoutePending.set(profile, localVoice.routeRevision);
  if (voiceRouteReservation) return abortable(voiceRouteSync, signal);
  if (!voiceRoutePending.size) { settleVoiceRouteWaiters(); return Promise.resolve(); }
  if (voiceBoundaryBusy()) {
    // Settings polling must remain free to retry after the current turn. Only
    // a background Invite waits for this event-driven page settlement.
    if (!wait) return Promise.resolve();
    let waiter;
    const pending = new Promise((resolve, reject) => { waiter = {resolve, reject}; voiceRouteWaiters.add(waiter); });
    return abortable(pending, signal).finally(() => voiceRouteWaiters.delete(waiter));
  }
  // Reserve synchronously before the first await. New text/microphone input
  // retains its IPC file and is admitted after this phase releases ownership.
  voiceRouteReservation = true;
  const operation = (async () => {
    try {
      while (voiceRoutePending.size) {
        if (stopped) throw Error('Voice service is closed');
        const changes = [...voiceRoutePending];
        // Reconnect only affected TTS pages, retaining committed memory/session
        // identities. New revisions remain queued while this reservation drains.
        await connections.reconfigure(changes.map(([profile]) => profile));
        for (const [profile, revision] of changes) {
          if (voiceRoutePending.get(profile) === revision) voiceRoutePending.delete(profile);
        }
      }
      settleVoiceRouteWaiters();
    } catch (error) {
      settleVoiceRouteWaiters(error); throw error;
    } finally { voiceRouteReservation = false; }
  })();
  // Observe failures even if a cancelled invitation no longer awaits this job.
  operation.catch(() => {});
  voiceRouteSync = operation;
  return abortable(operation, signal);
}
function invitedVoiceCurrent(profile, receipt) {
  if (stopped || receipt?.ready !== true || localVoice.pending || localVoice.availabilityPending
      || voiceRouteReservation || voiceRoutePending.size) return false;
  if (receipt.provider === 'convai') return !localVoice.usesProfile(profile);
  // Playback Off: the worker was released and none is waited for (bridge/voice-selection.mjs, prepareProfile `muted`).
  if (receipt.muted === true) return localVoice.playbackEnabled === false && receipt.provider === localVoice.provider && localVoice.usesProfile(profile);
  return receipt.provider === localVoice.provider && ['pocket','omni'].includes(receipt.provider) && receipt.profile === profile
    && localVoice.usesProfile(profile) && localVoice.profileReady(profile);
}
async function prepareInvitedVoice(profile, {signal} = {}) {
  for (;;) {
    throwIfCancelled(signal);
    if (stopped) throw Error('Voice service is closed');
    const receipt = await localVoice.prepareProfile(profile, {signal});
    if (receipt?.ready !== true || !['convai','pocket','omni'].includes(receipt.provider)
        || (receipt.provider !== 'convai' && receipt.profile !== profile)) {
      throw Error('Local voice readiness could not be verified');
    }
    await abortable(syncVoiceRoutes({wait: true, signal}), signal);
    throwIfCancelled(signal);
    if (stopped) throw Error('Voice service is closed');
    // A settings change can commit while page retirement is awaiting its host.
    // Recheck the actual route before authorizing this invitation's connection.
    if (receipt.muted === true && localVoice.playbackEnabled === false) {
      if (receipt.provider !== localVoice.provider || !localVoice.usesProfile(profile)) continue;
    } else if (receipt.provider !== 'convai') {
      if(receipt.provider!==localVoice.provider)continue;
      if (!localVoice.usesProfile(profile) || !localVoice.profileReady(profile)) continue;
    } else if (localVoice.usesProfile(profile)) continue;
    return receipt;
  }
}
const invitations = new CompanionInvitations({memory: relationshipRoutes.invitationMemory(playerMemory, currentBoundary), connections,
  prepareVoice: prepareInvitedVoice,
  voiceCurrent: invitedVoiceCurrent,
  routeCurrent: (profile, guard) => !relationshipRouteReservation && !relationshipRoutePending.size
    && relationshipRoutes.guardSelected(profile, guard, currentBoundary()),
  currentWorld: currentBoundary,
  isKnown: profile => Object.hasOwn(ids, profile),
  isCurrentGuard: guard => playerMemory.isCurrent(guard),
  publish: (value, options) => atomic(resolve(runtime, 'companion-invitations-state.json'), JSON.stringify(value), options),
});

function measure(input, values) {
  const previous = latency.get(input.requestId) || {requestId: input.requestId, profile: input.profileKey, groupIndex: input.group?.index};
  const clock = turnClocks.get(input.requestId);
  latency.set(input.requestId, {...previous, ...values, ...(clock ? {stages: clock.snapshot()} : {})});
  while (latency.size > 24) latency.delete(latency.keys().next().value);
  while (turnClocks.size > 24) { turnClocks.get(turnClocks.keys().next().value)?.stop(); turnClocks.delete(turnClocks.keys().next().value); }
  // No dialogue, API keys or character session IDs are written to metrics.
  metricsWriting = metricsWriting.catch(() => {}).then(() => atomic(resolve(runtime, 'bridge-latency.json'), JSON.stringify({
    version: 1, updated: Date.now(), turns: [...latency.values()],
  })));
  return metricsWriting;
}
// A record update the turn does not wait for (the writes still go out in order). The ones before the model request used to be
// awaited, so every turn waited for two file replacements (each a write and a rename, 5 to 60 ms on a busy disk) before asking
// the model anything.
const note = (input, values) => { void measure(input, values).catch(() => {}); };
const turnMark = (requestId, name, at) => { turnClocks.get(requestId)?.mark(name, at); };
// The reply reached the game: the turn's clock stops watching the event loop.
const markPublished = (requestId, at) => { const clock = turnClocks.get(requestId); clock?.mark('published', at); clock?.stop(); };

const prefetch = new GroupPrefetch({prepare: async (input, {signal}) => {
  // The SDK has no session fork/rollback. Existing sessions are warm-only so
  // cancelled predictions cannot alter memory or erase conversation history.
  if (realtimeConfig(input).endUserId || realtimeSessions.has(sessionKey(input))) throw Error('Identified or existing character session is warm-only');
  if (singleSession()) throw Error('A single-session plan cannot run a speculative turn');
  // Local speech belongs to the submitted turn's game admission, never a
  // predicted future turn. The cached result remains text until respond().
  return {...await realtime.prepare(realtimeConfig(input), {signal}), transport: 'realtime'};
}});
// Speaker N+1 of a group round is generated while N is still audible, then held
// until the game submits that exact turn (docs/GROUP_VOICE.md, Look-ahead).
const lookahead = new GroupLookahead({start: entry => startAhead(entry)});
const dropPrefetch = () => { prefetch.invalidate(); lookahead.cancel(); };

// `streamed` (optional, set by respondStreamed): the reply is still being written and `result` holds only its first sentence, which
// is voiced at once; the finished reply is merged into the returned result when the voice is done (bridge/reply-stream.mjs).
async function synthesizeReply(input, result, signal, current, profile = profileFor(input, roster), receiptPrepared = preparedInputs.get(input), streamed, omniSpeculation) {
  const spoken = await synthesizeReplyBody(input, result, signal, current, profile, receiptPrepared, streamed, omniSpeculation);
  if (!streamed) return spoken;
  return streamed.settle ? streamed.settle(spoken) : mergeFinishedReply(spoken, await finishedReply(streamed, spoken), streamed);
}
// The finished reply of a streamed turn, or null when the model failed after the first sentence was spoken (that sentence stands).
async function finishedReply(streamed, spoken) {
  try { return await streamed.final; }
  catch (error) {
    if (streamed.signal?.aborted) throw error;
    console.error('[CyberpunkConvai] Reply ended after its first sentence:', error.message);
    return null;
  }
}
function mergeFinishedReply(spoken, final, streamed) {
  const text = final?.text ?? streamed.stream.text;
  const {speechText: _speech, emotionMarks: _marks, voiceMarks: _sounds, ...rest} = spoken;
  return {...rest, ...(final?.sessionID !== undefined ? {sessionID: final.sessionID} : {}), text,
    ...(final?.speechText !== undefined ? {speechText: final.speechText} : {}),
    ...(final?.emotionMarks !== undefined ? {emotionMarks: final.emotionMarks} : {}),
    ...(final?.voiceMarks !== undefined ? {voiceMarks: final.voiceMarks} : {}),
    ...(final?.naturalDevices !== undefined ? {naturalDevices: final.naturalDevices} : {}),
    timing: {...final?.timing, ...spoken.timing}};
}

async function synthesizeReplyBody(input, result, signal, current, profile, receiptPrepared, streamed, omniSpeculation) {
  if(localVoice.playbackEnabled===false)return{...result,audio:undefined,faces:[],captions:[]};
  const turnPlan = turnVoice(input);
  if (turnPlan.engine === 'convai') {
    logVoiceRoute(input, profile, {engine: 'convai', language: turnPlan.language});
    return {...result, timing: {...result.timing, voiceProvider: 'convai'}};
  }
  // A local turn follows its reply's language: English keeps the chosen voice, another language needs OmniVoice.
  const voice = replyVoice({plan: turnPlan, text: result.text, local: localChoice(input.profileKey)});
  if (voice.engine === 'none') {
    logVoiceRoute(input, profile, voice);
    return {...result, audio: undefined, faces: [], captions: [], timing: {...result.timing, voiceProvider: 'none'},
      audioError: 'The selected voice speaks English only; showing the written reply.'};
  }
  const omni = voice.engine === 'omni', language = voice.language && voice.language !== 'en' ? voice.language : undefined;
  const voiceKey = voiceKeyFor(input);
  markStage('voiceStart');
  throwIfCancelled(signal);
  // The face's plan (bridge/emotion-selector.mjs): the player's message and the reply, the character's manner and the
  // previous turn's mood; the character's own tags (Expressive emotions) win, then Convai's own label. Text-only
  // Convai turns send that label about 0.5 s after the text (lateEmotionToken), so it is awaited alongside the voice
  // and used when it is there in time: Omni re-plans before the first phrase's face is built, Pocket's stream
  // planner picks it up on its next rebuild. The receipt records what was used, with no dialogue text.
  // Omni renders one audio file per phrase: its phrase edges are forced segment boundaries, so every phrase gets its
  // own expression aligned to its own audio. Pocket and Convai streams segment by sentence and are aligned to the
  // audio by pauses/duration (bridge/expression-timeline.mjs).
  const player = typeof result.userText === 'string' && result.userText.trim() ? result.userText : input.text;
  const spans = omni ? phraseOffsets(result.text, splitSpeechText(result.text)) : undefined;
  const planFor = convai => emotionSelection.plan({player, reply: result.text, profile: input.profileKey, convai,
    marks: result.emotionMarks, breaks: spans ? spans.slice(1).map(span => span[0]) : []});
  const late = {signal: undefined, settled: false, startedAt: Date.now()};
  if (result.expressionSignal === undefined && Number.isSafeInteger(result.lateEmotionToken)) {
    const config = realtimeConfig(input), token = result.lateEmotionToken;
    late.promise = waitLateEmotion(() => realtime.lateEmotion(config, token), {signal})
      .then(value => { late.signal = value; late.settled = true; late.lateMs = Date.now() - late.startedAt; return value; });
  } else late.settled = true;
  const expressionReceipt = (plan, expression, extra = {}) => atomic(resolve(runtime, 'expression-receipt.json'), JSON.stringify({
    version: 3, updated: Date.now(), requestId: input.requestId, profile: input.profileKey, provider: omni ? 'omni' : 'pocket',
    selector: emotionSelection.mode, emotion: expression?.emotion ?? null, scale: expression?.scale ?? null,
    basis: expression?.basis ?? null, delivered: expression !== undefined, ...extra,
    plan: plan ? {trait: plan.trait, baseline: plan.baseline, evidence: plan.evidence ?? null, summary: plan.summary ?? null,
      segments: plan.segments.map(segment => ({from: segment.start, to: segment.end, seconds: Math.round(segment.seconds * 100) / 100,
        weights: segment.weights, dominant: segment.dominant, mixed: segment.mixed, tags: segment.tags})), phrases: spans} : null})).catch(() => {});
  // A calm plan has no reply-level cue: the face rests neutral instead of holding a label after the reply.
  const withPlan = (base, plan) => {
    let next = {...base, expressionSignal: base.expressionSignal ?? result.expressionSignal};
    if (next.expressionSignal === undefined || next.expressionSignal?.basis === 'text' || next.expressionSignal?.basis === 'calm') {
      // The single-cue fallback (no plan) keeps its feeling or tone cue but not its resting-warmth default.
      const fallback = plan ? undefined : textExpressionSignal(result.text, {profile: input.profileKey});
      const cue = plan ? (plan.summary?.basis === 'calm' ? undefined : planSignal(plan)) : fallback?.basis === 'default' ? undefined : fallback;
      next.expressionSignal = cue;
      if (cue === undefined) delete next.expressionSignal;
    }
    if (plan) next.expressionPlan = plan;
    return next;
  };
  let plan = planFor(result.expressionSignal);
  result = withPlan(result, plan);
  // A streamed reply is planned again when it is finished (the plan above only covers its first sentence): the mood is
  // remembered and the receipt written once, from the whole reply.
  if (!streamed) emotionSelection.remember(input.profileKey, plan);
  if (!streamed) expressionReceipt(plan, result.expressionSignal, {convai: result.expressionSignal?.basis === 'ordered' || result.expressionSignal?.basis === 'response-id'
    ? result.expressionSignal.emotion : null, convaiLate: late.settled ? null : 'pending'});
  // Convai's late label, once known: one more receipt (and, for Omni, the plan used from the first face on).
  const refine = () => {
    if (!late.signal) return false;
    plan = planFor(late.signal);
    result = withPlan({...result, expressionSignal: late.signal}, plan);
    emotionSelection.remember(input.profileKey, plan);
    expressionReceipt(plan, late.signal, {convai: late.signal.emotion, convaiLate: late.lateMs ?? null});
    return true;
  };
  if (!omni) late.promise?.then(() => refine(), () => {});
  if (streamed) streamed.settle = async spoken => {
    const final = await finishedReply(streamed, spoken);
    const merged = mergeFinishedReply(spoken, final, streamed);
    const {expressionSignal: _signal, expressionPlan: _plan, ...base} = merged;
    result = {...base, ...(final?.expressionSignal !== undefined ? {expressionSignal: final.expressionSignal} : {})};
    plan = planFor(result.expressionSignal);
    result = withPlan(result, plan);
    emotionSelection.remember(input.profileKey, plan);
    expressionReceipt(plan, result.expressionSignal, {convai: null, convaiLate: null, streamed: true});
    return {...base, ...(result.expressionSignal !== undefined ? {expressionSignal: result.expressionSignal} : {}),
      ...(result.expressionPlan ? {expressionPlan: result.expressionPlan} : {})};
  };
  const ahead = current?.ahead;
  if(omni){
    // The one GPU worker is FIFO. A look-ahead phrase queued while the speaker
    // being heard still has phrases to render would delay that speaker's own
    // next phrase; wait for its production to finish (its audio plays on).
    if(ahead?.isHeld())await waitUntil(()=>streaming===0,{signal});
    const lookahead=new AbortController(),cancelLookahead=()=>lookahead.abort();
    signal?.addEventListener('abort',cancelLookahead,{once:true});
    try{
      const phrases=splitSpeechText(result.text),steps=localVoice.steps;
      // Voice tags (Natural speech) go to OmniVoice only, where the model wrote them; subtitles keep the clean phrase.
      const voiced=(naturalSpeech.enabled?speechPhrases(phrases,result.speechText,omniTagsFor(language)):undefined)??phrases;
      // OmniVoice renders one phrase at a time: the first phrase of a reply whose first sentence was seen while it was still being
      // written is already rendering (respondStreamed). It is used when it is the phrase this reply starts with, else dropped.
      const reuse=omniSpeculation&&omniSpeculation.phrase===voiced[0]&&omniSpeculation.language===language&&omniSpeculation.steps===steps;
      if(omniSpeculation&&!reuse)omniSpeculation.cancel();
      const first=reuse?omniSpeculation.promise:synthesizeOmniPhrase(voiceKey,voiced[0],{signal,steps,language,preStore:true});
      // Queue phrase 2 behind phrase 1 now: the GPU renders it while phrase 1's
      // lip analysis, storage and publication run, instead of after them.
      let second;
      if(phrases.length>1){second=synthesizeOmniPhrase(voiceKey,voiced[1],{signal:lookahead.signal,steps,language});second.catch(()=>{});}
      const generated=await first;
      // Convai's late label is normally in by now (phrase 1 takes longer to render than it takes to arrive); never wait.
      // If it comes later, the phrases not yet rendered use it: the stream holds this same plan object.
      if(late.settled)refine();
      else{const shared=result.expressionPlan;late.promise?.then(()=>{if(refine()&&shared&&result.expressionPlan!==shared)Object.assign(shared,result.expressionPlan);},()=>{});}
      logVoiceRoute(input, profile, voice, {lipText: !!generated.timing?.lipText});
      return {...result,...generated,text:result.text,timing:{...result.timing,...generated.timing},
        streamPlan:phrases.length>1?{phrases,speech:voiced,steps,language,voiceKey,lookahead:{promise:second,cancel:cancelLookahead},
          expressionPlan:result.expressionPlan,spans}:undefined};
    }catch(error){
      cancelLookahead();
      throwIfCancelled(signal);console.error('[CyberpunkConvai] Omni speech:',error.message);
      logVoiceRoute(input, profile, {engine: 'none', language: voice.language}, {reason: 'OmniVoice worker error: written reply only'});
      return {...result,audio:undefined,faces:[],captions:[],audioError:'Local voice is unavailable; showing the written reply.'};
    }
  }
  if ((await readSpeechStateCached()).continuousAvailable !== true) {
    logVoiceRoute(input, profile, {engine: 'none', language: voice.language}, {reason: 'local streaming unavailable: written reply only'});
    return {...result, audio: undefined, faces: [], captions: [],
      audioError: 'Local streaming is unavailable; showing the written reply.'};
  }
  logVoiceRoute(input, profile, voice);
  const speech = continuousSpeech(input, profile, current, signal, receiptPrepared, true, streamed ? streamed.marks : result.emotionMarks, {player, late});
  let prefetched;
  if (ahead?.isHeld()) {
    // Synthesize now, into memory (the one renderer page may still be draining
    // the previous speaker); the whole text is still sent to Pocket once.
    // Pocket's worker is FIFO, so this runs right after the prior speaker's job.
    // The Inworld cloud voice turns the reply's emotion marks into steering (docs/CLOUD_VOICE_INWORLD.md); the other voices ignore them.
    const replyMarks = result.emotionMarks, replySounds = result.voiceMarks;
    prefetched = new BufferedPcm({signal, synthesize: (onPcm, options) => localVoice.synthesizeStream(voiceKey, result.text, {...options, onPcm, emotion: {marks: replyMarks, sounds: replySounds}})});
    prefetched.start().then(() => ahead.markReady(), () => {});
    try {
      await ahead.waitClaimed(signal);
      // The previous speaker's renderer may still be retiring its page.
      await waitUntil(() => !realtime.localPcmBusy, {signal, timeoutMs: 3000});
    } catch (error) { prefetched.discard(); throw error; }
  }
  return deliverPocketSpeech({input, profile, voiceKey, result, current, signal, voice: localVoice, host: realtime, speech,
    phoneAnalysis:localVoice.phoneAnalysis,jaliFace,prefetched,stream:streamed?.stream,
    onAnalysis: timing => measure(input, {localLipAnalysis: timing})});
}

// options.preStore (the reply's first phrase): the audio is written for its speech slot while the face analysis runs, not after it
// (bridge/speech-audio.mjs prepareSpeech); the result carries `preStored` for publishResult.
async function synthesizeOmniPhrase(profile,text,{preStore=false,...options}={}){
  markStage('ttsSent');
  const generated=await localVoice.synthesize(profile,text,options);
  markStage('firstPcm');
  let preStored;
  // The analysis is started first (it runs in a worker), then the file is prepared on this thread while that runs: the other way round
  // the preparation's 10 ms of decoding and levelling would delay the start of the analysis.
  const analysing=jaliFace?jaliFace.analyseWav(generated.audio,{...options,text}):null;// the phrase as voiced, tags included
  analysing?.catch(()=>{});
  if(preStore&&typeof generated.audio==='string')try{preStored=prepareSpeech(generated.audio,audioDepot);}catch{/* the ordinary store follows */}
  const withStore=result=>preStored?{...result,preStored}:result;
  if(jaliFace)try{
    const facial=await analysing;
    return withStore({...generated,...facial,timing:{...generated.timing,...facial.timing,voiceProvider:'omni'}});
  }catch(error){
    if(options?.signal?.aborted)void preStored?.discard();throwIfCancelled(options?.signal);console.error('[CyberpunkConvai] Facial model fallback:',error.message);
  }
  try{
    const facial=await lipsync.analyse(generated.audio,options);
    return withStore({...generated,...facial,timing:{...generated.timing,...facial.timing,voiceProvider:'omni'}});
  }catch(error){
    if(options?.signal?.aborted)void preStored?.discard();throwIfCancelled(options?.signal);console.error('[CyberpunkConvai] Omni lip-sync fallback:',error.message);
    return withStore({...generated,timing:{...generated.timing,voiceProvider:'omni'}});
  }
}

// Status writes are queued in call order, so a caller may leave one unawaited (a turn's 'thinking' no longer holds up the
// provider request) without an older state ever landing after a newer one.
let statusWriting = Promise.resolve();
async function status(state, detail = '') {
  const text = JSON.stringify({state, detail: detail.slice(0, 200), updated: Date.now()});
  const job = statusWriting.catch(() => {}).then(() => atomic(statusPath, text));
  statusWriting = job;
  return job;
}

function continuousSpeech(input, profile, current, signal, receiptPrepared = preparedInputs.get(input), local = false, marks,
  {player = input.text, late} = {}) {
  const options = {signal, isCurrent: current, isCurrentSync: current.sync};
  const ahead = current.ahead;
  const speech = new ConvaiContinuousSpeech({input, profile, current, signal,
    planExpression: emotionSelection.planner({player, profile: input.profileKey, marks, late}),
    onTimeline: timeline => logEmotionTimeline(input, profile, {provider: local ? 'pocket' : 'convai', ...timeline}),
    ...(local ? {faceBuilder: ownedPocketFace} : {jaliFace}),
    // A look-ahead turn buffers silently until the game submits it. Once its
    // complete text is known (and it is no longer held), the next group speaker
    // may be prepared from that text.
    // V's typed line, when it is audible, holds the reply the same way until it ends (bridge/v-voice.mjs).
    hold: () => ahead?.isHeld() === true || current.vLine?.()?.holds() === true,
    holdPeek: () => ahead?.isHeld() === true || current.vLine?.()?.blocking === true,
    onHeld: (bufferedSeconds, textComplete) => { if (bufferedSeconds >= 0.4 && textComplete) ahead?.markReady(); },
    onText: (text, userText) => {
      if (typeof userText === 'string') noteKnowledgeTurn(receiptPrepared, {userText});
      lookahead.setSource({input, text, userText, current: current.sourceValid || current});
    },
    readControl: () => readFile(resolve(runtime, 'continuous-control.json'), 'utf8'),
    leaseWake: () => leaseWake.next(),
    writeState: value => atomic(resolve(runtime, 'continuous-speech.json'), JSON.stringify(value), options),
    writeFace: (value, {segments} = {}) => atomic(resolve(runtime, 'continuous-face.json'),
      segments ? encodeSegmentedFace(value) : JSON.stringify(value), options),
    // The game's adapter says how it reads the timeline file: segments (decoded by changed segment), a plain document or not at all.
    faceFile: async () => { const state = await readSpeechStateCached(); return state.continuousFaceSegments === true ? 'segments' : state.continuousFaceFile === true; },
    writeReply: value => atomic(replyPath, JSON.stringify({...value, ...keyNotice()}), options),
    onPublished: timing => { markPublished(input.requestId, timing.publishedAt);
      return measure(input, {...timing, stream: {mode: local ? 'pocket-continuous' : 'convai-continuous'}, nativePlaybackObserved: false}); },
    // The first renderer state with audio in it: the moment the sound can start (the turn's record, bridge/turn-clock.mjs).
    onAudio: () => { turnMark(input.requestId, 'firstPcmAccepted'); turnMark(input.requestId, 'firstFrame'); },
    onStarted: timing => { turnMark(input.requestId, 'playbackObserved', timing.continuousPlaybackFirstObservedAt);
      return measure(input, {...timing, continuousPlaybackObserved: true}); },
    onGenerated: async text => {
      // Microphone context refresh creates a new projection at finish. Its
      // generated/delivered receipts still belong to the original submitted
      // turn, shared by every channel of this conversation.
      // An add-on speaker (Delamain, Skippy) has no knowledge receipt: no Convai memory and no world-knowledge route belong to its
      // turns (runAddonTurn). Throwing here for the missing receipt stopped the voice stream the moment the text was complete,
      // which cut every add-on line off in the middle (probe.log 2026-10-14: "Conversation receipt owner changed" after each
      // Delamain line). Such a turn only has to still be current.
      if (!receiptPrepared && input.addon) {
        if (!await current()) throw Error('Conversation owner changed');
        return;
      }
      if (!receiptPrepared || !await current()) throw Error('Conversation receipt owner changed');
      await knowledgeRouter.activity(receiptPrepared, 'generated-reply', {replyText: text});
      stagedKnowledgeTurn(receiptPrepared, {replyText: text});
    },
  });
  // Poll the buffered turn at once when the game submits it, or when V's line ends.
  ahead?.claimed.then(() => speech.wakeUp(), () => {});
  current.vLine?.()?.whenClear(() => speech.wakeUp());
  return speech;
}

// Original remote PCM has a continuous renderer. It never enters Omni's text
// splitter, local TTS worker or per-phrase Audioware file queue.
async function convaiReply(input, profile, current, signal) {
  logVoiceRoute(input, profile, {engine: 'convai', language: turnVoice(input).language});
  const state = await readSpeechStateCached();
  // Retain the complete-file adapter until this game session advertises the
  // new Lua admission controller; installing files alone does not load them.
  if (state.continuousAvailable !== true) {
    return {...await realtime.reply(realtimeConfig(input), {signal}), transport: 'realtime'};
  }
  const speech = continuousSpeech(input, profile, current, signal);
  try {
    const result = await realtime.reply(realtimeConfig(input), {signal, liveSpeech: speech.options});
    return {...result, transport: 'realtime', liveDelivery: {published: speech.published,
      ended: speech.ended, generated: speech.generated, id: speech.token}};
  } catch (error) { await speech.fail().catch(() => {}); throw error; }
}

// A text-route reply (Mistral, the local AI) is voiced while it is still being written (bridge/reply-stream.mjs): the first
// complete sentence goes to the voice as soon as the model has written it, the rest follows when the reply is finished. Only the
// Pocket-engine voices (Pocket and Voxtral) take part; a reply with no safe first sentence, another voice, or no continuous
// playback is built and voiced as a whole, exactly as before. "replyStreaming": false in settings.json (or
// CYBERPUNK_CONVAI_REPLY_STREAM=0) switches it off.
async function respondStreamed(input, profile, {signal, current}) {
  const config = realtimeConfig(input);
  const stream = newReplyStream(config, profile);
  const final = Promise.resolve(realtime.reply(config, {signal, stream})).then(result => ({...result, transport: 'realtime'}));
  final.catch(() => {});
  return voiceStreamedReply(input, profile, {signal, current, stream, final, config});
}
const newReplyStream = (config, profile) => new ReplyStream({name: config.local?.name ?? profile?.name ?? '', isTag: hasEmotionTag});

// The voice half of a streamed reply, shared by a typed turn (respondStreamed) and a voice-key turn (bridge/voice-key-stream.mjs, started
// from prepareReply while the text host is still writing the reply). 'stream' is the ReplyStream the text host feeds, 'final' the
// finished reply's promise. 'userText' (voice key only) is what the player said: the first sentence's admission carries it.
// 'receiptPrepared' is the turn's knowledge receipt when it is not the default one (undefined: the default).
async function voiceStreamedReply(input, profile, {signal, current, stream, final, config, userText = () => '', receiptPrepared}) {
  const marks = [];
  stream.onChange(() => { if (stream.complete && Array.isArray(stream.meta?.emotionMarks)) marks.splice(0, marks.length, ...stream.meta.emotionMarks); });
  const whole = async () => synthesizeReply(input, await final, signal, current, profile, receiptPrepared);
  const head = await abortable(stream.headReady, signal);
  if (!head) return whole();
  const voice = replyVoice({plan: turnVoice(input), text: head, local: localChoice(input.profileKey)});
  if (voice.engine === 'omni' && localVoice.playbackEnabled !== false) {
    // The first phrase renders while the model writes the rest.
    const phrase = splitSpeechText(head)[0], language = voice.language && voice.language !== 'en' ? voice.language : undefined, steps = localVoice.steps;
    const controller = new AbortController(), cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, {once: true});
    const promise = synthesizeOmniPhrase(voiceKeyFor(input), phrase, {signal: controller.signal, steps, language, preStore: true});
    promise.catch(() => {});
    final.then(() => {}, cancel);
    try { return await synthesizeReply(input, await final, signal, current, profile, receiptPrepared, undefined, {phrase, language, steps, promise, cancel}); }
    finally { signal?.removeEventListener('abort', cancel); cancel(); }
  }
  if (voice.engine !== 'pocket' || localVoice.playbackEnabled === false || (await readSpeechStateCached()).continuousAvailable !== true) return whole();
  throwIfCancelled(signal);
  // The tags written inside the first sentence move the face from its first frame (the finished reply re-plans with all of them).
  const headMarks = expressiveEmotions.active ? stream.headMarks : [];
  if (headMarks.length && !marks.length) marks.push(...headMarks);
  const said = userText();
  const partial = {text: head, transport: 'realtime', sessionID: config.sessionId, timing: {streamedHead: true},
    ...(said ? {userText: said} : {}),
    ...(headMarks.length ? {emotionMarks: headMarks} : {}), ...(naturalSpeech.enabled && stream.headSounds.length ? {voiceMarks: stream.headSounds} : {})};
  return synthesizeReply(input, partial, signal, current, profile, receiptPrepared, {stream, final, marks, signal});
}

async function respond(input, profile, {signal, prepared, current} = {}) {
  if (localVoice.playbackEnabled!==false&&audioAvailable(await readSpeechStateCached())) {
    if (prepared) {
      let cached;
      try { cached = await prepared; }
      catch { throwIfCancelled(signal); /* Failed speculation falls back to the submitted turn. */ }
      // Once a cached turn enters audible local playback, failure must not
      // submit that same prompt to Convai again or replay another response.
      if (cached) return synthesizeReply(input, cached, signal, current, profile);
    }
    throwIfCancelled(signal);
    // Mistral has no Convai audio: a turn that would use the cloud voice (no local voice available) is a written reply.
    if (!turnUsesLocal(input) && !mistral.active) return convaiReply(input, profile, current, signal);
    if (mistral.active && replyStreaming && !current?.ahead && !input.reaction) return respondStreamed(input, profile, {signal, current});
    return synthesizeReply(input, {...await realtime.reply(realtimeConfig(input), {signal}), transport: 'realtime'}, signal, current, profile);
  }
  prefetch.invalidate(); prepared?.cancel();
  throwIfCancelled(signal);
  // Text-only replies keep the same identified transport when native playback
  // is unavailable; legacy HTTP does not document the player-memory binding.
  return {...await realtime.reply({...realtimeConfig(input), ttsEnabled: false}, {signal}), transport: 'realtime'};
}

// One compact line per reply for scripts/Show-EmotionTimeline.mjs (bridge/expression-timeline.mjs). Diagnostic only.
function logEmotionTimeline(input, profile, {provider, text, plan, face, signal} = {}) {
  try {
    const record = timelineRecord({requestId: input.requestId, speaker: profile?.name, profile: profile?.key, provider,
      reply: text, plan, face, signal});
    if (record) console.error(TIMELINE_PREFIX + JSON.stringify(record));
  } catch { /* logging never affects speech */ }
}

async function publishResult(input, profile, result, current = async () => true, signal) {
  if (!await current()) return false;
  // A reply published as a whole (OmniVoice) is ready now: V's typed line, if it is audible, finishes first; if it is not, it is dropped.
  await current.vLine?.()?.waitClear(signal);
  if (!await current()) return false;
  // The language of this exchange predicts the next turn without text (reactions, warm connections).
  if (!input.reaction) multilingual.observe(input.text);
  multilingual.observe(result.text);
  logNaturalSpeech(input, result);
  logFollowUp(input, result);
  // One line per reply: whether this turn's context carried V's gear (bridge/player-gear.mjs), or why not. Counts only, no names.
  // A voice with no body (persona.voiceContext) gets neither V's gear nor the person form of the block below.
  const voice = addonHost.usesVoiceContext(input.profileKey);
  try { if (!input.reaction) console.error(`[PlayerGear] profile=${input.profileKey} ${voice ? 'Player gear: none (voice speaker)' : gearDiagnostic(input)}`); } catch { /* a log line never affects a reply */ }
  // And whether it carried the "right now" block (clock, place, company; bridge/turn-context.mjs). Counts only.
  try { if (!input.reaction) console.error(`[TurnContext] profile=${input.profileKey} ${turnContextDiagnostic(input, {ambient: isAmbientProfile(input.profileKey), voice})}`); } catch { /* a log line never affects a reply */ }
  if (result.continuous) {
    if (!result.liveDelivery?.published || !result.liveDelivery.ended) throw Error('Continuous speech did not finish');
    // The game already received admission, live text and the consumed-sample
    // clock. Publishing a second ordinary reply would replay or replace it.
    realtimeSessions.set(sessionKey(input), result.sessionID);
    connections.used(input, result.timing); prefetch.published(input, result.text); prefetchObserved = '';
    await measure(input, {transport: 'realtime', timing: result.timing,
      stream: {id: result.liveDelivery.id, mode: result.timing?.voiceProvider === 'pocket' ? 'pocket-continuous' : 'convai-continuous', complete: true},
      continuousPlaybackCompleteAt: Date.now()});
    await status('ready', profile.name);
    return true;
  }
  const preparationStartedAt = Date.now();
  let audio, face, stream, audioError = result.audioError, diagnostic;
  if (result.audio) {
    try {
      if(result.streamPlan){
        stream=new SpeechStream({input,...result.streamPlan,slots,readState:readSpeechState,current,signal,
          writeManifest:document=>writeStreamManifest(document,current),
          synthesize:(text,options)=>synthesizeOmniPhrase(result.streamPlan.voiceKey??profile.key,text,{...options,language:result.streamPlan.language})});
        const first=await stream.begin(result);audio=first.audio;face=first.face;
      }else{
        const id=randomUUID();await slots.begin(id,current);audio=await slots.write(id,1,result.audio,current,result.preStored);
      }
      if (!await current()) { stream?.closeQueue(); return false; }
      try { face ??= buildFacialTimeline(result, input); }
      catch (error) { console.error('[CyberpunkConvai] Facial timing unavailable:', error.message); }
      // A diagnostic file (40 KB): written after the reply is committed, not in front of it (docs/LATENCY_2026-10-13.md, 4.6).
      diagnostic = () => atomic(resolve(runtime, 'last-speech-timing.json'), JSON.stringify({
        requestId: input.requestId, faces: result.faces, facesFormat: result.facesFormat,
        captions: result.captions, duration: audio.duration, face,
      }), {signal, isCurrent: current, isCurrentSync: current.sync});
    } catch (error) {
      stream?.closeQueue();result.streamPlan?.lookahead?.cancel?.();
      audio = undefined; face = undefined;stream=undefined;
      audioError = 'Voice could not be prepared; showing the written reply.';
      console.error('[CyberpunkConvai] Voice preparation failed:', error.message);
    }
  }
  if (!await current()) { stream?.closeQueue(); return false; }
  // The next group speaker may be prepared from this reply's text from now on.
  lookahead.setSource({input, text: result.text, userText: result.userText, current: current.sourceValid || current});
  const committed = await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation,
    entity: input.entity, profile: profile.key, text: result.text, userText: result.userText, audio, face, audioError,
    stream:stream?.descriptor(),updated: Date.now(), ...keyNotice()}), {signal, isCurrent: current, isCurrentSync: current.sync});
  if (!committed || !await current()) { stream?.closeQueue(); return false; }
  void diagnostic?.().catch(() => {});
  logEmotionTimeline(input, profile, {provider: result.timing?.voiceProvider ?? null, text: result.text,
    plan: result.expressionPlan, face, signal: result.expressionSignal});
  (result.transport === 'realtime' ? realtimeSessions : sessions).set(sessionKey(input), result.sessionID);
  if (result.transport === 'realtime') connections.used(input, result.timing);
  prefetch.published(input, result.text);
  // Reconsider the prediction file after a source reply becomes valid.
  prefetchObserved = '';
  markPublished(input.requestId);
  await measure(input, {transport: result.transport || 'rest', timing: result.timing, preparation: result.preparation,
    audioStoreMs: Date.now() - preparationStartedAt, publishedAt: Date.now(), audioDurationSeconds: audio?.duration,
    stream:stream?{id:stream.manifest.streamId,chunks:stream.phrases.length,mode:'omni-phrases'}:undefined,
    nativePlaybackObserved: false});
  await status('ready', profile.name);
  if(stream){
    streaming++;
    try{
      await stream.finish();
      if(await current())await measure(input,{stream:{id:stream.manifest.streamId,mode:'omni-phrases',
        chunks:stream.manifest.chunks.length,complete:stream.manifest.complete,error:stream.error,
        productionMs:Date.now()-stream.started,audioDurationSeconds:stream.totalDuration,
        timings:stream.manifest.chunks.map(chunk=>({index:chunk.index,readyAt:chunk.readyAt,
          duration:chunk.audio.duration,...chunk.timing}))}});
    }finally{streaming--;prefetchObserved='';}
  }
  return true;
}

const micPath = resolve(runtime, 'microphone-command.json');
const microphoneKnowledge = new Map();
const microphoneSpeech = new Map();
// Voice-key turns on a text route that are voiced while the reply is written (bridge/voice-key-stream.mjs), by request id.
const microphoneStreams = new Map();
let micObserved = await readFile(micPath, 'utf8').catch(() => '');
let micPolling = false;
// What Convai has heard of V's recording so far, for the game to show while V talks (mod/microphone.lua reads it on its
// own poll). Written only when the words change; the request id keeps a late file from another recording out.
let heardSent = {id: '', text: ''}, heardPolled = '';
async function publishHeard(recording) {
  const text = await mic.heard();
  if (mic.current !== recording || stopped) return;
  // One line per recording shows where the live caption stops: the poll reached it, and when the first words came.
  if (heardPolled !== recording.requestId) { heardPolled = recording.requestId; console.error('[CyberpunkConvai] Microphone: reading heard words for ' + recording.requestId.slice(-12)); }
  if (heardSent.id === recording.requestId ? heardSent.text === text : !text) return;
  if (heardSent.id !== recording.requestId) console.error('[CyberpunkConvai] Microphone: first heard words ' + (Date.now() - recording.opened) + ' ms after the device opened (' + [...text].length + ' characters)');
  heardSent = {id: recording.requestId, text};
  await atomic(resolve(runtime, 'microphone-heard.json'), JSON.stringify({requestId: recording.requestId, text, updated: Date.now()}));
}
// V speaking to an add-on speaker (F7, F10): recognised locally, answered by the add-on turn route (bridge/addon-voice.mjs).
const addonVoice = createAddonVoice({isSpeaker: key => addonHost.isSpeaker(key), speech: mistralSpeech,
  currentFor: (requestId, signal) => {
    const current = async () => {
      if (stopped || signal?.aborted || mic.current?.requestId !== requestId) return false;
      let latest; try { latest = JSON.parse(await readFile(micPath, 'utf8')); } catch { return false; }
      return latest.input?.requestId === requestId && latest.action === 'finish';
    };
    current.sync = () => !stopped && !signal?.aborted && mic.current?.requestId === requestId;
    return current;
  },
  runTurn: ({input, signal, current, userText}) => {
    const request = {input, controller: {signal}, receivedAt: Date.now()};
    return withTurnClock(request, clock => runAddonTurn(request, input, profileFor(input, roster), current, clock, {userText}));
  },
  answerError: async ({input, signal, current, error}) => {
    // The same answer a typed add-on turn gets from runInput: a message about the service, not about the microphone.
    console.error('[Addons] Voice turn failed:', error.message);
    await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation, entity: input.entity,
      error: 'The conversation service could not reply. Please try again.', ...keyFailure(error, input)}),
      {signal, isCurrent: current, isCurrentSync: current.sync}).catch(() => {});
  }});

const mic = new MicrophoneSession({hostFactory: addonVoice.hostFactory(() => realtime.voiceChannel()),
  onState: (state, input) => atomic(resolve(runtime, 'microphone-state.json'), JSON.stringify({state, requestId: input.requestId, updated: Date.now()})),
  prepareReply: async (input, signal) => {
    if (addonVoice.voice(input) || localVoice.playbackEnabled === false) return;
    const prepared = microphoneKnowledge.get(input.requestId);
    const current = async () => {
      if (stopped || signal.aborted || mic.current?.requestId !== input.requestId || !prepared) return false;
      let command; try { command = JSON.parse(await readFile(micPath, 'utf8')); } catch { return false; }
      return command.input?.requestId === input.requestId && command.action === 'finish'
        && await knowledgeRouter.current(prepared);
    };
    current.sync = () => !stopped && !signal.aborted && mic.current?.requestId === input.requestId
      && prepared && knowledgeRouter.currentSync(prepared);
    // A local voice on a text route (Mistral, the local AI): the reply is voiced while it is still being written, as a typed turn's
    // is (bridge/voice-key-stream.mjs). Without a safe first sentence, another voice or no continuous playback it is voiced whole, as before.
    if (turnUsesLocal(input)) {
      if (!mistral.active || !replyStreaming || input.reaction || !prepared) return;
      const config = realtimeConfig(input), profile = profileFor(input, roster);
      const streamed = startVoiceKeyStream({stream: newReplyStream(config, profile), signal,
        speak: ({stream, final, signal: own, userText}) => voiceStreamedReply(input, profile, {signal: own, current, stream, final, config, userText, receiptPrepared: prepared})});
      microphoneStreams.set(input.requestId, streamed);
      signal.addEventListener('abort', () => { if (microphoneStreams.get(input.requestId) === streamed) microphoneStreams.delete(input.requestId); }, {once: true});
      return streamed.options;
    }
    if ((await readSpeechStateCached()).continuousAvailable !== true) return;
    const speech = continuousSpeech(input, profileFor(input, roster), current, signal, prepared);
    microphoneSpeech.set(input.requestId, speech);
    return {liveSpeech: speech.options};
  },
  onReply: async (input, result, signal) => {
    if (addonVoice.voice(input)) return;   // the add-on turn published itself (bridge/addon-voice.mjs)
    // A voice-key turn on a text route has been voiced since its first sentence (prepareReply): it only needs the finished reply.
    const streamed = microphoneStreams.get(input.requestId);
    microphoneStreams.delete(input.requestId);
    let handedOn = false;
    try {
      if (stopped) return;
      const prepared = microphoneKnowledge.get(input.requestId);
      if (!prepared || !await knowledgeRouter.current(prepared)) return;
      const command = JSON.parse(await readFile(micPath, 'utf8'));
      if (command.input?.requestId !== input.requestId || command.action === 'cancel') return;
      const current = async () => {
        if (stopped || signal?.aborted) return false;
        const latest = JSON.parse(await readFile(micPath, 'utf8').catch(() => '{}'));
        return latest.input?.requestId === input.requestId && latest.action !== 'cancel' && await knowledgeRouter.current(prepared);
      };
      current.sync = () => !stopped && !signal?.aborted && knowledgeRouter.currentSync(prepared);
      const speech = microphoneSpeech.get(input.requestId);
      let spoken;
      if (streamed) { handedOn = true; streamed.finish({...result, transport: 'realtime'}); spoken = await streamed.spoken; }
      else spoken = await synthesizeReply(input, {...result, transport: 'realtime',
        ...(speech ? {liveDelivery: {published: speech.published, ended: speech.ended,
          generated: speech.generated, id: speech.token}} : {})}, signal, current, profileFor(input, roster), prepared);
      if (!spoken.liveDelivery?.generated) {
        await knowledgeRouter.activity(prepared, 'generated-reply', {replyText: result.text});
        stagedKnowledgeTurn(prepared, {replyText: result.text, userText: result.userText});
      }
      await publishResult(input, profileFor(input, roster), spoken, current, signal);
      microphoneSpeech.delete(input.requestId);
    } finally { if (streamed && !handedOn) streamed.abort(); }
  },
  onError: async (input, error) => {
    microphoneStreams.get(input.requestId)?.fail(error);
    microphoneStreams.delete(input.requestId);
    await microphoneSpeech.get(input.requestId)?.fail().catch(() => {});
    microphoneSpeech.delete(input.requestId);
    console.error('[CyberpunkConvai] Microphone:', error.message);
    const prepared = microphoneKnowledge.get(input.requestId);
    const current = async () => {
      if (stopped || (prepared && !await knowledgeRouter.current(prepared))) return false;
      let latest; try { latest = JSON.parse(await readFile(micPath, 'utf8')); } catch { return false; }
      return latest.input?.requestId === input.requestId && latest.action !== 'cancel';
    };
    current.sync = () => !stopped && (!prepared || knowledgeRouter.currentSync(prepared));
    if (!await current()) return;
    // A recording that held no speech is not a device fault: the game says so instead of blaming the microphone.
    const noSpeech = /No speech was heard/.test(error?.message || '');
    // A device that sends no sound at all is named, so the player knows which Windows input to look at.
    const silent = error?.code === 'MIC_SILENT';
    await atomic(resolve(runtime, 'microphone-state.json'), JSON.stringify({state: silent ? 'silent' : noSpeech ? 'no-speech' : 'error', requestId: input.requestId,
      ...(silent ? {device: String(error.device ?? '').slice(0, 80)} : {}), updated: Date.now()}), {isCurrent: current, isCurrentSync: current.sync});
    await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation,
      entity: input.entity, error: 'Voice conversation failed. Check your microphone and try again.', ...keyFailure(error, input)}), {isCurrent: current, isCurrentSync: current.sync});
  },
});

async function resetLiveRoutes({cancelTurns = true} = {}) {
  await companionActions.revoke();
  // Clearing cloud memory must retire injected provider context and session
  // history too. No native/save data or persistent player identity is changed.
  if (cancelTurns) {
    active?.controller.abort();
    phone.close(); phoneKnowledge.clear();
    await cancelMicrophone();
  }
  dropPrefetch();
  await invitations.clear('world-or-memory-reset');
  await Promise.allSettled([realtime.close(), phoneRealtime.close()]);
  await connections.clear();
  sessions.clear(); realtimeSessions.clear(); knowledgeTurns.clear();
  partyObserved = ''; prewarmObserved = ''; prefetchObserved = '';
  rewarmLocalVoice();
}

// A text route's hidden browser (the local voice's renderer) is closed with the realtime host by a world reset, a key switch or a
// provider switch. Nothing else opens it until the next composer warm-up, so a turn that comes first would start Edge in front of its
// voice (770 ms, then the renderer page: the live record of 2026-10-13, the turn after a provider switch). Open it again at once.
function rewarmLocalVoice() {
  if (mistral.active && localVoice.playbackEnabled !== false && !stopped) void realtime.prewarmLocal();
}

async function quiescePlayerMemory({signal, scope, profileKeys} = {}) {
  throwIfCancelled(signal);
  memoryQuiescing++;
  try {
    await resetLiveRoutes();
    throwIfCancelled(signal);
    // Forget all memories also forgets what shopkeepers remember of V. PlayerMemory has already persisted the reset
    // epoch and fenced every character, so a turn begun earlier can no longer write; a failed removal fails the clear.
    if (scope === 'all' && (await vendorMemory.forgetAll()).ok !== true) throw Error('Vendor memory could not be cleared');
    // The text providers keep their own conversation memory here (bridge/memory-store.mjs): Forget clears it too, records and vectors included.
    mistralMemory.forget({all: scope === 'all', profileKeys: profileKeys ?? []});
    await mistralMemory.flush().catch(() => {});
    return {quiesced: true};
  } finally { memoryQuiescing--; }
}

async function admitPlayerConversation(prepared, {signal} = {}) {
  throwIfCancelled(signal);
  if (!prepared?.sendAllowed || !await knowledgeRouter.current(prepared)) throw Error('Conversation world changed');
  // Capture topic/profile/audience before provider work. This is ephemeral
  // prompt material, never synthetic dialogue or memory seeding. Automatic and
  // group routes receive no private intrinsic history. F7's unrecognized
  // [Microphone] placeholder likewise selects no private topic.
  intrinsicHistory.select(prepared.input, prepared, value => knowledgeRouter.currentSync(value));
  // An actually admitted battle/loot reply can enter natural provider memory.
  // Register its Forget target locally without enabling or seeding anything.
  if (prepared.input.reaction) {
    await playerMemory.recordAutomaticConversation({profileKey: prepared.route.providerProfileKey ?? prepared.route.profileKey,
      guard: prepared.guard, channel: prepared.route.channel,
      requestId: prepared.input.requestId || prepared.input.id, signal});
    throwIfCancelled(signal);
    if (!await knowledgeRouter.current(prepared)) throw Error('Conversation memory changed');
    return {reconnectRequired: false};
  }
  // Stage timing for bridge-latency.json (submissionStages.memory). performance is absent in the vm test sandbox.
  const clock = () => globalThis.performance?.now?.() ?? Date.now(), memoryStarted = clock();
  const begin = {profileKey: prepared.route.providerProfileKey ?? prepared.route.profileKey,
    guard: prepared.guard, source: 'player',
    channel: prepared.route.transport === 'microphone' ? 'microphone' : prepared.route.channel,
    requestId: prepared.input.requestId || prepared.input.id, signal};
  // Generic residents and npc-* archetypes keep Convai long-term memory off (docs/PLAYER_MEMORY.md, "Vendor
  // memory"): record the Forget target locally, never verify or enable provider memory. That verification
  // (character list + get, and an update + readback when off) cost 6.7 s on a first resident turn.
  // With Mistral no Convai memory is enabled or checked either: the Forget target is recorded locally, like an ordinary NPC.
  if (prepared.providerMemory === 'session-only' || mistral.active) {
    await playerMemory.beginSessionConversation(begin);
    throwIfCancelled(signal);
    if (!await knowledgeRouter.current(prepared)) throw Error('Conversation memory changed');
    return {reconnectRequired: false, memory: {mode: 'session-only', beginMs: clock() - memoryStarted}};
  }
  await playerMemory.beginConversation(begin);
  throwIfCancelled(signal);
  if (!await knowledgeRouter.current(prepared)) throw Error('Conversation memory changed');
  const memory = {mode: 'provider', beginMs: clock() - memoryStarted};
  const refresh = {profileKey: prepared.route.providerProfileKey ?? prepared.route.profileKey, guard: prepared.guard};
  const reconnectRequired = playerMemory.connectionRefreshRequired(refresh)
    || connections.needsRetirement(prepared.route.profileKey);
  if (reconnectRequired) {
    // Invited companions completed this before spawning. A first conversation
    // with an existing world NPC still prepares on demand, retiring only that
    // character's pre-enable routes rather than everyone else's warm pages.
    await connections.retireInvitation(prepared.route.profileKey, {signal});
    const host = prepared.route.channel === 'phone' ? phoneRealtime : realtime;
    const config = {...realtimeConfig(prepared.input), ttsEnabled: prepared.route.channel === 'phone'
      ? false : localVoice.playbackEnabled!==false&&!turnUsesLocal(prepared.input)};
    if (!await host.refreshIdle(config)) throw Error('The character connection is still releasing. Please try again.');
    throwIfCancelled(signal);
    if (!await knowledgeRouter.current(prepared)) throw Error('Conversation world changed');
    playerMemory.acknowledgeConnectionRefresh(refresh);
    memory.refreshMs = clock() - memoryStarted - memory.beginMs;
  }
  return {reconnectRequired, memory};
}

async function pollMicrophone() {
  if (micPolling || stopped || voiceRouteReservation || relationshipRouteReservation) return;
  micPolling = true;
  try {
    const raw = await readFile(micPath, 'utf8').catch(() => '');
    if (raw && raw !== micObserved) {
      let command;
      try { command = JSON.parse(raw); } catch { return; }
      const input = parseInput(JSON.stringify(command.input));
      if (!input || !['start', 'finish', 'cancel'].includes(command.action)) return;
      micObserved = raw;
      // Every command is logged with where it came from (the game's key press, key release, 30 s cap...) and how far into the recording
      // it arrived, so a recording that does not stop shows whether the stop ever got here.
      const ranMs = mic.current?.requestId === input.requestId && mic.current.opened ? Date.now() - mic.current.opened : null;
      console.error('[CyberpunkConvai] Microphone: ' + command.action + ' command, source ' + String(command.source ?? 'unknown').replace(/[^\w.-]/g, '').slice(0, 24)
        + (ranMs === null ? '' : ', ' + ranMs + ' ms into the recording'));
      if (command.action === 'finish') {
        // The stop is the moment the recording ends: close the device now, not after the context refresh below.
        const stopAt = Date.now();
        void mic.stopCapture(input.requestId).then(ran => {
          if (ran !== null) console.error('[CyberpunkConvai] Microphone: capture closed ' + (Date.now() - stopAt) + ' ms after the stop command (recording ran ' + ran + ' ms)');
        }).catch(() => {});
      }
      if (command.action === 'cancel') {
        if (mic.current?.requestId === input.requestId) await cancelMicrophone();
      }
      else if (command.action === 'finish' && addonVoice.voice(input)) {
        // The recording belongs to the speaker it started with; the finish only refreshes the game's context for the turn.
        if (mic.current?.requestId !== input.requestId) { await cancelMicrophone(); return; }
        void mic.finish(input.requestId, {input, config: addonVoice.config(input)}).catch(error => console.error(error.message));
      }
      else if (command.action === 'finish') {
        const prior = microphoneKnowledge.get(input.requestId);
        if (!prior || !await knowledgeRouter.current(prior)) { await cancelMicrophone(); return; }
        const refreshed = await knowledgeRouter.prepare({...input, source: 'microphone'},
          {worldToken: worldSession?.token, generation: worldSession?.generation});
        if (!await knowledgeRouter.current(prior) || !await knowledgeRouter.current(refreshed)
            || refreshed.sessionKey !== prior.sessionKey) { await cancelMicrophone(); return; }
        // The same submitted turn retains its receipt owner; only the context
        // snapshot and native input data refresh at microphone completion.
        preparedInputs.set(refreshed.input, refreshed);
        const signal = mic.current?.controller.signal;
        // A group recording arms only a leave offer for its round (docs/WORLD_COMPANIONS.md).
        companionActions.admit(refreshed, {source: refreshed.input.group ? 'group-voice' : 'private-voice', signal,
          isCurrent: async () => !stopped && !signal?.aborted && await knowledgeRouter.current(refreshed)
            && await readFile(micPath, 'utf8').catch(() => '') === raw,
          isCurrentSync: () => !stopped && !signal?.aborted && knowledgeRouter.currentSync(refreshed)});
        void mic.finish(input.requestId, {input: refreshed.input, config: realtimeConfig(refreshed.input)})
          .catch(error => console.error(error.message));
      }
      else if (addonVoice.voice(input)) {
        // An add-on speaker has no Convai character, knowledge route or memory to prepare, and its subtitles need no game audio.
        if (!profileFor(input, roster)) { await mic.onError(input, Error('Voice service or character is unavailable')); return; }
        void companionActions.revoke();
        active?.controller.abort(); dropPrefetch();
        await cancelMicrophone();
        const latest = JSON.parse(await readFile(micPath, 'utf8').catch(() => '{}'));
        if (latest.input?.requestId !== input.requestId || latest.action === 'cancel') return;
        void mic.start(input, addonVoice.config(input)).catch(error => console.error(error.message));
      }
      else {
        const profile = profileFor(input, roster);
        if (!profile || !ids[profile.key] || !await audioReady(runtime)) {
          await mic.onError(input, Error('Voice service or character is unavailable')); return;
        }
        // The talk key: the surroundings picture is published on the voice page as soon as the recording runs, while V talks.
        companionVision.beginVoice(input.requestId);
        // A new microphone turn supersedes a pending text reply.
        void companionActions.revoke();
        active?.controller.abort(); dropPrefetch();
        await cancelMicrophone();
        const prepared = await knowledgeRouter.prepare({...input, source: 'microphone'},
          {worldToken: worldSession?.token, generation: worldSession?.generation});
        try { await admitPlayerConversation(prepared); }
        catch (error) { await mic.onError(input, error); return; }
        await knowledgeRouter.submitted(prepared);
        preparedInputs.set(prepared.input, prepared); microphoneKnowledge.clear();
        microphoneKnowledge.set(input.requestId, prepared); rememberKnowledgeTurn(prepared);
        await connections.setRequest(prepared.input, realtimeConfig(prepared.input));
        const latest = JSON.parse(await readFile(micPath, 'utf8').catch(() => '{}'));
        if (microphoneKnowledge.get(input.requestId) !== prepared || !await knowledgeRouter.current(prepared)
            || latest.input?.requestId !== input.requestId || latest.action === 'cancel') {
          await cancelKnowledgeTurn(prepared); return;
        }
        void mic.start(prepared.input, realtimeConfig(prepared.input)).catch(error => console.error(error.message));
      }
    }
    const recording = mic.current;
    if (recording) {
      const owner = microphoneKnowledge.get(recording.requestId);
      if (addonVoice.voice(recording.input)) {
        // No Convai owner to check; the rest (the 30 s limit, the live words) is the same as for any recording.
        if (recording.opened && Date.now() - recording.opened >= 32000 && recording.intent !== 'finish') await cancelMicrophone();
        else await publishHeard(recording);
      }
      else if (!owner || !await knowledgeRouter.current(owner) || !await audioReady(runtime)) await cancelMicrophone();
      // Lua's 30-second finish captures fresh native context. Never let the
      // bridge timeout submit the old start snapshot first. Allow its command
      // two seconds to arrive; a missing command cancels the recording.
      else if (recording.opened && Date.now() - recording.opened >= 32000 && recording.intent !== 'finish') {
        await cancelMicrophone();
      }
      else await publishHeard(recording);
    }
  } finally { micPolling = false; }
}

async function reactionCurrent(input) {
  if (!input.reaction) return true;
  // CET replaces the heartbeat by removing then renaming its file, and Windows can refuse a read for a moment while the file is being
  // replaced or scanned (EPERM, EBUSY, EACCES). Retry those briefly, but never retry an explicit cancellation or stale lease.
  for (let attempt = 0; attempt < 3; attempt++) {
    let lease;
    try { lease = JSON.parse(await readFile(resolve(runtime, 'reaction-lease.json'), 'utf8')); }
    catch (error) {
      if (!LEASE_SHARING.has(error.code) && !(error instanceof SyntaxError)) return false;
      if (attempt === 2) {
        // Unreadable, rather than a cancelled request. A request whose lease was good a moment ago keeps going for a short grace: one
        // refused read must not cut a remark the game is playing (an add-on lease is rewritten every second while it plays).
        const seen = reactionLeaseSeen.get(input.requestId);
        return seen?.goodAt !== undefined && Date.now() - seen.goodAt <= LEASE_UNREADABLE_GRACE_MS ? true : null;
      }
      await new Promise(done => setTimeout(done, 15));
      continue;
    }
    const problem = reactionLeaseProblem(input, lease);
    noteReactionLease(input.requestId, problem ? {problem} : {goodAt: Date.now(), problem: undefined});
    return problem === null;
  }
}
// The last good verdict and the last refusal of each reaction request (a few kept), for reactionCurrent's grace and for the log.
const reactionLeaseSeen = new Map();
const LEASE_SHARING = new Set(['ENOENT', 'EPERM', 'EBUSY', 'EACCES']);
const LEASE_UNREADABLE_GRACE_MS = 1000;
function noteReactionLease(requestId, update) {
  const entry = {...reactionLeaseSeen.get(requestId), ...update};
  reactionLeaseSeen.delete(requestId); reactionLeaseSeen.set(requestId, entry);
  while (reactionLeaseSeen.size > 8) reactionLeaseSeen.delete(reactionLeaseSeen.keys().next().value);
}
// Why a reaction request stopped being current, when its lease said so (the add-on log line of a remark nobody heard).
const reactionLeaseRefusal = requestId => reactionLeaseSeen.get(requestId)?.problem ?? null;

async function tick() {
  if (polling || stopped || voiceRouteReservation || relationshipRouteReservation) return;
  polling = true;
  try {
    const reactionRequest = active;
    if (reactionRequest?.input.reaction && !await reactionCurrent(reactionRequest.input)
        && active === reactionRequest) reactionRequest.controller.abort();
    const stamp = await stat(inputPath).catch(() => null);
    if (!stamp) return;
    // An unchanged file identity needs no read of the (large) request.
    const stampIdentity = fileIdentity(stamp);
    if (stampIdentity === observedIdentity) return;
    const raw = await readFile(inputPath, 'utf8');
    const signature = `${stamp.mtimeMs}:${stamp.size}:${raw}`;
    if (signature === observed) { observedIdentity = stampIdentity; return; }
    const input = parseInput(raw);
    if (!input) {
      observed = signature; observedIdentity = stampIdentity;
      prefetch.invalidate();
      // Lua replaces this small file in place. A transient partial write is
      // not a new target and must not cancel an otherwise valid active turn.
      if (!active) await status('invalid-input', 'Could not parse the game request');
      return;
    }
    // input is parseInput's own result: hash it without parsing it again.
    const identity = parsedInputIdentity(input);
    if (identity === lastAcceptedIdentity) { observed = signature; observedIdentity = stampIdentity; return; }
    const lease = await reactionCurrent(input);
    // A missing/partial heartbeat has not accepted or rejected new input.
    // Leave its signature unseen so the next poll can retry the same file.
    if (lease === null) return;
    observed = signature; observedIdentity = stampIdentity;
    if (!lease) return;
    lastAcceptedIdentity = identity;
    void companionActions.revoke();
    active?.controller.abort();
    const owner = new RequestFileOwner(inputPath, raw, stamp);
    // The exact turn may already be generated and held back (group look-ahead):
    // adopt it instead of starting another provider request.
    const held = lookahead.claim(input, owner);
    if (held) {
      active = held; void cancelMicrophone();
      void measure(held.input, {claimedAt: Date.now(), lookahead: lookahead.stats(held.lookahead)});
      return;
    }
    const controller = new AbortController();
    const request = active = {input, raw, owner, controller, receivedAt: Date.now(), writtenAt: stamp.mtimeMs};
    // Native decision/history context is projected at actual submission. A
    // raw prediction cannot be substituted for that verified context.
    void processInput(request);
  } catch (error) { console.error('[CyberpunkConvai] Input poll:', error.message); }
  finally { polling = false; }
}

// Run the predicted next group speaker now, held back from the game until it
// submits that exact turn. The request carries the entry that gates publication.
function startAhead(entry) {
  const request = {input: entry.input, raw: null, owner: entry.owner, controller: entry.controller,
    receivedAt: entry.startedAt, lookahead: entry};
  void processInput(request);
  return request;
}

// Runs the turn under its own TurnClock, so every stage the turn reaches (here and in the text route, the voice, the PCM host
// and the continuous speech) lands in this turn's record (bridge/turn-clock.mjs). The clock watches the event loop until the
// turn is published.
async function processInput(request, prepared) {
  return withTurnClock(request, clock => runInput(request, prepared, clock));
}
async function withTurnClock(request, run) {
  stockCancel?.();   // a turn needs the text route now: a line being written ahead of time gives way
  const clock = new TurnClock({origin: request.receivedAt});
  if (Number.isFinite(request.writtenAt) && request.writtenAt <= request.receivedAt + 5) clock.mark('inputWritten', request.writtenAt);
  clock.mark('received', request.receivedAt);
  if (request.input?.requestId) turnClocks.set(request.input.requestId, clock);
  clock.watch({maxMs: 20_000});
  return withClock(clock, () => run(clock));
}

// An add-on speaker's turn (docs/ADDON_API.md): a remark the add-on asked for, or V talking to it. Text comes from Mistral or the local
// AI only (AddonHost.routeFor); with neither set up the game is told once (errorCode addon-provider). A remark that nearly repeats one
// of the speaker's recent lines is dropped silently (addon-duplicate). The voice is the speaker's local voice when there is one.
function addonTurnConfig(input, profile) {
  noteTurn(input);
  // A voice with no body (a cab's AI, persona.voiceContext) gets the voice form of the main mod's context: no "with V in person", no party
  // names outside a group round, no gear or journal (bridge/quest-context.mjs voiceConversationBlocks).
  const base = addonHost.usesVoiceContext(input.profileKey) ? voiceConversationBlocks(input) : intrinsicConversationContext.blocks(input);
  const blocks = [...base, ...addonHost.blocks(input)];
  return {text: input.reaction?.kind === 'addon' ? addonHost.trigger(input) : input.text, reaction: input.reaction,
    context: joinedContext(blocks), contextParts: contextPartsOf(blocks),
    local: {profileKey: input.profileKey, name: profile.name, channel: input.group ? 'group' : 'private'}};
}
// Stock (docs/ADDON_API.md, "Stock", bridge/addon-stock.mjs): while an add-on asks for prepared lines the model writes them ahead of
// the moment, one at a time, only while nothing else needs the machine, and only on Mistral (a background generation on the local AI
// would take the GPU from the game in the middle of a fight). Nothing here exists without add-ons or without a stock request.
const addonStock = addonHost.stock;
let stockTimer = null, stockCancel = null, stockRunning = false;
async function stockGenerate({profileKey, entry, mode, avoid, route}) {
  const owner = addonHost.speakers.get(profileKey), profile = profileFor({profileKey}, roster);
  if (!owner || !profile) throw Error('unknown add-on speaker');
  const prepared = avoid.length ? [{key: 'prepared', tier: 'volatile',
    text: `Lines already prepared for later (never repeat their jokes or wording):\n${avoid.map(line => `- ${line}`).join('\n')}`}] : [];
  const input = {profileKey, text: entry.text, reaction: {kind: 'addon', addon: owner.addon.id, speaker: owner.speaker.id, event: entry.key, expiresAt: Date.now() + 60_000, maxWords: entry.maxWords},
    addon: {id: owner.addon.id, speaker: owner.speaker.id, event: entry.key, text: entry.text, facts: entry.facts, maxWords: entry.maxWords,
      ...(mode ? {mode} : {}), blocks: [...entry.blocks, ...prepared], stock: true}};
  // A reaction is never recorded in the speaker's conversation memory (TextProviderHost.reply), so these lines leave no trace there.
  const config = addonTurnConfig(input, profile);
  config.text += (entry.slots.length ? ` Where a live number belongs, write it as a slot in curly braces, only these slots: ${entry.slots.map(name => `{${name}}`).join(' ')}.`
    : ' Do not use curly braces.') + ' Write one line for the moment this happens, to be spoken a few seconds from now; do not state anything that may already be untrue.';
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
  stockCancel = () => controller.abort();
  try {
    return (await addonTextHost(route, profileKey).reply(config, {signal: controller.signal})).text;
  } catch (error) {
    throw timedOut ? Error('the line took too long') : error;
  } finally { clearTimeout(timer); stockCancel = null; }
}
function stockTick() {
  if (!addonStock || stockRunning || stopped) return;
  if (!addonStock.size) { clearInterval(stockTimer); stockTimer = null; return; }
  stockRunning = true;
  // Outside the clock of whatever turn started this (the async context would carry its stage marks into the stock line).
  void withClock(undefined, () => addonStock.pump({now: Date.now, generate: stockGenerate, busy: () => stopped || voiceBoundaryBusy(),
    route: profileKey => { const route = addonHost.routeFor(profileKey, addonRouteState()); return route === 'mistral' ? route : null; }}))
    .then(result => { if (result.status === 'failed') console.error(`[Addons] Stock line for ${result.profileKey}/${result.key} not written: ${result.reason}`); })
    .catch(error => console.error('[Addons] Stock pump:', error.message))
    .finally(() => { stockRunning = false; });
}
// The state file changed (or was read again): the one-second pump timer runs while any entry is wanted and stops with the last one.
// The timer also covers lines going stale, which no event announces.
function stockWake() {
  if (!addonStock || stopped) return;
  if (addonStock.size && !stockTimer) { stockTimer = setInterval(stockTick, 1000); stockTimer.unref?.(); }
  stockTick();
}
if (addonStock) addonHost.onStock = stockWake;
async function runAddonTurn(request, input, profile, current, clock, {userText = ''} = {}) {
  const {controller} = request, ahead = request.lookahead, signal = controller.signal;
  const fail = (error, errorCode) => atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation, entity: input.entity,
    error, errorCode}), {signal, isCurrent: current, isCurrentSync: current.sync});
  addonHost.beginTurn(input);
  const route = addonHost.routeFor(profile.key, addonRouteState());
  if (!route) { await fail(addonHost.providerNotice(profile.key), 'addon-provider'); return; }
  const remark = input.reaction?.kind === 'addon';
  // The local AI keeps the default remark gap at about 20 s, so its GPU bursts stay rare beside the game (LOCAL_REMARK_GAP_S).
  const pace = remark ? addonHost.localPace(profile.key, route, undefined, input.reaction?.priority) : 0;
  if (pace > 0) {
    // gap is the spacing itself, so the game waits that long before it asks again instead of asking and being refused.
    await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation, entity: input.entity,
      error: '', errorCode: 'addon-pace', gap: LOCAL_REMARK_GAP_S, retryAfter: pace}), {signal, isCurrent: current, isCurrentSync: current.sync});
    return;
  }
  // A remark that never reaches the player (withdrawn by the game, cancelled while being written) is given back to the pace.
  const paceToken = remark ? addonHost.remarkStarted(profile.key, route) : null;
  let published = false;
  try {
  note(input, {receivedAt: request.receivedAt, preparation: {mode: ahead ? 'lookahead' : 'none'}, reaction: input.reaction?.phase, addonRoute: route});
  if (!ahead) void status('thinking', profile.name).catch(() => {});
  clock.mark('admitted');
  const host = addonTextHost(route, profile.key);
  // A remark that asked for stock uses a line the model wrote ahead (filled with this moment's numbers) when one is ready; with
  // none ready it is written now, exactly as without stock. Either way the pump gets a chance to refill soon after.
  const stocked = remark && input.addon?.stock && addonStock
    ? addonStock.take(profile.key, input.addon.event, {mode: addonHost.modeOf(profile.key)?.id ?? null, facts: input.addon.facts}) : null;
  if (remark && input.addon?.stock && addonStock) { note(input, {addonStock: stocked ? 'hit' : 'miss'}); stockWake(); }
  if (stocked) clock.mark('stock');
  const config = stocked ? (noteTurn(input), null) : addonTurnConfig(input, profile);
  const voiced = localVoice.playbackEnabled !== false && turnUsesLocal(input) && audioAvailable(await readSpeechStateCached());
  throwIfCancelled(signal);
  let result;
  if (voiced && !remark && replyStreaming && !ahead) {
    // A conversation streams its first sentence to the voice, like any text-provider turn.
    const stream = newReplyStream(config, profile);
    const final = Promise.resolve(host.reply(config, {signal, stream})).then(reply => ({...reply, transport: 'realtime'}));
    final.catch(() => {});
    result = await voiceStreamedReply(input, profile, {signal, current, stream, final, config, userText: () => userText});
  } else {
    const generate = async attempt => ({...await host.reply(attempt === input ? config : addonTurnConfig(attempt, profile), {signal}), transport: 'realtime'});
    const first = stocked ? {text: stocked, model: 'stock', finishReason: 'stop', transport: 'realtime'} : null;
    // A remark is checked against the speaker's recent lines before anything is spoken. One that nearly repeats a recent line is written
    // once more (with those lines named), unless that could not arrive before the remark goes stale; a conversation reply is never checked.
    const made = remark ? await addonHost.produce(input, generate, {first})
      : {reply: first ?? await generate(input), duplicate: false, retried: false};
    const reply = made.reply;
    if (made.retried) note(input, {addonRetry: made.duplicate ? 'still-repeated' : 'new-line'});
    if (made.duplicate) {
      console.error(`[Addons] ${profile.key}: remark dropped (${made.rule ? `it broke a rule: ${made.rule}` : 'it repeated a recent line'}${made.retried ? ', twice' : ''})`);
      await fail('', 'addon-duplicate');
      return;
    }
    result = voiced ? await synthesizeReply(input, reply, signal, current, profile) : {...reply, ttsEnabled: false};
  }
  if (ahead) { ahead.markReady(); await ahead.waitClaimed(signal); }
  if (!await current()) return;
  // A spoken turn carries the recognised words: a group round hands them to the next speakers (mod/group-chat.lua received).
  if (userText) result = {...result, userText};
  await measure(input, {resultReadyAt: Date.now(), requestToResultMs: Date.now() - request.receivedAt});
  if (await publishResult(input, profile, result, current, signal)) { published = true; addonHost.afterReply(input, result.text); }
  } finally {
    if (paceToken && !published && addonHost.remarkRefunded(paceToken)) {
      const refusal = reactionLeaseRefusal(input.requestId);
      console.error(`[Addons] ${profile.key}: remark ${input.addon?.event ?? '?'} did not reach the player${refusal ? ` (lease: ${refusal})` : ''}; it does not count towards the local pace`);
    }
  }
}

async function runInput(request, prepared, clock) {
  let input = request.input;
  const {controller} = request;
  // A conversation turn: the frame buffer stops capturing (the view is on the companion now); the turn takes a buffered frame.
  companionVision.beginTurn(input);
  const ahead = request.lookahead;
  const preparationStarted = performance.now();
  const stages = {};
  let knowledgeTurn;
  const current = async () => {
    if (controller.signal.aborted || (active !== request && !ahead?.isHeld()) || stopped) return false;
    // The complete request was validated once at admission. Its file identity,
    // and on any identity change its exact bytes, detect every replacement,
    // including changed context under the same request ID, without rereading
    // or reparsing the large journal on every playback poll and PCM packet.
    return await request.owner.current() && await reactionCurrent(input)
      && (!knowledgeTurn || await knowledgeRouter.current(knowledgeTurn));
  };
  current.sync = () => !controller.signal.aborted && (active === request || !!ahead?.isHeld()) && !stopped
    && (!knowledgeTurn || knowledgeRouter.currentSync(knowledgeTurn));
  // Group look-ahead: the speaker that follows this turn is prepared from its
  // complete text. This turn's file ownership outlives `active` (Omni keeps
  // playing after its production ends), so it is checked on its own.
  current.sourceValid = async () => !controller.signal.aborted && !stopped && await request.owner.current()
    && (!knowledgeTurn || await knowledgeRouter.current(knowledgeTurn));
  current.ahead = ahead;
  try {
    // A look-ahead turn runs beside the speaker still being heard. The
    // microphone and the companion action mailbox belong to the claimed turn.
    if (!ahead) await cancelMicrophone();
    stages.cancelMicrophoneMs = performance.now() - preparationStarted;
    throwIfCancelled(controller.signal);
    const profile = profileFor(input, roster);
    // An add-on speaker never takes the Convai path below (no knowledge route, no Convai memory or connection, no allowance).
    if (profile && addonHost.isSpeaker(profile.key)) { await runAddonTurn(request, input, profile, current, clock); return; }
    if (!profile || !ids[profile.key]) {
      await status('unmatched-npc', `No verified profile for ${input.name} (${input.bodyType})`);
      await atomic(replyPath, JSON.stringify({...input, text: undefined,
        error: `${input.name} does not have a conversation profile configured yet.`}), {signal: controller.signal, isCurrent: current, isCurrentSync: current.sync});
      return;
    }
    knowledgeTurn = await knowledgeRouter.prepare(input, {worldToken: worldSession?.token, generation: worldSession?.generation});
    stages.knowledgePreparedMs = performance.now() - preparationStarted;
    clock.mark('knowledge');
    input = knowledgeTurn.input; request.input = input; preparedInputs.set(input, knowledgeTurn);
    if (!await current()) return;
    // No speculative user turn may enter identified character memory.
    if (knowledgeTurn.remoteConfig?.endUserId) { prepared?.cancel(); prepared = undefined; }
    const memoryStarted = performance.now();
    const admission = await admitPlayerConversation(knowledgeTurn, {signal: controller.signal});
    stages.memoryAdmissionMs = performance.now() - memoryStarted;
    if (admission?.memory) stages.memory = admission.memory;
    await knowledgeRouter.submitted(knowledgeTurn);
    stages.submissionRecordedMs = performance.now() - preparationStarted;
    clock.mark('admitted');
    if (!await current()) return;
    // Only the first speaker of a group round may admit an action (sending
    // companions away), so a look-ahead skips the admission that would also
    // clear the mailbox beside the speaker still heard.
    if (!ahead) companionActions.admit(knowledgeTurn, {source: input.group ? 'group-text' : 'private-text', signal: controller.signal,
      isCurrent: async () => !stopped && !controller.signal.aborted && await knowledgeRouter.current(knowledgeTurn)
        && await request.owner.current(),
      isCurrentSync: () => !stopped && !controller.signal.aborted && knowledgeRouter.currentSync(knowledgeTurn)});
    rememberKnowledgeTurn(knowledgeTurn);
    note(input, {receivedAt: request.receivedAt, preparation: {mode: ahead ? 'lookahead' : prepared ? 'claimed' : 'none'},
      journalStatus: input.journal?.status || 'not-supplied', journalObjectives: input.journal?.quest?.objectives.length || 0,
      battleStatus: input.battle?.status || 'not-supplied', reaction: input.reaction?.phase});
    if (!ahead) void status('thinking', profile.name).catch(() => {});
    const canWarm = await audioReady(runtime);
    throwIfCancelled(controller.signal);
    // How warm this turn's page already was (opened at the talk key, the composer, a look or a partner).
    const turnRoute = realtimeConfig(input), connectionWarm = connections.warmState(input, turnRoute);
    // The speaker being heard already holds this round's group connections.
    if (canWarm && !ahead) await connections.setRequest(input, turnRoute);
    throwIfCancelled(controller.signal);
    clock.mark('transport');
    note(input, {transportRequestedAt: Date.now(), connectionWarm,
      submissionStages: {...stages, beforeTransportMs: performance.now() - preparationStarted}});
    // V's voice for typed lines starts only now, after the text request is under way: it runs beside the reply and never in front of it.
    let vLine = null;
    vVoice.noteGender(input);
    current.vLine = () => vLine;
    const replying = respond(input, profile, {signal: controller.signal, prepared, current});
    if (!ahead) vLine = vVoice.start(input, {signal: controller.signal, clock});
    const result = await replying;
    // Ready but not yet submitted by the game: hold until it is, or cancelled.
    // (Continuous speech already waited for this inside its own admission.)
    if (ahead) { ahead.markReady(); await ahead.waitClaimed(controller.signal); }
    // Do not show a late reply to a different target or a newer turn.
    if (!await current()) return;
    if (!result.liveDelivery?.generated) {
      await knowledgeRouter.activity(knowledgeTurn, 'generated-reply', {replyText: result.text});
      stagedKnowledgeTurn(knowledgeTurn, {replyText: result.text});
    }
    await measure(input, {resultReadyAt: Date.now(), requestToResultMs: Date.now() - request.receivedAt});
    await publishResult(input, profile, result, current, controller.signal);
  } catch (error) {
    // A look-ahead that fails before the game submits it publishes nothing;
    // the submitted turn then runs as an ordinary request.
    if (ahead?.isHeld()) { lookahead.fail(ahead); console.error('[CyberpunkConvai] Look-ahead turn failed:', error.message); return; }
    if (companionActions.pending?.packet.requestId === input?.requestId) void companionActions.revoke();
    if (!await current()) return;
    await status('error', error.message).catch(() => {});
    if (input) await atomic(replyPath, JSON.stringify({requestId: input.requestId,
      generation: input.generation, entity: input.entity,
      error: 'The conversation service could not reply. Please try again.', ...keyFailure(error, input)}), {signal: controller.signal, isCurrent: current, isCurrentSync: current.sync}).catch(() => {});
    console.error('[CyberpunkConvai] Bridge request failed:', error.message);
  } finally {
    if (knowledgeTurn && (controller.signal.aborted || !await current())) await cancelKnowledgeTurn(knowledgeTurn);
    if (active === request) active = null;
  }
}

let lastAudioHeartbeat = 0;
async function pollPrefetch() {
  if (prefetchPolling || stopped || memoryQuiescing) return;
  prefetchPolling = true;
  try {
    prefetch.prune();
    // Lua publishes party membership before releasing an attached invitation.
    // Read its reservation first, then the later membership publication so the
    // prepared private page survives the ownership handoff in this poll.
    let invitationRequest;
    try { invitationRequest = JSON.parse(await readFile(resolve(runtime, 'companion-invitations.json'), 'utf8')); } catch {}
    const partyRaw = await readFile(partyPath, 'utf8').catch(() => '');
    let partySnapshot; try { partySnapshot = JSON.parse(partyRaw); } catch {}
    if (partyRaw && partyRaw !== partyObserved) {
      const change = connections.ingest(partySnapshot);
      if (change) {
        partyObserved = partyRaw;
        if (change.removed.includes(active?.input.profileKey)) active.controller.abort();
        if (change.removed.length) dropPrefetch();
      }
    }
    // A Windows replace can briefly leave a file absent. Preserve the last
    // fresh reservation on that frame; expiry/world guards still fail closed.
    if (parsePartyConnections(partySnapshot)) invitations.ingest(invitationRequest);
    await invitations.poll();
    // Keep invitation/world leases fresh during page reconciliation; composer
    // warmup and speculative turns resume after the reservation finishes.
    if (voiceRouteReservation || relationshipRouteReservation) return;
    await connections.maintain();
    if (partyWasFresh && connections.stale) {
      dropPrefetch(); active?.controller.abort(); await mic.cancel(); await realtime.close();
    }
    partyWasFresh = !connections.stale;
    const speech = await readSpeechState();
    if (speech.available && Date.now() - speech.updated < 5000) lastAudioHeartbeat = Date.now();
    else if (lastAudioHeartbeat && Date.now() - lastAudioHeartbeat > 5000) {
      lastAudioHeartbeat = 0; dropPrefetch();
      active?.controller.abort(); await connections.clear(); await realtime.close();
    }
    if (speech.state === 'playing' && Date.now() - speech.updated < 5000) speechPlayingAt = Date.now();   // a reply is playing: no capture
    const row = latency.get(speech.requestId);
    if (row && speech.state === 'playing' && speech.position > 0 && !row.nativePlaybackObserved) {
      turnMark(speech.requestId, 'playbackObserved');
      await measure({requestId: speech.requestId, profileKey: row.profile}, {nativePlaybackObserved: true,
        nativePlaybackFirstObservedAt: Date.now(), nativePlaybackPositionSeconds: speech.position,
        nativePlaybackStartEstimateAt: Date.now() - speech.position * 1000});
    }
    // A composer hint only opens connections. It contains no text and cannot
    // generate a response, touch persistent dialogue or enable the microphone.
    const hintRaw = await readFile(prewarmPath, 'utf8').catch(() => '');
    if (hintRaw !== prewarmObserved && !active && !mic.current && !micPolling) {
      prewarmObserved = hintRaw;
      let hint; try { hint = parsePrewarm(JSON.parse(hintRaw), ids); } catch {}
      if (!hint) { companionVision.closeComposer(); await connections.setComposer(null); }
      else if (await audioReady(runtime)) {
        if (mic.current || micPolling || stopped) { prewarmObserved = ''; return; }
        // A private hint for an ambient NPC carries its entity: open that NPC's own route now, while V types.
        const config = hint.scope === 'private' && hint.entity ? ambientWarmConfig(hint.audience[0], hint.entity) : null;
        vVoice.warmUp();
        const opening = connections.setComposer(config ? {...hint, config} : hint);
        // The surroundings picture goes onto the target pages now, while V types (retried while a page still connects).
        companionVision.openComposer(composerPages(hint, config));
        await opening;
      }
    }
    await nearbyWarm.apply(await readFile(nearbyPath, 'utf8').catch(() => ''));
  } finally { prefetchPolling = false; }
}

// The game publishes the turn it will submit for the next group speaker as soon
// as the speaker being heard has complete reply text (and clears the file when
// that prediction stops being valid). Run that turn now, held back from the
// game, so the speaker change no longer pays a whole provider request.
let lookaheadPolling = false, lookaheadWaiting = {raw: '', at: 0}, lookaheadHandled = '';
async function pollLookahead() {
  if (lookaheadPolling || stopped || memoryQuiescing || voiceRouteReservation || relationshipRouteReservation || singleSession()) return;
  lookaheadPolling = true;
  try {
    lookahead.prune();
    const raw = await readFile(prefetchPath, 'utf8').catch(() => '');
    if (raw === prefetchObserved || raw === lookaheadHandled) return;
    let command;
    try { command = JSON.parse(raw); } catch { prefetchObserved = raw; dropPrefetch(); return; }
    // `{}` withdraws the prediction: audience change, an undelivered or
    // interrupted speaker, a new message or a dismissal.
    if (!command?.input) { prefetchObserved = raw; dropPrefetch(); return; }
    const source = lookahead.source;
    if (!source || source.input.requestId !== command.sourceRequestId) {
      // The source reply is recorded just before the game can see it complete;
      // allow a late arrival a moment before giving up on this prediction.
      if (lookaheadWaiting.raw !== raw) lookaheadWaiting = {raw, at: Date.now()};
      if (Date.now() - lookaheadWaiting.at < 1500) return;
    }
    prefetchObserved = raw;
    const predicted = validateLookahead(command, source);
    // A recording microphone owns the device; the first speaker's own reply
    // phase (which this prediction follows) does not.
    const micAllows = !mic.current || (mic.current.finishing && mic.current.requestId === source?.input.requestId);
    if (!predicted || !micAllows || !Object.hasOwn(ids, predicted.profileKey) || !profileFor(predicted, roster)
        || !await source.current() || !await audioReady(runtime) || stopped) {
      dropPrefetch(); return;
    }
    lookaheadHandled = raw;
    lookahead.offer(predicted);
  } finally { lookaheadPolling = false; }
}

const deliveredReceipts = new Set();
const pendingDeliveryReceipts = new Map();
// After a reply is confirmed heard: a one-shop vendor remembers the exchange. Never throws into delivery bookkeeping.
async function rememberVendorTurn(entry) {
  if (!entry.exchange?.replyText) return;
  try {
    const prepared = entry.prepared, key = vendorMemoryKey(prepared);
    if (!key) return;
    // A microphone turn is remembered by its recognized words only, never by the "[Microphone]" placeholder.
    const spoken = prepared.route.transport === 'microphone' || prepared.input.source === 'microphone';
    await vendorMemory.remember({memoryKey: key, profileKey: prepared.route.profileKey,
      playerText: spoken ? entry.exchange.userText : prepared.input.text, replyText: entry.exchange.replyText,
      isCurrent: () => !stopped && !memoryQuiescing && knowledgeRouter.currentSync(prepared)});
  } catch { /* Memory is a convenience; the conversation never depends on it. */ }
}
async function recordDelivery(receipt) {
  if (!receipt || receipt.version !== 1 || typeof receipt.requestId !== 'string') return;
  const entry = knowledgeTurns.get(receipt.requestId);
  if (!entry?.generated || entry.cancelled || receipt.partial !== false || receipt.cancelled !== false) return;
  const input = entry.prepared.input;
  const phoneReceipt = entry.prepared.route?.channel === 'phone';
  if (phoneReceipt ? receipt.source !== 'phone-ui' || receipt.state !== 'accepted'
    : !['native-playback', 'continuous-playback'].includes(receipt.source) || receipt.state !== 'completed'
      || !Number.isSafeInteger(receipt.totalChunks) || receipt.totalChunks < 1 || receipt.totalChunks > 10000
      || receipt.completedChunks !== receipt.totalChunks) return;
  if (receipt.source === 'continuous-playback'
    && (receipt.backend !== 'browser-pcm' || receipt.totalChunks !== 1)) return;
  if (['native-playback', 'continuous-playback'].includes(receipt.source)
      && (receipt.entity !== input.entity || receipt.generation !== input.generation)) return;
  if (receipt.source === 'phone-ui' && receipt.profileKey !== input.profileKey) return;
  const id = JSON.stringify([receipt.source, receipt.requestId, receipt.id || receipt.sequence]);
  if (deliveredReceipts.has(id)) return;
  if (pendingDeliveryReceipts.has(id)) return pendingDeliveryReceipts.get(id);
  const task = (async () => {
    const result = await knowledgeRouter.activity(entry.prepared, 'delivered-reply', receipt);
    if (result?.status === 'unavailable') return;
    entry.delivered = true;
    deliveredReceipts.add(id);
    while (deliveredReceipts.size > 128) deliveredReceipts.delete(deliveredReceipts.values().next().value);
    await rememberVendorTurn(entry);
  })();
  pendingDeliveryReceipts.set(id, task);
  try { return await task; }
  finally { if (pendingDeliveryReceipts.get(id) === task) pendingDeliveryReceipts.delete(id); }
}
async function pollKnowledge() {
  if (knowledgePolling || stopped) return;
  knowledgePolling = true;
  try {
    const session = await readWorldSession(resolve(runtime, 'world-session.json'));
    const priorWorld = worldSession?.ready ? JSON.stringify([worldSession.token, worldSession.generation]) : null;
    worldSession = session;
    const nextWorld = worldSession?.ready ? JSON.stringify([worldSession.token, worldSession.generation]) : null;
    if (priorWorld && priorWorld !== nextWorld) {
      memoryQuiescing++;
      try { await resetLiveRoutes(); }
      finally { memoryQuiescing--; }
    }
    const speech = await readSpeechState();
    if (Number.isFinite(speech.updated) && Date.now() - speech.updated < 5000) await recordDelivery(speech.lastDelivery);
    let phoneDelivery;
    try { phoneDelivery = JSON.parse(await readFile(resolve(runtime, 'knowledge-phone-delivery.json'), 'utf8')); } catch {}
    if (phoneDelivery?.version === 1 && Number.isFinite(phoneDelivery.updated) && Date.now() - phoneDelivery.updated < 5000
      && Array.isArray(phoneDelivery.receipts) && phoneDelivery.receipts.length <= 16) {
      for (const receipt of phoneDelivery.receipts) await recordDelivery(receipt);
    }
    await atomic(resolve(runtime, 'knowledge-status.json'), JSON.stringify({version: 1, updated: Date.now(),
      reason: nextWorld ? 'current-world' : 'world-unavailable',
      bound: playerMemory.status().available === true, identifiedMemory: true,
      memoryMode: 'natural-conversations', providerIdLimit: 1,
      rules: knowledgePack.rules.filter(rule => rule.reviewed && /verified$/.test(rule.status)).length,
      worldGeneration: worldSession?.generation, currentWorld: !!nextWorld}));
  } finally { knowledgePolling = false; }
}

// An existing request belongs to an earlier game/mod session; process only new input.
const initial = await stat(inputPath).catch(() => null);
if (initial) {
  const raw = await readFile(inputPath, 'utf8');
  observed = `${initial.mtimeMs}:${initial.size}:${raw}`; observedIdentity = fileIdentity(initial);
  const input = parseInput(raw); if (input) lastAcceptedIdentity = parsedInputIdentity(input);
}
const controlPath = resolve(stateDirectory, 'bridge-control.json');
let controlsObserved = await readFile(controlPath, 'utf8').catch(() => '');
let settingsPolling = false, lastVoiceHeartbeat = 0;
const voicePreview = new VoicePreviewLease();
// Lip sync delay (Bluetooth), bridge/audio-delay.mjs. The resolved value goes to
// every browser renderer through its control and to the game (Omni/Audioware
// path) through runtime/audio-delay.json, read once per utterance.
let audioDelaySetting = 'auto', audioOutput = null, audioDelayPublished = '';
const audioWatch = new AudioOutputWatch({onChange: output => { audioOutput = output; void applyAudioDelay(); }});
async function applyAudioDelay() {
  // The probe starts with the first conversation turn, not at idle startup. It runs only while the delay is automatic and voice
  // playback is on: a hand-set delay or silence has nothing to measure, and its PowerShell process would only wake every minute.
  if (audioDelaySetting === 'auto' && localVoice.playbackEnabled !== false) { if (active) audioWatch.start(); }
  else audioWatch.suspend();
  const delayMs = resolveDelayMs(audioDelaySetting, audioOutput);
  if (setAudioDelayMs(delayMs)) console.error(`Lip sync delay: ${delayMs} ms (${audioDelaySetting}${audioOutput ? `, ${audioOutput.bluetooth ? 'Bluetooth' : 'not Bluetooth'}: ${audioOutput.name}` : ''})`);
  const document = JSON.stringify({version: 1, delayMs: audioDelayMs(), setting: audioDelaySetting,
    bluetooth: audioOutput?.bluetooth ?? null});
  if (document === audioDelayPublished) return;
  audioDelayPublished = document;
  await atomic(resolve(runtime, 'audio-delay.json'), document).catch(() => { audioDelayPublished = ''; });
}
// The key in use changes here, and only when no turn, microphone, preparation or route change is running: connections
// and conversation sessions belong to the account of the key that opened them, so all of them are retired together.
let keySwitching = false;
async function applyKeyChoice() {
  if (keySwitching || stopped || !keys.pending || voiceBoundaryBusy() || voiceRouteReservation) return;
  keySwitching = true;
  try {
    const own = keys.requested.source === 'player';
    keys.apply();
    memoryProvider.use({key: keys.current(), own, backend: keys.usesBackend});
    quota.clear();
    dropPrefetch(); prefetchObserved = '';
    await Promise.allSettled([realtime.close(), phoneRealtime.close()]);
    sessions.clear(); realtimeSessions.clear();
    await phone.forgetSessions().catch(() => {});
    console.error(`[CyberpunkConvai] Conversation key: ${own ? "the player's own" : "the installation's"}`);
    rewarmLocalVoice();
    await ownKeyControl.publishStatus().catch(() => {});
  } finally { keySwitching = false; }
}
// The conversation provider in use changes here, and only when nothing is running (same boundary as the Convai key): Convai
// sessions belong to the provider that opened them, so they are retired together. The transcript is kept.
let providerSwitching = false;
async function applyProviderChoice() {
  if (providerSwitching || stopped || !mistral.pending || voiceBoundaryBusy() || voiceRouteReservation) return;
  providerSwitching = true;
  try {
    mistral.apply();
    // The cloud provider's connection (DNS, TCP, TLS) opens now, not in front of the first turn (docs/LATENCY_2026-10-13.md, 4.5/4.7).
    if (mistral.active && mistral.route === 'mistral') void warmTurnConnections({provider: mistral.route});
    dropPrefetch(); prefetchObserved = '';
    await Promise.allSettled([realtime.close(), phoneRealtime.close()]);
    sessions.clear(); realtimeSessions.clear();
    await phone.forgetSessions().catch(() => {});
    console.error(`[CyberpunkConvai] Conversation provider: ${mistral.applied}`);
    rewarmLocalVoice();
    // Leaving the local AI gives its graphics memory back at once; arriving loads it (a first start compiles shaders for a while).
    if (mistral.applied === 'local') void localServer.ensure({background: true}).catch(() => {});
    else void localServer.stop().catch(() => {});
    // Back to Convai: the memory search's embedding process (CPU) is not needed either, and goes now instead of after its five idle minutes.
    // Add-on speakers answer through the text routes whatever the provider is, so with an add-on installed it stays on its idle timer.
    if (!mistral.active && !addonHost.active) void localEmbedder.close().catch(() => {});
    await mistralControl.publishStatus().catch(() => {});
  } finally { providerSwitching = false; }
}
// Resources the current settings do not use are released (docs/RESOURCE_LIFECYCLE.md). Due-checked from the 500 ms settings poll: a few property
// reads, nothing per frame, never while a turn, microphone or preparation is running (the page releases wait for the next poll).
//   - The facial model's worker thread leaves at once when voice playback is turned Off (V speaks no face) and comes back
//     at the first poll after playback is turned on.
//   - V's line renderer page closes when V's voice is off (or has no clips), and with the companions' page when playback is Off.
//   - The hidden browser closes when nothing uses it for BROWSER_IDLE_MS: no Convai page in the pool or kept for the party, no
//     recording, no renderer turn, and (text provider with playback on) no wish to keep the local voice's renderer warm.
const BROWSER_IDLE_MS = 300_000;
let releasingUnused = false;
async function releaseUnused() {
  if (releasingUnused || stopped) return;
  releasingUnused = true;
  try {
    const muted = localVoice.silent;
    if (jaliFace) { if (muted) await jaliFace.suspend(); else if (!jaliFace.active) void jaliFace.resume(); }
    if (voiceBoundaryBusy() || voiceRouteReservation || keySwitching || providerSwitching) return;
    await realtime.releaseRendererPages({line: !vVoice.enabled || !vVoice.available, companion: muted});
    const keepRenderer = mistral.active && localVoice.playbackEnabled !== false;
    await realtime.releaseIfIdle({idleMs: BROWSER_IDLE_MS, keepRenderer});
    await phoneRealtime.releaseIfIdle({idleMs: BROWSER_IDLE_MS});
  } finally { releasingUnused = false; }
}
// The Local AI model choice (bridge/local-model-choice.mjs), looked at on the settings poll: the pin from settings.json, Mature content and
// the Mature pack decide it, and the list of installed models is published for the settings page (at most every 5 s). A change while Local AI is
// the provider reloads the model at an idle moment (never mid-reply); with another provider the next start reads it. No polling of the server.
const localModelSizes = new Map();
const localModelSizeMiB = file => {
  if (!localModelSizes.has(file)) { try { localModelSizes.set(file, statSync(file).size / 1048576); } catch { return 0; } }
  return localModelSizes.get(file);
};
const installedLocalModels = () => describeLocalModels(listLocalModels({pack: localPack, matureModels: maturePackModels, customModels: customScan.models}), localModelSizeMiB);
// The model the settings page shows as selected when none was chosen (the largest that fits) and the one turning Mature content on selects.
// The free memory is what the last start saw before it loaded its model; until there was a start, the card's total stands in.
const localModelDefaults = () => defaultModelIds({models: listLocalModels({pack: localPack, matureModels: maturePackModels, customModels: customScan.models}),
  matureOn: matureContent.enabled, freeMiB: localServer.lastFreeMiB ?? localServer.totalVramMiB ?? cardTotalMiB, totalMiB: localServer.totalVramMiB ?? cardTotalMiB, sizeOf: localModelSizeMiB});
const customModelProblems = () => customScan.problems.map(({name, reason}) => ({name: String(name).slice(0, 60), reason}));
// The card's total memory marks a custom model that can never fit, and stands in for the free memory in the model the page shows as
// selected. The first start reads it from llama-server; before that one nvidia-smi call (once a minute at most, and only while more than
// one model is installed) stands in.
async function learnCardTotal() {
  if (localServer.totalVramMiB || cardTotalMiB || installedLocalModels().length < 2 || Date.now() - cardAskedAt < 60000) return;
  cardAskedAt = Date.now();
  cardTotalMiB = await nvidiaTotalMiB().catch(() => null);
}
let localModelChoiceKey = null, localModelListKey = '', localModelListCheckedAt = 0;
async function syncLocalModelChoice(settings) {
  if (!settings || typeof settings !== 'object') return;   // a partial settings write: keep what is chosen
  const pin = normalisePin(settings.localModel);
  if (pin !== localModelPin) { localModelPin = pin; localModelFallbackNoted = ''; console.error(`[LocalAI] model choice is now ${pin}`); }
  const choiceKey = `${localModelPin}|${matureContent.enabled}|${matureContent.pack}`;
  if (choiceKey !== localModelChoiceKey) {
    const first = localModelChoiceKey === null;
    localModelChoiceKey = choiceKey;
    if (!first && mistral.applied === 'local') void localServer.reselect().catch(() => {});
  }
  if (Date.now() - localModelListCheckedAt >= 5000) {
    localModelListCheckedAt = Date.now();
    refreshLocalPack();
    scanCustomModels();
    await learnCardTotal();
    const listKey = JSON.stringify([installedLocalModels(), localModelDefaults(), customModelProblems()]);
    if (listKey !== localModelListKey) { localModelListKey = listKey; await mistralControl.publishStatus().catch(() => {}); }
  }
}
let speechCheckedAt = 0;
async function pollSettings(checkShutdown = true) {
  if (settingsPolling || stopped) return;
  settingsPolling = true;
  try {
    // Read the draft first. Apply saves settings before withdrawing its lease,
    // so a completed Apply cannot be combined with an older settings snapshot
    // and accidentally retire the already-warmed model.
    const preview = voicePreview.observe(await readFile(resolve(runtime, 'voice-preview.json'), 'utf8').catch(() => ''));
    // A transient rename/partial settings write must not reset the selected quality.
    const raw = await readFile(resolve(runtime, 'settings.json'), 'utf8').catch(() => '');
    let settings; try { settings = JSON.parse(raw); } catch {}
    // Own Convai key: the setting and the settings page's commands, then the switch itself once nothing is running.
    if (settings) {
      if (keys.setPreference(settings.useOwnConvaiKey === true)) await ownKeyControl.publishStatus().catch(() => {});
      await ownKeyControl.poll().catch(() => {});
      await applyKeyChoice();
      // Convai's free plans carry no multilingual support: conversations use the original characters, not the twins.
      if (keys.singleSession) settings = {...settings, multilingualConversations: false};
      // Conversation provider (docs/MISTRAL.md): the setting and the settings page's commands, then the switch itself.
      if (mistral.setPreference(settings.conversationProvider)) {
        if (mistral.preference === 'local') prepareLocal();
        // Choosing another provider unloads the local model at once when it is not answering turns (it was loaded ahead by prepareLocal and
        // never applied, or the player changed their mind); when it is answering, applyProviderChoice unloads it at the next idle boundary.
        else if (mistral.localUnused) void localServer.stop().catch(() => {});
        await mistralControl.publishStatus().catch(() => {});
      }
      await mistralControl.poll().catch(() => {});
      if (Date.now() - speechCheckedAt > 10000) {
        speechCheckedAt = Date.now();
        const stt = mistralSpeech?.available() === true;
        if (stt !== mistral.sttAvailable) { mistral.sttAvailable = stt; await mistralControl.publishStatus().catch(() => {}); }
      }
      await applyProviderChoice();
      if (mistral.active) {
        // A local voice: Pocket speaks when the Convai cloud voice is selected (there is no Convai audio), and
        // the twins (another Convai character per language) are not used.
        settings = {...settings, multilingualConversations: false, ...(settings.voiceProvider === 'convai' ? {voiceProvider: 'pocket'} : {})};
      }
    }
    if (settings) { audioDelaySetting = settingDelay(settings); await applyAudioDelay(); }
    if (settings) youtubeTv?.setEnabled(settings.youtubeTv === true);
    // Dialogue level match (docs/DIALOGUE_LEVEL.md): makeup gain for every voice.
    if (updateDialogueLevel(await readFile(resolve(runtime, 'dialogue-level.json'), 'utf8').catch(() => '')))
      console.error(`Dialogue level: ${JSON.stringify(dialogueLevel())}`);
    const relationshipState = await readFile(resolve(runtime, 'relationship-state.json'), 'utf8').catch(() => undefined);
    if (relationshipRoutes.update(settings, relationshipState,
        {boundary: currentBoundary(), busy: voiceBoundaryBusy() || voiceRouteReservation})) {
      dropPrefetch(); prefetchObserved = '';
    }
    // Every phrase of an accepted turn keeps its original provider and quality.
    // Microphone startup and input polling also own a boundary before `active`.
    if (localVoice.update(settings, preview, voiceBoundaryBusy())) {
      dropPrefetch(); prefetchObserved = '';
    }
    // A prepared reply was written under the previous Natural speech instructions.
    const speechChanged = naturalSpeech.update(settings), emotionsChanged = expressiveEmotions.update(settings);
    const followUpChanged = followUp.update(settings);
    if (followUpChanged) console.error(`[FollowUp] setting is now ${followUp.enabled ? 'on' : 'off'}`);
    if (vVoice.update(settings)) console.error(`[VVoice] setting is now ${vVoice.enabled ? 'on' : 'off'}`);
    if (companionVision.update(settings)) console.error(`[Vision] setting is now ${companionVision.enabled ? 'on' : 'off'} (${companionVision.transport})`);
    localVoice.setVHelperWanted(vVoice.enabled && vVoice.available);
    void releaseUnused().catch(error => console.error('[CyberpunkConvai] Releasing unused resources:', error.message));
    const matureBefore = matureContent.enabled, packBefore = matureContent.pack;
    if (maturePackInstalled() !== packBefore) await mistralControl.publishStatus().catch(() => {});   // the settings help says whether the uncensored models are installed
    const matureChanged = matureContent.update(settings) || matureContent.enabled !== matureBefore;
    if (matureChanged) console.error(`[MatureContent] setting is now ${matureContent.enabled ? 'on' : 'off'}`);
    // The guard's patterns compile on first use (about a second); do that now, in the background, not inside the first Mature turn.
    if (matureChanged && matureContent.enabled) void warmMatureGuard();
    await syncLocalModelChoice(settings);
    if (speechChanged) console.error(`[NaturalSpeech] setting is now ${naturalSpeech.enabled ? 'on' : 'off'}`);
    if (emotionSelection.update(settings)) console.error(`Facial emotion selector: ${emotionSelection.mode}`);
    if (settings && typeof settings === 'object') replyStreaming = settings.replyStreaming !== false && !replyStreamingForcedOff;
    // Multilingual conversations changes which voice a turn uses (and so its instructions).
    // (The voice selection reads the same setting: while it is on, a fallback never lands on Pocket.)
    const multilingualChanged = multilingual.update(settings);
    if (speechChanged || emotionsChanged || multilingualChanged || followUpChanged) { dropPrefetch(); prefetchObserved = ''; }
    if (matureChanged) { dropPrefetch(); prefetchObserved = ''; }
    refreshWarmVoices();
    await syncRelationshipRoutes(); await syncVoiceRoutes();
    publishRelationshipRoutes();
    if (Date.now() - lastVoiceHeartbeat >= 5000) {
      lastVoiceHeartbeat = Date.now(); localVoice.publish(localVoice.state);
    }
    const control = await readFile(controlPath, 'utf8').catch(() => '');
    if (control !== controlsObserved) {
      controlsObserved = control;
      let command; try { command = JSON.parse(control); } catch {}
      if (checkShutdown && command?.action === 'shutdown' && command.pid === process.pid) void shutdown();
      if (command?.action === 'diagnostics' && command.pid === process.pid) {
        const pendingAction = companionActions.pending;
        await atomic(resolve(stateDirectory, 'bridge-diagnostics.json'), JSON.stringify({version: 1, updated: Date.now(),
          action: {admitted: !!pendingAction, accepted: pendingAction?.accepted === true,
            current: !!pendingAction && companionActions.current(pendingAction),
            profile: pendingAction?.input?.profileKey ?? null},
          vision: companionVision.diagnostics(), pages: await realtime.diagnostics()}));
      }
    }
  } finally { settingsPolling = false; }
}
const ownKeyControl = await new OwnKeyControl({keys, quota, daily: turnGuard, commandPath: resolve(runtime, 'own-key-command.json'),
  publish: value => atomic(resolve(runtime, 'own-key-state.json'), JSON.stringify(value))}).open();
quota.onChange = () => { void ownKeyControl.publishStatus().catch(() => {}); };
const mistralControl = await new MistralControl({provider: mistral, commandPath: resolve(runtime, 'mistral-key-command.json'),
  inworldCommandPath: resolve(runtime, 'inworld-key-command.json'), localStatus: localAiStatus, maturePack: () => maturePackInstalled(), localModels: installedLocalModels, localModelDefaults, localModelProblems: customModelProblems, model: () => MISTRAL_MODEL, publish: value => atomic(resolve(runtime, 'mistral-state.json'), JSON.stringify(value))}).open();
mistral.onChange(() => { void mistralControl.publishStatus().catch(() => {}); });
const memoryControl = await PlayerMemoryControl.open({memory: playerMemory,
  commandPath: resolve(runtime, 'memory-command.json'),
  chatResetPath: resolve(runtime, 'memory-chat-resets.json'),
  chatResetFamilies: relationshipRoutes.providerFamilies,
  publish: value => atomic(resolve(runtime, 'memory-status.json'), JSON.stringify(value))});
// Help > Generate report: a redacted zip of versions, status and log tails.
// The key and provider IDs are passed only so they can be scrubbed from it.
const supportReport = await SupportReportControl.open({game, runtime, stateDirectory, project,
  secrets: () => [...keys.secrets(), ...mistral.secrets()], knownIds: () => Object.values(relationshipRoutes.providerIds ?? ids),
  bridge: () => ({busy: !!active, microphoneActive: !!mic.current})});
// Settings > Edit characters: a local page, served only while it is open (bridge/character-editor-server.mjs).
const characterEditor = new CharacterEditor({personas: personaBook, overrides: characterOverrides, memory: mistralMemory, route: () => mistral.route});
const editorControl = await EditorControl.open({server: new EditorServer({editor: characterEditor, log: message => console.error('[Editor] ' + message)}),
  commandPath: resolve(runtime, 'editor-command.json'), statusPath: resolve(runtime, 'editor-status.json'),
  log: message => console.error('[Editor] ' + message)});
// YouTube on V's TV: nothing starts until the player picks YouTube on a TV in V's home (runtime/youtube-tv-command.json).
// While a video plays it ducks for the conversation: a turn running, the microphone open or a reply being spoken.
youtubeTv = await new YouTubeTv({runtime, stateDirectory, browserExecutable: process.env.CYBERPUNK_CONVAI_BROWSER,
  audible: async () => !!(active || mic.current) || ((await readSpeechStateCached().catch(() => ({})))?.state ?? 'idle') !== 'idle',
  log: message => console.error('[YouTubeTv] ' + message)}).start();
// While a video is on, the TV is what companions see (about a frame a second, docs/COMPANION_VISION.md "The TV").
companionVision.setScreenSource(youtubeTv.visionSource());
await companionActions.revoke();
await status('waiting');
await pollSettings(false);
await pollKnowledge();
void localVoice.start().catch(error => console.error('[CyberpunkConvai] Local voice startup:', error.message));
// A text route (Mistral, the local AI) opens no Convai connection, so nothing else starts the hidden browser that renders the
// local voice; the first reply would wait for it (about a second and a half under a running game). Start it now.
if (mistral.active && localVoice.playbackEnabled !== false) void realtime.prewarmLocal();
console.log('[CyberpunkConvai] Convai conversation bridge ready');
// A poll is one stat of the request file until Lua replaces it, so a short
// interval costs little and removes up to 150 ms from every turn's start.
const timer = setInterval(tick, 50);
const micTimer = setInterval(() => { void pollMicrophone().catch(error => console.error('[CyberpunkConvai] Microphone poll:', error.message)); }, 150);
const prefetchTimer = setInterval(() => { void pollPrefetch().catch(error => console.error('[CyberpunkConvai] Preparation poll:', error.message)); }, 150);
const lookaheadTimer = setInterval(() => { void pollLookahead().catch(error => console.error('[CyberpunkConvai] Look-ahead poll:', error.message)); }, 60);
// Add-ons only: the state and settings files are also read once a second, in case the directory watcher missed a change.
const addonTimer = addonHost.active ? setInterval(() => { for (const read of Object.values(addonHost.watchHandlers(runtime))) void read(); }, 1000) : null;
addonTimer?.unref?.();
// A poll that is still running when the service closes is rejected with 'Voice service is closed': expected at shutdown, not a fault.
const settingsTimer = setInterval(() => { void pollSettings().catch(error => { if (!stopped) console.error('[CyberpunkConvai] Settings poll:', error.message); }); }, 500);
const phoneTimer = setInterval(() => { void pollPhone().catch(error => console.error('[CyberpunkConvai] Phone poll:', error.message)); }, 150);
// The status file the game reads can be held open by the game for a moment (Windows refuses the rename: EPERM/EBUSY); the next poll
// writes it again, so the same message is logged at most once a minute, with how many were left out.
let knowledgePollQuiet = {message: '', at: 0, skipped: 0};
function logKnowledgePoll(error) {
  const message = String(error?.message ?? error);
  const kind = message.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '*');   // the temp file name differs every time
  const now = Date.now();
  if (kind === knowledgePollQuiet.message && now - knowledgePollQuiet.at < 60_000) { knowledgePollQuiet.skipped++; return; }
  const skipped = knowledgePollQuiet.skipped;
  knowledgePollQuiet = {message: kind, at: now, skipped: 0};
  console.error('[CyberpunkConvai] Knowledge poll:', message + (skipped ? ` (${skipped} more of the same were not logged)` : ''));
}
const knowledgeTimer = setInterval(() => { void pollKnowledge().catch(logKnowledgePoll); }, 500);
const memoryTimer = setInterval(() => { void memoryControl.poll().catch(error => console.error('[CyberpunkConvai] Memory control:', error.message)); }, 500);
const supportTimer = setInterval(() => { void supportReport.poll().catch(error => console.error('[CyberpunkConvai] Support report:', error.message)); }, 500);
// The same polls run a few milliseconds after the game replaces their file (bridge/file-wake.mjs): a typed or spoken turn and a
// phone message no longer wait half an interval (25 ms for the request, 75 ms for the microphone and the phone) to be seen.
// The intervals above stay as the fallback. The watcher never keeps the process alive.
watchFiles(runtime, {
  'last-input.json': tick,
  'microphone-command.json': () => pollMicrophone().catch(error => console.error('[CyberpunkConvai] Microphone poll:', error.message)),
  'phone-chat-input.json': () => pollPhone().catch(error => console.error('[CyberpunkConvai] Phone poll:', error.message)),
  // The game's playback lease releases the first sound: the playback pump polls the moment it is written (docs/LATENCY_2026-10-13.md, 4.2).
  'continuous-control.json': () => leaseWake.fire(),
  'youtube-tv-command.json': () => youtubeTv.poll().catch(error => console.error('[YouTubeTv] Command poll:', error.message)),
  // The add-on state and settings the game writes (docs/ADDON_API.md); no entries without add-ons.
  ...addonHost.watchHandlers(runtime),
}, {log: message => console.error('[CyberpunkConvai] ' + message)});
const editorTimer = setInterval(() => { void editorControl.poll().catch(error => console.error('[CyberpunkConvai] Character editor:', error.message)); }, 500);
const youtubeTimer = setInterval(() => { void youtubeTv.poll().catch(error => console.error('[YouTubeTv] Command poll:', error.message)); }, 500);
async function shutdown() {
  if (stopped) return;
  await companionActions.revoke();
  stopped = true; active?.controller.abort(); dropPrefetch(); audioWatch.stop(); tokenSource?.stop();
  companionVision.stop();
  settleVoiceRouteWaiters(Error('Voice service is closed'));
  phone.close(); clearInterval(phoneTimer);
  phoneKnowledge.clear();
  clearInterval(knowledgeTimer);
  clearInterval(memoryTimer);
  clearInterval(supportTimer); supportReport.close();
  clearInterval(editorTimer); await editorControl.close().catch(() => {});
  clearInterval(youtubeTimer); await youtubeTv.close().catch(() => {});
  clearInterval(timer); clearInterval(micTimer); clearInterval(prefetchTimer); clearInterval(lookaheadTimer); clearInterval(settingsTimer);
  if (stockTimer) { clearInterval(stockTimer); stockTimer = null; }
  stockCancel?.();
  await invitations.clear('service-stopped');
  await voiceRouteSync.catch(() => {});
  await relationshipRouteSync.catch(() => {});
  await Promise.allSettled([localVoice.close(), mic.cancel(), connections.clear(), mistralSpeech.close()]);
  await Promise.allSettled([realtime.close(), phoneRealtime.close(), jaliFace?.close()]);
  mistralHost.close();
  await mistralMemory.flush().catch(() => {});
  await Promise.allSettled([localServer.stop(), localEmbedder.close()]);
  await vendorMemory.idle().catch(() => {});
  await memoryControl.close(); await playerMemory.close();
  await Promise.allSettled([metricsWriting, connectionMetricsWriting, voiceMetricsWriting]);
  await status('stopped'); process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
// However the bridge ends, the model servers it started end with it (their graphics memory must not stay taken).
process.on('exit', () => { try { localServer.killSync(); localEmbedder.killSync?.(); } catch { /* best effort */ } });
