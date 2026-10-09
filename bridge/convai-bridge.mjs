import {readFile, stat, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {archetypeContext, isAmbientProfile, parseInput, profileFor} from './protocol.mjs';
import {audioReady} from './speech-audio.mjs';
import {buildFacialTimeline} from './facial-timeline.mjs';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';
import {PhoneticLipsync} from './phonetic-lipsync.mjs';
import {JaliFace} from './jali-face.mjs';
import {textExpressionSignal} from './text-emotion.mjs';
import {planSignal, phraseOffsets, traitFor} from './emotion-analysis.mjs';
import {EmotionSelection, waitLateEmotion} from './emotion-selector.mjs';
import {SpeechSlots, SpeechStream, splitSpeechText} from './speech-stream.mjs';
import {deliverPocketSpeech} from './pocket-speech.mjs';
import {ownedPocketFace} from './pocket-facial-stream.mjs';
import {RealtimeHost} from './realtime-host.mjs';
import {MicrophoneSession} from './microphone-session.mjs';
import {randomUUID} from 'node:crypto';
import {conversationScope} from './group-context.mjs';
import {conversationContext as baseConversationContext} from './quest-context.mjs';
import {createIntrinsicConversationContext, loadIntrinsicCharacterContext} from './intrinsic-character-context.mjs';
import {battleTrigger, reactionLeaseValid} from './battle-context.mjs';
import {GroupPrefetch, parsedInputIdentity, parsePrewarm} from './group-prefetch.mjs';
import {GroupLookahead, validateLookahead, waitUntil, BufferedPcm} from './group-lookahead.mjs';
import {abortable, throwIfCancelled} from './transport-pool.mjs';
import {PartyConnections, parsePartyConnections} from './party-connections.mjs';
import {NearbyWarm} from './nearby-warm.mjs';
import {CompanionInvitations} from './companion-invitations.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {VoiceRoutingLog, ROUTING_LOG_NAME, describeVoiceRoute} from './voice-routing-log.mjs';
import {variantSeed} from './voice-variants.mjs';
import {NaturalSpeech, OMNI_TAGS, omniTagsFor, speechPhrases} from './natural-speech.mjs';
import {FollowUp} from './follow-up.mjs';
import {ExpressiveEmotions} from './expressive-emotions.mjs';
import {resolveVoiceConfigPaths} from './voice-config-paths.mjs';
import {detectOmniPack} from './omni-pack.mjs';
import {ResidentPhoneAnalysis} from './resident-phone-analysis.mjs';
import {VoicePreviewLease} from './voice-preview.mjs';
import {PhoneChat, parsePhoneState, phoneRecentConversationContext} from './phone-chat.mjs';
import {GameLaunchIdentity, identifyGameLaunch} from './game-launch.mjs';
import {PlayerMemory} from './player-memory.mjs';
import {VendorMemory, vendorMemoryKey} from './vendor-memory.mjs';
import {PlayerMemoryApi} from './player-memory-api.mjs';
import {PlayerMemoryControl} from './player-memory-control.mjs';
import {SupportReportControl} from './support-report.mjs';
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
const voiceConfigPaths = resolveVoiceConfigPaths(stateDirectory);
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
const localVoice = new VoiceSelection(voiceConfig, {project, configPath: localVoiceConfigPath,
  phoneAnalysis: jaliFace ? undefined : phoneAnalysis,
  pythonExecutable: voiceConfig.runtime?.pythonExecutable,
  omniConfigs:omniVoiceConfigs,omniConfigPaths:voiceConfigPaths.omni,previewSettleMs:1500,
  // The optional OmniVoice pack (worker Python, model weights, adapter); Settings greys Omni out without it.
  omniPack:()=>detectOmniPack({project,config:omniVoiceConfigs.long}),
  profileKeys:roster.map(profile=>profile.key),
  onState: state => {
    voiceMetricsWriting = voiceMetricsWriting.catch(() => {}).then(() => atomic(resolve(runtime, 'local-voice-state.json'), JSON.stringify(state)));
    return voiceMetricsWriting;
  },
  onLog: message => process.stderr.write('[LocalVoice] ' + message),
});
const keyLine = (await readFile(keyFile, 'utf8')).trim();
const key = /^api-key\s*=\s*(\S+)\s*$/i.exec(keyLine)?.[1];
if (!key) throw Error('Local Convai key file must contain api-key=...');
await mkdir(runtime, {recursive: true});

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
  historicalPairAllowed: ({profileKey, characterId}) => playerMemory?.hasContactedProviderPair(profileKey, characterId) === true});
playerMemory = await PlayerMemory.open({path: resolve(stateDirectory, 'player-memory.json'),
  characterIds: relationshipRoutes.providerIds, characterFamilies: relationshipRoutes.providerFamilies,
  provider: memoryProvider, quiesce: quiescePlayerMemory, retired: providerKey => RETIRED_PROVIDER_KEY.test(providerKey)});
const knowledgeRouter = new PlayerKnowledge({playerMemory, pack: knowledgePack, questCatalog,
  isWorldCurrent: worldCurrent, getBoundary: currentBoundary,
  selectProfile: (profile, boundary) => relationshipRoutes.select(profile, boundary)});
const phoneKnowledge = new PlayerPhoneKnowledge({router: knowledgeRouter, getBoundary: currentBoundary});
// "Natural speech": the setting, and the display text of every reply with voice tags removed (bridge/natural-speech.mjs).
const naturalSpeech = new NaturalSpeech();
// "Expressive emotions": the character marks its own feelings inline; the marks drive the face (bridge/expressive-emotions.mjs).
const expressiveEmotions = new ExpressiveEmotions();
// "Follow-up questions": the character sometimes shows interest in the player inside the reply it is already giving (bridge/follow-up.mjs).
const followUp = new FollowUp();
// Facial emotion selection (bridge/emotion-selector.mjs): player message + reply + character manner + Convai's own
// label; `emotionSelector: "legacy"` in settings.json returns to the reply-only planner.
const emotionSelection = new EmotionSelection();
const cleanReply = result => expressiveEmotions.process(naturalSpeech.process(result));
// "Multilingual conversations": the setting and the language the conversation was last in (bridge/multilingual.mjs).
const multilingual = new MultilingualConversations();
const phoneRealtime = new RealtimeHost({transformReply: cleanReply});
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
    const admitted = await admitPlayerConversation(prepared, {signal: options.signal});
    await knowledgeRouter.submitted(prepared);
    throwIfCancelled(options.signal);
    if (!await knowledgeRouter.current(prepared)) throw Error('Phone world changed');
    rememberKnowledgeTurn(prepared);
    void companionActions.revoke();
    const result = await phoneRealtime.reply({key, characterId: options.characterId,
      sessionId: admitted.reconnectRequired ? undefined : options.sessionId,
      scope: prepared.scope, ...remote,
      context: conversationContext(prepared.input),
      text: options.input.text, ttsEnabled: false}, {signal: options.signal});
    if (!await knowledgeRouter.current(prepared)) throw Error('Phone world changed');
    await knowledgeRouter.activity(prepared, 'generated-reply', {replyText: result.text});
    stagedKnowledgeTurn(prepared);
    return result;
  },
  publish: (value, options) => atomic(phoneOutput, JSON.stringify(value), options),
  sessions: phoneSessions, saveSessions: value => atomic(phoneSessionPath, JSON.stringify(value)),
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
  } finally { phonePolling = false; }
}

const inputPath = resolve(runtime, 'last-input.json');
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
const readSpeechState = async () => {
  try { return JSON.parse(await readFile(resolve(runtime, 'speech-state.json'), 'utf8')); } catch { return {}; }
};
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
const realtime = new RealtimeHost({onCompanionAction: packet => companionActions.deliver(packet),
  transformReply: cleanReply});
let observed = '', observedIdentity = null;
let lastAcceptedIdentity = '';
let polling = false, active = null, stopped = false;
let prefetchPolling = false, prefetchObserved = '', partyObserved = '', partyWasFresh = false;
let prewarmObserved = await readFile(prewarmPath, 'utf8').catch(() => '');
const latency = new Map();
let metricsWriting = Promise.resolve();
let connectionMetricsWriting = Promise.resolve();

const preparedInputs = new WeakMap();
const intrinsicConversationContext = createIntrinsicConversationContext({baseContext: baseConversationContext,
  intrinsic: intrinsicHistory, resolveAdmission: input => preparedInputs.get(input),
  isCurrentSync: prepared => knowledgeRouter.currentSync(prepared)});
// Natural speech: the devices the CURRENT voice engine can render, for spoken replies only. Phone chat is text,
// battle and loot reactions are short barks, and the Convai cloud voice cannot follow it (it would read tags aloud).
// The voice of each turn (bridge/multilingual.mjs). Decided once per submitted turn, the first time it is needed, so
// the context (tags or none), the Convai TTS flag and the delivery all agree. With Multilingual conversations off it
// is exactly the character's chosen voice; on (Settings keep the voice on OmniVoice or the cloud voice), a turn in
// another language never reaches Pocket, and a cloud-voice turn never gets tag instructions.
const turnVoices = new Map();
const localChoice = profile => ({uses: localVoice.usesProfile(profile), provider: localVoice.provider});
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
const naturalSpeechContext = input => {
  const prepared = preparedInputs.get(input);
  const phone = input.channel === 'phone' || prepared?.route?.channel === 'phone';
  const spoken = !phone && !input.reaction && localVoice.playbackEnabled !== false;
  const engine = turnVoice(input).engine;
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
// A returning shopkeeper's memory of V (bridge/vendor-memory.mjs): only private text/voice turns of a one-shop vendor.
const vendorMemoryContext = prepared => {
  const key = vendorMemoryKey(prepared);
  return key ? vendorMemory.contextFor({memoryKey: key, profileKey: prepared.route.profileKey}) : '';
};
const conversationContext = input => {
  const prepared = preparedInputs.get(input), admitted = prepared && knowledgeRouter.currentSync(prepared);
  return [intrinsicConversationContext(input), archetypeContext(input), admitted ? vendorMemoryContext(prepared) : '',
    admitted ? relationshipContext(prepared.relationship, prepared.route.channel,
      {group: prepared.input.group, audience: prepared.route.audience,
        worldToken: prepared.worldToken, generation: prepared.generation}) : '',
    admitted && prepared.route.channel === 'phone' ? phoneRecentConversationContext(prepared.input) : '',
    // Follow-up questions go before the voice notes: after "keep the same length and content" they lost most of their effect
    // (scripts/Probe-FollowUp.mjs: a pull in 16 of 26 offered turns here, against 13 of 41 after them).
    followUpContext(input), naturalSpeechContext(input), expressiveEmotionsContext(input),
    // Multilingual conversations: the reply language, last so it outweighs the English notes above.
    multilingual.contextFor(input.reaction ? '' : input.text)]
    .filter(Boolean).join('\n\n');
};
const boundaryFor = input => ({entity: input?.entity,
  worldToken: input?.worldKnowledge?.worldToken || worldSession?.token,
  generation: input?.worldKnowledge?.generation || worldSession?.generation});
const routeFor = input => preparedInputs.get(input)
  || knowledgeRouter.configFor(input.profileKey, conversationScope(input), boundaryFor(input));
const sessionKey = input => routeFor(input)?.sessionKey || JSON.stringify(['unavailable', input.profileKey, input.requestId]);
const completeContext = input => JSON.stringify([conversationContext(input), routeFor(input)?.guard?.characterId, realtimeSessions.get(sessionKey(input)) || null,
  turnUsesLocal(input) ? 'local' : 'convai']);
const realtimeConfig = input => ({key, characterId: routeFor(input)?.guard?.characterId, sessionId: realtimeSessions.get(sessionKey(input)),
  scope: routeFor(input)?.scope || conversationScope(input), ...(routeFor(input)?.remoteConfig || {}),
  context: conversationContext(input), text: battleTrigger(input), reaction: input.reaction,
  companionAction: companionActions.configFor(input),
  ttsEnabled: localVoice.playbackEnabled!==false&&!turnUsesLocal(input)});
const warmRoute = (profile, scope) => memoryQuiescing ? null : knowledgeRouter.configFor(profile, scope,
  {worldToken: worldSession?.token, generation: worldSession?.generation});
// The exact private route of one physical ambient NPC (a generic resident or npc-* archetype has no route without
// its entity). It has the transport identity of the turn later submitted to that NPC, so the page warmed while V
// types or looks at the NPC is the page that turn uses (docs/NPC_ARCHETYPES.md, "Latency").
const ambientWarmConfig = (profile, entity) => {
  if (memoryQuiescing || !isAmbientProfile(profile) || typeof entity !== 'string') return null;
  const route = knowledgeRouter.configFor(profile, 'private', {entity, worldToken: worldSession?.token, generation: worldSession?.generation});
  return route ? {key, characterId: route.guard.characterId, scope: route.scope, ...(route.remoteConfig || {}),
    sessionId: realtimeSessions.get(route.sessionKey), ttsEnabled: warmUsesConvaiVoice(profile)} : null;
};
const connections = new PartyConnections({host: realtime,
  canWarm: () => !stopped && !memoryQuiescing && !active && !mic.current && !micPolling && !lookahead.busy,
  isKnown: profile => Object.hasOwn(ids, profile) && !!warmRoute(profile, 'private'),
  configFor: (profile, scope) => {
    const route = warmRoute(profile, scope);
    if (!route) throw Error('No current world for conversation warmup');
    return {key, characterId: route.guard.characterId, scope: route.scope, ...(route.remoteConfig || {}),
      sessionId: realtimeSessions.get(route.sessionKey), ttsEnabled: warmUsesConvaiVoice(profile)};
  },
  onState: state => {
    connectionMetricsWriting = connectionMetricsWriting.catch(() => {}).then(() => atomic(resolve(runtime, 'party-connection-state.json'), JSON.stringify(state)));
    return connectionMetricsWriting;
  },
});
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
    if (receipt.provider !== 'convai') {
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
  latency.set(input.requestId, {...previous, ...values});
  while (latency.size > 24) latency.delete(latency.keys().next().value);
  // No dialogue, API keys or character session IDs are written to metrics.
  metricsWriting = metricsWriting.catch(() => {}).then(() => atomic(resolve(runtime, 'bridge-latency.json'), JSON.stringify({
    version: 1, updated: Date.now(), turns: [...latency.values()],
  })));
  return metricsWriting;
}

const prefetch = new GroupPrefetch({prepare: async (input, {signal}) => {
  // The SDK has no session fork/rollback. Existing sessions are warm-only so
  // cancelled predictions cannot alter memory or erase conversation history.
  if (realtimeConfig(input).endUserId || realtimeSessions.has(sessionKey(input))) throw Error('Identified or existing character session is warm-only');
  // Local speech belongs to the submitted turn's game admission, never a
  // predicted future turn. The cached result remains text until respond().
  return {...await realtime.prepare(realtimeConfig(input), {signal}), transport: 'realtime'};
}});
// Speaker N+1 of a group round is generated while N is still audible, then held
// until the game submits that exact turn (docs/GROUP_VOICE.md, Look-ahead).
const lookahead = new GroupLookahead({start: entry => startAhead(entry)});
const dropPrefetch = () => { prefetch.invalidate(); lookahead.cancel(); };

async function synthesizeReply(input, result, signal, current, profile = profileFor(input, roster), receiptPrepared = preparedInputs.get(input)) {
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
  emotionSelection.remember(input.profileKey, plan);
  expressionReceipt(plan, result.expressionSignal, {convai: result.expressionSignal?.basis === 'ordered' || result.expressionSignal?.basis === 'response-id'
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
      const first=synthesizeOmniPhrase(voiceKey,voiced[0],{signal,steps,language});
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
  if ((await readSpeechState()).continuousAvailable !== true) {
    logVoiceRoute(input, profile, {engine: 'none', language: voice.language}, {reason: 'local streaming unavailable: written reply only'});
    return {...result, audio: undefined, faces: [], captions: [],
      audioError: 'Local streaming is unavailable; showing the written reply.'};
  }
  logVoiceRoute(input, profile, voice);
  const speech = continuousSpeech(input, profile, current, signal, receiptPrepared, true, result.emotionMarks, {player, late});
  let prefetched;
  if (ahead?.isHeld()) {
    // Synthesize now, into memory (the one renderer page may still be draining
    // the previous speaker); the whole text is still sent to Pocket once.
    // Pocket's worker is FIFO, so this runs right after the prior speaker's job.
    prefetched = new BufferedPcm({signal, synthesize: (onPcm, options) => localVoice.synthesizeStream(voiceKey, result.text, {...options, onPcm})});
    prefetched.start().then(() => ahead.markReady(), () => {});
    try {
      await ahead.waitClaimed(signal);
      // The previous speaker's renderer may still be retiring its page.
      await waitUntil(() => !realtime.localPcmBusy, {signal, timeoutMs: 3000});
    } catch (error) { prefetched.discard(); throw error; }
  }
  return deliverPocketSpeech({input, profile, voiceKey, result, current, signal, voice: localVoice, host: realtime, speech,
    phoneAnalysis:localVoice.phoneAnalysis,jaliFace,prefetched,
    onAnalysis: timing => measure(input, {localLipAnalysis: timing})});
}

async function synthesizeOmniPhrase(profile,text,options){
  const generated=await localVoice.synthesize(profile,text,options);
  if(jaliFace)try{
    const facial=await jaliFace.analyseWav(generated.audio,{...options,text});// the phrase as voiced, tags included
    return {...generated,...facial,timing:{...generated.timing,...facial.timing,voiceProvider:'omni'}};
  }catch(error){
    throwIfCancelled(options?.signal);console.error('[CyberpunkConvai] Facial model fallback:',error.message);
  }
  try{
    const facial=await lipsync.analyse(generated.audio,options);
    return {...generated,...facial,timing:{...generated.timing,...facial.timing,voiceProvider:'omni'}};
  }catch(error){
    throwIfCancelled(options?.signal);console.error('[CyberpunkConvai] Omni lip-sync fallback:',error.message);
    return {...generated,timing:{...generated.timing,voiceProvider:'omni'}};
  }
}

async function status(state, detail = '') {
  await atomic(statusPath, JSON.stringify({state, detail: detail.slice(0, 200), updated: Date.now()}));
}

function continuousSpeech(input, profile, current, signal, receiptPrepared = preparedInputs.get(input), local = false, marks,
  {player = input.text, late} = {}) {
  const options = {signal, isCurrent: current, isCurrentSync: current.sync};
  const ahead = current.ahead;
  const speech = new ConvaiContinuousSpeech({input, profile, current, signal,
    planExpression: emotionSelection.planner({player, profile: input.profileKey, marks, late}),
    ...(local ? {faceBuilder: ownedPocketFace} : {jaliFace}),
    // A look-ahead turn buffers silently until the game submits it. Once its
    // complete text is known (and it is no longer held), the next group speaker
    // may be prepared from that text.
    hold: () => ahead?.isHeld() === true,
    onHeld: (bufferedSeconds, textComplete) => { if (bufferedSeconds >= 0.4 && textComplete) ahead?.markReady(); },
    onText: (text, userText) => {
      if (typeof userText === 'string') noteKnowledgeTurn(receiptPrepared, {userText});
      lookahead.setSource({input, text, userText, current: current.sourceValid || current});
    },
    readControl: () => readFile(resolve(runtime, 'continuous-control.json'), 'utf8'),
    writeState: value => atomic(resolve(runtime, 'continuous-speech.json'), JSON.stringify(value), options),
    writeFace: value => atomic(resolve(runtime, 'continuous-face.json'), JSON.stringify(value), options),
    faceFile: async () => (await readSpeechState()).continuousFaceFile === true,
    writeReply: value => atomic(replyPath, JSON.stringify(value), options),
    onPublished: timing => measure(input, {...timing, stream: {mode: local ? 'pocket-continuous' : 'convai-continuous'}, nativePlaybackObserved: false}),
    onStarted: timing => measure(input, {...timing, continuousPlaybackObserved: true}),
    onGenerated: async text => {
      // Microphone context refresh creates a new projection at finish. Its
      // generated/delivered receipts still belong to the original submitted
      // turn, shared by every channel of this conversation.
      if (!receiptPrepared || !await current()) throw Error('Conversation receipt owner changed');
      await knowledgeRouter.activity(receiptPrepared, 'generated-reply', {replyText: text});
      stagedKnowledgeTurn(receiptPrepared, {replyText: text});
    },
  });
  // Poll the buffered turn at once when the game submits it.
  ahead?.claimed.then(() => speech.wakeUp(), () => {});
  return speech;
}

// Original remote PCM has a continuous renderer. It never enters Omni's text
// splitter, local TTS worker or per-phrase Audioware file queue.
async function convaiReply(input, profile, current, signal) {
  logVoiceRoute(input, profile, {engine: 'convai', language: turnVoice(input).language});
  const state = await readSpeechState();
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

async function respond(input, profile, {signal, prepared, current} = {}) {
  if (localVoice.playbackEnabled!==false&&await audioReady(runtime)) {
    if (prepared) {
      let cached;
      try { cached = await prepared; }
      catch { throwIfCancelled(signal); /* Failed speculation falls back to the submitted turn. */ }
      // Once a cached turn enters audible local playback, failure must not
      // submit that same prompt to Convai again or replay another response.
      if (cached) return synthesizeReply(input, cached, signal, current, profile);
    }
    throwIfCancelled(signal);
    if (!turnUsesLocal(input)) return convaiReply(input, profile, current, signal);
    return synthesizeReply(input, {...await realtime.reply(realtimeConfig(input), {signal}), transport: 'realtime'}, signal, current, profile);
  }
  prefetch.invalidate(); prepared?.cancel();
  throwIfCancelled(signal);
  // Text-only replies keep the same identified transport when native playback
  // is unavailable; legacy HTTP does not document the player-memory binding.
  return {...await realtime.reply({...realtimeConfig(input), ttsEnabled: false}, {signal}), transport: 'realtime'};
}

async function publishResult(input, profile, result, current = async () => true, signal) {
  if (!await current()) return false;
  // The language of this exchange predicts the next turn without text (reactions, warm connections).
  if (!input.reaction) multilingual.observe(input.text);
  multilingual.observe(result.text);
  logNaturalSpeech(input, result);
  logFollowUp(input, result);
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
  let audio, face, stream, audioError = result.audioError;
  if (result.audio) {
    try {
      if(result.streamPlan){
        stream=new SpeechStream({input,...result.streamPlan,slots,readState:readSpeechState,current,signal,
          writeManifest:document=>writeStreamManifest(document,current),
          synthesize:(text,options)=>synthesizeOmniPhrase(result.streamPlan.voiceKey??profile.key,text,{...options,language:result.streamPlan.language})});
        const first=await stream.begin(result);audio=first.audio;face=first.face;
      }else{
        const id=randomUUID();await slots.begin(id,current);audio=await slots.write(id,1,result.audio,current);
      }
      if (!await current()) { stream?.closeQueue(); return false; }
      try { face ??= buildFacialTimeline(result, input); }
      catch (error) { console.error('[CyberpunkConvai] Facial timing unavailable:', error.message); }
      await atomic(resolve(runtime, 'last-speech-timing.json'), JSON.stringify({
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
    stream:stream?.descriptor(),updated: Date.now()}), {signal, isCurrent: current, isCurrentSync: current.sync});
  if (!committed || !await current()) { stream?.closeQueue(); return false; }
  (result.transport === 'realtime' ? realtimeSessions : sessions).set(sessionKey(input), result.sessionID);
  if (result.transport === 'realtime') connections.used(input, result.timing);
  prefetch.published(input, result.text);
  // Reconsider the prediction file after a source reply becomes valid.
  prefetchObserved = '';
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
let micObserved = await readFile(micPath, 'utf8').catch(() => '');
let micPolling = false;
const mic = new MicrophoneSession({hostFactory: () => realtime.voiceChannel(),
  onState: (state, input) => atomic(resolve(runtime, 'microphone-state.json'), JSON.stringify({state, requestId: input.requestId, updated: Date.now()})),
  prepareReply: async (input, signal) => {
    if(localVoice.playbackEnabled===false||turnUsesLocal(input)||(await readSpeechState()).continuousAvailable!==true)return;
    const prepared = microphoneKnowledge.get(input.requestId);
    const current = async () => {
      if (stopped || signal.aborted || mic.current?.requestId !== input.requestId || !prepared) return false;
      let command; try { command = JSON.parse(await readFile(micPath, 'utf8')); } catch { return false; }
      return command.input?.requestId === input.requestId && command.action === 'finish'
        && await knowledgeRouter.current(prepared);
    };
    current.sync = () => !stopped && !signal.aborted && mic.current?.requestId === input.requestId
      && prepared && knowledgeRouter.currentSync(prepared);
    const speech = continuousSpeech(input, profileFor(input, roster), current, signal, prepared);
    microphoneSpeech.set(input.requestId, speech);
    return {liveSpeech: speech.options};
  },
  onReply: async (input, result, signal) => {
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
    const spoken = await synthesizeReply(input, {...result, transport: 'realtime',
      ...(speech ? {liveDelivery: {published: speech.published, ended: speech.ended,
        generated: speech.generated, id: speech.token}} : {})}, signal, current, profileFor(input, roster), prepared);
    if (!spoken.liveDelivery?.generated) {
      await knowledgeRouter.activity(prepared, 'generated-reply', {replyText: result.text});
      stagedKnowledgeTurn(prepared, {replyText: result.text, userText: result.userText});
    }
    await publishResult(input, profileFor(input, roster), spoken, current, signal);
    microphoneSpeech.delete(input.requestId);
  },
  onError: async (input, error) => {
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
    await atomic(resolve(runtime, 'microphone-state.json'), JSON.stringify({state: 'error', requestId: input.requestId, updated: Date.now()}), {isCurrent: current, isCurrentSync: current.sync});
    await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation,
      entity: input.entity, error: 'Voice conversation failed. Check your microphone and try again.'}), {isCurrent: current, isCurrentSync: current.sync});
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
}

async function quiescePlayerMemory({signal, scope} = {}) {
  throwIfCancelled(signal);
  memoryQuiescing++;
  try {
    await resetLiveRoutes();
    throwIfCancelled(signal);
    // Forget all memories also forgets what shopkeepers remember of V. PlayerMemory has already persisted the reset
    // epoch and fenced every character, so a turn begun earlier can no longer write; a failed removal fails the clear.
    if (scope === 'all' && (await vendorMemory.forgetAll()).ok !== true) throw Error('Vendor memory could not be cleared');
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
  if (prepared.providerMemory === 'session-only') {
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
      if (command.action === 'cancel') {
        if (mic.current?.requestId === input.requestId) await cancelMicrophone();
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
      else {
        const profile = profileFor(input, roster);
        if (!profile || !ids[profile.key] || !await audioReady(runtime)) {
          await mic.onError(input, Error('Voice service or character is unavailable')); return;
        }
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
      if (!owner || !await knowledgeRouter.current(owner) || !await audioReady(runtime)) await cancelMicrophone();
      // Lua's 30-second finish captures fresh native context. Never let the
      // bridge timeout submit the old start snapshot first. Allow its command
      // two seconds to arrive; a missing command cancels the recording.
      else if (recording.opened && Date.now() - recording.opened >= 32000 && recording.intent !== 'finish') {
        await cancelMicrophone();
      }
    }
  } finally { micPolling = false; }
}

async function reactionCurrent(input) {
  if (!input.reaction) return true;
  // CET replaces the heartbeat by removing then renaming its file. Retry
  // that brief gap, but never retry an explicit cancellation or stale lease.
  for (let attempt = 0; attempt < 3; attempt++) {
    let lease;
    try { lease = JSON.parse(await readFile(resolve(runtime, 'reaction-lease.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) return false;
      if (attempt === 2) return null; // Unreadable, rather than a cancelled request.
      await new Promise(done => setTimeout(done, 15));
      continue;
    }
    return reactionLeaseValid(input, lease);
  }
}

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
    const request = active = {input, raw, owner, controller, receivedAt: Date.now()};
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

async function processInput(request, prepared) {
  let input = request.input;
  const {controller} = request;
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
    if (!profile || !ids[profile.key]) {
      await status('unmatched-npc', `No verified profile for ${input.name} (${input.bodyType})`);
      await atomic(replyPath, JSON.stringify({...input, text: undefined,
        error: `${input.name} does not have a conversation profile configured yet.`}), {signal: controller.signal, isCurrent: current, isCurrentSync: current.sync});
      return;
    }
    knowledgeTurn = await knowledgeRouter.prepare(input, {worldToken: worldSession?.token, generation: worldSession?.generation});
    stages.knowledgePreparedMs = performance.now() - preparationStarted;
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
    if (!await current()) return;
    // Only the first speaker of a group round may admit an action (sending
    // companions away), so a look-ahead skips the admission that would also
    // clear the mailbox beside the speaker still heard.
    if (!ahead) companionActions.admit(knowledgeTurn, {source: input.group ? 'group-text' : 'private-text', signal: controller.signal,
      isCurrent: async () => !stopped && !controller.signal.aborted && await knowledgeRouter.current(knowledgeTurn)
        && await request.owner.current(),
      isCurrentSync: () => !stopped && !controller.signal.aborted && knowledgeRouter.currentSync(knowledgeTurn)});
    rememberKnowledgeTurn(knowledgeTurn);
    await measure(input, {receivedAt: request.receivedAt, preparation: {mode: ahead ? 'lookahead' : prepared ? 'claimed' : 'none'},
      journalStatus: input.journal?.status || 'not-supplied', journalObjectives: input.journal?.quest?.objectives.length || 0,
      battleStatus: input.battle?.status || 'not-supplied', reaction: input.reaction?.phase});
    if (!ahead) await status('thinking', profile.name);
    const canWarm = await audioReady(runtime);
    throwIfCancelled(controller.signal);
    // How warm this turn's page already was (opened at the talk key, the composer, a look or a partner).
    const turnRoute = realtimeConfig(input), connectionWarm = connections.warmState(input, turnRoute);
    // The speaker being heard already holds this round's group connections.
    if (canWarm && !ahead) await connections.setRequest(input, turnRoute);
    throwIfCancelled(controller.signal);
    await measure(input, {transportRequestedAt: Date.now(), connectionWarm,
      submissionStages: {...stages, beforeTransportMs: performance.now() - preparationStarted}});
    const result = await respond(input, profile, {signal: controller.signal, prepared, current});
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
      error: 'The conversation service could not reply. Please try again.'}), {signal: controller.signal, isCurrent: current, isCurrentSync: current.sync}).catch(() => {});
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
    const row = latency.get(speech.requestId);
    if (row && speech.state === 'playing' && speech.position > 0 && !row.nativePlaybackObserved) {
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
      if (!hint) await connections.setComposer(null);
      else if (await audioReady(runtime)) {
        if (mic.current || micPolling || stopped) { prewarmObserved = ''; return; }
        // A private hint for an ambient NPC carries its entity: open that NPC's own route now, while V types.
        const config = hint.scope === 'private' && hint.entity ? ambientWarmConfig(hint.audience[0], hint.entity) : null;
        await connections.setComposer(config ? {...hint, config} : hint);
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
  if (lookaheadPolling || stopped || memoryQuiescing || voiceRouteReservation || relationshipRouteReservation) return;
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
  // The probe starts with the first conversation turn, not at idle startup.
  if (audioDelaySetting === 'auto' && active) audioWatch.start();
  const delayMs = resolveDelayMs(audioDelaySetting, audioOutput);
  if (setAudioDelayMs(delayMs)) console.error(`Lip sync delay: ${delayMs} ms (${audioDelaySetting}${audioOutput ? `, ${audioOutput.bluetooth ? 'Bluetooth' : 'not Bluetooth'}: ${audioOutput.name}` : ''})`);
  const document = JSON.stringify({version: 1, delayMs: audioDelayMs(), setting: audioDelaySetting,
    bluetooth: audioOutput?.bluetooth ?? null});
  if (document === audioDelayPublished) return;
  audioDelayPublished = document;
  await atomic(resolve(runtime, 'audio-delay.json'), document).catch(() => { audioDelayPublished = ''; });
}
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
    if (settings) { audioDelaySetting = settingDelay(settings); await applyAudioDelay(); }
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
    if (speechChanged) console.error(`[NaturalSpeech] setting is now ${naturalSpeech.enabled ? 'on' : 'off'}`);
    if (emotionSelection.update(settings)) console.error(`Facial emotion selector: ${emotionSelection.mode}`);
    // Multilingual conversations changes which voice a turn uses (and so its instructions).
    // (The voice selection reads the same setting: while it is on, a fallback never lands on Pocket.)
    const multilingualChanged = multilingual.update(settings);
    if (speechChanged || emotionsChanged || multilingualChanged || followUpChanged) { dropPrefetch(); prefetchObserved = ''; }
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
          pages: await realtime.diagnostics()}));
      }
    }
  } finally { settingsPolling = false; }
}
const memoryControl = await PlayerMemoryControl.open({memory: playerMemory,
  commandPath: resolve(runtime, 'memory-command.json'),
  chatResetPath: resolve(runtime, 'memory-chat-resets.json'),
  chatResetFamilies: relationshipRoutes.providerFamilies,
  publish: value => atomic(resolve(runtime, 'memory-status.json'), JSON.stringify(value))});
// Help > Generate report: a redacted zip of versions, status and log tails.
// The key and provider IDs are passed only so they can be scrubbed from it.
const supportReport = await SupportReportControl.open({game, runtime, stateDirectory, project,
  secrets: () => [key], knownIds: () => Object.values(relationshipRoutes.providerIds ?? ids),
  bridge: () => ({busy: !!active, microphoneActive: !!mic.current})});
await companionActions.revoke();
await status('waiting');
await pollSettings(false);
await pollKnowledge();
void localVoice.start().catch(error => console.error('[CyberpunkConvai] Local voice startup:', error.message));
console.log('[CyberpunkConvai] Convai conversation bridge ready');
// A poll is one stat of the request file until Lua replaces it, so a short
// interval costs little and removes up to 150 ms from every turn's start.
const timer = setInterval(tick, 50);
const micTimer = setInterval(() => { void pollMicrophone().catch(error => console.error('[CyberpunkConvai] Microphone poll:', error.message)); }, 150);
const prefetchTimer = setInterval(() => { void pollPrefetch().catch(error => console.error('[CyberpunkConvai] Preparation poll:', error.message)); }, 150);
const lookaheadTimer = setInterval(() => { void pollLookahead().catch(error => console.error('[CyberpunkConvai] Look-ahead poll:', error.message)); }, 60);
const settingsTimer = setInterval(() => { void pollSettings().catch(error => console.error('[CyberpunkConvai] Settings poll:', error.message)); }, 500);
const phoneTimer = setInterval(() => { void pollPhone().catch(error => console.error('[CyberpunkConvai] Phone poll:', error.message)); }, 150);
const knowledgeTimer = setInterval(() => { void pollKnowledge().catch(error => console.error('[CyberpunkConvai] Knowledge poll:', error.message)); }, 500);
const memoryTimer = setInterval(() => { void memoryControl.poll().catch(error => console.error('[CyberpunkConvai] Memory control:', error.message)); }, 500);
const supportTimer = setInterval(() => { void supportReport.poll().catch(error => console.error('[CyberpunkConvai] Support report:', error.message)); }, 500);
async function shutdown() {
  if (stopped) return;
  await companionActions.revoke();
  stopped = true; active?.controller.abort(); dropPrefetch(); audioWatch.stop();
  settleVoiceRouteWaiters(Error('Voice service is closed'));
  phone.close(); clearInterval(phoneTimer);
  phoneKnowledge.clear();
  clearInterval(knowledgeTimer);
  clearInterval(memoryTimer);
  clearInterval(supportTimer); supportReport.close();
  clearInterval(timer); clearInterval(micTimer); clearInterval(prefetchTimer); clearInterval(lookaheadTimer); clearInterval(settingsTimer);
  await invitations.clear('service-stopped');
  await voiceRouteSync.catch(() => {});
  await relationshipRouteSync.catch(() => {});
  await Promise.allSettled([localVoice.close(), mic.cancel(), connections.clear()]);
  await Promise.allSettled([realtime.close(), phoneRealtime.close()]);
  await vendorMemory.idle().catch(() => {});
  await memoryControl.close(); await playerMemory.close();
  await Promise.allSettled([metricsWriting, connectionMetricsWriting, voiceMetricsWriting]);
  await status('stopped'); process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
