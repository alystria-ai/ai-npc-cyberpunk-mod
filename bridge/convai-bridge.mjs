// First, so a full disk or a closed output can never end this process through a log line (bridge/safe-streams.mjs, error report 1cbe337a5144ebbd).
import './safe-streams-install.mjs';
import {readFile, stat, mkdir} from 'node:fs/promises';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {decisionLedgerReader} from './game-dialogue.mjs';
import {witnessReceiptsReader} from './witness-receipts.mjs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {archetypeContext, isAmbientProfile, parseInput, personKey, profileFor} from './protocol.mjs';
import {configureKnowledgeParts, preloadKnowledgePart} from './knowledge-parts.mjs';
import {audioReady, removeAudioDepot} from './speech-audio.mjs';
import {createSpeechStateReader, audioAvailable} from './speech-state-cache.mjs';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';
import {SpeechPace} from './speech-pace.mjs';
import {encodeSegmentedFace} from './continuous-face-file.mjs';
import {timelineRecord, TIMELINE_PREFIX} from './expression-timeline.mjs';
import {JaliFace} from './jali-face.mjs';
import {textExpressionSignal} from './text-emotion.mjs';
import {planSignal, traitFor} from './emotion-analysis.mjs';
import {EmotionSelection, waitLateEmotion} from './emotion-selector.mjs';
import {createOmniPcmVoice} from './omni-pcm.mjs';
import {deliverPocketSpeech} from './pocket-speech.mjs';
// Scripted quest lines (docs/QUEST_PRIMITIVES.md section 4): the line's reply, its voice route, and the prepared voice that plays its audio file.
import {scriptedResult, scriptedRoute} from './quest-lines.mjs';
import {createPreparedVoice, readPreparedFile} from './prepared-voice.mjs';
import {createPreparedAudio, createDecodeCache} from './prepared-audio.mjs';
import {MediaLink} from './media-link.mjs';
import {ReplyStream, finishedText} from './reply-stream.mjs';
import {hasEmotionTag} from './emotion-tags.mjs';
import {ownedPocketFace} from './pocket-facial-stream.mjs';
import {RealtimeHost} from './realtime-host.mjs';
import {CompanionVision, visionDisabledByEnv} from './companion-vision.mjs';
import {VisionCapture} from './vision-capture.mjs';
import {MicrophoneSession, microphoneErrorState} from './microphone-session.mjs';
import {createAddonVoice} from './addon-voice.mjs';
import {startVoiceKeyStream} from './voice-key-stream.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {conversationScope} from './group-context.mjs';
import {conversationContext as baseConversationContext, conversationContextBlocks as baseConversationBlocks, firstPersonReminder, voiceConversationBlocks, turnContextOptions, gearWantedFor} from './quest-context.mjs';
import {dynamicOn, dynamicOff} from './quest-context.mjs';
import {createIntrinsicConversationContext, loadIntrinsicCharacterContext} from './intrinsic-character-context.mjs';
import {battleTrigger, reactionLeaseProblem} from './battle-context.mjs';
import {eventExchange} from './appointment-events.mjs';
import {GroupPrefetch, parsedInputIdentity, parsePrewarm} from './group-prefetch.mjs';
import {GroupLookahead, lookaheadAllowed, lookaheadKind, validateLookahead, validateFollow, validateAhead, PREPARED_HOLD_MS, waitUntil, BufferedPcm, createStatCachedReader} from './group-lookahead.mjs';
import {abortable, throwIfCancelled} from './transport-pool.mjs';
import {PartyConnections, parsePartyConnections, spawnedWarmLimit} from './party-connections.mjs';
import {NearbyWarm} from './nearby-warm.mjs';
import {CompanionInvitations} from './companion-invitations.mjs';
import {VoiceSelection, voiceFailureCause} from './voice-selection.mjs';
import {browserFailureTail, lastBrowserStartFailure} from './system-browser.mjs';
import {VoxtralVoice} from './voxtral-voice.mjs';
import {InworldVoice} from './inworld-voice.mjs';
import {INWORLD_KEY_FILE, InworldKey} from './inworld-key.mjs';
import {createReferencePreparer, PREPARED_FOLDER, RUNTIME_PREPARED_FOLDER} from './voxtral-reference.mjs';
import {VoiceRoutingLog, ROUTING_LOG_NAME, describeVoiceRoute, describeVLine, referenceOf, cloudReferenceOf} from './voice-routing-log.mjs';
import {VoiceLanguagePacks} from './voice-language-packs.mjs';
import {PocketLanguageModels, PocketLanguageNotice} from './pocket-language-models.mjs';
import {LastReplyCapture, CAPTURE_FOLDER} from './last-reply-capture.mjs';
import {DevTranscript, TRANSCRIPT_FILE} from './dev-transcript.mjs';
import {captureReader as placeCaptureReader} from './named-places.mjs';
import {variantSeed} from './voice-variants.mjs';
import {NaturalSpeech, OMNI_TAGS, omniTagsFor, speechPhrases} from './natural-speech.mjs';
import {dynamicInfo} from './dynamic-info.mjs';
import {VVoice, V_VOICE_KEYS, extraVoices, vSettingsFor} from './v-voice.mjs';
import {MicVLines} from './mic-v-line.mjs';
import {installVVoiceReference, loadVVoiceReferencesWithMods, vGenderOfKey} from './v-voice-mod-service.mjs';
import {MatureContent, matureAllowsCloudVoice} from './mature-content.mjs';
import {warmMatureGuard} from './mature-guard.mjs';
import {detectMaturePack} from './mature-pack.mjs';
import {gearDiagnostic, gearSeen} from './player-gear.mjs';
import {gearMemory} from './gear-memory.mjs';
import {turnContextDiagnostic, turnContextWhere, modsProbeLine, vixenProbeLines} from './turn-context.mjs';
import {besideV} from './turn-context.mjs';
import {lastTalk} from './last-talk.mjs';
import {sceneryMemory} from './scenery-memory.mjs';
import {ExpressiveEmotions} from './expressive-emotions.mjs';
import {resolveVoiceConfigPaths} from './voice-config-paths.mjs';
import {detectOmniPack, missingOmniClips, missingOmniClipsLine} from './omni-pack.mjs';
import {ownPythonLine, ownPythonSummary, readOwnPythonSetting, resolveOwnPython} from './omni-own-python.mjs';
import {OmniAmdSetup} from './omni-amd-setup.mjs';
import {REMOTE_FILE, RemoteOmniAddress, RemoteOmniControl} from './remote-omni-control.mjs';
import {ResidentPhoneAnalysis} from './resident-phone-analysis.mjs';
import {VoicePreviewLease} from './voice-preview.mjs';
import {PhoneChat, parsePhoneState, phoneRecentConversationContext, rosterContacts} from './phone-chat.mjs';
import {PhoneWarm, PHONE_HOST_IDLE_MS} from './phone-warm.mjs';
import {PhoneFailureLog, PHONE_CODES} from './phone-failure.mjs';
import {GameLaunchIdentity, identifyGameLaunch} from './game-launch.mjs';
import {PlayerMemory} from './player-memory.mjs';
import {VendorMemory, vendorMemoryKey} from './vendor-memory.mjs';
import {ReputationStore} from './reputation.mjs';
import {PlayerMemoryApi} from './player-memory-api.mjs';
import {PlayerMemoryControl} from './player-memory-control.mjs';
import {SupportReportControl} from './support-report.mjs';
import {ErrorEvents, eventFromError, installCrashCapture} from './error-events.mjs';
import {installStageMarker, markBridgeStage} from './stage-marker.mjs';
import {endIfIncomplete, installFileErrorGuard, readRequiredJson} from './runtime-files.mjs';
import {gpuVendors, nvidiaCardMiB, amdRoute} from './gpu-vendors.mjs';
import {SetupCheckControl, cachedBrowserName, cachedGraphicsCards, cachedModManagers, collectSetupCheck, findNestedPacks, readPackPlacement} from './setup-check.mjs';
import {CharacterOverrides} from './character-overrides.mjs';
import {CharacterOptions} from './character-options.mjs';
import {PromptProfiles} from './prompt-profile-store.mjs';
import {WorldRules, convaiWorldRulesBlocks} from './world-rules.mjs';
import {CustomCharacters, isCustomKey, rosterIndex, releaseVoiceFiles} from './custom-characters.mjs';
import {PlayerVoices, PLAYER_PREPARED_FOLDER, releasePreparedSlots} from './player-voices.mjs';
import {LiveVoices, shippedVoicesReader, voicesOf} from './live-voices.mjs';
import {GameVoiceClips, STAND_IN_VOICES, applyReadyClips, applyStandIns, builderFiles, clipVoiceConfigPaths, readManifest as readVoiceClipManifest, readWords as readVoiceClipWords, standInDescriptors} from './voice-clips.mjs';
import {fallbackAliases, missingFallbacks, missingFallbacksLine, readFallbacks} from './voice-fallbacks.mjs';
import {CharacterEditor} from './character-editor.mjs';
import {EditorServer} from './character-editor-server.mjs';
import {EditorControl} from './character-editor-control.mjs';
import {PaidTierControl, plansUrlFor} from './convai-paid-tier.mjs';
import {startConvaiSignIn} from './convai-signin.mjs';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {PlayerPhoneKnowledge, playerPhoneGeneration} from './player-phone-knowledge.mjs';
import {atomicFile as atomic} from './guarded-file.mjs';
import {readWorldSession, lateWorld, worldBoundary, MIC_LEASE_MS} from './world-session.mjs';
import {RelationshipRouting, retireRelationshipConnections, RELATIONSHIP_PROFILES} from './relationship-routing.mjs';
import {EddiesDecisions, romanceOf} from './eddies.mjs';
import {Bonds, BondStore} from './bonds.mjs';
import {BondPacks} from './bond-pack-runner.mjs';
import {configureStoryPacksGate, storyPacksAvailable} from './story-packs-gate.mjs';
import {QuestLink} from './quest-link.mjs';
import {createFactsReader} from './quest-facts.mjs';
import {syncAllowlist} from './gift-tables.mjs';
import {createQuestPoller} from './quest-poller.mjs';
import {relationshipContext, romanceReminder} from './romance-context.mjs';
import {RomanceBond} from './romance-bond.mjs';
import {MultilingualConversations, RETIRED_PROVIDER_KEY, VoiceLanguageNotice, multilingualTwins, planTurnVoice, replyLanguageFrom, replyVoice} from './multilingual.mjs';
import {CompanionActions, driveLimitNote} from './companion-actions.mjs';
import {publishCallOff} from './call-off.mjs';
import {callMeetNote, callLine, parseCallMeetOffer, planCallMeet} from './call-meet.mjs';
import {RequestFileOwner, fileIdentity, requestFileEmpty} from './request-ownership.mjs';
import {updateDialogueLevel, dialogueLevel, updateVoiceVolume, voiceVolumePercentNow, vVoiceVolumePercentNow} from './dialogue-level.mjs';
import {AudioOutputWatch, audioDelayMs, resolveDelayMs, setAudioDelayMs, settingDelay} from './audio-delay.mjs';
import {ConvaiKeys, OwnKeyControl, PLAYER_KEY_FILE, PLAYER_USER_FILE, memoryRecovery, parseKeyFileText, validateKey, withoutIdentity} from './convai-key.mjs';
import {QuotaWatch, classifyFailure} from './convai-quota.mjs';
import {AUTH_CONFIG_FILE, INSTALL_FILE, PACKAGED_AUTH_FILE, TokenSource, loadInstallId, readAuthSettings} from './convai-credential.mjs';
import {DAILY_LIMIT, LimitStore, SharedKeyGuard, UsageStore, limitFromEnvironment, machineId} from './shared-key-guard.mjs';
import {MISTRAL_KEY_FILE, MistralControl, MistralProvider, PROVIDERS, parseMistralKey} from './mistral-key.mjs';
import {CUSTOM_FILE, CustomControl, CustomEndpoint, testConnection as testCustomConnection} from './custom-endpoint.mjs';
import {activeEndpoint, migrateEarlierSetups, openGeminiEndpoint} from './gemini-provider.mjs';
import {TextProviderHost, attachTextProvider, customRoute, isLocalUnavailable, localRoute, mistralRoute} from './text-provider-host.mjs';
import {MEMORY_FILE as MISTRAL_MEMORY_FILE} from './mistral-memory.mjs';
import {MemoryStore} from './memory-store.mjs';
import {mistralScheduler, PRIORITY} from './mistral-rate.mjs';
import {detectLocalAiPack, describePackFiles, packFileProblems} from './local-ai-pack.mjs';
import {BLOCKED as LOCAL_AI_BLOCKED, LocalLlmServer, isPlayerServerDetail, nvidiaFreeMiB, nvidiaTotalMiB, unavailableDetail} from './local-llm-server.mjs';
import {SMALL_CARD_ROOM} from './local-vram-fit.mjs';
import {defaultModelIds, describeLocalModels, externalModels, listLocalModels, localAiAvailable, matureOffBlocks, normalisePin, ownFileModels} from './local-model-choice.mjs';
import {CustomModelScanner} from './custom-models.mjs';
import {LlamaEmbedder} from './local-embed.mjs';
import {ChildRegistry, CHILDREN_FILE, reapChildren} from './child-registry.mjs';
import {priorityGate, readTurnPriority, setProcessPriority} from './process-priority.mjs';
import {watchFiles, createWakeSignal, mergeHandlers} from './file-wake.mjs';
import {GameStateSync} from './game-state.mjs';
const leaseWake = createWakeSignal();
import {PersonaBook, joinBlocks, worldBlocksInCacheOrder, freshParts} from './mistral-prompt.mjs';
import {LocalStt} from './local-stt.mjs';
import {SpeechLanguage, LOCAL_PACKS, planRecording, PLAYER_LANGUAGE_FILE, parsePlayerLanguage, playerLanguageText} from './speech-language.mjs';
import {VoxtralStt} from './voxtral-stt.mjs';
import {LocalSttCapture, createLocalSpeech, hostBrowser} from './local-stt-capture.mjs';
import {MicTap, TapCapture, TAP} from './mic-tap.mjs';
import {MicDevicesControl, MIC_DEVICES_COMMAND, MIC_DEVICES_STATE, settingMicDevice} from './mic-devices-control.mjs';
import {MicLive} from './mic-live.mjs';
import {createVoiceChoice, KeySender, parseHub, HUB_FILE, RESULT_FILE} from './voice-choice.mjs';
import {describeThresholds} from './voice-activity.mjs';
import {DEFAULT_MODELS as MISTRAL_MODELS, DECISION_MODELS as MISTRAL_DECISION_MODELS, DEFAULT_MODEL as MISTRAL_MODEL, errorCodeFor as mistralCodeFor, errorExtrasFor as mistralExtrasFor, failureDetail as localFailureDetail, warmConnection} from './mistral-client.mjs';
import {TurnClock, withClock, markStage} from './turn-clock.mjs';
import {KNOWLEDGE_PARTS_MS, SlowTurnWatch, knowledgeParts} from './slow-turns.mjs';
import {VoiceSilenceWatch} from './voice-silence.mjs';
import {LearnedLimits} from './prompt-fit.mjs';
import {repeatLimiter} from './repeat-log.mjs';
import {AddonHost, LOCAL_REMARK_GAP_S, fixedProvider, rosterLookup, sharedMemory} from './addons.mjs';
import {AddonContent} from './addon-content.mjs';
import {memoryScopes, scopedMemory} from './memory-scope.mjs';
import {readGpuProcessMemory} from './gpu-memory.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDirectory = resolve(process.env.CYBERPUNK_CONVAI_STATE || resolve(project, 'runtime'));
const game = process.env.CYBERPUNK_CONVAI_GAME || 'E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077';
const runtime = resolve(game, 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/runtime');
// One priority rule for everything on the path from V's words to the first sound of the reply (docs/PROCESS_PRIORITY.md): HIGH (never realtime) by default, `priority = normal`
// in <state>/priority.txt is the player's way back. This process takes it first (the supervisor also sets it from outside), then the workers and the hidden browser it starts.
const {level: turnPriority, source: turnPrioritySource} = readTurnPriority({stateDirectory});
// Start-up timeline (docs/PROCESS_PRIORITY.md, "Start-up"): the wall-clock time (UTC, the clock of probe.log) and the seconds since this process began, for the few events that
// can be lined up with the game's title-screen frame gaps (probe.log "Start-up:" lines). A handful of lines a session; most of this log has no clock.
const timeline = event => { try { process.stderr.write(`[Timeline] ${new Date().toISOString()} +${process.uptime().toFixed(1)} s ${event}\n`); } catch { /* a log never fails */ } };
timeline('the service began (modules loaded)');
// The title screen has no turns, and the game is loading with every core busy (its main thread waits for the key press): the service starts at NORMAL and takes HIGH when the game
// has a world (or a turn arrives, or the title hold runs out), so nothing of ours can starve the title. Everything it starts is gated the same way (bridge/process-priority.mjs PriorityGate).
priorityGate.log = line => process.stderr.write(line + '\n');
if (turnPriority === 'high') {
  priorityGate.close();
  priorityGate.whenOpen(() => {
    const done = setProcessPriority(process.pid, 'high');
    process.stderr.write(`[Priority] conversation service: ${done ? 'high' : 'could not be raised'}\n`);
    return done;
  }, 'conversation service');
} else process.stderr.write(`[Priority] ${turnPriority} (${turnPrioritySource}): nothing is raised above normal\n`);
// Automatic error reports (docs/ERROR_REPORTS.md): this process only records (bridge/error-events.mjs); the service's supervisor sends.
// An uncaught exception or unhandled rejection is written down as the process ends (how it ends does not change); a failed turn that is
// not the player's own doing and the setup check's problems are recorded after the fact, never on a turn's path. Off with the setting.
installCrashCapture({stateDirectory, runtime});
// What the bridge last started (a turn's stage, a voice render, the microphone, the vision helper) goes into a small file the supervisor reads if this process
// ends without a JavaScript stack (bridge/stage-marker.mjs); one memory line (rss and heap) is logged every 5 minutes. Both are in this process only.
installStageMarker({stateDirectory});
// A file read that nobody waits for and that fails because the folder changed under it (ENOENT, EPERM, EBUSY, ...) never ends the service
// (bridge/runtime-files.mjs); any other unhandled rejection is the crash it always was. The data files the bridge reads at its start are
// different: without one it cannot work, so `requiredJson` ends it at once with one plain line (the supervisor shows "Runtime incomplete").
installFileErrorGuard({record: error => { try { errorEvents.record({...eventFromError(error, 'bridge-rejection'), detail: {handled: true}}); } catch {} }});
const requiredJson = name => readRequiredJson(project, name).catch(endIfIncomplete);
// What a voice failure's report adds about the PC when it is made (not on a turn's path, only for a failed voice): the vendor of each card, the biggest card's size and, on an
// NVIDIA card, its free memory right now (the voice workers, the game and Local AI share it). A card list that cannot be read gives the rest.
const voiceHardware = async () => {
  const cards = await cachedGraphicsCards().catch(() => []);
  const vendors = gpuVendors(cards);
  const sizes = (Array.isArray(cards) ? cards : []).filter(card => gpuVendors([card]).length && Number.isFinite(card?.memoryMiB) && card.memoryMiB > 0).map(card => card.memoryMiB);
  const total = nvidiaCardMiB(cards) ?? (sizes.length ? Math.max(...sizes) : null);
  const free = vendors.includes('nvidia') ? await nvidiaFreeMiB().catch(() => null) : null;
  return {gpuVendors: vendors, ...(total ? {vramTotalMiB: total} : {}), ...(Number.isFinite(free) ? {vramFreeMiB: free} : {})};
};
const errorEvents = new ErrorEvents({stateDirectory, runtime, voiceHardware});
// The bridge polls the game's files every 50 to 500 ms. A poll that fails for a lasting reason logs once per cause, then at most once a minute
// with how many were left out, never one line per tick (bridge/repeat-log.mjs).
const pollLog = repeatLimiter({write: line => console.error(line)});
const noteSetupProblems = document => { try { if (document) errorEvents.setupChecked(document); } catch { /* never fails start-up */ } };
const keyFile = process.env.CYBERPUNK_CONVAI_KEY_FILE || resolve(stateDirectory, 'convai-key.txt');
// The player's own state files in runtime/ (settings, phone chats, add-on settings, NPC names, ...): a copy is kept outside the game folder,
// where Mod Organizer 2 cannot lose it (bridge/game-state.mjs). Only the packaged launcher turns this on, with the folder the copies are in.
const gameStateFolder = process.env.CYBERPUNK_CONVAI_GAME_STATE;
const gameState = gameStateFolder ? new GameStateSync({runtime, durable: resolve(gameStateFolder), log: message => console.error('[GameState] ' + message)}) : null;
// Named characters, then the generic NPC archetypes (docs/NPC_ARCHETYPES.md). The archetype roster is optional:
// without it (or without their IDs in characters.json) unnamed NPCs simply have no profile.
const roster = [...await requiredJson('characters/roster.json'),
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
// Content packs (API 1.1, bridge/addon-content.mjs): add-ons that only change how the characters talk (world rules, prompt-profile wording). The prompt-profile store and
// the world rules below read them with plain lookups; the player's on/off switch arrives in the add-on settings file. Nothing without a pack.
const addonContent = new AddonContent({host: addonHost, log: message => console.error('[Addons] ' + message)});
if (addonContent.installed) console.error('[Addons] Content packs: ' + addonContent.describe());
// Voice clips players give characters in the editor (docs/CHARACTER_EDITOR.md, "Voice clips"; bridge/player-voices.mjs): kept in the data folder
// (<state>/player-voices/<key>.wav and player-voices.json), opened before the voice configurations are built so each clip is merged over the
// shipped voice of its character. A removed clip's Voxtral slot (<state>/player-voices-prepared) goes with it. A clip saved or removed while the
// service runs reaches the running voices through `liveVoices` (created below, once the voice configurations exist), with no restart.
let liveVoices = null;
const playerVoices = await PlayerVoices.open({dir: stateDirectory, log: message => console.error('[PlayerVoices] ' + message),
  onRemoved: key => releasePreparedSlots({folder: resolve(stateDirectory, PLAYER_PREPARED_FOLDER), key}),
  onChanged: key => {
    // A replaced clip's Voxtral slot goes too (a slot is named by its clip's hash, so a stale one is never used, but it is not left lying around).
    void releasePreparedSlots({folder: resolve(stateDirectory, PLAYER_PREPARED_FOLDER), key}).catch(() => {});
    return liveVoices?.refresh(key).catch(error => console.error('[PlayerVoices] the voices did not follow the change: ' + (error?.message ?? 'error')));
  }});
console.error(`[PlayerVoices] voice clips and their list are kept in ${playerVoices.folder} and ${playerVoices.indexPath}`);
// Characters the player made (docs/CHARACTER_EDITOR.md, "Your own characters"): opened here, before the voice configurations are built. Their rows
// join the roster array (profileFor and the other lookups by key); the list the game reads is runtime/custom-characters.json. They never have a
// Convai character: runCustomTurn answers them. Deleting one removes its voice clip and its prepared voice setups.
const customCharacters = await CustomCharacters.open({dir: stateDirectory, exchangePath: resolve(runtime, 'custom-characters.json'), roster: rosterIndex(roster),
  log: message => console.error('[Custom] ' + message), onChange: () => syncCustomRoster(),
  onDeleted: key => { void playerVoices.clear(key).catch(() => {}); void characterOptions.remove(key).catch(() => {}); return releaseCustomVoice(key); }});
function syncCustomRoster() {
  for (let at = roster.length - 1; at >= 0; at--) if (roster[at]?.kind === 'custom') roster.splice(at, 1);
  roster.push(...customCharacters.rosterRows());
  // The add-ons' name lookup was built from the roster the first time it was asked: a character made or renamed in the editor must be in it.
  addonHost.characterLookup?.reset?.();
}
syncCustomRoster();
// What the player chose for a character besides its words (docs/CHARACTER_EDITOR.md, "Look and moves"): <state>/character-options.json, read once here. The reply length is a plain
// lookup in the persona; the choices the game acts on (the look, gestures, idle moves, seating, reactions) are copied to runtime/character-options.json for the Lua side.
const characterOptions = await CharacterOptions.open({dir: stateDirectory, exchangePath: resolve(runtime, 'character-options.json'), log: message => console.error('[Editor] ' + message)});
await characterOptions.prune(key => !isCustomKey(key) || customCharacters.has(key));
// The content packs' rewritten characters and names are laid over the roster rows now, and again each time a pack is switched (bridge/addon-content.mjs bindRoster).
addonContent.bindRoster(roster);
// runtime/relationship-profiles.json (the retired alternate affectionate profiles) is no longer read: every character has one profile.
// Multilingual twins (docs/MULTILINGUAL_PROFILES.md): used for a turn whose message is clearly not English (wantsTwin). A missing
// map is an English-only installation; a twin that no longer clones the current profile is left out.
const multilingualProfiles = multilingualTwins(JSON.parse(await readFile(resolve(stateDirectory, 'multilingual-profiles.json'), 'utf8').catch(error => {
  if (error.code === 'ENOENT') return 'null';
  throw error;
})), {ordinaryIds: ids});
if (multilingualProfiles.skipped.length) console.error('[CyberpunkConvai] Multilingual profiles not used:', multilingualProfiles.skipped.join(', '));
// A content pack's Convai twins (add-on API 1.1): characters made from the pack's text, used for a character while the pack is on and Convai's shared plan answers (a player's own key has
// no twins, like the multilingual ones). A turn that goes to the multilingual twin keeps it; a character without a twin keeps its ordinary Convai character.
const relationshipRoutes = new RelationshipRouting({ordinaryIds: ids, multilingual: multilingualProfiles.twins,
  packTwins: addonContent.convaiTwins({ids, taken: Object.values(multilingualProfiles.twins)}),
  packTwinFor: profileKey => (keys.singleSession ? null : addonContent.twinFor(profileKey))});
// The sample rate Convai's audio really arrives at, per Convai character, where the packets' label is wrong (bridge/convai-audio-rates.mjs). Learned from a turn's bytes and statistics, kept
// here between sessions (convai-audio-rates.json in the state folder; a missing or unreadable file is an empty memory), and handed to every later turn of that character. Version 2: the
// first version of the file (a plain map) held the 44.1 kHz guess for every multilingual twin, which played their lines 1.84 times too fast, so it is not read.
const audioRatesPath = resolve(stateDirectory, 'convai-audio-rates.json');
const savedAudioRates = await readFile(audioRatesPath, 'utf8').then(text => { const file = JSON.parse(text); return file?.version === 2 ? file.rates : null; }, () => null).catch(() => null);
let audioRatesWriting = Promise.resolve();
// Which voice configuration files are live is named by runtime/voice-configs.json (bridge/voice-config-paths.mjs):
// the searched references for Pocket and for OmniVoice's short and long choices, each falling back to the base file.
// Add-on voices are merged into copies of these files (addons.<name> in the state folder); without add-on voices the paths are unchanged.
// V's voice for typed lines (docs/V_VOICE.md): the two reference clips cut from the game's own V lines (released with the mod under
// voice-references/v-voice, or assets/v-voice in a source checkout) are merged here as the voices v-male and v-female, like an add-on's
// voice. They only sit in the configurations; nothing is prepared or loaded for them until a typed line is spoken in V's voice.
const referenceRoots = process.env.CYBERPUNK_CONVAI_OMNI_REFERENCES ? [process.env.CYBERPUNK_CONVAI_OMNI_REFERENCES]
  : [resolve(stateDirectory, 'voice-references'), resolve(project, 'runtime/voice-references')];
// The multilingual packs (docs/VOICE_LANGUAGE_PACKS.md, bridge/voice-language-packs.mjs): the game's own dub of a character in the language of a reply, as the
// reference OmniVoice and the Mistral voice clone from. Found and checked once here (a few file headers; nothing at all without a pack), looked at again by the
// settings poll, and asked for from memory per reply. A broken pack is ignored with one log line, and the reason goes in the support report.
const languagePacks = new VoiceLanguagePacks({roots: referenceRoots, log: line => console.error('[VoiceLanguagePacks] ' + line),
  onChange: () => { try { voxtralVoice.forgetLanguageReferences(); } catch {} }});
await languagePacks.scan().catch(error => console.error('[VoiceLanguagePacks] scan failed:', error?.message ?? error));
// Developer mode: the last spoken reply's audio and its reference, in <state>/debug (bridge/last-reply-capture.mjs). Off otherwise, and then it costs nothing.
const replyCapture = new LastReplyCapture({directory: resolve(stateDirectory, CAPTURE_FOLDER), log: line => console.error('[Debug] ' + line)});
// Developer mode: every turn as text in <state>/dev-transcript.log (bridge/dev-transcript.mjs): the time, who spoke, the provider, V's words, the reply, whether a picture went along and where V was.
// Nothing is written, and nothing is built for it, while Developer mode is off; a key the bridge holds is replaced by [key]. Not part of any report.
const devTranscript = new DevTranscript({path: resolve(stateDirectory, TRANSCRIPT_FILE), secrets: () => [...keys.secrets(), ...mistral.secrets()], log: line => console.error('[Debug] ' + line)});
let devPictures = 0;
function recordDevTurn(input, profile, result) {
  if (!devTranscript.enabled) return;
  try {
    const sent = companionVision.counters?.turnsWithPicture ?? 0, picture = sent > devPictures;
    devPictures = sent;
    devTranscript.record({speaker: profile?.name ?? input.profileKey, provider: mistral.applied, picture,
      user: input.reaction ? `(automatic ${input.reaction.kind ?? 'reaction'})` : (typeof result.userText === 'string' && result.userText.trim() ? result.userText : input.text), reply: result.text,
      where: turnContextWhere(input, turnContextOptions(input, isAmbientProfile(input.profileKey)))});
  } catch { /* a transcript never affects a reply */ }
}
// Named places measured in the game with the developer probe (runtime/quest-place-capture.json, bridge/named-places.mjs): read when the file changes, never on a turn.
const placeCaptures = placeCaptureReader({path: resolve(runtime, 'quest-place-capture.json'), log: line => console.error('[TurnContext] ' + line)});
// A player's V voice mod (docs/V_VOICE.md, "V voice mods"): the reference built from the mod's own lines replaces the shipped clip of that gender. The player's own clip
// for V (the editor) wins over both. Here, at start, only the references an earlier scan built are read (two small files per gender: no archive is listed, no process is
// started, so the ready signal waits for nothing); the scan itself (startVVoiceModScan, below) runs once, in the background, only while V's voice is on. `source` on each
// voice names the reference.
const vVoiceLoadOptions = {shippedDirectories: [...referenceRoots.map(root => resolve(root, 'v-voice')), resolve(project, 'assets/v-voice')], game, stateDirectory, project,
  log: line => console.error('[VVoice] ' + line)};
const {report: initialVVoiceModReport, ...vVoiceReferences} = await loadVVoiceReferencesWithMods({...vVoiceLoadOptions, scan: false});
let vVoiceModReport = initialVVoiceModReport;
// The player's voice clips (a story character's, or one of their own characters') join the configurations like V's voices, with three differences:
// they are never copied (the workers read them from <state>/player-voices, named runtime/player-voices/<key>.wav), a clip replaces the shipped voice
// of its character, and it is taken out of the startup preparation, so nothing is prepared or loaded before that character speaks. A clip given or
// removed while the service runs counts from that character's next line (LiveVoices, below); a custom character with no clip speaks with the
// voice of its gender (aliases below). Only story characters and the player's existing characters may have one; a clip of a character the player
// deleted is removed here.
// V's two voices (v-male, v-female) take a clip of the player's too (the editor's V rows): the clip beats a V voice mod's reference and the shipped one.
const playerVoiceAllowed = key => isCustomKey(key) ? customCharacters.has(key) : Object.values(V_VOICE_KEYS).includes(key) || roster.some(row => row?.key === key && row.kind === 'named');
await playerVoices.prune(key => !isCustomKey(key) || customCharacters.has(key));
const playerVoiceExtras = await playerVoices.extras(playerVoiceAllowed);
const originalVoiceConfigPaths = resolveVoiceConfigPaths(stateDirectory);
const voiceConfigPaths = await addonHost.voiceConfigPaths(originalVoiceConfigPaths, {stateDirectory,
  roots: referenceRoots, extra: extraVoices(vVoiceReferences).concat(playerVoiceExtras), playerVoiceDirectory: playerVoices.folder});
for (const warning of voiceConfigPaths.warnings) console.error('[CyberpunkConvai] Voice configuration: ' + warning);
const readVoiceConfig = async path => JSON.parse(await readFile(path, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '{}';
  throw error;
}));
// The files the voice workers are started with: the configurations, or (below) the same configurations with the clip edits in them.
let localVoiceConfigPath = voiceConfigPaths.pocket;
let omniVoiceConfigPaths = voiceConfigPaths.omni;
const voiceConfig = await readVoiceConfig(localVoiceConfigPath);
const omniVoiceConfigs = {short: await readVoiceConfig(voiceConfigPaths.omni.short), long: await readVoiceConfig(voiceConfigPaths.omni.long)};
// The PocketTTS models (docs/POCKET_LANGUAGE_MODELS.md, bridge/pocket-language-models.mjs): <Pocket references>/multilingual-pocket/<lang>, the folder the Pocket worker reads;
// found and checked once here (file sizes only), looked at again by the settings poll, and asked for from memory per reply.
const pocketLanguages = new PocketLanguageModels({roots: [voiceConfig.runtime?.referenceDirectory], packs: languagePacks, log: line => console.error('[PocketLanguages] ' + line)});
await pocketLanguages.scan().catch(error => console.error('[PocketLanguages] scan failed:', error?.message ?? error));
// Voice clips built on this PC from the player's own game files (docs/VOICE_EXTRACTION.md, bridge/voice-clips.mjs). Only a character whose shipped clip is missing (or with
// CYBERPUNK_CONVAI_GAME_CLIPS=1) is ever built, once, when it is first invited or talked to; the clips are kept in <references>/generated and the tables name them like any
// reference. A game with no English voice files downloads them from Hugging Face instead (CYBERPUNK_CONVAI_VOICE_CLIPS_DOWNLOAD=0 turns that off). Nothing here runs per frame
// and nothing is started at start: the builder is a process of its own, below normal priority, that exits when the character's clips are written.
const shippedVoiceTables = shippedVoicesReader(originalVoiceConfigPaths);
let gameVoiceClips = null;
const standInVoices = {pocket: {}, short: {}, long: {}};
// 'female' or 'male' for the stand-in voice: the roster's word, else the archetype key's (npc-valentinos-female).
const genderOfVoiceKey = key => {
  const gender = String(roster.find(row => row?.key === key)?.gender ?? '').toLowerCase();
  return gender === 'female' || gender === 'male' ? gender : /(^|-)female(-|$)/.test(String(key)) ? 'female' : 'male';
};
let voiceTablesEdited = false;
try {
  const manifestPath = resolve(project, 'characters/voice-clips-manifest.json');
  const manifest = existsSync(manifestPath) ? readVoiceClipManifest(await readFile(manifestPath, 'utf8')) : {};
  // The words of each character's clips: a character the shipped configurations have no row for (an older Runtime) has none to take from.
  const wordsPath = resolve(project, 'characters/voice-clips-words.json');
  const words = existsSync(wordsPath) ? readVoiceClipWords(await readFile(wordsPath, 'utf8')) : {};
  gameVoiceClips = await GameVoiceClips.open({manifest, words, manifestPath, gameDirectory: game, referenceRoot: referenceRoots[0], stateDirectory,
    mirrorRoots: [...referenceRoots.slice(1), voiceConfig.runtime?.referenceDirectory],
    ...builderFiles({project, runtimePython: voiceConfig.runtime?.pythonExecutable}),
    prefer: process.env.CYBERPUNK_CONVAI_GAME_CLIPS === '1', download: process.env.CYBERPUNK_CONVAI_VOICE_CLIPS_DOWNLOAD === '0' ? false : {},
    onBuilt: key => liveVoices?.refresh(key), log: message => console.error('[VoiceClips] ' + message)});
  const tables = {pocket: voicesOf(voiceConfig), short: voicesOf(omniVoiceConfigs.short), long: voicesOf(omniVoiceConfigs.long)};
  // The stand-in voices (the two archetype voices that always ship) as the shipped tables have them, kept for the live tables (standInDescriptors).
  for (const engine of Object.keys(tables)) standInVoices[engine] = Object.fromEntries(Object.values(STAND_IN_VOICES).map(key => [key, tables[engine]?.[key]]).filter(([, row]) => row));
  const named = applyReadyClips(gameVoiceClips, tables);
  voiceTablesEdited = named.length > 0;
  if (named.length) console.error(`[VoiceClips] ${named.length} character(s) speak with clips built from the game's files`);
  // Packages without the clips (voiceClips.fromGame): a character whose clips are not built yet speaks with the stand-in voice of its gender until they are, with no error.
  const waiting = applyStandIns(gameVoiceClips, tables, genderOfVoiceKey);
  voiceTablesEdited ||= waiting.length > 0;
  if (waiting.length) console.error(`[VoiceClips] ${waiting.length} character(s) speak with a stand-in voice until their clips are built from the game's files`);
} catch (error) { gameVoiceClips = null; console.error('[VoiceClips] unavailable:', error?.message ?? error); }
// The workers read their voices from a file, so the edited tables are written out and the workers are started on those files (once, at start, a few small writes).
if (voiceTablesEdited) {
  const written = await clipVoiceConfigPaths({paths: {pocket: voiceConfigPaths.pocket, omni: voiceConfigPaths.omni}, stateDirectory,
    configs: {pocket: voiceConfig, short: omniVoiceConfigs.short, long: omniVoiceConfigs.long}}).catch(error => ({pocket: voiceConfigPaths.pocket, omni: voiceConfigPaths.omni, warnings: [String(error?.message ?? error)]}));
  for (const warning of written.warnings) console.error('[VoiceClips] ' + warning);
  localVoiceConfigPath = written.pocket;
  omniVoiceConfigPaths = written.omni;
}
// The side characters with no voice of their own speak with their fallback archetype voice (characters/cast-sweep-voices.json, docs/CAST_SWEEP.md): an alias of the voice service
// (voiceOf), so nothing is added to the voice configurations, the workers never hear the side characters' keys and prepare the archetype voice once. A character with a row of its own
// in an engine's table (shipped, stand-in or clips built on this PC) keeps it. An engine whose table lacks an archetype answers that character in text: one summary line, no error.
let voiceFallbacks = Object.create(null);
try {
  const fallbackPath = resolve(project, 'characters/cast-sweep-voices.json');
  if (existsSync(fallbackPath)) voiceFallbacks = readFallbacks(await readFile(fallbackPath, 'utf8'), new Set(roster.filter(row => row?.kind === 'named').map(row => row.key)));
  const line = missingFallbacksLine(missingFallbacks(voiceFallbacks, {pocket: voicesOf(voiceConfig), short: voicesOf(omniVoiceConfigs.short), long: voicesOf(omniVoiceConfigs.long)}), Object.keys(voiceFallbacks).length);
  if (line) console.error(line);
} catch (error) { console.error('[VoiceFallbacks] unavailable:', error?.message ?? error); }
// A character is wanted (invited, or the first sign of a talk): its clips are made in the background if it has none. Never throws, never waits unless asked to.
const wantVoiceClips = (profile, reason) => {
  if (!gameVoiceClips) return null;
  let key = profile;
  try { key = localVoice.voiceKeyFor(profile, profile) || profile; } catch { /* the voice selection is not up yet */ }
  // A character that speaks with its fallback archetype voice is still the one whose clips are built: its own key, not the archetype's.
  if (key !== profile && gameVoiceClips.has(profile)) key = profile;
  return gameVoiceClips.wanted(key, {shipped: shippedVoiceTables, reason});
};
liveVoices = new LiveVoices({players: playerVoices, allowed: playerVoiceAllowed, folder: playerVoices.folder,
  voices: {pocket: voicesOf(voiceConfig), short: voicesOf(omniVoiceConfigs.short), long: voicesOf(omniVoiceConfigs.long)},
  shipped: shippedVoiceTables, log: message => console.error('[PlayerVoices] ' + message),
  generated: (key, shipped) => gameVoiceClips?.descriptors(key, shipped) ?? (gameVoiceClips ? standInDescriptors(gameVoiceClips, key, shipped, standInVoices, genderOfVoiceKey(key)) : null),
  // V is not in the shipped configurations (its voices are merged in as extras, from the mod-built or shipped clip copied to voice-references/addons):
  // with the player's clip gone V goes back to that reference, with no restart.
  fallback: key => {
    const voice = vGenderOfKey(key) ? vVoiceReferences.voices[vGenderOfKey(key)] : null;
    return voice ? {reference: `runtime/voice-references/addons/${key}.wav`, sha256: voice.sha256, transcript: voice.transcript} : null;
  },
  apply: update => { const applied = localVoice.setVoices(update); if (applied) { dropPrefetch(); prefetchObserved = ''; } return applied; }});
// An OmniVoice pack that is installed but short of reference clips (an extraction that stopped, a folder a mod manager cleared) leaves some characters
// without an OmniVoice voice; say so once in the log (bridge/omni-pack.mjs). File checks only, once, at start. It runs after the voice clip service has put the stand-in
// voices into the tables: a character whose clips are built on this PC (voiceClips.fromGame) names a clip that is there, so the line never lists the whole cast.
try {
  if (detectOmniPack({project, config: omniVoiceConfigs.long}).installed) {
    for (const mode of ['short', 'long']) {
      const line = missingOmniClipsLine(missingOmniClips({config: omniVoiceConfigs[mode], except: gameVoiceClips ? Object.keys(gameVoiceClips.manifest) : [],
        referenceDirectory: process.env.CYBERPUNK_CONVAI_OMNI_REFERENCES || resolve(project, 'runtime/voice-references')}), mode);
      if (line) console.error(line);
    }
  }
} catch (error) { console.error('[OmniPack] clip check failed:', error?.message ?? error); }
// What a custom character's voice leaves outside the data folder goes when the character does, and anything no character owns is swept here at
// start: the prepared setups Pocket saved (<work>/prepared-voices, bridge/prepared-voices.mjs) and copies older builds made under
// <reference root>/addons/. Nothing else is touched (releaseVoiceFiles names exactly the files it may remove). Voxtral's slots of player clips
// that no clip owns any more are swept too (releasePreparedSlots).
const customVoiceFolders = () => ({roots: [...referenceRoots, voiceConfig.runtime?.referenceDirectory],
  preparedFolder: typeof voiceConfig.runtime?.workDirectory === 'string' && voiceConfig.runtime.workDirectory ? resolve(voiceConfig.runtime.workDirectory, 'prepared-voices') : null});
const releaseCustomVoice = key => releaseVoiceFiles({key, ...customVoiceFolders()});
void releaseVoiceFiles({keep: new Set(customCharacters.list().map(row => row.key)), ...customVoiceFolders()})
  .then(count => { if (count) console.error(`[Custom] ${count} voice file(s) of deleted characters removed`); }).catch(() => {});
void releasePreparedSlots({folder: resolve(stateDirectory, PLAYER_PREPARED_FOLDER), keep: new Set(playerVoices.list().map(clip => clip.key))}).catch(() => {});
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
// 24 kHz mono (the clone keeps only the bandwidth of its reference) and cut to about 8.5 s (Ogg Vorbis as well when ffmpeg is on the machine; MP3 stops at 11.3 kHz), prepared once per character and kept in <references>/prepared
// (the Runtime's own pre-built slots are read from <references>/prepared-runtime when that one has none that fits, or only a WAV or MP3 where the Runtime has the Ogg).
// CYBERPUNK_CONVAI_VOXTRAL_FULL_REFERENCE=1 sends the clips whole, as before. A player's clip (playerRoot) is read from the data folder and its
// prepared slot is kept there too (<state>/player-voices-prepared), never in the references folder of the game.
// Reply streaming (bridge/reply-stream.mjs): on unless settings.json "replyStreaming": false or this variable is 0. Kept up here, beside the other
// environment reads, so the sections of this file that tests evaluate on their own never touch `process`.
const replyStreamingForcedOff = process.env.CYBERPUNK_CONVAI_REPLY_STREAM === '0';
let replyStreaming = !replyStreamingForcedOff;
const voxtralReferenceRoot = process.env.CYBERPUNK_CONVAI_OMNI_REFERENCES || resolve(stateDirectory, 'voice-references');
const voxtralPreparers = process.env.CYBERPUNK_CONVAI_VOXTRAL_FULL_REFERENCE === '1' ? null : {
  shipped: createReferencePreparer({cacheDirectory: resolve(voxtralReferenceRoot, PREPARED_FOLDER), shippedDirectories: [resolve(voxtralReferenceRoot, RUNTIME_PREPARED_FOLDER)], onLog: message => process.stderr.write(`[Voxtral] ${message}\n`)}),
  player: createReferencePreparer({cacheDirectory: resolve(stateDirectory, PLAYER_PREPARED_FOLDER), onLog: message => process.stderr.write(`[Voxtral] ${message}\n`)}),
  // A multilingual pack keeps its Mistral slots in its own prepared/ folder (options.slots), found by the same signature as every other slot.
  slots: new Map(),
};
const voxtralPreparer = (options = {}) => {
  if (options.slots) {
    if (!voxtralPreparers.slots.has(options.slots)) voxtralPreparers.slots.set(options.slots, createReferencePreparer({cacheDirectory: options.slots, onLog: message => process.stderr.write(`[Voxtral] ${message}\n`)}));
    return voxtralPreparers.slots.get(options.slots);
  }
  return options.player ? voxtralPreparers.player : voxtralPreparers.shipped;
};
// V's reference built from a V voice mod is the player's own making: a multilingual pack's V clip (the game's own dub in that language) does not replace it, in any language
// (docs/V_VOICE.md: the player's clip, then the mod's reference, then the pack's clip, then the shipped one). Read from memory per reply.
const vModKeepsReference = key => { const gender = vGenderOfKey(key); return gender !== null && String(vVoiceReferences.voices[gender]?.source ?? '').startsWith('mod:'); };
const voxtralVoice = new VoxtralVoice({getKey: () => { try { return mistral.apiKey ?? null; } catch { return null; } },
  referenceRoot: voxtralReferenceRoot, playerRoot: playerVoices.folder, languagePacks, keepsReference: vModKeepsReference,
  prepare: voxtralPreparers ? (bytes, options = {}) => voxtralPreparer(options)(bytes, options) : undefined,
  onLog: message => process.stderr.write(message)});
// The Inworld cloud voice (docs/INWORLD.md): the same kind of choice, on the player's own Inworld key (player-inworld-key.txt in the state folder, added in
// Settings > Voices > Custom voices). Each character is cloned once from the same reference clips; the voice ids are kept in player-inworld-voices.json in the
// state folder. Nothing of it runs until the player chooses it: no connection is made and no clip is read until a reply (or the warm-up of a chosen Inworld voice) asks.
const inworldKey = await new InworldKey({keyPath: resolve(stateDirectory, INWORLD_KEY_FILE)}).load();
const inworldVoice = new InworldVoice({getKey: () => inworldKey.key, referenceRoot: voxtralReferenceRoot, playerRoot: playerVoices.folder,
  storePath: resolve(stateDirectory, 'player-inworld-voices.json'), onLog: message => process.stderr.write(message)});
// The graphics card vendors (names only, bridge/gpu-vendors.mjs), from the card list the setup check and the error report read too (looked up once):
// the OmniVoice start line names them and the game's voice menu says OmniVoice needs an NVIDIA card when the PC has none. The lookup starts the first time
// OmniVoice is wanted (chosen or starting; VoiceSelection passes `wanted`), never at start-up, which runs no process of its own. null until the list is read;
// the voice state is published again when it arrives.
// The same list gives the NVIDIA card's memory (nvidiaCardMiB: a number, no name): OmniVoice's "needs 12 GB" hint, and a timeout on a card of 8 GB or less read as too little graphics memory.
// With the player's own Python for OmniVoice (<data>/omni-python.txt, bridge/omni-own-python.mjs, docs/OMNIVOICE_AMD.md) its self-test runs beside the card list,
// and OmniVoice waits for both: a Python that passed is the worker's, and the card memory its PyTorch reads (an AMD card has no NVIDIA size) is the one the
// small-card rules use. Without the file nothing more happens than before.
let graphicsVendors = null;
let graphicsCardMiB = null;
let graphicsLookup = false, graphicsKnown = false;
let omniOwnPython = null, omniOwnPythonRun = null, graphicsCards = [];
const cardMiB = () => omniOwnPython?.used && omniOwnPython.vramMiB ? omniOwnPython.vramMiB : nvidiaCardMiB(graphicsCards);
let omniOwnPythonBusy = false;
// Settings > Voices > OmniVoice for AMD (bridge/omni-amd-setup.mjs), made further down; told when the Python test has a new answer.
let omniAmdSetup = null;
// Until its self-test has run, a file that names a Python is only known to be there (one small read at start-up, no process): the voice menu does not
// say "needs NVIDIA" while it may still pass.
let omniOwnPythonNamed = null;
readOwnPythonSetting({stateDirectory}).then(setting => { if (setting.configured && !setting.problem) omniOwnPythonNamed = {configured: true, used: false, pending: true, reason: null}; }, () => {});
// `again`: a Python that was refused is tested again (the Help page). `force`: tested again whatever the last answer was (the AMD setup just finished or was removed).
const checkOwnPython = ({again = false, force = false} = {}) => {
  if (omniOwnPythonRun && (omniOwnPythonBusy || !(force || (again && omniOwnPython?.configured && !omniOwnPython.used)))) return omniOwnPythonRun;
  omniOwnPythonBusy = true;
  if (force) omniOwnPythonNamed = null;
  omniOwnPythonRun = resolveOwnPython({stateDirectory, runtimePython: process.env.CYBERPUNK_CONVAI_PYTHON,
    packInstalled: detectOmniPack({project, config: omniVoiceConfigs.long}).installed})
    .catch(() => ({configured: false}))
    .then(result => {
      omniOwnPython = result; omniOwnPythonBusy = false;
      if (graphicsKnown) graphicsCardMiB = cardMiB();
      if (result.configured) process.stderr.write(`[LocalVoice] [OmniPython] ${ownPythonLine(result)}\n`);
      try { if (!localVoice.closed) localVoice.publish(); } catch {}
      void omniAmdSetup?.publishStatus().catch(() => {});
      return result;
    });
  return omniOwnPythonRun;
};
const lookUpGraphics = wanted => {
  if (wanted && !graphicsLookup) {
    graphicsLookup = true;
    Promise.all([cachedGraphicsCards().then(found => { graphicsCards = found; graphicsVendors = gpuVendors(found); }, () => {}), checkOwnPython()])
      .finally(() => {
        graphicsCardMiB = cardMiB();
        graphicsKnown = true; try { if (!localVoice.closed) localVoice.publish(); } catch {}
      });
  }
};
const graphicsVendorsSource = wanted => { lookUpGraphics(wanted); return graphicsVendors; };
// undefined while the list is being read, so OmniVoice is not started on a card that turns out to be 8 GB or less (VoiceSelection.omniCardPending); null once read and unknown.
const graphicsAmdRouteSource = wanted => { lookUpGraphics(wanted); return graphicsKnown && amdRoute(graphicsCards); };
const graphicsMemorySource = wanted => { lookUpGraphics(wanted); return wanted && !graphicsKnown ? undefined : graphicsCardMiB; };
// Remote OmniVoice (docs/REMOTE_OMNIVOICE.md, Settings > Voices > Custom voices): the saved address of an OmniVoice server on the player's network. A file read and nothing more:
// no request is made to it unless the setting `remoteOmni` is on and OmniVoice is the chosen voice, or the player presses Test.
const remoteOmniAddress = await new RemoteOmniAddress({path: resolve(stateDirectory, REMOTE_FILE), log: message => console.error('[RemoteOmni] ' + message)}).load();
// The game's title screen holds V's helper voice (bridge/voice-selection.mjs startHold): it loads once the game has a world, or when the service has
// run TITLE_HOLD_MAX_MS without one. A function declaration: it is read before worldSession exists, and the latch is the module's.
// The same moment ends the title screen's hold on priorities and on the start-up work (bridge/process-priority.mjs PriorityGate, docs/PROCESS_PRIORITY.md): everything the
// service started at normal is raised to its turn level, and what waited for a world (V's helper voice, the V voice mod scan) goes ahead.
const TITLE_HOLD_MAX_MS = 600_000;
let titleHoldOver = false;
function endTitle(reason) {
  if (titleHoldOver) return false;
  titleHoldOver = true;
  timeline(`the title screen is over (${reason})`);
  priorityGate.open(reason);
  return true;
}
function titleHolds() {
  if (titleHoldOver) return false;
  if (worldSession?.ready === true) endTitle('the game has a world');
  else if (process.uptime() * 1000 >= TITLE_HOLD_MAX_MS) endTitle('the title hold ran out');
  return !titleHoldOver;
}
// V's helper voice (a Python process importing torch) has a shorter hold: the screen that waits for a key press is the title, so it may load as soon as a save is being loaded
// (the game's lease says `loading`, mod/init.lua convaiPublishLoading), about 15 s before the world exists, and not only once the world does. It still starts at NORMAL priority
// (the gate above) and rises with everything else when the world exists.
let loadBegun = false;
function helperHolds() { return titleHolds() && !loadBegun; }
setTimeout(() => { endTitle('the title hold ran out'); }, TITLE_HOLD_MAX_MS).unref?.();
const localVoice = new VoiceSelection(voiceConfig, {project, configPath: localVoiceConfigPath, startHold: helperHolds, workerPriority: turnPriority, pythonCacheDirectory: resolve(stateDirectory, 'python-cache'),
  omniRemoteAddress: () => remoteOmniAddress.endpoint, omniReferenceRoots: referenceRoots,
  gpuVendors: graphicsVendorsSource, gpuAmdRoute: graphicsAmdRouteSource, gpuMemoryMiB: graphicsMemorySource,
  omniOwnPython: () => omniOwnPython ?? omniOwnPythonNamed,
  phoneAnalysis: jaliFace ? undefined : phoneAnalysis,
  pythonExecutable: voiceConfig.runtime?.pythonExecutable,
  omniConfigs:omniVoiceConfigs,omniConfigPaths:omniVoiceConfigPaths,previewSettleMs:1500,
  voxtral:voxtralVoice,inworld:inworldVoice,languagePacks,pocketLanguages,keepsReference:vModKeepsReference,
  // OmniVoice's start does not warm the English startup voices when every reply is in a fixed language that a voice pack speaks (they would only delay the first line).
  skipStartupWarm: () => { const fixed = multilingual.fixed; return !!fixed && fixed !== 'en' && languagePacks.installed; },
  // Mature content on: no cloud voice speaks (Voxtral reads as Pocket; owner decision 2026-10-20, bridge/mature-content.mjs matureAllowsCloudVoice).
  cloudBarred: () => !matureAllowsCloudVoice(matureContent.enabled),
  aliases: fallbackAliases(voiceFallbacks, key => customCharacters.voiceAlias(key)),
  // The optional OmniVoice pack (worker Python, model weights, adapter); Settings greys Omni out without it.
  omniPack:()=>detectOmniPack({project,config:omniVoiceConfigs.long}),
  profileKeys:roster.map(profile=>profile.key),
  onState: state => {
    voiceMetricsWriting = voiceMetricsWriting.catch(() => {}).then(() => atomic(resolve(runtime, 'local-voice-state.json'), JSON.stringify(state)));
    return voiceMetricsWriting;
  },
  onLog: message => process.stderr.write('[LocalVoice] ' + message),
  // A voice that could not start becomes an error report (once per reason per run) and, for the Pocket voice, a row of the Help page's setup check.
  onFailure: info => errorEvents.voiceFailed(info),
  // V's own Pocket worker finished loading: prepare V's voice on it now (the clone of the reference clip takes seconds on a slow CPU),
  // so the first typed line of the session does not pay for it (bridge/v-voice.mjs warmUp). No renderer page is opened for this.
  onVHelperReady: () => vVoice.warmUp({page: false}),
});
// The release package ships NO Convai key: the shared account is reached through the sign-in backend (authSettings, below), and the daily
// limit applies to that. A plain api-key=... file in the state folder is a developer's (or a player's own) key and is used directly, with no
// daily limit, as it always was. Anything else in that file (a key a release before 0.2.9 packed there, or a damaged file) is ignored: the
// file is optional, so the bridge starts without it and Convai turns on the shared account fail with one plain notice when there is
// neither a key nor a backend (bridge/convai-key.mjs noCredentialError).
const key = parseKeyFileText(await readFile(keyFile, 'utf8').catch(() => ''));
await mkdir(runtime, {recursive: true});
await customCharacters.publish();
await characterOptions.publish({quiet: true});
// Which add-ons were found and why any was not loaded, for the game to tell the player (docs/ADDON_API.md). With none, a status
// file an earlier run left is removed and nothing is written. Then the add-on state and settings the game last wrote.
await addonHost.publishStatus(runtime).catch(error => console.error('[Addons] Status not written:', error.message));
// The content packs' new names and name pools, for the game to apply with the packs' switches (mod/content-names.lua); nothing without them.
await addonContent.publish(runtime);
for (const read of Object.values(addonHost.watchHandlers(runtime))) await read();
// Each speaker's recent lines and memories of earlier fights or rides (runtime/addon-journal.json); nothing without add-ons.
await addonHost.loadJournal(stateDirectory);
// The key conversations use: the one this installation provides, or the player's own (docs/OWN_CONVAI_KEY.md). It changes
// only at an idle boundary (applyKeyChoice). `quota` remembers a used-up plan for the settings page and the in-game notice.
// The sign-in backend (docs/CONVAI_AUTH_BACKEND.md, auth-backend/). A release ships it ON (app/defaults/convai-auth.json, written by the
// release build, no fallback); a development checkout has it off unless CYBERPUNK_CONVAI_AUTH_BACKEND=1 or convai-auth.json in the
// state folder says so, and an address and secret are set. Per setting the order is: environment, state-folder convai-auth.json, the
// package's file (so a developer's "enabled": false still turns a package's backend off). A plain developer key in the state folder keeps
// the package's file out: that key is used directly, as before. When on, the shared account is reached with a short-lived token fetched in
// the background (never on a turn); a player's own key is untouched. If the backend cannot be reached, a developer's key stands in only
// while CYBERPUNK_CONVAI_AUTH_FALLBACK allows it and a key exists; a release has neither, so the turn fails at once with a notice.
const authSettings = await readAuthSettings({path: resolve(stateDirectory, AUTH_CONFIG_FILE), packagedPath: resolve(project, PACKAGED_AUTH_FILE), usePackaged: !key});
// The backend sets the daily limit (auth-backend/, POST /api/admin/config). A value that arrives before the guard exists waits here.
let backendDailyLimit = null, turnGuardRef = null;
if (authSettings.problem) console.error(`[CyberpunkConvai] Sign-in backend is off: ${authSettings.problem}`);
const modVersion = await readFile(resolve(project, 'package.json'), 'utf8').then(text => JSON.parse(text).version, () => undefined);
const tokenSource = authSettings.enabled ? new TokenSource({url: authSettings.url, backupUrl: authSettings.backupUrl, secret: authSettings.secret,
  installId: await loadInstallId({path: resolve(stateDirectory, INSTALL_FILE)}),
  version: typeof modVersion === 'string' && /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(modVersion) ? modVersion : '0.0.0-dev',
  fallback: authSettings.fallback, log: message => console.error('[CyberpunkConvai] ' + message),
  onLimit: value => { backendDailyLimit = value; if (turnGuardRef?.setLimit(value)) console.error(`[CyberpunkConvai] Shared conversation allowance changed by the sign-in backend: ${value} turns a day`); }}) : null;
if (tokenSource) {
  console.error(`[CyberpunkConvai] Conversation sign-in: backend ${new URL(authSettings.url).host}${authSettings.backupUrl ? `, backup ${new URL(authSettings.backupUrl).host}` : ''}, developer-key fallback ${authSettings.fallback && key ? 'on' : 'off'}`);
  tokenSource.start(); // in the background, in parallel with the rest of start-up
} else if (!key) {
  console.error('[CyberpunkConvai] No Convai sign-in and no Convai key: conversations on the shared Convai account fail with a notice (a player\'s own key, Mistral, Local AI and Custom work)');
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
// The player's custom OpenAI-compatible endpoint (docs/CUSTOM_PROVIDER.md): address, optional key and model id in player-custom-endpoint.txt in this state
// folder. Reading it is a file read and nothing more: no request is made to the endpoint unless the player chooses this provider or presses Test connection.
const customEndpoint = await new CustomEndpoint({path: resolve(stateDirectory, CUSTOM_FILE), log: message => console.error('[Custom] ' + message)}).load();
// Google Gemini (bridge/gemini-provider.mjs): the same client on a second endpoint with its own saved key (player-gemini-endpoint.txt), a provider of its own in the list.
const geminiEndpoint = await openGeminiEndpoint(stateDirectory, message => console.error('[Gemini] ' + message));
const mistral = await new MistralProvider({keyPath: resolve(stateDirectory, MISTRAL_KEY_FILE), inworld: inworldKey, custom: customEndpoint, gemini: geminiEndpoint}).load();
// runtime/mistral-state.json is not written until the first settings poll has applied the saved provider (released after it, at the end of
// start-up): until then the provider is the default, Convai, and the game would read that as the player's choice for a moment.
mistral.statusHeld = true;
// The endpoint the turns use: Google Gemini's while that provider is applied, the Custom provider's otherwise (follows the provider's idle boundary).
const turnEndpoint = activeEndpoint({provider: mistral, custom: customEndpoint, gemini: geminiEndpoint});
// Earlier setups moved once (bridge/gemini-provider.mjs): a Gemini plan a test build saved on the Custom page, a saved Mistral key into the Mistral preset.
await migrateEarlierSetups({custom: customEndpoint, gemini: geminiEndpoint, mistralKey: mistral.key, log: message => console.error('[Gemini] ' + message)});
// The optional Local AI packs (standard and lite) and the supervisor of the model server. Nothing starts here: the server is
// started when the player chooses Local, and stops by itself after ten idle minutes. A developer points CYBERPUNK_CONVAI_LOCAL_AI_DEV
// at a folder of models (docs/LOCAL_AI.md).
let localPack = detectLocalAiPack({project});
// Omni (the OmniVoice pack) loads first and the model tier is chosen from the graphics memory left (docs/LOCAL_AI.md): a wait of
// at most two minutes inside the supervisor, then the tier that fits, else Local AI says why it cannot (its turns never go to a cloud provider).
// True once a settings poll has read the voice settings (playback on or off): until then `playbackEnabled` is only its default.
let voiceSettingsRead = false;
// Settled means: the voice settings have been read (until then `requestedProvider` is its default, Pocket, and the first poll starts Local AI before it reads them: the 2026-10-22 report
// loaded the model whole beside an OmniVoice that was still to load), and OmniVoice is either not wanted, loaded, not installed, or has failed and the committed voice is the fallback.
const omniSettled = () => voiceSettingsRead && (localVoice.requestedProvider !== 'omni' || localVoice.provider === 'omni' || localVoice.omniPack?.installed === false || localVoice.fallback != null);
// The graphics memory of OmniVoice (MiB) while it is wanted, playing is on and it is not loaded (still loading, or waiting to be loaded again in the background): the model is not placed in
// memory that Omni is about to take. Pocket runs on the CPU and counts nothing; V's OmniVoice engine is a job on the same worker and adds nothing.
const omniStillToLoadMiB = () => !localVoice.remoteWanted && localVoice.requestedProvider === 'omni' && localVoice.omniPack?.installed !== false && localVoice.playbackEnabled !== false && localVoice.provider !== 'omni'
  && (localVoice.fallback == null || localVoice.omniRetry != null) ? SMALL_CARD_ROOM.omniVoiceMiB : 0;
// The graphics memory OmniVoice holds while it is loaded: part of the card's used memory that is not the game's (the small-card room measures the game's footprint without it).
const omniResidentMiB = () => !localVoice.remoteWanted && localVoice.clientBackend === 'omni' && localVoice.client?.loaded === true && localVoice.playbackEnabled !== false ? SMALL_CARD_ROOM.omniVoiceMiB : 0;
// Which installed model loads (docs/LOCAL_AI.md, "Choosing the model"): the localModel setting (auto or one model) and Mature content, read
// when a start begins. A change while Local AI is the provider reloads at an idle moment (localModelChoiceChanged, on the settings poll).
let localModelPin = 'auto';
// The setting "Allow Local AI to use RAM" (localOffload, off by default): the chosen model is kept when it does not fit the free graphics memory, with part of it on the processor.
let localOffloadAllowed = false;
// Models the player added by hand (manifest.custom.json in %LOCALAPPDATA%\AiNpcCyberpunkMod\local-ai and in the Local AI folder, docs/LOCAL_AI.md "Add your own model"): a few stats and one small JSON read each, with
// the GGUF header read only for a file that changed. Looked at on the settings poll (at most every 5 s) and when a model is about to load.
const customScanner = new CustomModelScanner({project, log: message => console.error('[LocalAI] ' + message)});
let customScan = {models: [], problems: []}, cardTotalMiB = null, cardAskedAt = 0;
const scanCustomModels = () => (customScan = customScanner.scan({totalVramMiB: localServer.totalVramMiB ?? cardTotalMiB}));
const localModelSelection = () => { maturePackInstalled(true); return {pin: localModelPin, keepChosen: localOffloadAllowed, matureOn: matureContent.enabled, matureModels: maturePackModels, customModels: scanCustomModels().models}; };
// The model servers a bridge that died hard (a V8 out-of-memory, a crash, "End task") left running are stopped before ours start, so the card's memory is free for them
// (bridge/child-registry.mjs: only a process that is exactly the exe and the start we wrote down, whose bridge is gone). Ours are written down as they start.
const childrenFile = resolve(stateDirectory, CHILDREN_FILE);
await reapChildren({file: childrenFile, log: message => console.error(message)});
const childRegistry = new ChildRegistry({file: childrenFile, log: message => console.error('[Resource] ' + message)});
const localServer = new LocalLlmServer({pack: localPack, stateFile: resolve(stateDirectory, 'local-ai-state.json'), selection: localModelSelection, processOptions: {registry: childRegistry, raiseLevel: turnPriority},
  beforeStart: async () => { for (let waited = 0; !omniSettled() && waited < 120000; waited += 500) await new Promise(done => setTimeout(done, 500)); },
  gameRoom: {voiceMiB: omniStillToLoadMiB, residentVoiceMiB: omniResidentMiB},
  // The OmniVoice worker's graphics-memory counters, read once when the chat model is found in shared memory (diagnostics: is the voice starved, or spilled too?).
  voiceMemory: async () => { const pid = localVoice.clientBackend === 'omni' ? localVoice.client?.child?.pid : null; return pid ? readGpuProcessMemory(pid) : null; },
  log: message => console.error('[LocalAI] ' + message)});
scanCustomModels();   // once now; then on the settings poll and when a model is about to load
localServer.on('failed', ({reason}) => {
  mistral.noteLocalFailure(reason);
  // The turns stay on Local AI (never handed to Mistral or Convai) and each says why; the next turn tries again (bridge/text-provider-host.mjs localRoute). One line per failure.
  if (mistral.localDown) logLocalDown();
});
// The model server stopped by itself and is running again: the game says so once, with the next reply (mod/init.lua, 'local-restarted').
localServer.on('restarted', () => mistral.noteLocalRestarted());
function logLocalDown() {
  console.error(`[LocalAI] Local AI is unavailable (${mistral.localBroken}): turns stay on Local AI, the game names the reason, and the next turn tries again`);
}
// A chosen model that is missing, does not fit or did not start: another was used (the event names it), and the game says so once per choice (not at every later start).
let localModelFallbackNoted = '';
// A model that did not fit the graphics memory also carries what it needs and what was available for it (MiB): the notice says both.
localServer.on('model-fallback', ({pin, reason, model, needMiB, availableMiB}) => {
  const key = pin + '|' + reason;
  if (key === localModelFallbackNoted) return;
  localModelFallbackNoted = key; mistral.noteLocalModelFallback(model, reason === 'low-memory' ? {needMiB, availableMiB} : undefined);
});
// Turns stalled (the game uses most of the graphics memory and the model reads at a crawl): the server stepped down to the next smaller model of its family, or, with
// none left, Local AI fails with 'low-memory' (its 'failed' follows; no cloud takes over). The game says so once, with the next reply (mod/init.lua, 'local-stepdown'). The saved choice is untouched.
localServer.on('model-stepdown', ({model}) => { mistral.noteLocalStepDown(model); });
// A model loaded with under 35% of its layers on the graphics card (the game holds the rest) runs mostly on the processor: slow, but allowed. The game says so once per model, with the next
// reply (mod/init.lua, 'local-cpu'; the game also shows it at most once per session). Smaller model or Custom provider is the cure it names; no cloud provider.
const cpuHeavyNoted = new Set();
localServer.on('offload-slow', ({id, model, share}) => {
  if (cpuHeavyNoted.has(id)) return;
  cpuHeavyNoted.add(id); mistral.noteLocalCpuHeavy();
  console.error(`[LocalAI] ${model} runs mostly on the processor (about ${Math.round((share ?? 0) * 100)}% of its layers on the graphics card): replies will be slow`);
});
// The player allowed partial offload to RAM and the chosen model did not fit the free graphics memory: it was kept with part on the processor. The game says so once per model, with the next reply
// (mod/init.lua, 'local-offload'), because replies are slower than from the card alone.
const offloadKeptNoted = new Set();
localServer.on('offload-kept', ({id, model, share}) => {
  if (offloadKeptNoted.has(id)) return;
  offloadKeptNoted.add(id); mistral.noteLocalOffloadKept(model);
  console.error(`[LocalAI] ${model} is kept as chosen with part of it on the processor (about ${Math.round((share ?? 0) * 100)}% of its layers on the graphics card): replies will be slower`);
});
// The model that had gone into shared memory (or partly onto the CPU) is whole on the graphics card again: the game says so once, with the next reply (mod/init.lua, 'local-gpu').
localServer.on('returned-to-card', ({model, fromSharedMiB, contextSize}) => {
  mistral.noteLocalReturned();
  console.error(`[LocalAI] ${model} is back on the graphics card${Number.isFinite(fromSharedMiB) ? ` (it had ${fromSharedMiB} MiB in shared system memory)` : ''}, context ${contextSize}: replies are fast again`);
});
localServer.on('state', status => {
  // The model server is running: whatever failed before is over (a later turn found memory again, or the retry of a turn started it), so turns stop failing with the old reason.
  if (status?.state === 'ready') mistral.clearLocalFailureAny();
  try { void mistralControl.publishStatus().catch(() => {}); } catch { /* the control is created further down */ }
});
// What the model server loaded and how its last turn went goes into the status file (the support report reads it): after a start, after the first turn on a model and
// after a turn that failed (the supervisor says so with this event), bundled within half a second. Nothing runs between those moments.
let diagnosticsTimer = null;
localServer.on('diagnostics', () => {
  if (diagnosticsTimer) return;
  diagnosticsTimer = setTimeout(() => { diagnosticsTimer = null; try { void mistralControl.publishStatus().catch(() => {}); } catch { /* the control is created further down */ } }, 500);
  diagnosticsTimer.unref?.();
});
const localEmbedder = new LlamaEmbedder({pack: localPack, processOptions: {registry: childRegistry}, log: message => console.error('[LocalAI] ' + message)});
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
// A server the player already runs (an `endpoint` entry of manifest.custom.json, docs/LOCAL_AI.md "Use your own server") can answer Local AI with no
// pack at all. Read from the last scan of the manifest (the settings poll, at most every 5 s): no file is read here.
const ownServerListed = () => externalModels(customScan.models).length > 0;
// Can Local AI answer at all: an installed pack, a server of the player's, or a GGUF file of their own with the Runtime's engine to run it (no pack needed, 2026-10-29).
const localAiUsable = pack => localAiAvailable({pack, customModels: customScan.models});
// The player has a model file of their own and the Runtime's engine is there to run it (no pack needed): the setup check counts that as installed.
const ownModelRunnable = pack => Boolean(pack?.server) && ownFileModels(listLocalModels({pack, customModels: customScan.models})).length > 0;
// The status the settings page shows: ready, warming up, not installed, not enough graphics memory, or unavailable.
function localAiStatus() {
  if (!localAiUsable(refreshLocalPack())) return 'not-installed';
  const {state, reason} = localServer.status();
  if (state === 'failed') return reason === 'low-memory' ? 'no-memory' : reason === 'not-installed' ? 'not-installed' : 'failed';
  return state === 'starting' || state === 'warming' ? 'warming' : 'ready';
}
// Why Local AI is down, when the settings page can tell the player what to do: only Mature models are usable and Mature content is off.
const localAiReason = () => { const {state, reason} = localServer.status(); return state === 'failed' && reason === 'mature-off' ? 'mature-off' : null; };
// Choosing Local: look for the pack, clear an earlier failure, and load the model in the background so the shader compile of a
// first start is over before the first conversation. A missing pack or a failed start leaves the provider on Local AI, and its turns say why.
function prepareLocal() {
  const pack = refreshLocalPack(true);
  if (!pack.installed) scanCustomModels();   // a pack-less install can still have a server or a model file of its own listed
  if (!localAiUsable(pack)) { mistral.noteLocalFailure('not-installed'); return; }
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
// The one daily cap (500 turns per installation) for the shared account (the sign-in backend with no key of the developer's own); never applied to
// a player's own key, Local AI, Mistral or Custom. It counts every turn the shared key serves: no pools for kinds of turns, no rate limit.
// CYBERPUNK_CONVAI_DAILY_LIMIT sets the cap (a number) or switches the guard off (off); without it only the shared account is limited, so
// a development checkout with a plain runtime/convai-key.txt is not. The count is saved twice (state folder, user profile), signed.
const dailyLimitPinned = typeof process.env.CYBERPUNK_CONVAI_DAILY_LIMIT === 'string' && process.env.CYBERPUNK_CONVAI_DAILY_LIMIT.trim() !== '';
// With the sign-in backend on, the cap is the backend's number: the last one it told this installation (kept in daily-limit.json), else 500,
// until the first answer arrives. Without the backend, or with the environment variable set, it stays what it was.
const limitStore = tokenSource && !dailyLimitPinned ? new LimitStore({machine: await machineId(), path: resolve(stateDirectory, 'daily-limit.json')}) : undefined;
const dailyLimit = limitFromEnvironment(process.env.CYBERPUNK_CONVAI_DAILY_LIMIT, tokenSource && !key ? (await limitStore?.load() ?? DAILY_LIMIT) : 0);
const turnGuard = await new SharedKeyGuard({limit: dailyLimit, applies: () => keys.source === 'shared', limitStore, pinned: dailyLimitPinned,
  onLimit: () => { void ownKeyControl?.publishStatus().catch(() => {}); },
  store: dailyLimit > 0 ? new UsageStore({machine: await machineId(), paths: [resolve(stateDirectory, 'daily-usage.json'),
    resolve(process.env.LOCALAPPDATA || homedir(), 'CyberpunkConvai', 'daily-usage.json')]}) : undefined,
  onChange: () => { tokenSource?.noteTurn(); void ownKeyControl?.publishStatus().catch(() => {}); }}).load();
turnGuardRef = turnGuard;
if (backendDailyLimit !== null) turnGuard.setLimit(backendDailyLimit);
// What the hosts ask before a turn: the local gate as before, plus (backend mode only) the backend's own "daily allowance used"
// answer, shown with the same notice. Both are synchronous checks of memory; nothing here touches the network.
const hostGuard = {check: () => { turnGuard.check(); if (tokenSource) keys.assertAllowed(); },
  consume: () => { turnGuard.consume(); }};
if (dailyLimit > 0) console.error(`[CyberpunkConvai] Shared conversation allowance: ${dailyLimit} turns a day, ${turnGuard.snapshot()?.left ?? dailyLimit} left today`);
const currentKey = () => keys.current();
// A player's key pre-opens no connections and speculates on nothing (its plan's interactions and its one-connection free plan).
// With Mistral there is no Convai connection to pre-open or to speculate on either. Group look-ahead is the exception on a
// confirmed paid plan (lookaheadAllowed below), which may hold six connections.
const singleSession = () => keys.singleSession || mistral.active;
// How many conversation connections a player's key may hold at once: one on a free, unknown or unread plan; Convai's six on a
// confirmed paid Gamer plan (docs/CONVAI_PAID_TIER.md), so several companions can talk and generate together. Memory-only;
// set once the paid tier service exists (further down), one until then.
let playerConnectionLimit = () => 1;
const connectionLimit = () => mistral.active ? 1 : playerConnectionLimit();
const spawnedConnections = () => spawnedWarmLimit({singleSession: keys.singleSession, connectionLimit: connectionLimit(), textProvider: mistral.active});
// `kind`: 'group' (the next speaker of a round), or 'follow' / 'ahead' (one line prepared beside a line that is playing: Johnny's follow-on, a companion's
// after-scene line). The text providers take only the second kind, as background-priority work (docs/COMPANION_SPEAK_UP.md, "Bridge side").
const textProviderChosen = () => mistral.active || mistral.requested !== 'convai';
const lookaheadAllowedFor = kind => lookaheadAllowed({singleSession: keys.singleSession, connectionLimit: connectionLimit(), textProvider: textProviderChosen(), kind});
const groupLookaheadAllowed = () => lookaheadAllowedFor('group');
// A text provider answered in a language the chosen voice cannot speak (Pocket speaks English only, Voxtral the languages its model lists): the reply is shown as text, and
// the player is told once per game session that OmniVoice has voices for other languages (the game's 'voice-language' notice).
const voiceLanguageNotice = new VoiceLanguageNotice();
// The Pocket model of a language is installed but the multilingual pack it clones from is not: that language's replies are text, said once per language per game session.
const pocketLanguageNotice = new PocketLanguageNotice();
let pocketNotice;
const keyNotice = () => {
  pocketNotice = undefined;
  const keyNotice = keys.takeNotice() ?? mistral.takeNotice({cloudVoice: localVoice.requestedProvider === 'convai'}) ?? voiceLanguageNotice.take() ?? (pocketNotice = pocketLanguageNotice.take())?.keyNotice
    // Windows draws its yellow capture border for the "Companions can see" pictures (docs/COMPANION_VISION.md): said once, with the next reply.
    ?? (companionVision.takeBorderNotice() ? 'vision-border' : undefined)
    // The setting is on and the provider cannot take pictures (a Local AI model with no vision projector, a Custom endpoint that refused one): said once per case, with the next reply.
    ?? companionVision.takeSightNotice() ?? undefined;
  // The fallback notice names the model that was used instead.
  return keyNotice ? {keyNotice, ...(keyNotice === 'pocket-language-pack' ? {keyNoticeLanguage: pocketNotice.keyNoticeLanguage} : {}), ...((keyNotice === 'local-model-fallback' || keyNotice === 'local-stepdown') && mistral.noticeModel ? {keyNoticeModel: mistral.noticeModel} : {}),
    ...(keyNotice === 'local-model-fallback' && mistral.noticeMemory ? {keyNoticeNeedMiB: mistral.noticeMemory.needMiB, keyNoticeAvailableMiB: mistral.noticeMemory.availableMiB} : {}),
    // The few words the game shows after the 'local-cpu' sentence (as data, so the sentence is the only string to translate); never a cloud provider.
    ...(keyNotice === 'local-cpu' ? {keyNoticeDetail: LOCAL_CPU_DETAIL} : {}),
    ...(keyNotice === 'local-offload' && mistral.noticeModel ? {keyNoticeModel: mistral.noticeModel} : {}),
    // The folder of the Hugging Face packs page the missing vision file is in (data, so the sentence is the only string to translate): local-ai or mature.
    ...(keyNotice === 'vision-local-no-file' ? {keyNoticeFolder: localServer.visionState().folder === 'mature' ? 'mature' : 'local-ai'} : {})} : {};
};
const LOCAL_CPU_DETAIL = 'a smaller model or the Custom provider is faster';
// The game's code for a turn Local AI could not take (never a hand-over to another provider): not enough free graphics memory, or any other reason it could not start.
const localUnavailableCode = error => error?.reason === 'low-memory' ? 'local-no-memory' : 'local-unavailable';
// A failed turn for the automatic error reports (bridge/error-events.mjs decides whether it is the player's own doing, from the same code
// the failure reply carries). Called after that reply is written; it defers its one file write, so the turn's path pays a function call.
function noteTurnFailure(error, input, {microphone = false} = {}) {
  try { turnClocks.get(input?.requestId)?.annotate({failed: true}); } catch { /* the slow-turn report leaves a failed turn out */ }
  try {
    const errorCode = input ? turnFailure(error, input).errorCode : undefined;
    errorEvents.turnFailed(error, {provider: mistral.route ?? 'convai', errorCode, microphone,
      localReason: errorCode === 'local-fallback' || errorCode === 'local-unavailable' || errorCode === 'local-no-memory' ? mistral.localBroken || localServer.status().reason : undefined});
  } catch { /* a report is never worth a failure of its own */ }
}
// While Local AI is chosen and cannot start, a failed turn names Local AI's own problem ('local-no-memory', 'local-unavailable'); an older 'local-fallback'
// code becomes that too (MistralProvider.failureCode). Others pass.
const providerFailureCode = code => mistral.failureCode(code);
// keyFailure (below) with that correction: what every failed turn's reply carries.
const turnFailure = (error, input) => {
  const failure = keyFailure(error, input), errorCode = providerFailureCode(failure.errorCode);
  const corrected = errorCode === failure.errorCode ? failure : {...failure, errorCode};
  // Mistral or Custom is chosen but cannot be used (no key, no address) and Convai answered instead: the failed turn carries that one-time notice
  // too (the game shows it once per session), so a setting that did not take effect is never silent. An automatic reaction just stops.
  const fallback = mistral.applied === 'convai' && !input?.reaction ? mistral.fallbackReason : null;
  if (fallback && !corrected.keyNotice) return {...corrected, keyNotice: fallback};
  // Local AI could not start (or would not start again after it stopped working): the game's sentence says that, and these few words say why
  // (the pack is missing, no graphics card, the model server stopped working), shown after it like a local turn's detail.
  if ((errorCode === 'local-unavailable' || errorCode === 'local-no-memory' || errorCode === 'local-fallback') && !corrected.errorDetail) {
    const detail = unavailableDetail(isLocalUnavailable(error) ? error.reason : mistral.localBroken, isLocalUnavailable(error) ? error.detail : localServer.status().detail);
    if (detail) return {...corrected, errorDetail: detail};
  }
  return corrected;
};
// The game's notice for a failure (docs/NOTIFICATIONS.md). An automatic reaction that hit the daily cap just stops: no notice.
const keyFailure = (error, input) => {
  // A Mistral failure says what to do about it (key, free limit, model); an automatic reaction (battle, loot) just stops.
  // The local AI that could not start: the turn fails with Local AI's own reason (local-no-memory, local-unavailable) and the next turn tries again; no other provider takes it.
  // The browser for the conversation page would not start (or there is none): a turn V asked for says which browser and why, like a Local AI failure.
  const browserFailed = error?.code === 'BROWSER_START_FAILED' || error?.code === 'NO_BROWSER';
  const errorCode = (input?.reaction ? undefined : browserFailed ? 'browser-failed' : isLocalUnavailable(error) ? localUnavailableCode(error) : mistralCodeFor(error))
    ?? quota.codeFor(error, {automatic: !!input?.reaction});
  // The detail is the bridge's own short sentence ("Brave was found but would not start: ..."), already cut down to file names.
  if (errorCode === 'browser-failed') return {errorCode, errorDetail: error.code === 'NO_BROWSER' ? 'no Chromium browser found' : String(error.message).split('\n')[0].slice(0, 140)};
  // A local turn that failed says what the model was waiting for: one plain English phrase (bridge/mistral-client.mjs failureDetail), which the game shows
  // after its own sentence (docs/NOTIFICATIONS.md, local-failed). Never a word of the reply, a path or a key. The corrections of turnFailure (below Local AI's
  // own 'local-no-memory' / 'local-unavailable') leave 'local-failed' alone: a model that started and failed a turn has this reason, not a start problem.
  const errorDetail = errorCode === 'local-failed' ? localFailureDetail(error) : undefined;
  return errorCode ? {errorCode, ...mistralExtrasFor(error), ...(errorDetail ? {errorDetail} : {})} : {};
};

const knowledgePack = await requiredJson('characters/world-knowledge.json');
const questCatalog = await requiredJson('research/cyberpunk/generated/quest-catalog.json');
const intrinsicHistory = await loadIntrinsicCharacterContext(project);
if (intrinsicHistory.unavailable.length) console.error('[CyberpunkConvai] Optional intrinsic topic packs unavailable:', intrinsicHistory.unavailable.join(', '));
// One local player ID is shared across all characters and saves. No save facts,
// branch IDs, manual memory archive or provider-ID pool participates in routing.
let worldSession = null, knowledgePolling = false, memoryQuiescing = 0;
// A voice turn that is running (the key is held, a recording or its reply is under way) rides out a game that stalls for up to MIC_LEASE_MS: the heartbeat is only late,
// and ending the turn for it left the player with a subtitle and no reply (bridge/world-session.mjs). Assigned once the microphone exists, below.
let micTurnRunning = () => false;
const currentBoundary = () => worldBoundary(worldSession, micTurnRunning());
const worldCurrent = boundary => {
  const current = currentBoundary();
  return !!current && current.worldToken === boundary.worldToken && current.generation === boundary.generation;
};
// Vendor memory (docs/PLAYER_MEMORY.md): a returning one-shop vendor remembers V. Local and bounded; no provider ID or call.
const vendorMemory = await VendorMemory.open({path: resolve(stateDirectory, 'vendor-memory.json'),
  onWarning: message => console.error('[CyberpunkConvai] Vendor memory: ' + message)});
// Street reputation (docs/REPUTATION_DESIGN.md): nothing is read or written until a turn carries the game's reputation snapshot (the
// setting is off by default). The game's deeds come in runtime/reputation-events.json and inline; the standing is kept beside vendor memory.
const reputation = new ReputationStore({path: resolve(stateDirectory, 'reputation.json'), eventsPath: resolve(runtime, 'reputation-events.json'),
  log: line => console.error(line)});
// Romance with any character, started and ended by V's words (bridge/romance-bond.mjs, docs/SIDE_ROMANCE.md); the game keeps the state in the save. Its Bonds object is set once that exists.
const romanceBond = new RomanceBond({log: line => console.error('[Romance] ' + line)});
let playerMemory;
const memoryProvider = new PlayerMemoryApi({key: key ?? undefined, characterIds: relationshipRoutes.providerIds, markerKeys: relationshipRoutes.markerKeys,
  credential: () => keys.credential(),
  historicalPairAllowed: ({profileKey, characterId}) => playerMemory?.hasContactedProviderPair(profileKey, characterId) === true});
// Backend mode: no key-only call (character list, character read, character update) runs from a player's machine. Ownership is the
// shipped id list; memory is switched on beforehand by scripts/Enable-CharacterMemory.mjs.
if (keys.usesBackend) memoryProvider.use({key: key ?? undefined, own: false, backend: true});
playerMemory = await PlayerMemory.open({path: resolve(stateDirectory, 'player-memory.json'),
  characterIds: relationshipRoutes.providerIds, characterFamilies: relationshipRoutes.providerFamilies,
  provider: memoryProvider, quiesce: quiescePlayerMemory, retired: providerKey => RETIRED_PROVIDER_KEY.test(providerKey)});
const knowledgeRouter = new PlayerKnowledge({playerMemory, pack: knowledgePack, questCatalog,
  isWorldCurrent: worldCurrent, getBoundary: currentBoundary,
  // Which Convai character answers is decided per turn: the multilingual twin for a message that is clearly not English, the ordinary
  // character otherwise (bridge/multilingual.mjs wantsTwin). A warm connection has no message and stays on the ordinary character: a language
  // change must not re-warm every nearby character on its twin; the first turn on a twin opens its session, the later ones reuse it.
  // A romance V started through the bond system (bridge/romance-bond.mjs) shapes the delivery of any character: the turn's bond block carries the save's state, a reaction or a warm-up uses the last one seen.
  selectProfile: (profile, boundary, turn) => {
    if (turn?.bonds) romanceBond.noteBlock(profile, turn.bonds.romance, boundary);
    return relationshipRoutes.select(profile, boundary, {multilingual: twinForTurn(turn), romance: romanceBond.stateFor(profile, boundary)});
  },
  // On by default, the game's decisionLedger setting writes the file (docs/QUEST_DECISIONS.md 4.4); one stat per turn when it does not exist.
  decisionLedger: decisionLedgerReader(resolve(stateDirectory, 'decision-ledger.json'), {readFile: path => readFileSync(path, 'utf8'), statFile: statSync}),
  // On by default, the game's witnessReceipts setting writes the file (docs/QUEST_DECISIONS.md 4.3); one stat per turn when it does not exist.
  witnessReceipts: witnessReceiptsReader(resolve(stateDirectory, 'witness-receipts.json'), {readFile: path => readFileSync(path, 'utf8'), statFile: statSync})});
const phoneKnowledge = new PlayerPhoneKnowledge({router: knowledgeRouter, getBoundary: currentBoundary});
// "Natural speech": the setting, and the display text of every reply with voice tags removed (bridge/natural-speech.mjs).
const naturalSpeech = new NaturalSpeech();
// "Expressive emotions": the character marks its own feelings inline; the marks drive the face (bridge/expressive-emotions.mjs).
const expressiveEmotions = new ExpressiveEmotions();
// Facial emotion selection (bridge/emotion-selector.mjs): player message + reply + character manner + Convai's own
// label; `emotionSelector: "legacy"` in settings.json returns to the reply-only planner.
const emotionSelection = new EmotionSelection();
const cleanReply = result => expressiveEmotions.process(naturalSpeech.process(result));
// The language the conversation was last in (bridge/multilingual.mjs). Replies follow the player's language on every route; there is no setting.
const multilingual = new MultilingualConversations();
// Convai's twins answer a turn only on the free shared plan (a player's own key has one session and no twins) and only while Convai answers at all.
const twinForTurn = turn => !!turn && !keys.singleSession && !mistral.active && multilingual.wantsTwin({text: turn?.text, reaction: !!turn?.reaction, hint: speechLanguage.evidence?.language ?? null});
// A player's free plan allows very few memory users. When Convai refuses a new one ("LTM speaker limit reached") the
// turn is repeated with a memory user the account already has, which becomes the player's one id on that key
// (convai-key.mjs, adoptUser; saved, so later sessions reuse it). Only when the account has none to adopt does the turn
// repeat without an end-user identity and the key's conversations go on without long-term memory (a Convai character
// with memory on may refuse those too: "Missing end_user_id"). Nothing is guessed: only that exact refusal does any of
// this, and a different key starts again.
const memoryPolicy = config => keys.memoryBlocked && config ? withoutIdentity(config) : keys.identify(config);
// Sessions opened under another identity belong to it; the transcript the phone shows is not touched.
function retireIdentifiedSessions() {
  sessions.clear(); realtimeSessions.clear(); sceneryMemory.clear(); gearMemory.clear();
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
const keyHostOptions = peers => ({exclusive: {enabled: singleSession, limit: connectionLimit, peers, retryMs: 1500},
  // The backend token replaces the key in the config sent to Convai (unchanged without backend mode or with a player's own key).
  credential: config => keys.credentialFor(config),
  onFailure: error => {
    const kind = quota.observe(error);
    if (kind === 'speaker') void adoptOrBlockMemory(); // a path that cannot retry (a voice turn): its next turn uses the account's memory user
    else if (kind === 'memory' && keys.unblockMemory()) void ownKeyControl.publishStatus().catch(() => {});
  },
  onSuccess: () => { quota.succeeded(); keys.settled(); },
  recover: memoryRecovery({keys, classify: classifyFailure, onBlocked: () => memoryBlocked(), onAdopted: () => memoryAdopted()})});
const phoneRealtime = new RealtimeHost({browserPriority: turnPriority, transformReply: cleanReply, guard: hostGuard, ...keyHostOptions(() => [realtime])});
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
// The bridge ends a running voice turn because its world or the game's speech service is gone for good. The game is told, as an error that says "could not reach" and
// not "check your Windows input device": otherwise it waits in silence for a reply that cannot come (mod/microphone.lua retries only after 8 s, on the next press).
async function abandonMicrophone(why) {
  const current = mic.current;
  await cancelMicrophone();
  if (!current || stopped) return;
  console.error('[CyberpunkConvai] Microphone: the voice turn ended (' + why + ')');
  micStateLast = {state: 'error', reason: 'connection', requestId: current.requestId};
  await publishMicState().catch(() => {});
}
async function cancelMicrophone() {
  void voiceChoice?.cancel('another turn');
  micV.dropAll('turn-ended');   // V's line for a spoken turn ends with the turn (bridge/mic-v-line.mjs)
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
// Every named character is a Chat contact (rosterContacts): the shipped phone contacts plus one per other profile.
const shippedPhoneContacts = await requiredJson('characters/phone-contacts.json');
const phoneContacts = [...shippedPhoneContacts, ...rosterContacts(shippedPhoneContacts, roster)];
// Why a Phone Chat message failed (bridge/phone-failure.mjs): one log line, the small state file the support report carries, and the
// automatic error report. The player's phone only says "Message could not be delivered"; this says why. No message or reply text.
const phoneFailureStatePath = resolve(runtime, 'phone-failure-state.json');
const phoneFailures = new PhoneFailureLog({
  log: line => console.error('[CyberpunkConvai] ' + line),
  read: async () => JSON.parse(await readFile(phoneFailureStatePath, 'utf8')),
  write: record => atomic(phoneFailureStatePath, JSON.stringify(record)),
  report: ({error, errorCode, provider}) => errorEvents.turnFailed(error, {provider: provider ?? 'convai', errorCode}),
  provider: () => mistral.route ?? 'convai'});
const phone = new PhoneChat({
  onFailure: info => phoneFailures.note(info),
  failureCode: error => { const code = mistralCodeFor(error) ?? quota.codeFor(error); return providerFailureCode(PHONE_CODES.has(code) || /^(mistral|local|custom|gemini)-/.test(code ?? '') ? code : isLocalUnavailable(error) ? localUnavailableCode(error) : undefined); },
  contacts: phoneContacts, ids, custom: key => customCharacters.has(key),
  resetFor: profileKey => memoryControl.chatResets.phoneState(profileKey),
  contextFor: options => phoneKnowledge.prepareContext(options),
  contextCurrent: context => phoneKnowledge.current(context),
  contextCurrentSync: context => phoneKnowledge.currentSync(context),
  reply: async options => {
    // A character the player made has no Convai character and no knowledge route: its text goes through the player's text provider, like its talk turns (runCustomTurn).
    if (customCharacters.has(options.profileKey)) return customPhoneReply(options);
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
      // An appointment event is a message the character starts (bridge/appointment-events.mjs): its text is a trigger, so the local memory routes record a
      // bracketed note in V's place (or nothing) instead of it.
      ...(options.input.event ? {phoneEvent: {v: eventExchange(options.input.event)}} : {}),
      text: options.input.text, ttsEnabled: false, local: localTurn(prepared.input, prepared)}), options.profileKey), {signal: options.signal});
    if (!await knowledgeRouter.current(prepared)) throw Error('Phone world changed');
    await knowledgeRouter.activity(prepared, 'generated-reply', {replyText: result.text});
    stagedKnowledgeTurn(prepared);
    // Character bonds: a typed message counts as an exchange, and a story pack reads it against its stage (after the reply, no model is asked).
    publishBonds(prepared.input, result); publishPhoneEvent(options.input, options.profileKey);
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
  // A character the player made has no Convai memory or connection to open ahead (its text provider is warmed by its talk composer, warmCustom).
  profileFor: contact => { const profile = phone.profileFor(contact); return customCharacters.has(profile) ? undefined : profile; },
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
// A bridge that starts while a game session is running (the supervisor restarted it) reads, parses and freezes the parts that session published a little after start-up,
// so the first turn does not (bridge/knowledge-parts.mjs preloadKnowledgePart). Only files written in the last 15 minutes: an older one is from an earlier session. Not per
// revision: the game publishes a part inside the turn's own capture, so there is nothing earlier to read.
setTimeout(() => { for (const name of ['world', 'active', 'history']) void preloadKnowledgePart(name, {maxAgeMs: 15 * 60_000}); }, 2000).unref();
const replyPath = resolve(runtime, 'reply.json');
const statusPath = resolve(runtime, 'bridge-status.json');
const prefetchPath = resolve(runtime, 'group-prefetch.json');
const prewarmPath = resolve(runtime, 'conversation-prewarm.json');
const partyPath = resolve(runtime, 'party-connections.json');
const nearbyPath = resolve(runtime, 'nearby-connections.json');
const sessions = new Map();
const realtimeSessions = new Map();
// Older versions wrote Audioware's reply slots here; nothing uses them now (every voice plays through the renderer), so what is left is removed.
void removeAudioDepot(game).catch(() => {});
const speechStateFile = async () => {
  try { return JSON.parse(await readFile(resolve(runtime, 'speech-state.json'), 'utf8')); } catch { return {}; }
};
// The game's heartbeat file: readSpeechState() reads it (receipts, the watchdog); readSpeechStateCached() answers a turn's
// questions from a read at most 1 s old (bridge/speech-state-cache.mjs).
const speechStateReader = createSpeechStateReader({read: speechStateFile});
const readSpeechState = () => speechStateReader.fresh();
const readSpeechStateCached = () => speechStateReader.cached();
// How many OmniVoice replies are still rendering phrases (the worker takes one job at a time; a held look-ahead turn waits for them).
let streaming = 0;
const companionActions = new CompanionActions({createToken: () => 'drive-' + randomUUID(),
  publish: (packet, options) => atomic(resolve(runtime, 'companion-actions.json'), JSON.stringify(packet), options),
  // One line for every turn that carried an ordinary NPC's reaction offer (docs/NPC_REACTIONS.md): where it stopped, or that it was handed over.
  log: line => console.error('[NPCReaction] ' + line),
  // One line for every turn that carried a housing offer (docs/HOUSEMATES.md): the choice the reply asked for and whether it reached the game.
  homeLog: line => console.error('[Housing] ' + line),
  // The Convai route's part nobody could see: what its page did with the offer (armed or not, proposals seen). Read from the existing
  // diagnostics of the pages, once, only for a turn that asked for no action; never on the reply's path.
  probe: async () => {
    const pages = (await realtime.diagnostics()).map(page => page.value?.actions).filter(actions => actions?.eligibility?.hasOffer);
    const seen = pages.at(-1);
    if (!seen) return 'convai=no page was offered the action list';
    const e = seen.eligibility;
    return `convai=allowed:${e.allowed} privateManual:${e.privateManual} verified:${e.verified} armed:${e.armed} published:${seen.published}`
      + ` accepted:${seen.accepted} skipped:${seen.skipped} skip:${seen.lastSkip ?? '-'} ack:${seen.contextAck ?? '-'}`;
  }});
// "Companions can see" (docs/COMPANION_VISION.md): one setting, off by default (Settings > Conversations), for every conversation provider. Every conversation turn carries a recent
// picture of V's surroundings from an in-memory buffer that native/vision fills out of process while someone is near and nobody is talking. With Convai it is published on the page ahead
// of the line, with Mistral, Local AI and Custom it is an image_url part of the last user message (bridge/vision-message.mjs). With the setting off nothing is captured and the helper is not
// started. companionVision.attachToNextTurn(images) lets other features show the companion something (e.g. a TV picture).
const visionLog = message => console.error('[Vision] ' + message);
let speechPlayingAt = 0;
// Development: CYBERPUNK_CONVAI_VISION_DEBUG_LAST=1 (or "visionDebugLastSent": true in settings.json) keeps the last picture handed to
// Convai in runtime/vision-last-sent.jpg, with runtime/vision-last-sent.json saying when it was taken and how it was sent.
// What the text provider that answers can take: Mistral's models all have vision (bridge/mistral-client.mjs VISION_MODELS), Local AI only with a model that has a projector that fits
// (LocalLlmServer.visionState, remembered state only, no I/O), a Custom endpoint until it refuses a picture.
const visionSees = () => {
  switch (mistral.route) {
    case 'mistral': return true;
    case 'local': { const state = localServer.visionState(); return state.available === true && state.reason !== 'no-room' && state.reason !== 'start-failed'; }
    case 'custom': return textRoutes.custom.visionAllowed() === true;
    case 'gemini': return textRoutes.gemini.visionAllowed() === true;
    default: return false;
  }
};
// Local AI with the setting on and a model that cannot see: the player is told once per model and cause (mod/init.lua 'vision-local-no-model'). Nothing for a model that is not installed:
// Local AI has its own notices for that.
const visionBlocker = () => {
  if (mistral.route !== 'local') return null;
  const state = localServer.visionState();
  if (!state.wanted || !state.model || (state.available && state.reason !== 'no-room' && state.reason !== 'start-failed')) return null;
  const cause = state.reason ?? 'no-projector';
  // The pack's manifest names a vision file that is not installed: the model can see with it, and the player is told once where to get it ('vision-local-no-file', the folder comes with the reply).
  if (cause === 'file-missing') return {code: 'vision-local-no-file', key: `local:${state.model}:${cause}`, why: `${state.model} can see with its vision file, which is not installed (${state.file ?? 'no name'}, the vision folder of ${state.folder ?? 'local-ai'} on Hugging Face)`};
  return {code: 'vision-local-no-model', key: `local:${state.model}:${cause}`,
    why: `${state.model} cannot see (${cause === 'no-room' ? 'its vision projector does not fit beside it on the graphics card' : cause === 'start-failed' ? 'llama-server could not use its vision projector' : 'it has no vision projector'})`};
};
const companionVision = new CompanionVision({capture: new VisionCapture({log: visionLog}), isConvai: () => !mistral.active, sees: visionSees, blocker: visionBlocker,
  provider: () => mistral.active ? mistral.route : 'convai',
  lastSentPath: resolve(runtime, 'vision-last-sent.jpg'),
  isNear: () => !connections.stale && (connections.profiles.length > 0 || connections.nearby.length > 0 || connections.partners.length > 0),
  isConversing: () => !!(active || mic.current || micPolling || connections.composer) || Date.now() - speechPlayingAt < 1500,
  stageVoice: images => realtime.stageVoiceVision(images),
  stagePage: (config, images) => realtime.prestageVision(config, images), unstagePage: config => realtime.unstageVision(config),
  log: visionLog});
const realtime = new RealtimeHost({browserPriority: turnPriority, onCompanionAction: packet => companionActions.deliver(packet),
  transformReply: cleanReply, guard: hostGuard, vision: companionVision, ...keyHostOptions(() => [phoneRealtime]),
  audioRates: savedAudioRates, log: line => console.error('[Convai audio] ' + line),
  onAudioRate: rates => { audioRatesWriting = audioRatesWriting.catch(() => {}).then(() => mkdir(stateDirectory, {recursive: true}).then(() => atomic(audioRatesPath, JSON.stringify({version: 2, rates})))).catch(() => {}); }});
// Mistral route (docs/MISTRAL.md): the same text reply path as Convai, with the persona built from characters/*.json and a small
// local memory. attachMistral makes both hosts answer text turns through it while the provider is Mistral. `localTurn` names
// the character, the channel and (for an ordinary NPC) its conversation, so the host can recall the right history; the Convai path
// never sees it.
// One host serves Mistral and the local AI (bridge/text-provider-host.mjs); `mistral.route` says which answers a turn. The cache
// scope is a hash of the state folder, so the Mistral cache key never carries a secret or a name.
// The prompt limits a cloud provider named when it refused a prompt as too long (bridge/prompt-fit.mjs), per provider and model, kept for three days so the next session starts from them.
const promptLimits = new LearnedLimits({file: resolve(stateDirectory, 'prompt-limits.json')});
const textRoutes = {
  mistral: mistralRoute({provider: mistral, model: () => MISTRAL_MODELS, decisionModel: () => MISTRAL_DECISION_MODELS, scheduler: mistralScheduler, priorities: PRIORITY, cacheScope: createHash('sha256').update(stateDirectory).digest('hex').slice(0, 12), limits: promptLimits, log: line => console.error(line),
    onImagesRejected: kind => companionVision.noteRefused(kind)}),
  local: localRoute({server: localServer, provider: mistral, log: message => console.error(message.startsWith('[PromptFit]') ? message : '[TextProvider] ' + message), onImagesRejected: kind => companionVision.noteRefused(kind)}),
  custom: customRoute({provider: mistral, custom: customEndpoint, limits: promptLimits, log: line => console.error(line), onImagesRejected: kind => companionVision.noteRefused(kind)}),
  gemini: customRoute({provider: mistral, custom: geminiEndpoint, name: 'gemini', limits: promptLimits, log: line => console.error(line), onImagesRejected: kind => companionVision.noteRefused(kind)}),
};
const providerOfCharacter = new Map();
const profileOfCharacter = config => {
  if (!providerOfCharacter.size) for (const table of [ids, relationshipRoutes.providerIds ?? {}]) for (const [profile, id] of Object.entries(table)) if (typeof id === 'string') providerOfCharacter.set(id, profile);
  return providerOfCharacter.get(config?.characterId);
};
// The player's own edits of a character (docs/CHARACTER_EDITOR.md): read from disk once here, then a plain lookup on every turn.
const characterOverrides = await CharacterOverrides.open({dir: resolve(stateDirectory, 'character-overrides'), log: message => console.error('[Editor] ' + message)});
// The player's rules for the whole world (docs/CHARACTER_EDITOR.md, "World rules"): <state>/world-rules.json, read once here; the prompt builder reads the text
// with a plain property read per turn. The text providers carry it in every persona; Convai gets it in the context it is sent every turn.
const worldRules = await WorldRules.open({dir: stateDirectory, log: message => console.error('[Editor] ' + message)});
// The text providers' personas carry the player's rules and then the content packs' (a view of the same store); the editor and Convai below read the store itself.
const personaBook = new PersonaBook(roster, {lean: true, overrides: characterOverrides, custom: customCharacters, options: characterOptions,
  worldRules: addonContent.installed ? addonContent.worldRulesView(worldRules) : worldRules});
// "Mature content": read from the settings file when it changes (never per turn); the local AI and Custom routes use it, Mistral and Convai never. The optional Mature
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
// Prompt profiles (bridge/prompt-profiles.mjs, docs/LOCAL_AI.md "Prompt profiles"): the wording of the output rules and the sampling per model, with the player's own changes
// (<state>/prompt-overrides/<profile>.json) read once here; a turn picks its profile with a plain lookup and a saved change is in effect on the next turn. The Convai prompt is not touched.
const promptProfiles = await PromptProfiles.open({dir: resolve(stateDirectory, 'prompt-overrides'), log: message => console.error('[PromptProfiles] ' + message),
  packs: addonContent.installed ? addonContent : null,
  active: () => ({route: mistral.route, tier: localServer.status?.().tier ?? null, mature: matureContent.enabled === true,
    custom: turnEndpoint.ready ? {origin: turnEndpoint.origin, model: turnEndpoint.model} : null})});
// A content pack whose manifest says memory "separate" (API 1.1) gives the characters a memory of their own while it is on: the text providers keep it under `<profile key>@<pack id>`
// (bridge/memory-scope.mjs). This is the one place the mapping is made: a turn takes its key once when it starts, the character editor reads the memory in use, Forget acts on it.
// Convai's own memory is not part of it (a pack's Convai twins have ids of their own); an add-on speaker's and a player-made character's keys are never changed.
// With no pack, or a pack with a shared memory, every key is the profile key, as before.
const memoryNamespace = memoryScopes(addonContent);
// When V last talked to each character (Settings > Dynamic info > Time since last talk, bridge/last-talk.mjs): kept per memory key, so a pack's characters have their own, read before the first turn.
await lastTalk.configure({path: resolve(stateDirectory, 'last-talk.json'), keyFor: memoryNamespace.keyFor, log: message => console.error('[LastTalk] ' + message)});
// Character bonds (Settings > Companions > Character bonds, bridge/bonds.mjs): the shared part of each bond, per memory key (it follows the memory, and Forget clears it),
// read before the first turn; the levels and their changes go to the game in runtime/bonds-status.json for the one notice per change (mod/bonds.lua).
const bondStore = new BondStore();
await bondStore.configure({path: resolve(stateDirectory, 'bonds.json'), keyFor: memoryNamespace.keyFor, log: message => console.error('[Bonds] ' + message)});
const bonds = new Bonds({store: bondStore, statusPath: resolve(runtime, 'bonds-status.json'), log: line => console.error('[Bonds] ' + line)});
romanceBond.bonds = bonds;
// Story packs (bridge/bond-pack-runner.mjs): short arcs a character starts at a bond level once their own story is done. Their state follows the save
// (<state>/bond-packs.json, every step stamped with the game clock); what the game is asked to do goes to runtime/bond-effects.json.
// NOT part of 0.4.0 (docs/STORY_PACKS_INACTIVE.md): without the development switch (bridge/story-packs-gate.mjs) the runner is built empty and inert. It loads no pack, reads and
// writes no state file (an existing bond-packs.json is left as it is), writes no effects, the quest link never writes a play file and no poll timer ever runs.
configureStoryPacksGate({runtime});
const storyPacksOn = storyPacksAvailable();
const bondPacks = new BondPacks({characters: new Set(roster.map(row => row.key)),
  ...(storyPacksOn ? {path: resolve(stateDirectory, 'bond-packs.json'), effectsPath: resolve(runtime, 'bond-effects.json')} : {packs: [], reach: null, path: null, effectsPath: null}),
  bonds, log: line => console.error('[BondPacks] ' + line),
  // Developer mode: a pack that does not start says why (once per pack per game day).
  explain: () => replyCapture.enabled,
  // The quest facts the game reports (runtime/quest-facts.json, bridge/quest-facts.mjs): looked at only when a gate asks, and then at most every few seconds.
  readFacts: createFactsReader({path: resolve(runtime, 'quest-facts.json')})});
await bondPacks.load().catch(() => {});
// The gift allowlist the game checks community gifts against (characters/gift-tables.json): written once at the service start, only when it is missing or changed.
if (storyPacksOn) void syncAllowlist({path: resolve(runtime, 'quest-gift-allowlist.json')});
bonds.packSource = bondPacks.source();
// Quest primitives (docs/QUEST_PRIMITIVES.md section 4): the quest the game is to execute goes to runtime/quest-play.json (written when the pack state changes), and what the game saw
// comes back through runtime/quest-events.json. The events file is read every 500 ms only while a quest is active: the timer exists only then (bridge/quest-poller.mjs), so with no quest
// nothing runs.
const questLink = new QuestLink({packs: bondPacks, readEvents: () => readFile(resolve(runtime, 'quest-events.json'), 'utf8').catch(() => ''),
  writePlay: text => atomic(resolve(runtime, 'quest-play.json'), text), now: Date.now, log: line => console.error('[QuestLink] ' + line)});
const questPoller = createQuestPoller({link: questLink, stopped: () => stopped, onError: error => pollLog('[CyberpunkConvai] Quest link:', error)});
// The pack state may have changed (a turn, a meeting): the play file follows it (a revision compare when nothing changed), and the poll runs while a quest is active.
const questSync = storyPacksOn ? () => { void questPoller.sync(); } : () => {};
// The prepared audio decoder and the media link. Made here, after the quest poller they read and before the voice routing code: the code between is evaluated piece by piece by tests.
const preparedAudio = createPreparedAudio({cache: createDecodeCache({directory: resolve(stateDirectory, 'prepared-audio-cache')}),
  onLog: message => console.error('[PreparedAudio] ' + message)});
// Music and sound effects of a story pack (docs/BOND_QUESTS.md 19.2 and 19.3, bridge/media-link.mjs): the game writes runtime/media-command.json, the bridge decodes the pack's file
// and plays it on the media page of the hidden browser (a second stream beside the voice, ducked under speech). A file of its own and not the request file, because a media request
// written over the request of a running talk turn would cancel that turn. No timer: the loop below calls maybePoll(), which looks only while a quest runs or a sound plays.
const mediaLink = new MediaLink({path: resolve(runtime, 'media-command.json'), bondPacks, audio: preparedAudio, fs: {stat, readFile},
  host: () => realtime.mediaHost(), peek: () => realtime.peekMedia(), wanted: () => questPoller.armed || realtime.mediaBusy,
  log: message => console.error('[Media] ' + message)});
const MEDIA_IDLE_MS = 30_000;
await mediaLink.open();   // remembers the command file of an earlier session, which is never played
const mistralHost = new TextProviderHost({provider: mistral, memory: mistralMemory, personas: personaBook, routes: textRoutes, matureContent, promptProfiles,
  memoryKeyFor: memoryNamespace.keyFor,
  transformReply: cleanReply, gate: memoryQuiet, resolveProfile: profileOfCharacter, log: message => console.error('[TextProvider] ' + message),
  // A companion action the reply asked for ("[DRIVE]", bridge/text-actions.mjs) reaches the game the way a Convai action does.
  deliverAction: message => companionActions.deliver(message),
  traceReaction: (token, info) => companionActions.traceReaction(token, info)});
// The hook for local speech recognition (bridge/local-stt.mjs and local-stt-capture.mjs; docs/LOCAL_STT.md). While Mistral is the
// provider the voice key needs it: `available()` says whether this computer can recognise speech, `voiceChannel({reply})` returns
// a channel (beginVoice / finishVoice / heard / close, like RealtimeHost.voiceChannel) whose finished recording is answered
// through `reply(config)`. Without it the voice key tells the player that voice needs Convai for now. The recogniser worker runs
// only during and just after a recording; the Convai microphone route never touches it.
// Other languages (docs/LOCAL_STT.md, "Other languages"): English keeps Moonshine. A recording in another language goes to Mistral's
// transcription on the Mistral route (the player's own key; audio leaves this computer only while Mistral is the conversation provider), or to an
// installed multilingual pack on this computer (Local AI and custom routes, and the fallback when Mistral cannot take a recording); with neither
// the English recogniser is used and the player is told once that voice input is English only for now. The language comes from the player's
// typed text and earlier recordings, else the interface language (settings.json, or runtime/ui-language.txt written by the game on a change).
// The player's language is kept between launches in the state folder (player-language.json): read once here, written in the background (never on a
// frame, never waiting) only when the language changes. A missing or invalid file is ignored.
const playerLanguageFile = resolve(stateDirectory, PLAYER_LANGUAGE_FILE);
const speechLanguage = new SpeechLanguage({readUiFile: () => readFile(resolve(runtime, 'ui-language.txt'), 'utf8'),
  remembered: parsePlayerLanguage(await readFile(playerLanguageFile, 'utf8').catch(() => '')),
  remember: language => { void atomic(playerLanguageFile, playerLanguageText(language)).catch(() => {}); }});
// The local speech recognition worker is high for good with the rule's default (an idle one costs nothing); otherwise below normal and raised to normal for a recording, as before.
const sttPriority = turnPriority === 'high' ? 'high' : 'below';
const voxtralStt = new VoxtralStt({getKey: () => { try { return mistral.apiKey ?? null; } catch { return null; } }, onLog: message => process.stderr.write(message)});
const englishStt = new LocalStt({project, pythonExecutable: voiceConfig.runtime?.pythonExecutable, priority: sttPriority});
// A pack decodes once per recording (no live words) and is a big model: it leaves memory 60 s after its last recording. The first load after
// the files were written reads a 650 MB model that Windows is still scanning: measured 68 s (4.9 s from the second load on), so a load may
// take 150 s before it counts as failed.
const packStts = new Map(LOCAL_PACKS.map(pack => [pack.id, new LocalStt({project, pythonExecutable: voiceConfig.runtime?.pythonExecutable, engine: pack,
  partials: false, pausePartials: false, idleMs: 60_000, startupMs: 150_000, finishMs: 30_000, priority: sttPriority})]));
const installedPackIds = () => LOCAL_PACKS.filter(pack => packStts.get(pack.id).available()).map(pack => pack.id);
async function routeRecording() {
  const {language, source} = await speechLanguage.current();
  // English (the usual case) costs one comparison here: nothing is looked up on disk for it.
  if (language === 'en') return {mode: 'english', language, source};
  const plan = planRecording({language, source, provider: mistral.route, voxtralReady: voxtralStt.ready, installed: installedPackIds(), englishAvailable: englishStt.available()});
  if (plan.pack) plan.stt = packStts.get(plan.pack.id);
  if (plan.fallback) plan.fallback = plan.fallback.map(next => next.pack ? {mode: 'pack', stt: packStts.get(next.pack.id)} : next);
  if (plan.mode === 'voxtral') plan.warm = () => { void warmConnection({provider: 'mistral'}).catch(() => {}); };
  return plan;
}
// The microphone tap (bridge/mic-tap.mjs): one open device whose audio is kept from the key press (hold-to-talk) or from the moment speech is
// detected (Voice activation), so nothing said while a connection, the recogniser or a turn is still starting is lost. The local recogniser,
// Mistral's transcription and Convai's page all take their audio from it. The game's microphone-live.json says when to open and close it.
// What the game reads: microphone-state.json carries `vad` (the detector's latest start or end, with an id) beside the turn's own state.
const BOOT_ID = Date.now().toString(36);
let micStateLast = {state: 'off', requestId: ''}, micVad = null, micCue = null, micCueSeq = 0;
const micVadBody = status => status ? {id: BOOT_ID + ':' + status.seq, phase: status.phase, at: Date.now()} : null;
function publishMicState(options) {
  return atomic(resolve(runtime, 'microphone-state.json'), JSON.stringify({...micStateLast, ...(micVad ? {vad: micVad} : {}), ...(micCue ? {cue: micCue} : {}), updated: Date.now()}), options);
}
// The input the player chose in Settings > Voices > Microphone (the label; '' is the Windows default), read from settings.json on the settings poll and asked for at each open.
let micPreferred = '';
// Speak dialogue choices (bridge/voice-choice.mjs, docs/VOICE_CHOICES.md): created below, once the recogniser exists; the tap reports the detector to it.
let voiceChoice = null, voiceChoicesOn = false;
const micCapture = new LocalSttCapture({getBrowser: hostBrowser(realtime), preferredDevice: () => micPreferred});
const micLive = new MicLive({tap: null, read: () => readFile(resolve(runtime, 'microphone-live.json'), 'utf8').catch(() => ''),
  log: line => console.error('[CyberpunkConvai] Microphone: ' + line),
  onListenError: () => { micVad = {id: BOOT_ID + ':error', phase: 'error', at: Date.now()}; void publishMicState().catch(() => {}); }});
const micTap = new MicTap({capture: micCapture, log: line => console.error('[CyberpunkConvai] Microphone: ' + line),
  onVad: status => { micVad = micVadBody(status); void publishMicState().catch(() => {}); try { voiceChoice?.onVad(status); } catch { /* never breaks the tap */ } },
  // The talk key pressed with the device cold: the game shows "Opening microphone…" and then "Speak now" (mod/microphone.lua).
  onCue: cue => { micCue = {id: BOOT_ID + ':cue:' + (++micCueSeq), hold: cue.hold, phase: cue.phase, cold: true}; void publishMicState().catch(() => {}); },
  // A released tap is reopened for listening when the game still asks for it (a turn ended, the voice browser restarted).
  onRelease: () => micLive.afterRelease()});
micLive.tap = micTap;
// CYBERPUNK_CONVAI_MIC_LINGER=0: the device closes with each recording instead of staying open for about 15 s after a voice turn.
if (process.env.CYBERPUNK_CONVAI_MIC_LINGER === '0') micTap.lingerAllowed = false;
// What the file held when this bridge started is from an earlier run (a key that was down, a listen request of a game that has gone): never acted on.
micLive.observed = await readFile(resolve(runtime, 'microphone-live.json'), 'utf8').catch(() => '');
console.error('[CyberpunkConvai] Microphone: ' + describeThresholds());
realtime.micTap = micTap;
realtime.onClosed = () => { void micTap.release(undefined, 'the voice browser closed'); micLive.afterRelease(); };
realtime.onStarted = () => { void micCapture.ensurePage().catch(() => {}); };
const mistralSpeech = createLocalSpeech({
  stt: englishStt,
  capture: new TapCapture({tap: micTap}),
  route: routeRecording, transcriber: voxtralStt, packs: [...packStts.values()],
  onLanguage: code => { if (speechLanguage.observeVoice(code)) console.error('[CyberpunkConvai] Microphone: the speech language is now ' + String(code).replace(/[^\w-]/g, '').slice(0, 12)); },
  alternatives: () => (mistral.route === 'mistral' && voxtralStt.ready) || installedPackIds().length > 0,
  // The input device, its level and the words (or why they were ignored) of every recording, one line each.
  log: line => console.error('[CyberpunkConvai] Microphone: ' + line)});
// Speak dialogue choices: the list on screen is published by the game (runtime/choice-hub.json) when it opens or changes; a spoken line is recognised here, matched
// to a caption with no language model and applied with the arrow keys and Enter (bridge/choice-keys.py). The result goes back in runtime/choice-result.json.
const readChoiceHub = async () => parseHub(await readFile(resolve(runtime, HUB_FILE), 'utf8').catch(() => ''));
voiceChoice = createVoiceChoice({speech: mistralSpeech, tap: micTap, readHub: readChoiceHub, enabled: () => voiceChoicesOn,
  publish: body => atomic(resolve(runtime, RESULT_FILE), JSON.stringify(body)),
  makeSender: () => new KeySender({python: voiceConfig.runtime?.pythonExecutable, script: fileURLToPath(new URL('./choice-keys.py', import.meta.url)),
    log: line => console.error('[CyberpunkConvai] Voice choice: ' + line)}),
  log: line => console.error('[CyberpunkConvai] ' + line)});
// Two side by side: the action decision and the reply of one turn are two requests at once (bridge/mistral-client.mjs, warmConnection).
// The custom provider warms its own https origin (none for a server on this computer or the home network, which has no TLS to open).
const warmTurnConnections = options => options?.provider === 'custom' || options?.provider === 'gemini'
  ? (() => { const endpoint = options.provider === 'gemini' ? geminiEndpoint : customEndpoint; return endpoint.warmOrigin ? warmConnection({...options, provider: 'custom', origin: endpoint.warmOrigin, connections: 2}) : Promise.resolve(false); })()
  : warmConnection({...options, connections: 2});
for (const host of [realtime, phoneRealtime]) attachTextProvider(host, {provider: mistral, mistral: mistralHost, speech: mistralSpeech, onPlayerText: text => speechLanguage.observeText(text), prewarmVoice: () => host === realtime && localVoice.playbackEnabled !== false, warmCloud: warmTurnConnections});
// Add-on speakers (docs/ADDON_API.md) answer through the player's Custom provider when it is the one in use and ready, else through Mistral or the
// local AI, whatever the player's conversation provider is: one text host per route (the local AI never falls back to Mistral), made the first time an add-on speaker needs it. They
// share the routes (one pacing per Mistral key), the persona book and the memory store; none exists without add-ons.
const addonTextHosts = new Map();
function addonTextHost(route, profileKey) {
  const cacheKey = `${route}:false`;   // the key keeps the shape it had when the local host could also hold a Mistral route
  let host = addonTextHosts.get(cacheKey);
  if (!host) {
    host = new TextProviderHost({provider: fixedProvider(mistral, route), memory: sharedMemory(mistralMemory), personas: personaBook,
      routes: {[route]: textRoutes[route]}, transformReply: cleanReply, gate: memoryQuiet,
      // The hard-limit guard (never the crude Mature persona layer) for an add-on speaker too: with the Mature setting on or an uncensored model loaded.
      matureContent, guardOnly: true,
      // An add-on speaker never says V's words: a reply that opens with V's own line (or writes V's side of the talk) loses them before the voice hears them.
      stripPlayerEcho: true,
      // What the speaker said on its own (a district remark) is not in the conversation memory: V's question about it must not be answered with it again.
      spokenLines: key => addonHost.recentLines(key),
      log: message => console.error('[Addons] ' + message)});
    addonTextHosts.set(cacheKey, host);
  }
  return host;
}
// What an add-on speaker's turn may use right now: the player's provider, a saved Mistral key that was not refused, a working Local AI pack,
// the Custom provider's endpoint once it is set up.
const addonRouteState = () => {
  const local = addonHost.active ? localAiStatus() : 'not-installed';
  return {applied: mistral.applied, mistralKey: !!mistral.apiKey && mistral.limit?.kind !== 'invalid',
    localReady: !['not-installed', 'no-memory', 'failed'].includes(local), customReady: customEndpoint.ready === true, geminiReady: mistral.geminiUsable};
};
// The game asked to warm a speaker (handle:prepare): open the Mistral connection, or load the speaker's prompt into the local AI.
addonHost.onWarm = profileKey => {
  const route = addonHost.routeFor(profileKey, addonRouteState());
  if (route === 'mistral') void warmConnection({provider: 'mistral'}).catch(() => {});
  else if (route === 'custom' || route === 'gemini') void warmTurnConnections({provider: route}).catch(() => {});
  else if (route === 'local') void addonTextHost(route, profileKey).prewarm({local: {profileKey}});
};
function localTurn(input, prepared = preparedInputs.get(input)) {
  const route = prepared ?? routeFor(input);
  const channel = route?.route?.channel ?? (input.channel === 'phone' ? 'phone' : input.group ? 'group' : 'private');
  const ambient = isAmbientProfile(input.profileKey);
  // A generic person (a resident, an archetype) is remembered under its own key, never under the profile: the same template is every stranger who uses it. `entity` is for the log line only.
  return {profileKey: input.profileKey, name: profileFor(input, roster)?.name ?? input.name, channel,
    ...(ambient ? {ambientKey: route?.sessionKey ?? `${input.profileKey}:${input.entity ?? ''}`, entity: input.entity} : {})};
}
let observed = '', observedIdentity = null, invalidSeen = '';
let lastAcceptedIdentity = '';
let polling = false, active = null, stopped = false;
let prefetchPolling = false, prefetchObserved = '', partyObserved = '', partyWasFresh = false;
let prewarmObserved = await readFile(prewarmPath, 'utf8').catch(() => '');
const latency = new Map();
// One TurnClock per request (bridge/turn-clock.mjs): the moment every stage of the turn was reached. `measure` writes its snapshot
// into the turn's record (`stages`) each time the record is written. Bounded like the records.
const turnClocks = new Map();
// Replies that are slow and stay slow become one `slow-turn` error report (bridge/slow-turns.mjs). Judged once per finished turn from the clock's
// numbers; the free video memory and the connection counts are read once, when the report is made, from what the bridge already holds.
const slowTurns = new SlowTurnWatch({onSlow: data => errorEvents.slowTurns(data),
  turnContext: () => ({provider: mistral.route ?? 'convai', voice: localVoice.provider}),
  reportContext: () => {
    const warm = connections.diagnostic();
    // `lastFreeMiB` is the free memory the model's LAST LOAD saw (often the game's start, long before the report); `local` is what the watch knows now (bridge/local-return.mjs).
    return {freeVideoMemoryMiB: localServer.lastFreeMiB, local: localServer.homeState(),
      background: {warmConnections: warm.ready, connectingConnections: warm.connecting, turnsInFlight: [...turnClocks.values()].filter(clock => !clock.has('published')).length}};
  }});
// Voice playback is on and the replies of this run never made a sound: one `voice-failed` report (bridge/voice-silence.mjs). Judged from the stage clock after each turn.
const voiceSilence = new VoiceSilenceWatch({onSilent: data => errorEvents.voiceSilent(data), wanted: () => !localVoice.closed && !localVoice.silent,
  context: () => ({engine: localVoice.provider, requested: localVoice.requestedProvider, active: localVoice.provider, fellBackTo: localVoice.resolvedProvider,
    // The hidden browser that plays every voice could not start in this run: that is why nothing was heard, with what the browser said.
    browser: lastBrowserStartFailure()})});
let metricsWriting = Promise.resolve(), metricsNext = null;
let connectionMetricsWriting = Promise.resolve();

const preparedInputs = new WeakMap();
const intrinsicConversationContext = createIntrinsicConversationContext({baseContext: baseConversationContext, baseBlocks: baseConversationBlocks,
  intrinsic: intrinsicHistory, resolveAdmission: input => preparedInputs.get(input),
  isCurrentSync: prepared => knowledgeRouter.currentSync(prepared), skip: input => addonContent.covers(input?.profileKey)});
// Natural speech: the devices the CURRENT voice engine can render, for spoken replies only. Phone chat is text,
// battle and loot reactions are short barks, and the Convai cloud voice cannot follow it (it would read tags aloud).
// The voice of each turn (bridge/multilingual.mjs). Decided once per submitted turn, the first time it is needed, so
// the context (tags or none), the Convai TTS flag and the delivery all agree. An English turn is exactly the character's chosen
// voice; a turn in another language never reaches Pocket (its reply is shown as text), and a cloud-voice turn never gets tag instructions.
const turnVoices = new Map();
// A cloud voice with no key speaks nothing, and its turns are written (planTurnVoice 'none'): neither a local voice nor the Convai voice stands in for it.
// `convai`: the Convai voice may speak this installation's turns, and only because the player chose it. A voice that cannot run (a local one,
// or Voxtral with no key, in a cool-down or in a language it does not list) or has no clip for this character is never replaced by it: that turn is
// written, and Convai gets ttsEnabled false (convaiSpeaks below).
// `cloud` and `speaks`: the Voxtral or Inworld voice (they run on Pocket's route) and the languages that voice speaks (bridge/multilingual.mjs cloudSpeaks).
const localChoice = profile => ({uses: localVoice.usesProfile(profile) && !localVoice.cloudKeyless, provider: localVoice.provider, convai: localVoice.convaiVoiceAllowed,
  cloud: localVoice.cloudActive ? localVoice.cloud : null, speaks: language => (localVoice.cloud === 'inworld' ? inworldVoice : voxtralVoice).speaks(language),
  pocket: {speaks: language => pocketLanguages.speaks(language), packMissing: language => pocketLanguages.packMissing(language)}});
function turnVoice(input) {
  const id = input?.requestId || input?.id, cacheKey = id ? JSON.stringify([id, input.profileKey]) : null;
  if (cacheKey && turnVoices.has(cacheKey)) { const known = turnVoices.get(cacheKey); noteVoicePlan(input, known); return known; }
  const profile = input.profileKey;
  const plan = planTurnVoice({textProvider: true, fixed: multilingual.fixed !== null, language: multilingual.expected(input.reaction ? '' : input.text),
    local: localChoice(profile)});
  if (cacheKey) {
    turnVoices.set(cacheKey, plan);
    // A reply expected in a language Pocket has a model for: the model is swapped in while the reply is being written (the worker only; nothing else waits on it).
    if (plan.reason === 'pocket-language' && plan.language && plan.engine === 'pocket' && !input.reaction) void localVoice.warmPocketLanguage(voiceKeyFor(input), plan.language);
    // The same for OmniVoice: the reply's pack clip of this character is prepared in the worker while the reply is being written.
    if (plan.reason === 'omni' && plan.language && plan.language !== 'en' && plan.engine === 'omni' && !input.reaction) void localVoice.warmOmniLanguage(voiceKeyFor(input), plan.language);
    while (turnVoices.size > 64) turnVoices.delete(turnVoices.keys().next().value);
  }
  noteVoicePlan(input, plan);
  return plan;
}
// The clock of the turn learns what the voice planner decided, for the "voice never played" report (bridge/voice-silence.mjs): two words, nothing of the turn's text.
function noteVoicePlan(input, plan) {
  try { turnClocks.get(input?.requestId)?.annotate({voicePlan: plan.engine, voiceReason: plan.reason}); } catch { /* a report never affects a reply */ }
}
// True when the Convai cloud voice is NOT the one speaking this turn: a local voice, or nothing at all ('none': written). Either way Convai sends no audio.
const turnUsesLocal = input => turnVoice(input).engine !== 'convai';
// Does Convai's own cloud voice speak this turn (the ttsEnabled flag of a Convai text turn)? Only when the player chose the Convai voice (owner rule 2026-10-21).
const convaiSpeaks = input => localVoice.playbackEnabled !== false && localVoice.convaiVoiceAllowed && !turnUsesLocal(input);
// One line per spoken reply: the voice chosen, the voice that spoke and why they differ (bridge/voice-routing-log.mjs).
// Routing facts only, no dialogue; the file append is queued off the speech path. Never allowed to affect a reply.
function logVoiceRoute(input, profile, reply, extra = {}) {
  try {
    // The local voice that speaks (a variant of an ambient profile, decided once per turn); the profile key otherwise.
    const voiceKey = ['pocket', 'omni'].includes(reply?.engine) && typeof voiceKeyFor === 'function' ? voiceKeyFor(input) : undefined;
    // The PocketTTS model that speaks this reply (the local voice, a language that has a model and a pack).
    const pocketModel = reply?.engine === 'pocket' && !localVoice.cloudActive && reply.language && reply.language !== 'en' && pocketLanguages.speaks(reply.language)
      ? {language: pocketLanguages.model(reply.language).language} : undefined;
    // The Convai character the turn went to (the original or its multilingual twin).
    let character;
    try {
      const route = routeFor(input), characterId = route?.guard?.characterId;
      if (characterId) character = {key: route.route?.providerProfileKey ?? input.profileKey, id: characterId};
    } catch {}
    // What the Mistral voice really clones from (known once the reference was built; the line's ref is the registry's first choice).
    let sent;
    try { if (reply?.engine === 'pocket' && localVoice.cloudActive && localVoice.cloud === 'voxtral') sent = voxtralVoice.referenceInfo(voiceKey ?? input.profileKey, reply.language); } catch {}
    routingLog.record(describeVoiceRoute({voice: localVoice, input, profile, plan: turnVoice(input), reply,
      sources: voiceSources, voiceKey, character, languageSet: languagePackFor(reply?.engine, reply?.language, voiceKey)?.set, pocketModel, sent, ...extra}));
  } catch {}
}
// The multilingual pack's entry that speaks a reply, or null (the English reference speaks): OmniVoice and the Mistral voice, a reply in a language that has a pack,
// a voice the pack lists, and not a voice the player gave a clip of their own. Pocket (English only) and the Convai voice never use one. In-memory lookups.
function languagePackFor(engine, language, voiceKey) {
  if (!language || language === 'en' || !voiceKey || !languagePacks.installed) return null;
  if (engine === 'omni') return localVoice.hasPlayerClip(voiceKey) ? null : languagePacks.entry(language, voiceKey);
  // The Inworld voice always clones from the English reference (one voice per character, speaking every language), so it has no pack entry.
  if (engine === 'pocket' && localVoice.cloudActive) return localVoice.cloud === 'inworld' ? null : voxtralVoice.languageEntry(voiceKey, language);
  // The local Pocket voice speaks the language from the pack's clip when it has the model for it (a player's own clip for the character stays the reference).
  if (engine === 'pocket') return localVoice.hasPlayerClip(voiceKey) ? null : pocketLanguages.entry(language, voiceKey);
  return null;
}
// The set a reply's reference is logged as (the routing line's ref): the pack's, else the English one. Only asked while Developer mode keeps the reply (replyCapture).
function referenceSetFor(engine, language, voiceKey) {
  const pack = languagePackFor(engine, language, voiceKey);
  if (pack) return pack.set;
  const english = engine === 'omni' ? referenceOf(localVoice, 'omni', voiceKey, voiceSources)
    : localVoice.cloudActive ? cloudReferenceOf(localVoice, voiceKey, voiceSources) : referenceOf(localVoice, 'pocket', voiceKey, voiceSources);
  return english?.set ?? null;
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
const warmUsesConvaiVoice = profile => localVoice.playbackEnabled !== false && localVoice.convaiVoiceAllowed && planTurnVoice({textProvider: true,
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
// V's voice for typed lines (bridge/v-voice.mjs, docs/V_VOICE.md): the player's typed line is also spoken in V's cloned voice, by the engine
// the player chose for V (Settings > Voices > V's voice engine): Pocket on the CPU (the default) or the Mistral cloud voice (Voxtral), whatever
// the companions use, or OmniVoice (only while it is the companions' voice: one more job on their GPU worker, queued first, waited for). Never
// the Convai cloud voice, never a local model beside a cloud voice that was chosen for it. Pocket and Voxtral run beside the companion's reply and
// never delay it (a line that is not ready in time is dropped); OmniVoice is the player's choice of a short wait. English on Pocket; on Voxtral also
// the languages its model lists (a turn in another language gets no V line otherwise); OmniVoice speaks every language.
// Which V is playing, kept between sessions (state folder): the first typed line of a session prepares the right voice before it is sent.
const vGenderFile = resolve(stateDirectory, 'v-voice-gender.json');
const vGenderMemory = {
  gender: (() => { try { return JSON.parse(readFileSync(vGenderFile, 'utf8')).gender; } catch { return null; } })(),
  save: gender => { void atomic(vGenderFile, JSON.stringify({gender})).catch(() => {}); }};
// The V voice mod scan (bridge/v-voice-mod-service.mjs, bridge/v-voice-mods.mjs): archive indexes and, only when a reference has to be built, the decoder, at most once per session,
// in the background a little after start-up and only once V's voice is on (never at start, never per reply). A reference that changed (a mod installed, swapped or removed) is
// installed where the workers read it and the running voices follow it (LiveVoices), with no restart; the player's own clip for V still wins.
const V_MOD_SCAN_DELAY_MS = 20_000;
let vModScanStarted = false;
const scanVVoiceMods = async () => {
  try {
    const found = await loadVVoiceReferencesWithMods({...vVoiceLoadOptions, scan: true, current: vVoiceReferences.voices});
    vVoiceModReport = found.report;
    for (const gender of found.changed) {
      const voice = found.voices[gender];
      if (voice) {
        await installVVoiceReference(voice, [...referenceRoots, voiceConfig.runtime?.referenceDirectory], {log: line => console.error('[VVoice] ' + line)});
        vVoiceReferences.voices[gender] = voice;
      } else delete vVoiceReferences.voices[gender];
      await liveVoices?.refresh(V_VOICE_KEYS[gender]);
    }
  } catch (error) { console.error('[VVoice] the V voice mod scan failed: ' + String(error?.message ?? error).slice(0, 120)); }
};
// Not while the title screen is up (27 Oct 2026, game 2.5: the scan's cache write at 11:11:45.5 UTC fell inside the one 2.4 s freeze the title showed, 28.3 s after init.lua began):
// it waits for the game's world (a 5 s look, nothing else runs meanwhile), then the delay above, so it never competes with the screen that waits for a key press.
const startVVoiceModScan = () => {
  if (vModScanStarted) return;
  vModScanStarted = true;
  const run = () => {
    timeline('V voice mod scan starts');
    void scanVVoiceMods().finally(() => timeline('V voice mod scan done'));
  };
  const wait = () => { if (titleHolds()) setTimeout(wait, 5000).unref?.(); else setTimeout(run, V_MOD_SCAN_DELAY_MS).unref?.(); };
  wait();
};
// Which reference V speaks from, for the log and the support report: the player's own clip, a V voice mod's ('mod:<archive file name>') or the shipped one.
const vReferenceLabel = gender => playerVoices.has(V_VOICE_KEYS[gender]) ? 'manual' : vVoiceReferences.voices[gender]?.source ?? 'shipped';
const vVoice = new VVoice({voices: vVoiceReferences.voices, log: line => console.error('[VVoice] ' + line), remember: vGenderMemory, referenceLabel: vReferenceLabel,
  // V's own line is spoken in its own language (English unless it is solidly another one, or a fixed Reply language says so): whatever the reply
  // turns out to be, V's line still plays when it is English.
  planFor: (input, key) => ({engine: vVoice.engine, language: multilingual.lineLanguage(input.text)}),
  // Pocket, when it is the companions' own voice: that worker speaks V too, one job at a time. Voice playback Off silences the companions,
  // not V: with the V setting on the Pocket worker stays loaded for his line (docs/RESOURCE_LIFECYCLE.md).
  ready: key => localVoice.vRouteSpeaks(key),
  isLocal: () => !localVoice.cloudActive,
  stream: (key, text, options) => {
    if (localVoice.cloudActive) return Promise.reject(Error('The companions use a cloud voice now'));   // never V on the cloud voice through Pocket's route
    return localVoice.synthesizeStream(key, text, options);
  },
  prepare: (key, options) => localVoice.prepareProfile(key, options),
  play: (config, producer, options) => realtime.playVoiceLine(config, producer, options),
  warm: options => realtime.prewarmVoiceLine(options),
  // With any other companion voice (OmniVoice, a cloud voice, the Convai voice) V's Pocket line is spoken by a Pocket worker of its own on
  // the CPU (bridge/v-helper-voice.mjs); with the engine Pocket the line is never rendered on OmniVoice's one GPU worker (the engine 'omni'
  // below is the player's separate choice of that). It is loaded in the background only while the V setting is on and the engine is Pocket
  // (never beside the Pocket route, with the Voxtral engine or with the Omni engine).
  helper: {speaks: key => localVoice.vHelperSpeaks(key), ready: key => localVoice.vHelperReady(key),
    stream: (key, text, options) => localVoice.vHelperStream(key, text, options),
    prepare: (key, options) => localVoice.vHelperPrepare(key, options),
    nearlyReady: key => localVoice.vHelperNearlyReady(key),
    whenReady: (key, options) => localVoice.vHelperWhenReady(key, options)},
  // The OmniVoice engine: V's line is one more job on the companions' Omni worker (bridge/voice-selection.mjs vOmni*), queued the moment the
  // line is sent, so it renders while the companion's text is written and the companion's render queues right behind it. No worker is loaded for it.
  omni: {problem: key => localVoice.vOmniProblem(key), render: (key, text, options) => localVoice.vOmniRender(key, text, options),
    prepare: (key, options) => localVoice.vOmniPrepare(key, options)},
  // The Voxtral engine: a request of its own to the Mistral voice, beside the companion's text request. No local model, and no fallback to
  // one (a failed line is silent; the subtitle is on screen). It never takes a start from the reply: while the shared Mistral scheduler is
  // pacing or pausing requests (a limit was hit, an allowance is nearly used up) V is skipped.
  cloud: {
    problem: key => {
      // Mature content on: no line goes to Mistral's voice (owner decision 2026-10-20, after Voxtral refused Mature lines in a live test). The settings poll
      // already reads a saved Voxtral engine as Pocket while it is on (vSettings); this is the net for a line that is asked before that poll.
      if (!matureAllowsCloudVoice(matureContent.enabled)) return 'Mature content is on';
      if (!voxtralVoice.hasKey) return 'no Mistral key';
      if (!voxtralVoice.readyForV) return 'a Mistral limit is cooling down';
      if (!voxtralVoice.hasReference(key)) return `no ${key} clip`;
      const load = mistralScheduler.stats();
      return load.spacingMs > 0 || load.pausedForMs > 0 ? 'Mistral is pacing requests' : null;
    },
    // V's lane: a limit that V's request earns pauses V only, never the companion's reply on the same key (VoxtralVoice lane 'v').
    stream: (key, text, options) => voxtralVoice.synthesizeStream(key, text, {...options, lane: 'v'}),
    speaks: language => voxtralVoice.speaks(language),
    languageSet: (key, language) => voxtralVoice.languageSet(key, language),
    warm: key => { void voxtralVoice.reference(key); }},
  // One log line and one record per V line: what happened and when (V's own stage clock), no dialogue.
  report: (input, summary) => {
    try {
      console.error(`[VVoice] profile=${input.profileKey} voice=${summary.voice} engine=${summary.engine} ref=${JSON.stringify(summary.reference ?? 'shipped')} result=${summary.result}`
        + `${summary.reason ? ' reason=' + summary.reason : ''}${summary.spoken ? ' source=microphone' : ''} marks=${JSON.stringify(summary.marks)}`);
      routingLog.record(describeVLine({input, summary}));
      void measure(input, {vVoice: summary}).catch(() => {});
      // A line that was started and then failed, or whose renderer finished without any sound, is a voice failure to look at (one report per distinct reason, the voice report's rules).
      if (summary.result === 'dropped' && (summary.reason === 'failed' || summary.reason === 'no-audio')) {
        errorEvents.voiceFailed({engine: 'v-line', reason: summary.failure ?? 'the renderer finished without any sound', cause: summary.reason === 'no-audio' ? 'no-audio' : voiceFailureCause(summary.failure),
          requested: localVoice.requestedProvider, active: localVoice.provider, fellBackTo: 'silent', silent: localVoice.silent,
          // A hidden browser that would not start: what the browser itself said, which the one line of the failure does not hold.
          tail: browserFailureTail(summary.failure)});
      }
    } catch { /* a log line never affects a reply */ }
  }});
// V's voice for what the player said (setting vVoiceMic, off by default): the line of each voice turn, handled like a typed line (bridge/mic-v-line.mjs, docs/V_VOICE.md).
const micV = new MicVLines({vVoice, stopped: () => stopped});
// A returning shopkeeper's memory of V (bridge/vendor-memory.mjs): only private text/voice turns of a one-shop vendor.
const vendorMemoryContext = prepared => {
  const key = vendorMemoryKey(prepared);
  return key ? vendorMemory.contextFor({memoryKey: key, profileKey: prepared.route.profileKey, scope: vendorScope(prepared)}) : '';
};
// While a content pack with a separate memory is on, the visits are kept apart from the normal ones (the same file, keys `<record>@<pack id>`; bridge/vendor-memory.mjs). A turn takes its
// memory once, when its context is first built, and the exchange is stored in that memory when it is heard, even if the pack was switched in between.
const vendorScopes = new WeakMap();
const vendorScope = prepared => {
  let scope = vendorScopes.get(prepared);
  if (scope === undefined) { scope = memoryNamespace.scope(); vendorScopes.set(prepared, scope); }
  return scope;
};
// The blocks of a turn's context in the order Convai gets them, each tagged by how often it changes (see conversationContextBlocks in
// bridge/quest-context.mjs). Convai gets them joined in this order; the text providers (Mistral, local) lay them out stable to
// volatile (bridge/mistral-prompt.mjs, layout v2) so a prefix cache keeps working.
// Eddies with characters (docs/EDDIES.md, bridge/eddies.mjs): the turn's money decision, made once per request from the game's `eddies` block (only sent while the
// setting is on) and V's words; its proposal is written after the reply is published (publishResult). The relationship the turn was admitted with counts.
const eddiesDecisions = new EddiesDecisions({log: line => console.error('[Eddies] ' + line)});
const eddiesNote = (input, prepared, admitted) => input.eddies
  ? eddiesDecisions.forTurn(input, {romance: romanceOf(admitted ? prepared.relationship : null, RELATIONSHIP_PROFILES),
    // The bond with V counts as trust, and a story pack's stage may ask for eddies or pay them back (bridge/bond-pack-runner.mjs).
    bondLevel: input.bonds ? bonds.levelFor(input, bondFacts(input, prepared, admitted)) : null, story: packTurn(input, prepared, admitted)?.story ?? null})?.note ?? '' : '';
// The proposal of a published turn (a spoken turn's words are read now), for the game to carry out (mod/eddies.lua). Never awaited, never in front of a reply.
// Character bonds: the turn's line (world tier: it changes only with a level, so prefix caches keep working) and the record of a published turn, which is made after the
// reply is out and never waits on anything. The relationship the turn was admitted with counts, as for Eddies.
const bondFacts = (input, prepared, admitted) => {
  const selection = admitted ? prepared?.relationship : null, romance = romanceOf(selection, RELATIONSHIP_PROFILES);
  // The tone of a romance is the relationship text's job (bridge/romance-context.mjs), once, for every kind of turn: the bond only counts the romance as story points.
  return {romance, near: besideV(input)};
};
// The note of a turn where V asks for a romance or ends one (the character's own trait and the bond level decide, the model only voices it); '' for every other turn.
const romanceNote = (input, prepared, admitted) => {
  if (!input.bonds) return '';
  const selection = admitted ? prepared?.relationship : null, view = bonds.viewFor(input, bondFacts(input, prepared, admitted));
  return romanceBond.noteFor(input, {together: romanceOf(selection, RELATIONSHIP_PROFILES) === 'partner', ended: selection?.bondRomance?.state === 'ended',
    level: view?.level ?? 1, hurt: view?.hurt ?? 0});
};
// A reaction (the game sends no bond block with it) repeats the line of the character's last talk with V, so the system message of the prompt reads the same on both and a model that
// continues only from a saved checkpoint reuses it; a talk with the setting off forgets the character's line.
const bondNote = (input, prepared, admitted) => {
  if (input.bonds) return bonds.contextFor(input, bondFacts(input, prepared, admitted));
  if (input.reaction) return bonds.repeatFor(input);
  if (!input.head) bonds.dropLine(input);
  return '';
};
// The turn's story pack decision (a start, or the stage in progress), made once per turn; null while Story packs is off or the turn is not a private one with a named character.
const packTurn = (input, prepared, admitted) => {
  if (!input.bonds?.packs) { if (input.bonds) bondPacks.on = false; return null; }
  const facts = bondFacts(input, prepared, admitted);
  return bondPacks.forTurn(input, {...facts, level: bonds.levelFor(input, facts) ?? 0});
};
function publishBonds(input, result, proposal = null) {
  // V's words to a quest's cast member are read once for an amount, yes or no, after the reply is out (bridge/quest-pay.mjs).
  if (input?.quest && bondPacks.afterPay(input, result?.userText)) questSync();
  if (!input?.bonds) return;
  const prepared = preparedInputs.get(input), admitted = prepared && knowledgeRouter.currentSync(prepared);
  bonds.recordTurn(input, result?.userText, bondFacts(input, prepared, admitted));
  // V asked for a romance or ended one: carried out now that the reply is out (the game writes it into the save).
  if (prepared?.worldToken) romanceBond.afterTurn(input, result?.userText, {worldToken: prepared.worldToken, generation: prepared.generation});
  // The pack the turn started, or V's words read against the stage (after the reply is out; no model is asked).
  if (input.bonds.packs) bondPacks.afterTurn(input, result?.userText, proposal);
  questSync();   // the pack state may have changed: the play file follows it
}
// A meeting the character kept or gave up on (the appointment events of Phone Chat): a story pack that waits on it moves on.
function publishPhoneEvent(input, profileKey) {
  const kind = input?.event?.kind;
  if (kind !== 'arrived' && kind !== 'stood-up') return;
  const gameSeconds = Number.isSafeInteger(input.turnContext?.gameTime) ? input.turnContext.gameTime : undefined;
  bondPacks.noteMeeting(profileKey, kind === 'arrived' ? 'met' : 'stood-up', gameSeconds); questSync();
}
// The greeting at a meeting (V reached the character): a story pack that waits on the meeting moves on.
function publishMeeting(input) {
  if (input?.reaction?.kind !== 'meet') return;
  const gameSeconds = Number.isSafeInteger(input.turnContext?.gameTime) ? input.turnContext.gameTime : undefined;
  bondPacks.noteMeeting(input.profileKey, 'met', gameSeconds); questSync();
}
function publishEddies(input, result) {
  if (!input?.eddies) return null;
  try {
    const proposal = eddiesDecisions.finish(input, result?.userText);
    if (proposal) void atomic(resolve(runtime, 'eddies-offer.json'), JSON.stringify(proposal)).catch(() => {});
    return proposal;
  } catch (error) { console.error('[Eddies] proposal failed: ' + String(error?.message ?? error).slice(0, 120)); return null; }
}
const conversationBlocks = input => {
  const prepared = preparedInputs.get(input), admitted = prepared && knowledgeRouter.currentSync(prepared);
  const block = (tier, text) => ({tier, text});
  return [...intrinsicConversationContext.blocks(input), block('world', archetypeContext(input, {place: dynamicInfo.on('location')})),
    block('world', admitted ? vendorMemoryContext(prepared) : ''),
    // Street reputation: at most two lines for an ordinary NPC's private turn, '' for everyone else and whenever the setting is off.
    block('world', reputation.contextFor(input, {place: dynamicInfo.on('location')})),
    // Add-on context (docs/ADDON_API.md): an add-on speaker's own blocks, or what the add-ons tell companions; none without add-ons.
    ...addonHost.blocks(input),
    block('world', bondNote(input, prepared, admitted)),
    block('volatile', romanceNote(input, prepared, admitted)),
    block('volatile', packTurn(input, prepared, admitted)?.note ?? ''),
    // The cast member of an armed pay stage is told what is asked and the least it takes (bridge/quest-pay.mjs); '' for every other turn.
    block('volatile', input.quest ? bondPacks.payNote(input) : ''),
    block('world', admitted ? relationshipContext(prepared.relationship, prepared.route.channel,
      {group: prepared.input.group, audience: prepared.route.audience,
        worldToken: prepared.worldToken, generation: prepared.generation}) : ''),
    // The partner tone again, right after V's words (the closing tier: bridge/mistral-prompt.mjs); '' unless the affectionate delivery is on for a private or phone turn.
    block('closing', admitted && !input.reaction ? romanceReminder(prepared.relationship, prepared.route.channel) : ''),
    // A phone message that can be a request to meet carries the game's offer as an instruction (bridge/meet-requests.mjs); '' for every other turn.
    // A holocall line carries the game's meeting offer the same way, as a note without tags (bridge/call-meet.mjs).
    block('volatile', typeof input.meetInstruction === 'string' ? input.meetInstruction : input.holocall && input.meetOffer ? callMeetNote(parseCallMeetOffer(input.meetOffer), input.text) : ''),
    block('volatile', typeof input.homeInstruction === 'string' ? input.homeInstruction : ''),
    block('volatile', eddiesNote(input, prepared, admitted)),
    block('volatile', admitted && prepared.route.channel === 'phone' ? phoneRecentConversationContext(prepared.input) : ''),
    // The player's world rules (bridge/world-rules.mjs): Convai's characters live on Convai's side and cannot be edited, so the rules reach them in the
    // dynamic info this context is (realtime-client.mjs updateContext sends it, replacing the last one, every turn), after all the game's facts in it (world,
    // relationship, phone recap), at most 2,000 characters of the player's words. The voice and style notes after them (Natural speech, Expressive
    // emotions, the first-person reminder, the reply language) keep the places that were measured for them. The tier is one no text-provider layout reads
    // (contextPartsOf): those carry the rules in the persona.
    // The content packs' world rules (API 1.1) follow the player's, kept to a size (bridge/addon-content.mjs convaiWorldRulesText); the pack's switch in the game's settings removes them.
    ...convaiWorldRulesBlocks(addonContent.convaiWorldRulesText(worldRules.get()), mistral.active),
    // The one-sentence first-person reminder goes after the voice blocks, which pull a reply away from the base rule (docs/FIRST_PERSON_RULE.md).
    // The Natural speech offer changes from turn to turn (it is dice and a place), so it is volatile; the Expressive emotion
    // notes are the same every turn for a given setting.
    block('volatile', naturalSpeechContext(input)), block('notes', expressiveEmotionsContext(input)),
    block('volatile', firstPersonReminder(input)),
    // The reply language, last so it outweighs the English notes above: the player's own language on every route (nothing in an English conversation; a recording follows the microphone's or the remembered language; docs/MULTILINGUAL_PROFILES.md). An appointment event (the character texting first) has the mod's English trigger as its text, which says nothing of the player's language: the last turns do.
    block('volatile', multilingual.contextFor(input.reaction || input.event ? '' : input.text, input.reaction ? null : speechLanguage.evidence?.language))];
};
const joinedContext = blocks => blocks.map(item => item.text).filter(Boolean).join('\n\n');
const conversationContext = input => joinedContext(conversationBlocks(input));
// {now, notes, world, volatile} for the text providers' prompt layout; only built while one of them answers.
// `worldBlocks` lists the world blocks one by one (with their keys) so a small context can cut them in order of priority.
// The world blocks go in the order a prefix cache wants (worldBlocksInCacheOrder): the world facts that follow V's words come after the blocks
// that only change on game events, so a turn re-reads the facts and not the whole world block.
const contextPartsOf = blocks => {
  const world = worldBlocksInCacheOrder(blocks.filter(item => item.tier === 'world'));
  return {...Object.fromEntries(['now', 'notes', 'volatile', 'closing'].map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))])),
    world: joinBlocks(world.map(item => item.text)),
    worldBlocks: world.filter(item => item.text).map(item => ({key: item.key, text: item.text})), ...freshParts(blocks)};
};
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
  // Convai offers no action the game did not offer, so it needs telling why a ride is not possible when V asks for one (the text routes' notes say it themselves).
  ...(input.reaction ? {} : {driveLimit: driveLimitNote(input.driveUnavailable, input.text)}),
  // A line prepared beside another (startAhead): the text route sends it as the lowest-priority work and never starts it ahead of a turn of V's.
  ...(preparedRequests.has(input.requestId) ? {prepared: true} : {}),
  ...(companionVision.active && typeof input.requestId === 'string' ? {visionTurn: input.requestId} : {}),
  ttsEnabled: convaiSpeaks(input),
  // The player's own voice is not Convai's (Pocket, OmniVoice, Voxtral): Convai sends no audio for such a turn (ttsEnabled above is false; a chosen Convai voice is
  // the only case where it speaks), and a fault in the format of any audio it does send leaves the written reply instead of failing the turn
  // (bridge/realtime-client.mjs, audioOptional).
  audioOptional: localChoice(input.profileKey).uses});
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
  // Characters another mod or a spawner created are the one exception on a player's key whose plan has room for them: their page is
  // opened when the game first lists them near V (nearby-connections.json `spawned`), so the first talk does not pay the connection.
  spawnedLimit: spawnedConnections, warmDeferred: () => keys.singleSession && spawnedConnections() > 0,
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
// A group round on a player's own key on a paid plan (several connections at once): the other speakers' conversation pages open while
// the first speaker is still being written, as the party maintenance does for the shared key (deferWarm keeps it off for a player's
// key). The look-ahead of the next speaker then finds its page ready and starts at its reply instead of at its connection (about
// 3.5 s of the 7 s a speaker took on the 2026-10-17 live round). Sends nothing, writes no memory, is never awaited by the turn and
// stops with it; a page that does not open is simply opened when its turn needs it, as before.
async function warmRoundAhead(input, signal) {
  const scope = conversationScope(input);
  for (const profile of input.group.audience) {
    if (signal.aborted || stopped || memoryQuiescing || !groupLookaheadAllowed()) return;
    if (profile === input.profileKey || !connections.isKnown(profile)) continue;
    try { await realtime.warm(connections.configFor(profile, scope), {signal}); } catch { /* opened on demand later */ }
  }
}
// The conversation pages a composer hint is about to use (its target's private page, or each speaker's group page), for staging
// the surroundings picture ahead of the line. Empty while vision is not active.
function composerPages(hint, config) {
  if (!companionVision.active) return [];
  try {
    if (hint.scope === 'private') return [config ?? connections.configFor(hint.audience[0], 'private')];
    return hint.audience.filter(profile => connections.isKnown(profile)).slice(0, 3).map(profile => connections.configFor(profile, hint.scope));
  } catch { return []; }
}
// The conversation pages of the speakers after this group speaker, for staging the surroundings picture on them while this speaker's line is written and heard: their
// turns have no composer, and Convai takes a picture only if it was published about 3 s before the line (docs/COMPANION_VISION.md, "What the turn waits for").
function nextSpeakerPages(input) {
  if (!companionVision.active || !input?.group || input.reaction || input.addon) return [];
  try {
    const audience = input.group.audience, at = audience.indexOf(input.profileKey), scope = conversationScope(input);
    if (at < 0) return [];
    return audience.slice(at + 1).filter(profile => connections.isKnown(profile)).slice(0, 2).map(profile => connections.configFor(profile, scope));
  } catch { return []; }
}
// "Auto-connect nearby characters": the game lists up to two characters it is looking at or
// standing near; their connection and local voice are prepared ahead (bridge/nearby-warm.mjs).
const nearbyWarm = new NearbyWarm({connections, isKnown: profile => Object.hasOwn(ids, profile), routeFor: ambientWarmConfig,
  canPrepare: () => !stopped && !memoryQuiescing && !active && !mic.current && !micPolling && !lookahead.busy
    && !voiceRouteReservation && !relationshipRouteReservation && !localVoice.pending && !localVoice.availabilityPending,
  prepareVoice: (profile, options) => localVoice.prepareProfile(profile, options),
  // OmniVoice: a character that is only near is not prepared (each preparation is 1 to 3 s of the card with nobody speaking); it is
  // prepared when V starts to talk to it (warmTalkTargets below). Partners and spawned characters are still prepared ahead.
  gpuVoice: () => localVoice.preparesOnGpu,
  onError: error => console.error('[CyberpunkConvai] Nearby warm-up:', error.message)});
// What a character costs the card before a word is said is paid when V starts to talk to it, not when it is merely in view: the composer
// opens, the talk key goes down, or a turn begins. Typing or speaking takes seconds, so this overlaps it. Only work that uses the GPU is
// held back for this: OmniVoice's voice preparation and the local AI's persona prefill. Both are best effort and never throw; both are
// idempotent (a prepared voice answers at once, a cached persona prefix costs a short prefill). `persona: false` is for a turn that has
// already begun: its own request is about to take the local server's one slot, and a prefill in front of it would only delay it.
// The local server has ONE slot and a newer persona warm-up stops an older one for another character (LocalLlmServer.prewarm / preempt), so
// only the first character named (the one who answers first) gets its persona read; a group's other speakers are prepared when their turn
// comes. Voices are all prepared: they are separate worker renders, not the model's slot.
function warmTalkTargets(profileKeys, {persona = true} = {}) {
  if (stopped || !Array.isArray(profileKeys)) return;
  let personaDone = false;
  // A private talk starts: the memory embedder is started now (only when this character has memories stored, a text route answers and the embedder is not running), so the first line
  // does not meet it cold. It exits by itself 300 s after its last use.
  if (persona && profileKeys.length === 1 && mistral.active && typeof profileKeys[0] === 'string') mistralMemory.warmFor(memoryNamespace.keyFor(profileKeys[0]));
  for (const key of new Set(profileKeys)) {
    if (typeof key !== 'string' || !Object.hasOwn(ids, key)) continue;
    void wantVoiceClips(key, 'talk');
    if (localVoice.preparesOnGpu && localVoice.usesProfile(key)) {
      // A fixed reply language with a voice pack: the pack's clip of this character is what speaks, so that is what is prepared (the English reference only
      // when the pack has no clip of this character).
      const fixed = multilingual.fixed;
      if (fixed && fixed !== 'en') void localVoice.warmOmniLanguage(key, fixed).then(done => done || localVoice.prepareProfile(key)).catch(() => {});
      else void localVoice.prepareProfile(key).catch(() => {});
    }
    if (persona && !personaDone && mistral.active && mistral.route === 'local') {
      personaDone = true;
      const profile = profileFor({profileKey: key}, roster);
      if (profile) void mistralHost.prewarm({local: {profileKey: key, name: profile.name}}).catch(() => {});
    }
  }
}
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
// `ownTurn`: asked by the request poll for the turn it is about to start. That turn's own flags (`active`, `polling`) are not other work; everything
// else (the microphone, Phone Chat, memory saving, look-ahead, a stream still being written) still is.
function voiceBoundaryBusy({ownTurn = false, ownMic = false} = {}) {
  return !!((!ownTurn && (active || polling)) || streaming || (!ownMic && micPolling) || mic.current || prefetchPolling || memoryQuiescing
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
  if (receipt.provider === 'convai' || receipt.provider === 'text') return !localVoice.usesProfile(profile);
  // Playback Off: the worker was released and none is waited for (bridge/voice-selection.mjs, prepareProfile `muted`).
  if (receipt.muted === true) return localVoice.playbackEnabled === false && receipt.provider === localVoice.provider && localVoice.usesProfile(profile);
  return receipt.provider === localVoice.provider && ['pocket','omni'].includes(receipt.provider) && receipt.profile === profile
    && localVoice.usesProfile(profile) && localVoice.profileReady(profile);
}
// The invited character's clips are made first when it has none (a minute at the most: the invitation already waits for its voice, and a failure leaves the voice it had).
async function waitForVoiceClips(wanting, signal) {
  let timer;
  try { await abortable(Promise.race([wanting, new Promise(done => { timer = setTimeout(done, 60_000); })]), signal); }
  catch (error) { if (signal?.aborted) throw error; }
  finally { clearTimeout(timer); }
}
async function prepareInvitedVoice(profile, {signal} = {}) {
  const wanting = wantVoiceClips(profile, 'invitation');
  if (wanting) await waitForVoiceClips(wanting, signal);
  for (;;) {
    throwIfCancelled(signal);
    if (stopped) throw Error('Voice service is closed');
    const receipt = await localVoice.prepareProfile(profile, {signal, required: true});
    const unvoiced = receipt?.provider === 'convai' || receipt?.provider === 'text';
    if (receipt?.ready !== true || !['convai','text','pocket','omni'].includes(receipt.provider)
        || (!unvoiced && receipt.profile !== profile)) {
      throw Error('Local voice readiness could not be verified');
    }
    await abortable(syncVoiceRoutes({wait: true, signal}), signal);
    throwIfCancelled(signal);
    if (stopped) throw Error('Voice service is closed');
    // A settings change can commit while page retirement is awaiting its host.
    // Recheck the actual route before authorizing this invitation's connection.
    if (receipt.muted === true && localVoice.playbackEnabled === false) {
      if (receipt.provider !== localVoice.provider || !localVoice.usesProfile(profile)) continue;
    } else if (!unvoiced) {
      if(receipt.provider!==localVoice.provider)continue;
      if (!localVoice.usesProfile(profile) || !localVoice.profileReady(profile)) continue;
    } else if (localVoice.usesProfile(profile)) continue;
    return receipt;
  }
}
// An invitation follows the provider the player has CHOSEN (mistral.requested), not the one in use (mistral.active): the switch itself waits for
// an idle boundary (a phone call, a talk, memory saving), and an invitation made in that wait must not ask Convai for memory, a token or a
// connection (a refused sign-in would fail it). While the switch is pending no connection is opened at all (connectionWanted).
const invitationTextProvider = () => mistral.requested !== 'convai';
const invitations = new CompanionInvitations({memory: relationshipRoutes.invitationMemory(playerMemory, currentBoundary, invitationTextProvider), connections,
  textProvider: invitationTextProvider, connectionWanted: () => !mistral.pending, provider: () => mistral.requested,
  log: line => console.error('[CyberpunkConvai] ' + line),
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
  // No dialogue, API keys or character session IDs are written to metrics. A turn updates its record six to eight times, each a replacement of
  // the whole file (a write and a rename); an update that arrives while the next write has not started yet shares it, and that write serialises
  // the latest state when it runs. Never more than one write running and one waiting; the writes still go out in order.
  metricsNext ??= metricsWriting.catch(() => {}).then(() => {
    metricsNext = null;
    return atomic(resolve(runtime, 'bridge-latency.json'), JSON.stringify({version: 1, updated: Date.now(), turns: [...latency.values()]}));
  });
  metricsWriting = metricsNext;
  return metricsNext;
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
// A content pack switched on or off in the game: a group reply prepared from the old wording is dropped, so the next one is written from the new (like an editor save).
addonContent.onChanged = () => { dropPrefetch(); prefetchObserved = ''; };

// `streamed` (optional, set by respondStreamed): the reply is still being written and `result` holds only its first sentence, which
// is voiced at once; the finished reply is merged into the returned result when the voice is done (bridge/reply-stream.mjs).
async function synthesizeReply(input, result, signal, current, profile = profileFor(input, roster), receiptPrepared = preparedInputs.get(input), streamed) {
  const spoken = await synthesizeReplyBody(input, result, signal, current, profile, receiptPrepared, streamed);
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

async function synthesizeReplyBody(input, result, signal, current, profile, receiptPrepared, streamed) {
  if(localVoice.playbackEnabled===false)return{...result,audio:undefined,faces:[],captions:[]};
  // A scripted quest line with its audio file is always played by the prepared voice, whatever voice the player chose (docs/BOND_QUESTS.md 14.7).
  if (result.audioPath) return synthesizePrepared(input, result, signal, current, profile);
  const turnPlan = turnVoice(input);
  if (turnPlan.engine === 'convai') {
    logVoiceRoute(input, profile, {engine: 'convai', language: turnPlan.language});
    return {...result, timing: {...result.timing, voiceProvider: 'convai'}};
  }
  // A local turn follows its reply's language: English keeps the chosen voice, another language needs OmniVoice.
  const voice = replyVoice({plan: turnPlan, text: result.text, local: localChoice(input.profileKey)});
  if (voice.engine === 'none') {
    // The chosen local voice cannot run right now (the game says so once, from the voice state's fallback): the reply is written, never given to a cloud voice.
    const unavailable = voice.reason === 'local-voice-unavailable';
    // The Pocket model of the language is installed but its voice pack is not: its own notice, per language (the generic one says OmniVoice speaks every language).
    if (voice.reason === 'pocket-language-pack-missing') { if (!input.reaction) pocketLanguageNotice.note(voice.language); }
    else if (!unavailable && !input.reaction) voiceLanguageNotice.note();
    logVoiceRoute(input, profile, voice);
    return {...result, audio: undefined, faces: [], captions: [], timing: {...result.timing, voiceProvider: 'none'},
      audioError: unavailable ? 'The selected voice is unavailable right now; showing the written reply.'
        : voice.reason === 'voice-language-unsupported' ? 'The selected voice does not speak this language; showing the written reply.'
        : voice.reason === 'pocket-language-pack-missing' ? 'The multilingual pack for this language is missing; showing the written reply.'
        : 'The selected voice speaks English only; showing the written reply.'};
  }
  const omni = voice.engine === 'omni', language = voice.language && voice.language !== 'en' ? voice.language : undefined;
  const voiceKey = voiceKeyFor(input);
  // Pocket in another language needs a clip of this character in the language's voice pack (or the player's own clip): without one the reply is written.
  if (voice.engine === 'pocket' && language && !localVoice.cloudActive && !localVoice.hasPlayerClip(voiceKey) && !pocketLanguages.entry(language, voiceKey)) {
    logVoiceRoute(input, profile, {engine: 'none', language}, {reason: 'the multilingual pack has no clip of this character'});
    return {...result, audio: undefined, faces: [], captions: [], timing: {...result.timing, voiceProvider: 'none'},
      audioError: 'The multilingual pack has no clip of this character; showing the written reply.'};
  }
  markStage('voiceStart');
  throwIfCancelled(signal);
  // The face's plan (bridge/emotion-selector.mjs): the player's message and the reply, the character's manner and the
  // previous turn's mood; the character's own tags (Expressive emotions) win, then Convai's own label. Text-only
  // Convai turns send that label about 0.5 s after the text (lateEmotionToken), so it is awaited alongside the voice
  // and used when it is there in time: Omni re-plans before the first phrase's face is built, Pocket's stream
  // planner picks it up on its next rebuild. The receipt records what was used, with no dialogue text.
  // The face's expression is aligned to the audio by pauses and duration (bridge/expression-timeline.mjs), for every voice.
  const player = typeof result.userText === 'string' && result.userText.trim() ? result.userText : input.text;
  const planFor = convai => emotionSelection.plan({player, reply: result.text, profile: input.profileKey, who: personKey(input), convai,
    marks: result.emotionMarks, breaks: []});
  const late = {signal: undefined, settled: false, startedAt: Date.now()};
  if (result.expressionSignal === undefined && Number.isSafeInteger(result.lateEmotionToken)) {
    const config = realtimeConfig(input), token = result.lateEmotionToken;
    late.promise = waitLateEmotion(() => realtime.lateEmotion(config, token), {signal})
      .then(value => { late.signal = value; late.settled = true; late.lateMs = Date.now() - late.startedAt; return value; });
  } else if (streamed?.convaiLate) {
    // A streamed Convai reply: Convai's label (the ordered one, or the late one the page hands a token for) is known only when the reply has returned. The stream's planner
    // reads `late` at each rebuild; the finished reply's plan below takes it when it is there.
    late.settled = false;
    const config = streamed.convaiLate;
    late.promise = Promise.resolve(streamed.final).then(async final => {
      if (final?.expressionSignal !== undefined) return final.expressionSignal;
      if (!Number.isSafeInteger(final?.lateEmotionToken)) return undefined;
      return waitLateEmotion(() => realtime.lateEmotion(config, final.lateEmotionToken), {signal});
    }, () => undefined).then(value => { late.signal = value; late.settled = true; late.lateMs = Date.now() - late.startedAt; return value; });
  } else late.settled = true;
  const expressionReceipt = (plan, expression, extra = {}) => atomic(resolve(runtime, 'expression-receipt.json'), JSON.stringify({
    version: 3, updated: Date.now(), requestId: input.requestId, profile: input.profileKey, provider: omni ? 'omni' : 'pocket',
    selector: emotionSelection.mode, emotion: expression?.emotion ?? null, scale: expression?.scale ?? null,
    basis: expression?.basis ?? null, delivered: expression !== undefined, ...extra,
    plan: plan ? {trait: plan.trait, baseline: plan.baseline, evidence: plan.evidence ?? null, summary: plan.summary ?? null,
      segments: plan.segments.map(segment => ({from: segment.start, to: segment.end, seconds: Math.round(segment.seconds * 100) / 100,
        weights: segment.weights, dominant: segment.dominant, mixed: segment.mixed, tags: segment.tags}))} : null})).catch(() => {});
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
  if (!streamed) emotionSelection.remember(personKey(input), plan);
  if (!streamed) expressionReceipt(plan, result.expressionSignal, {convai: result.expressionSignal?.basis === 'ordered' || result.expressionSignal?.basis === 'response-id'
    ? result.expressionSignal.emotion : null, convaiLate: late.settled ? null : 'pending'});
  // Convai's late label, once known: one more receipt (and, for Omni, the plan used from the first face on).
  const refine = () => {
    if (!late.signal) return false;
    plan = planFor(late.signal);
    result = withPlan({...result, expressionSignal: late.signal}, plan);
    emotionSelection.remember(personKey(input), plan);
    expressionReceipt(plan, late.signal, {convai: late.signal.emotion, convaiLate: late.lateMs ?? null});
    return true;
  };
  if (!streamed) late.promise?.then(() => refine(), () => {});
  if (streamed) streamed.settle = async spoken => {
    const final = await finishedReply(streamed, spoken);
    const merged = mergeFinishedReply(spoken, final, streamed);
    const {expressionSignal: _signal, expressionPlan: _plan, ...base} = merged;
    // Convai's late label (a streamed Convai reply): normally in long before the voice has ended; when it is not yet, it is waited for here (the wait is capped by waitLateEmotion),
    // so the mood carried to the next turn and the receipt have it.
    if (!late.settled && late.promise) await late.promise.catch(() => {});
    const known = final?.expressionSignal ?? (late.settled ? late.signal : undefined);
    result = {...base, ...(known !== undefined ? {expressionSignal: known} : {})};
    plan = planFor(result.expressionSignal);
    result = withPlan(result, plan);
    emotionSelection.remember(personKey(input), plan);
    expressionReceipt(plan, result.expressionSignal, {convai: null, convaiLate: null, streamed: true});
    return {...base, ...(result.expressionSignal !== undefined ? {expressionSignal: result.expressionSignal} : {}),
      ...(result.expressionPlan ? {expressionPlan: result.expressionPlan} : {})};
  };
  const ahead = current?.ahead;
  if ((await readSpeechStateCached()).continuousAvailable !== true) {
    logVoiceRoute(input, profile, {engine: 'none', language: voice.language}, {reason: 'local streaming unavailable: written reply only'});
    return {...result, audio: undefined, faces: [], captions: [],
      audioError: 'Local streaming is unavailable; showing the written reply.'};
  }
  logVoiceRoute(input, profile, voice);
  const speech = continuousSpeech(input, profile, current, signal, receiptPrepared, true, streamed ? streamed.marks : result.emotionMarks, {player, late, engine: omni ? 'omni' : 'pocket'});
  // OmniVoice speaks through the same renderer as Pocket (docs/OMNIVOICE_PCM.md): its phrases arrive as PCM packets from this adapter.
  let capture;
  const engineVoice = omni ? omniVoiceFor({input, result, streamed, language, capture: () => capture}) : localVoice;
  let prefetched;
  if (ahead?.isHeld()) {
    // The one GPU worker is FIFO: a look-ahead phrase queued while the speaker being heard still has phrases to render would delay that
    // speaker's own next phrase, so the look-ahead of an OmniVoice reply waits for that production to finish (its audio plays on).
    if (omni) await waitUntil(() => streaming === 0, {signal});
    // Synthesize now, into memory (the one renderer page may still be draining
    // the previous speaker); the whole text is still sent to Pocket once.
    // Pocket's worker is FIFO, so this runs right after the prior speaker's job.
    // The voices ignore a reply's emotion marks; they are carried with the request.
    const replyMarks = result.emotionMarks, replySounds = result.voiceMarks;
    prefetched = new BufferedPcm({signal, synthesize: (onPcm, options) => engineVoice.synthesizeStream(voiceKey, result.text, {...options, onPcm, ahead: true, emotion: {marks: replyMarks, sounds: replySounds}, ...(language ? {language} : {})})});
    prefetched.start().then(() => ahead.markReady(), () => {});
    try {
      await ahead.waitClaimed(signal);
      // The previous speaker's renderer may still be retiring its page.
      await waitUntil(() => !realtime.localPcmBusy, {signal, timeoutMs: 3000});
    } catch (error) { prefetched.discard(); throw error; }
  }
  // Developer mode: keep this reply's audio and its reference (undefined, and nothing held, while it is off).
  capture = replyCapture.enabled ? replyCapture.begin({engine: omni ? 'omni' : localVoice.cloudActive ? (localVoice.cloud === 'inworld' ? 'inworld' : 'voxtral') : 'pocket', voiceKey, language: language ?? 'en',
    reference: referenceSetFor(omni ? 'omni' : 'pocket', language, voiceKey)}) : undefined;
  return deliverPocketSpeech({input, profile, voiceKey, result, current, signal, voice: engineVoice, host: realtime, speech,
    phoneAnalysis:localVoice.phoneAnalysis,jaliFace,prefetched,stream:streamed?.stream,language,capture,
    onAnalysis: timing => measure(input, {localLipAnalysis: timing})});
}

// OmniVoice's voice for the continuous renderer: the resident worker renders one phrase at a time (a WAV), bridge/omni-pcm.mjs turns the
// phrases into the PCM packets deliverPocketSpeech feeds the renderer and the streaming face model. Per reply (it knows the reply's
// voice-tagged text, language and capture); nothing is held between replies. `capture` is read when a phrase arrives (Developer mode).
function omniVoiceFor({input, result, streamed, language, capture}) {
  const tagged = (phrases, raw) => naturalSpeech.enabled && typeof raw === 'string' ? speechPhrases(phrases, raw, omniTagsFor(language)) : undefined;
  let headPhrases = [];
  const voice = createOmniPcmVoice({
    steps: () => localVoice.steps,
    // The AMD route (ROCm, the player's own Python) asks once more for a phrase that failed instead of ending the reply there (docs/OMNIVOICE_AMD.md); NVIDIA is unchanged.
    // How long this reply's first sound waits so its rest is rendered in time (bridge/omni-runway.mjs): the engine's pace holds it (bridge/speech-pace.mjs).
    onRunway: ms => { omniPace.runwayMs = ms; },
    retries: () => omniOwnPython?.used && omniOwnPython.backend === 'rocm' ? 1 : 0,
    onRetry: ({index, error}) => process.stderr.write(`[LocalVoice] [OmniPython] phrase ${index + 1} failed (${String(error?.message ?? error).slice(0, 100)}), asking again\n`),
    synthesize: async (key, text, options) => {
      const generated = await localVoice.synthesize(key, text, options);
      if (generated.timing?.voiceLanguageReference === 'fallback') capture()?.note({referenceUsed: 'english-fallback'});
      return generated;
    },
    // Voice tags (Natural speech) go to OmniVoice only, where the model wrote them; subtitles keep the clean phrase. A reply voiced while it
    // is still written has them for its rest only (the finished reply's tagged text), never for its first sentence.
    voicedPhrases: (phrases, {role}) => {
      if (role === 'tail') {
        const all = tagged([...headPhrases, ...phrases], streamed?.stream?.meta?.speechText);
        return all?.slice(headPhrases.length);
      }
      headPhrases = phrases;
      return streamed ? undefined : tagged(phrases, result.speechText);
    }});
  // The count keeps memory maintenance and a held look-ahead turn off the worker while this reply still has phrases to render.
  return {synthesizeStream: async (key, text, options) => {
    streaming++;
    try { return await voice.synthesizeStream(key, text, options); }
    finally { streaming--; prefetchObserved = ''; }
  }};
}

// Status writes are queued in call order, so a caller may leave one unawaited (a turn's 'thinking' no longer holds up the
// provider request) without an older state ever landing after a newer one.
// `turn` ({requestId, provider}) names the turn a 'thinking' is for and the provider that took it: the game reads it once, when a turn it
// sent has had no reply for 90 s, to say why (taken by Local AI still loading, by Convai in place of a Local AI that is not ready, or never
// taken at all) instead of guessing that the service is not running (mod/service-status.lua noReplyMessage).
let statusWriting = Promise.resolve();
async function status(state, detail = '', turn = null) {
  const named = turn && typeof turn.requestId === 'string' ? {requestId: turn.requestId.slice(0, 160), provider: turn.provider} : {};
  const text = JSON.stringify({state, detail: detail.slice(0, 200), updated: Date.now(), ...named});
  const job = statusWriting.catch(() => {}).then(() => atomic(statusPath, text));
  statusWriting = job;
  return job;
}

// What a voice engine's recent lines taught: after one that broke, the next ones buffer a longer lead before their first sound, sized from how
// slowly the broken line was produced. One per engine (the Mistral cloud voice, the Pocket voice, the Convai voice): the speed is the engine's.
const cloudPace = new SpeechPace(), pocketPace = new SpeechPace(), convaiPace = new SpeechPace(), omniPace = new SpeechPace(), preparedPace = new SpeechPace();
const paceOf = (local, cloud) => local ? (cloud ? cloudPace : pocketPace) : convaiPace;
function continuousSpeech(input, profile, current, signal, receiptPrepared = preparedInputs.get(input), local = false, marks,
  {player = input.text, late, engine, mic} = {}) {
  const options = {signal, isCurrent: current, isCurrentSync: current.sync};
  const ahead = current.ahead;
  // A prepared quest line is buffered whole before it is sent, so it has a pace of its own and teaches no live engine's.
  const pace = engine === 'prepared' ? preparedPace : engine === 'omni' ? omniPace : paceOf(local, localVoice.cloudActive);
  const speech = new ConvaiContinuousSpeech({input, profile, current, signal,
    // V speaks your microphone lines, on the Convai provider: the recognised words arrive in the stream, V's line starts from them and holds the reply (bridge/mic-v-line.mjs).
    ...(mic ? {onTranscript: mic.onTranscript, awaitTranscript: mic.awaitTranscript} : {}),
    planExpression: emotionSelection.planner({player, profile: input.profileKey, who: personKey(input), marks, late}),
    onTimeline: timeline => logEmotionTimeline(input, profile, {provider: local ? 'pocket' : 'convai', ...timeline}),
    ...(local ? {faceBuilder: ownedPocketFace} : {jaliFace}),
    // A look-ahead turn buffers silently until the game submits it. Once its
    // complete text is known (and it is no longer held), the next group speaker
    // may be prepared from that text.
    // V's typed line, when it is audible, holds the reply the same way: it is published to the game shortly before V's line ends (the
    // game's round trip overlaps V's last moments, V_HANDOFF_LEAD_MS) and its sound starts when V has ended (bridge/v-voice.mjs).
    hold: () => ahead?.isHeld() === true || current.vLine?.()?.holdsPublish() === true,
    holdPeek: () => ahead?.isHeld() === true || current.vLine?.()?.holdsPublishPeek() === true,
    holdSound: () => current.vLine?.()?.blocking === true,
    onHeld: (bufferedSeconds, textComplete) => { if (bufferedSeconds >= 0.4 && textComplete) ahead?.markReady(); },
    pace,
    // One record per line of how it played (underruns: how often its audio ran dry), and one log line when it broke.
    onEnded: info => {
      void measure(input, {playback: info}).catch(() => {});
      if (info.underruns > 0) console.error(`[Speech] profile=${input.profileKey} the voice broke ${info.underruns} time(s): ${info.seconds.toFixed(1)} s of audio`
        + (info.playedMs ? ` played over ${(info.playedMs / 1000).toFixed(1)} s` : '')
        + `; the next lines buffer ${pace.lead.toFixed(1)} s first (this one refilled ${Number.isFinite(info.refillSeconds) ? info.refillSeconds.toFixed(1) : '?'} s after a break)`);
    },
    onText: (text, userText) => {
      if (typeof userText === 'string') noteKnowledgeTurn(receiptPrepared, {userText});
      lookahead.setSource({input, text, userText, current: current.sourceValid || current, signal});
    },
    readControl: () => readFile(resolve(runtime, 'continuous-control.json'), 'utf8'),
    leaseWake: () => leaseWake.next(),
    writeState: value => atomic(resolve(runtime, 'continuous-speech.json'), JSON.stringify(value), options),
    writeFace: (value, {segments} = {}) => atomic(resolve(runtime, 'continuous-face.json'),
      segments ? encodeSegmentedFace(value) : JSON.stringify(value), options),
    // The game's adapter says how it reads the timeline file: segments (decoded by changed segment), a plain document or not at all.
    faceFile: async () => { const state = await readSpeechStateCached(); return state.continuousFaceSegments === true ? 'segments' : state.continuousFaceFile === true; },
    writeReply: value => atomic(replyPath, JSON.stringify({...value, ...keyNotice(), ...dfNote(value?.requestId)}), options),
    // The record is written in the background (still in order): the poll that reads the game's lease does not wait for a 25 KB file.
    onPublished: timing => { markPublished(input.requestId, timing.publishedAt);
      note(input, {...timing, stream: {mode: engine === 'omni' ? 'omni-continuous' : local ? 'pocket-continuous' : 'convai-continuous'}, nativePlaybackObserved: false}); },
    // The game's first lease reached the bridge (the turn's record: published -> leaseRead is the game's half of the hand-off).
    onLease: () => turnMark(input.requestId, 'leaseRead'),
    // The game was paused (a pause or a menu) while this reply waited for its sound: the slow-turn report leaves the turn out.
    onPaused: () => turnClocks.get(input.requestId)?.annotate({gamePaused: true}),
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
      // A character the player made is the same: runCustomTurn voices the reply with no knowledge receipt (error report e0fc2ad3,
      // Local AI + Pocket: "Conversation receipt owner changed" after every custom-character line).
      if (!receiptPrepared && (input.addon || customCharacters.has(input.profileKey) || input.reaction?.kind === 'scripted')) {
        if (!await current()) throw Error('Conversation owner changed');
        return;
      }
      if (!receiptPrepared || !await current()) throw Error('Conversation receipt owner changed');
      await knowledgeRouter.activity(receiptPrepared, 'generated-reply', {replyText: text});
      stagedKnowledgeTurn(receiptPrepared, {replyText: text});
    },
  });
  // Poll the buffered turn at once when the game submits it, when V's line nears its end (publish) and when it ends (sound).
  ahead?.claimed.then(() => speech.wakeUp(), () => {});
  current.vLine?.()?.whenNearEnd?.(() => speech.wakeUp());
  current.vLine?.()?.whenClear(() => speech.wakeUp());
  return speech;
}

// Original remote PCM has a continuous renderer. It never enters Omni's text
// splitter or the local TTS worker.
async function convaiReply(input, profile, current, signal) {
  logVoiceRoute(input, profile, {engine: 'convai', language: turnVoice(input).language});
  const state = await readSpeechStateCached();
  // A game session whose Lua adapter does not advertise continuous playback (the scripts are not loaded yet, or the adapter failed) has no way
  // to play a voice: the reply is asked as text (no audio is requested) and written, with the one reason the game shows.
  if (state.continuousAvailable !== true) {
    logVoiceRoute(input, profile, {engine: 'none', language: turnVoice(input).language}, {reason: 'local streaming unavailable: written reply only'});
    return {...await realtime.reply({...realtimeConfig(input), ttsEnabled: false}, {signal}), transport: 'realtime',
      audioError: 'Local streaming is unavailable; showing the written reply.'};
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
  const final = Promise.resolve(realtime.reply(config, {signal, stream, deferRecord: deferExchange(input)})).then(result => ({...result, transport: 'realtime'}));
  final.catch(() => {});
  return voiceStreamedReply(input, profile, {signal, current, stream, final, config});
}
// The exchange of a text-provider turn (Mistral, Local AI, Custom) is remembered only when its reply is published (publishResult): a reply the
// player never heard (a target switch, a cancel, the game's 90 s cutoff, an interrupted stream) leaves no memory. The text host hands over a one-shot
// commit per turn through its deferRecord option; a turn that is dropped never commits it, and the WeakMap lets it go with the turn's input.
const pendingExchanges = new WeakMap();
const deferExchange = input => commit => { pendingExchanges.set(input, commit); };
function commitExchange(input) {
  const commit = pendingExchanges.get(input);
  if (!commit) return;
  pendingExchanges.delete(input);
  try { commit(); } catch (error) { console.error('[CyberpunkConvai] Memory exchange not recorded:', error?.message); }
}
// The default route: Convai writes the text (its own voice is off), a local voice speaks it. The text so far is read from the conversation page while Convai writes it
// (bridge/realtime-host.mjs, textStream) and the first complete sentence goes to the voice before the reply is finished, as on the text routes. Convai's own emotion label
// belongs to the finished reply: it is read when the reply returns and the face takes it up as it does for a reply voiced as a whole (late, below).
async function respondConvaiStreamed(input, profile, {signal, current}) {
  const config = realtimeConfig(input);
  const stream = newReplyStream(config, profile);
  const final = Promise.resolve(realtime.reply(config, {signal, textStream: stream})).then(result => {
    markStage('fullText');
    // The finished text is cleaned the way the sentence given to the voice was, then agrees with it or is cut back to it (the text never contradicts the audio).
    const text = finishedText(stream, result.text);
    const done = {...result, text, transport: 'realtime'};
    stream.finish(text, done);
    return done;
  }, error => { stream.fail(error); throw error; });
  final.catch(() => {});
  return voiceStreamedReply(input, profile, {signal, current, stream, final, config, convaiLate: config});
}
const newReplyStream = (config, profile) => new ReplyStream({name: config.local?.name ?? profile?.name ?? '', isTag: hasEmotionTag});

// The voice half of a streamed reply, shared by a typed turn (respondStreamed) and a voice-key turn (bridge/voice-key-stream.mjs, started
// from prepareReply while the text host is still writing the reply). 'stream' is the ReplyStream the text host feeds, 'final' the
// finished reply's promise. 'userText' (voice key only) is what the player said: the first sentence's admission carries it.
// 'receiptPrepared' is the turn's knowledge receipt when it is not the default one (undefined: the default).
async function voiceStreamedReply(input, profile, {signal, current, stream, final, config, userText = () => '', receiptPrepared, convaiLate}) {
  const marks = [];
  stream.onChange(() => { if (stream.complete && Array.isArray(stream.meta?.emotionMarks)) marks.splice(0, marks.length, ...stream.meta.emotionMarks); });
  const whole = async () => synthesizeReply(input, await final, signal, current, profile, receiptPrepared);
  const head = await abortable(stream.headReady, signal);
  if (!head) return whole();
  const voice = replyVoice({plan: turnVoice(input), text: head, local: localChoice(input.profileKey)});
  // Pocket, Voxtral and OmniVoice are voiced while the reply is still being written: the first sentence goes to the renderer at once.
  if ((voice.engine !== 'pocket' && voice.engine !== 'omni') || localVoice.playbackEnabled === false || (await readSpeechStateCached()).continuousAvailable !== true) return whole();
  throwIfCancelled(signal);
  // The tags written inside the first sentence move the face from its first frame (the finished reply re-plans with all of them).
  const headMarks = expressiveEmotions.active ? stream.headMarks : [];
  if (headMarks.length && !marks.length) marks.push(...headMarks);
  const said = userText();
  const partial = {text: head, transport: 'realtime', sessionID: config.sessionId, timing: {streamedHead: true},
    ...(said ? {userText: said} : {}),
    ...(headMarks.length ? {emotionMarks: headMarks} : {}), ...(naturalSpeech.enabled && stream.headSounds.length ? {voiceMarks: stream.headSounds} : {})};
  return synthesizeReply(input, partial, signal, current, profile, receiptPrepared, {stream, final, marks, signal, ...(convaiLate ? {convaiLate} : {})});
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
    if (!mistral.active && replyStreaming && !current?.ahead && !input.reaction) return respondConvaiStreamed(input, profile, {signal, current});
    return synthesizeReply(input, {...await realtime.reply(realtimeConfig(input), {signal, deferRecord: deferExchange(input)}), transport: 'realtime'}, signal, current, profile);
  }
  prefetch.invalidate(); prepared?.cancel();
  throwIfCancelled(signal);
  // Text-only replies keep the same identified transport when native playback
  // is unavailable; legacy HTTP does not document the player-memory binding.
  return {...await realtime.reply({...realtimeConfig(input), ttsEnabled: false}, {signal, deferRecord: deferExchange(input)}), transport: 'realtime'};
}

// One compact line per reply for scripts/Show-EmotionTimeline.mjs (bridge/expression-timeline.mjs). Diagnostic only.
function logEmotionTimeline(input, profile, {provider, text, plan, face, signal} = {}) {
  try {
    const record = timelineRecord({requestId: input.requestId, speaker: profile?.name, profile: profile?.key, provider,
      reply: text, plan, face, signal});
    if (record) console.error(TIMELINE_PREFIX + JSON.stringify(record));
  } catch { /* logging never affects speech */ }
}

// A holocall reply is complete: V may have asked her to come and meet them, and she may have agreed (docs/IMMERSIVE_INVITATIONS.md, "Holocalls"). On a text
// provider one small request decides it, after the reply and beside everything else (never awaited, never in front of a turn); on Convai the action list of the
// turn did (bridge/companion-actions.mjs). A line that cannot be about a meeting sends nothing to any model.
function decideCallMeet(input, result, signal) {
  try {
    const pending = companionActions.pending;
    if (!pending?.meet || pending.packet.requestId !== input.requestId || typeof result?.text !== 'string') return;
    const userText = callLine(input, result);
    const plan = planCallMeet(pending.meet, userText);
    if (!plan) return;
    void mistralHost.decideMeet({plan, userText, replyText: result.text, token: pending.packet.actionId, profileKey: input.profileKey, signal}).catch(() => {});
  } catch { /* the call's reply never depends on this */ }
}

async function publishResult(input, profile, result, current = async () => true, signal) {
  if (!await current()) return false;
  if (input.holocall && input.meetOffer && mistral.active) decideCallMeet(input, result, signal);
  // A scripted quest line used no Convai session and no warm connection: it must not overwrite the character's session id or mark a connection as used (runScriptedTurn).
  const scripted = input.reaction?.kind === 'scripted';
  // "Never mind, cancel that" said to a companion at V's side calls off a meeting V arranged with someone who is not here (bridge/call-off.mjs).
  publishCallOff(runtime, atomic, input, result?.userText);
  // A reply published as a whole (OmniVoice) is ready now: V's typed line, if it is audible, finishes first; if it is not, it is dropped.
  await current.vLine?.()?.waitClear(signal);
  if (!await current()) return false;
  // The language of this exchange predicts the next turn without text (reactions, warm connections).
  // Only a turn the player had a hand in sets the conversation's language: the reply to a reaction (a bark) is short and may be in any language.
  if (!input.reaction) multilingual.observeTurn(input.text, result.text, speechLanguage.evidence?.language ?? null);
  logNaturalSpeech(input, result);
  // The reply is published, so this character has been told V's gear as of this turn: the next turn is compared against it and says what changed (bridge/gear-memory.mjs).
  // Not for an automatic reaction (it carries no gear), a voice with no body, or while Settings > Dynamic info has V's gear off (none of it was told).
  const gearTold = () => { try { if (!input.reaction && !voice && dynamicOn('gear', input)) gearSeen(input, gearMemory, {visible: isAmbientProfile(input.profileKey)}); } catch { /* a memory never affects a reply */ } };
  // One line per reply: whether this turn's context carried V's gear (bridge/player-gear.mjs), or why not. Counts only, no names.
  // A voice with no body (persona.voiceContext) gets neither V's gear nor the person form of the block below.
  const voice = addonHost.usesVoiceContext(input.profileKey);
  try { if (!input.reaction) console.error(`[PlayerGear] profile=${input.profileKey} ${voice ? 'Player gear: none (voice speaker)' : gearDiagnostic(input, {memory: gearMemory, visible: isAmbientProfile(input.profileKey), told: gearWantedFor(input)})}`); } catch { /* a log line never affects a reply */ }
  // And whether it carried the "right now" block (clock, place, company; bridge/turn-context.mjs). Counts only.
  try { if (!input.reaction) console.error(`[TurnContext] profile=${input.profileKey} ${turnContextDiagnostic(input, voice ? {ambient: isAmbientProfile(input.profileKey), voice, off: dynamicOff(input)} : turnContextOptions(input, isAmbientProfile(input.profileKey)))}`); } catch { /* a log line never affects a reply */ }
  if (result.continuous) {
    if (!result.liveDelivery?.published || !result.liveDelivery.ended) throw Error('Continuous speech did not finish');
    // The game already received admission, live text and the consumed-sample
    // clock. Publishing a second ordinary reply would replay or replace it.
    if (!scripted) realtimeSessions.set(sessionKey(input), result.sessionID);
    recordDevTurn(input, profile, result);
    commitExchange(input); gearTold(); publishBonds(input, result, publishEddies(input, result)); publishMeeting(input);
    if (!scripted) connections.used(input, result.timing);
    prefetch.published(input, result.text); prefetchObserved = '';
    await measure(input, {transport: 'realtime', timing: result.timing,
      stream: {id: result.liveDelivery.id, mode: result.timing?.voiceProvider === 'pocket' ? 'pocket-continuous' : result.timing?.voiceProvider === 'omni' ? 'omni-continuous' : result.timing?.voiceProvider === 'prepared' ? 'prepared-continuous' : 'convai-continuous', complete: true},
      continuousPlaybackCompleteAt: Date.now()});
    await status('ready', profile.name, {requestId: input.requestId});
    return true;
  }
  // Every voice that speaks has been played through the renderer by now (the continuous branch above): what reaches this point is a
  // written reply, with the reason when the voice could not be had.
  const audioError = result.audioError;
  // Convai's voice did not start within 5 s of the finished text (bridge/realtime-client.mjs TEXT_WITHOUT_AUDIO_MS): the reply is written, no failure and no error report.
  if (result.timing?.convaiVoiceTimedOut === true) console.error(`[Convai] voice did not arrive in ${Math.round((result.timing.textWithoutAudioMs ?? 5000) / 1000)} s; the reply is shown as text (profile=${input.profileKey})`);
  // The next group speaker may be prepared from this reply's text from now on.
  lookahead.setSource({input, text: result.text, userText: result.userText, current: current.sourceValid || current, signal});
  const committed = await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation,
    entity: input.entity, profile: profile.key, text: result.text, userText: result.userText, audioError,
    // A scripted line whose prepared audio was missing or could not be played: the game shows the subtitle and adds a Phone Chat line (bridge/quest-lines.mjs scriptedResult).
    ...(result.missingAudio === true ? {missingAudio: true} : {}),
    updated: Date.now(), ...keyNotice(), ...dfNote(input.requestId)}), {signal, isCurrent: current, isCurrentSync: current.sync});
  if (!committed || !await current()) return false;
  recordDevTurn(input, profile, result);
  commitExchange(input); gearTold(); publishBonds(input, result, publishEddies(input, result)); publishMeeting(input);
  logEmotionTimeline(input, profile, {provider: result.timing?.voiceProvider ?? null, text: result.text,
    plan: result.expressionPlan, face: undefined, signal: result.expressionSignal});
  if (!scripted) (result.transport === 'realtime' ? realtimeSessions : sessions).set(sessionKey(input), result.sessionID);
  if (result.transport === 'realtime' && !scripted) connections.used(input, result.timing);
  prefetch.published(input, result.text);
  // Reconsider the prediction file after a source reply becomes valid.
  prefetchObserved = '';
  markPublished(input.requestId);
  await measure(input, {transport: result.transport || 'rest', timing: result.timing, preparation: result.preparation,
    publishedAt: Date.now(), nativePlaybackObserved: false});
  await status('ready', profile.name, {requestId: input.requestId});
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
// A character the player made is spoken to the same way: recognised here, answered by runCustomTurn.
const addonVoice = createAddonVoice({isSpeaker: key => addonHost.isSpeaker(key) || customCharacters.has(key), speech: mistralSpeech,
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
    const own = customCharacters.has(input.profileKey);
    return withTurnClock(request, clock => (own ? runCustomTurn : runAddonTurn)(request, input, profileFor(input, roster), current, clock, {userText}));
  },
  answerError: async ({input, signal, current, error}) => {
    // The same answer a typed add-on turn gets from runInput: a message about the service, not about the microphone.
    console.error('[Addons] Voice turn failed:', error.message);
    await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation, entity: input.entity,
      error: 'The conversation service could not reply. Please try again.', ...turnFailure(error, input)}),
      {signal, isCurrent: current, isCurrentSync: current.sync}).catch(() => {});
    noteTurnFailure(error, input, {microphone: true});
  }});

const mic = new MicrophoneSession({hostFactory: addonVoice.hostFactory(() => realtime.voiceChannel()),
  // The key's own length is the recording: the audio since the press is already kept (bridge/mic-tap.mjs), so no minimum recording is waited out.
  minRecordMs: 0,
  // `note`: the recording's channel says something the game should tell the player once ('english-only', bridge/local-stt-capture.mjs).
  onState: (state, input, opened) => {
    micStateLast = {state, requestId: input.requestId, ...(state === 'recording' && typeof opened?.note === 'string' ? {note: opened.note.slice(0, 24), ...(opened.note === 'mic-loopback' && typeof opened.device === 'string' ? {device: opened.device.slice(0, 80)} : {})} : {})};
    // Whatever ends the recording ends the tap with it (a no-op when a channel or the key already did).
    if (state === 'off') void micTap.release(input.requestId, 'the recording is over');
    return publishMicState();
  },
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
    // V's line for this spoken turn, if one was started: the reply's audio is held behind it like a typed line's (bridge/mic-v-line.mjs).
    current.vLine = () => micV.lineOf(input.requestId);
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
    const speech = continuousSpeech(input, profileFor(input, roster), current, signal, prepared, false, undefined,
      {mic: micV.convaiHooks(input, signal, () => speech.wakeUp()) ?? undefined});
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
      current.vLine = () => micV.lineOf(input.requestId);
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
    const {state, ...fields} = microphoneErrorState(error);
    const noSpeech = state === 'no-speech', silent = state === 'silent', language = fields.reason === 'language';
    micStateLast = {state, requestId: input.requestId, ...fields};
    await publishMicState({isCurrent: current, isCurrentSync: current.sync});
    await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation,
      entity: input.entity, error: 'Voice conversation failed. Check your microphone and try again.', ...turnFailure(error, input)}), {isCurrent: current, isCurrentSync: current.sync});
    if (!noSpeech && !silent && !language) noteTurnFailure(error, input, {microphone: true});
  },
});

// V repeats what the player said (setting vVoiceMic): exactly like a typed line (spoken in full, the reply follows it). Started by the transcript callback of the
// microphone channel on a text provider, and by the recognised words in the stream on the Convai provider (convaiHooks above). An add-on's or a made
// character's voice turn starts it itself.
mic.prepareReply = micV.wrapPrepare(mic.prepareReply, {own: input => addonVoice.voice(input)});
// A voice turn is running from the key press (the tap is held for a turn) until its reply is published or it is cancelled (world lease, above).
micTurnRunning = () => mic.current !== null || (micTap.state !== 'closed' && micTap.mode === 'turn');

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
  sessions.clear(); realtimeSessions.clear(); sceneryMemory.clear(); gearMemory.clear(); knowledgeTurns.clear();
  partyObserved = ''; prewarmObserved = ''; prefetchObserved = '';
  rewarmLocalVoice();
}

// A text route's hidden browser (the local voice's renderer) is closed with the realtime host by a world reset, a key switch or a
// provider switch. Nothing else opens it until the next composer warm-up, so a turn that comes first would start Edge in front of its
// voice (770 ms, then the renderer page: the live record of 2026-10-13, the turn after a provider switch). Open it again at once.
function rewarmLocalVoice() {
  // Not before the first settings poll has read the playback setting: with voice playback Off a text provider needs no browser, and the
  // default (On) would start one at launch that then lives for BROWSER_IDLE_MS for nothing. The poll calls this once it has read it.
  if (voiceSettingsRead && mistral.active && localVoice.playbackEnabled !== false && !stopped) void realtime.prewarmLocal();
}

async function quiescePlayerMemory({signal, scope, profileKeys} = {}) {
  throwIfCancelled(signal);
  memoryQuiescing++;
  try {
    await resetLiveRoutes();
    throwIfCancelled(signal);
    // Forget all memories also forgets what shopkeepers remember of V. PlayerMemory has already persisted the reset
    // epoch and fenced every character, so a turn begun earlier can no longer write; a failed removal fails the clear.
    // Forget acts on the memory in use: the normal one, or the separate memory of the content pack that is on (bridge/memory-scope.mjs). The other stays as it is.
    const pack = memoryNamespace.scope();
    if (scope === 'all' && (await vendorMemory.forgetAll({scope: pack})).ok !== true) throw Error('Vendor memory could not be cleared');
    // The text providers keep their own conversation memory here (bridge/memory-store.mjs): Forget clears it too, records and vectors included.
    mistralMemory.forget({all: scope === 'all', profileKeys: (profileKeys ?? []).map(memoryNamespace.keyFor), scope: pack});
    lastTalk.forget({all: scope === 'all', profileKeys: (profileKeys ?? []).map(memoryNamespace.keyFor), scope: pack});   // a forgotten character does not remember when it last met V
    bonds.forget({all: scope === 'all', profileKeys: (profileKeys ?? []).map(memoryNamespace.keyFor), scope: pack});   // the bond's talk part follows the memory it came from
    bondPacks.forgetHistory({all: scope === 'all', profileKeys: profileKeys ?? []});   // the lasting lines a story pack kept follow the memory too
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
      ? false : convaiSpeaks(prepared.input)};
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
      markBridgeStage('microphone.' + command.action);
      const holdId = typeof command.hold === 'string' && /^[\w.-]{1,40}$/.test(command.hold) ? command.hold : null;
      console.error('[CyberpunkConvai] Microphone: ' + command.action + ' command, source ' + String(command.source ?? 'unknown').replace(/[^\w.-]/g, '').slice(0, 24)
        + (holdId ? ', key hold ' + holdId : '') + (ranMs === null ? '' : ', ' + ranMs + ' ms into the recording'));
      // The microphone tap (bridge/mic-tap.mjs) first, before any preparation: the audio from the key press (or from the detected start of speech)
      // is already being kept; this only names its owner. A start the tap does not know (no hold signal arrived) opens it here.
      if (command.action === 'start') {
        const voiceTurn = command.source === 'vad';
        const onset = voiceTurn && micTap.listening ? micTap.vadStatus?.onsetMs : undefined;
        micTap.open(input.requestId, {holdId, vad: voiceTurn, ...(Number.isFinite(onset) ? {sinceMs: onset - TAP.prerollMs} : {})}).catch(() => {});
      } else if (command.action === 'finish') void micTap.stop(input.requestId);
      else void micTap.release(input.requestId, 'cancelled by the game');
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
        if (!prior || !await knowledgeRouter.current(prior)) { await abandonMicrophone('the world is gone'); return; }
        const refreshed = await knowledgeRouter.prepare({...input, source: 'microphone'},
          {worldToken: worldSession?.token, generation: worldSession?.generation});
        if (!await knowledgeRouter.current(prior) || !await knowledgeRouter.current(refreshed)
            || refreshed.sessionKey !== prior.sessionKey) { await abandonMicrophone('the world changed'); return; }
        // The same submitted turn retains its receipt owner; only the context
        // snapshot and native input data refresh at microphone completion.
        preparedInputs.set(refreshed.input, refreshed);
        const signal = mic.current?.controller.signal;
        // A group recording arms only a leave and/or home offer for its round (docs/WORLD_COMPANIONS.md, docs/HOUSEMATES.md).
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
        // The provider the player chose rides in the command (mod/init.lua): the recording goes to it, as a typed line does (providerForTurn).
        await providerForTurn(input, {mic: true});
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
        await providerForTurn(input, {mic: true});
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
        // While V talks: the voice (OmniVoice) and the persona (local AI) of whoever answers, if nothing prepared them before.
        warmTalkTargets([prepared.input.profileKey, ...(prepared.input.group?.audience ?? [])]);
        // V repeats the spoken line (setting): its voice is prepared now, while the player talks, so the line is not the slow one. Nothing runs per frame.
        if (vVoice.micWanted) { vVoice.noteGender(prepared.input); vVoice.warmUp(); }
        // A reply the local renderer will voice (Pocket, Voxtral): its output device opens while V talks (RealtimeHost.standbyLocal; an
        // unused one closes itself after 30 s). Routing is read without fixing this turn's voice plan, which waits for the words.
        const choice = localChoice(prepared.input.profileKey);
        if (choice.uses && choice.provider === 'pocket' && localVoice.playbackEnabled !== false) void realtime.standbyLocal?.()?.catch(() => {});
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
      else if (!owner || !await knowledgeRouter.current(owner) || !await audioReady(runtime, MIC_LEASE_MS)) await abandonMicrophone('the world or the speech service of the game is gone');
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
// Requests the game has already submitted (the last few): a line prepared ahead for one of them is useless and is never started (pollLookahead).
const submittedRequests = new Set();
const noteSubmitted = requestId => { submittedRequests.delete(requestId); submittedRequests.add(requestId); while (submittedRequests.size > 24) submittedRequests.delete(submittedRequests.values().next().value); };
// Lines prepared ahead that are in flight, by request id: the text route sends these as background work (realtimeConfig).
const preparedRequests = new Map();

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
    // An empty file is a missing file: the game writes it in place to withdraw the request (it never deletes the file, which
    // a virtual file system such as Mod Organizer 2's would not follow), and ships it empty. The owner of a running turn sees
    // the change through RequestFileOwner, as it saw the removal.
    if (requestFileEmpty(raw)) { observedIdentity = stampIdentity; return; }
    const signature = `${stamp.mtimeMs}:${stamp.size}:${raw}`;
    if (signature === observed) { observedIdentity = stampIdentity; return; }
    const input = parseInput(raw);
    if (!input) {
      // The game rewrites this file in place, so a read can land in the middle of the write. A partial read is not a
      // finished request, a cancel or an error: it is read again on the next poll, and its identity (size, time) is not
      // remembered, so the finished file is read as soon as it changes. Only content that reads the same twice is reported.
      if (invalidSeen !== signature) { invalidSeen = signature; return; }
      observed = signature; observedIdentity = stampIdentity;
      prefetch.invalidate();
      // A transient partial write is not a new target and must not cancel an otherwise valid active turn.
      if (!active) await status('invalid-input', 'Could not parse the game request');
      return;
    }
    invalidSeen = '';
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
    noteSubmitted(input.requestId);
    void companionActions.revoke();
    active?.controller.abort();
    // The provider the player chose is in the request (mod/init.lua sendRequest): a line sent right after picking Local AI is answered by Local AI even if the
    // settings poll has not read the change yet. Before the look-ahead claim: a held turn prepared on the old provider is dropped by the switch (dropPrefetch).
    // Look-ahead turns themselves (startAhead) never come through here.
    await providerForTurn(input);
    const owner = new RequestFileOwner(inputPath, raw, stamp);
    // The exact turn may already be generated and held back (group look-ahead):
    // adopt it instead of starting another provider request.
    const held = lookahead.claim(input, owner);
    if (held) {
      active = held; void cancelMicrophone();
      // The submitted turn is this one now: the status names it, as runInput's 'thinking' does for a turn that starts here.
      void status('thinking', profileFor(input, roster)?.name ?? '', {requestId: input.requestId, provider: mistral.active ? mistral.route : 'convai'}).catch(() => {});
      void measure(held.input, {claimedAt: Date.now(), lookahead: lookahead.stats(held.lookahead)});
      return;
    }
    const controller = new AbortController();
    const request = active = {input, raw, owner, controller, receivedAt: Date.now(), writtenAt: stamp.mtimeMs};
    // Native decision/history context is projected at actual submission. A
    // raw prediction cannot be substituted for that verified context.
    void processInput(request);
  } catch (error) { pollLog('[CyberpunkConvai] Input poll:', error); }
  finally { polling = false; }
}

// Run the predicted next group speaker now, held back from the game until it
// submits that exact turn. The request carries the entry that gates publication.
function startAhead(entry) {
  const request = {input: entry.input, raw: null, owner: entry.owner, controller: entry.controller,
    receivedAt: entry.startedAt, lookahead: entry};
  // A line prepared beside another (Johnny's follow-on, an after-scene line) is marked for the text route, which sends it as background work.
  const prepared = entry.kind !== 'group' ? entry.input.requestId : null;
  if (prepared) preparedRequests.set(prepared, entry.kind);
  void processInput(request).catch(() => {}).finally(() => { if (prepared) preparedRequests.delete(prepared); });
  return request;
}

// Runs the turn under its own TurnClock, so every stage the turn reaches (here and in the text route, the voice, the PCM host
// and the continuous speech) lands in this turn's record (bridge/turn-clock.mjs). The clock watches the event loop until the
// turn is published.
// Dark Future's state in a turn (docs/DYNAMIC_INFO.md, "Other mods' state"): one compact probe line per turn that carried the game side's note, so a missing remark
// can be told from a failed read, a switch that is off, a question that was not recognised and a sentence that was not sent. It goes to this log and, in the turn's
// reply (fields `df`, `fac`, `inj`: Dark Future, Flesh and Chrome, Injuries), to the game, whose probe.log gets the same lines next to "Conversation result". Words only; the newest few turns are kept.
const dfLines = new Map();
const DF_LOG_TAGS = {df: 'DarkFuture', fac: 'FleshAndChrome', inj: 'Injuries'};
const dfNote = requestId => dfLines.has(requestId) ? dfLines.get(requestId) : {};
function logDarkFuture(input) {
  try {
    if (!input || input.reaction || typeof input.requestId !== 'string' || addonHost.usesVoiceContext(input.profileKey)) return;
    const options = turnContextOptions(input, isAmbientProfile(input.profileKey));
    // df: (Dark Future), fac: (Flesh and Chrome) and inj: (Injuries): one line each, only when the game side sent that mod's note.
    const lines = {...(modsProbeLine(input, options) ? {df: modsProbeLine(input, options)} : {}), ...vixenProbeLines(input, options)};
    if (!Object.keys(lines).length) return;
    dfLines.set(input.requestId, lines);
    while (dfLines.size > 8) dfLines.delete(dfLines.keys().next().value);
    // Each line carries the tag of its own mod ([DarkFuture] df:, [FleshAndChrome] fac:, [Injuries] inj:), so a log search for one mod never finds another's.
    for (const [tag, line] of Object.entries(lines)) console.error(`[${DF_LOG_TAGS[tag] ?? 'DarkFuture'}] ${line}`);
  } catch { /* a log line never affects a reply */ }
}
async function processInput(request, prepared) {
  // A submitted turn (not one prepared ahead) is the bridge's from here, and its status says so at once (the game's probe line a few seconds after a
  // typed turn reads it, mod/service-status.lua receipt): a request that never shows as received was never read. One log line, codes only. Not awaited.
  const input = request.input;
  if (!request.lookahead && input) {
    endTitle('a turn arrived');   // a player talking has a world, whatever the poll has seen yet
    void status('received', '', {requestId: input.requestId, provider: input.provider}).catch(() => {});
    console.error(`[Turn] received ${String(input.requestId).slice(0, 80)} generation=${input.generation}${input.reaction ? ' reaction' : ''}`);
    logDarkFuture(input);
  }
  return withTurnClock(request, clock => runInput(request, prepared, clock));
}
async function withTurnClock(request, run) {
  stockCancel?.();   // a turn needs the text route now: a line being written ahead of time gives way
  const clock = new TurnClock({origin: request.receivedAt});
  if (Number.isFinite(request.writtenAt) && request.writtenAt <= request.receivedAt + 5) clock.mark('inputWritten', request.writtenAt);
  clock.mark('received', request.receivedAt);
  if (request.input?.requestId) turnClocks.set(request.input.requestId, clock);
  clock.watch({maxMs: 20_000});
  // Judged for the slow-turn report once the turn has reached its first sound and its run has ended (bridge/slow-turns.mjs).
  const ended = slowTurns.track(clock), silenceEnded = voiceSilence.track(clock);
  try { return await withClock(clock, () => run(clock)); } finally { ended(); silenceEnded(); }
}

// An add-on speaker's turn (docs/ADDON_API.md): a remark the add-on asked for, or V talking to it. Text comes from the player's Custom
// provider, Mistral or the local AI only (AddonHost.routeFor); with neither set up the game is told once (errorCode addon-provider). A remark that nearly repeats one
// of the speaker's recent lines is dropped silently (addon-duplicate). The voice is the speaker's local voice when there is one.
function addonTurnConfig(input, profile) {
  noteTurn(input);
  // A voice with no body (a cab's AI, persona.voiceContext) gets the voice form of the main mod's context: no "with V in person", no party
  // names outside a group round, no gear or journal (bridge/quest-context.mjs voiceConversationBlocks).
  const base = addonHost.usesVoiceContext(input.profileKey) ? voiceConversationBlocks(input) : intrinsicConversationContext.blocks(input);
  // The reply language, last like a companion's: an add-on always answers on a text provider (Mistral, the local AI or Custom), whatever the
  // companions use, so the text provider's rule applies directly. A remark has no words of V's and follows the conversation's language.
  const language = multilingual.contextFor(input.reaction ? '' : input.text, speechLanguage.evidence?.language ?? null);
  const blocks = [...base, ...addonHost.blocks(input), ...(language ? [{tier: 'volatile', text: language}] : [])];
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
  if (!ahead) void status('thinking', profile.name, {requestId: input.requestId, provider: route}).catch(() => {});
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
  // V's voice for a line typed to an add-on's voice (docs/V_VOICE.md): started only after the text request is under way, like a companion's,
  // so it runs beside the reply and never in front of it; the reply's voice waits for it (current.vLine) or drops it. V's own words are
  // never part of the add-on speaker's reply (the text host cuts them, text-provider-host.mjs) and V is spoken by V's own voice page.
  let vLine = null;
  vVoice.noteGender(input);
  current.vLine = () => vLine;
  const startV = () => { if (!remark && !ahead && !vLine) vLine = vVoice.start(input, {signal, clock, spoken: Boolean(userText)}); };
  if (voiced && !remark && replyStreaming && !ahead) {
    // A conversation streams its first sentence to the voice, like any text-provider turn.
    const stream = newReplyStream(config, profile);
    const final = Promise.resolve(host.reply(config, {signal, stream})).then(reply => ({...reply, transport: 'realtime'}));
    final.catch(() => {});
    startV();
    result = await voiceStreamedReply(input, profile, {signal, current, stream, final, config, userText: () => userText});
  } else {
    const generate = async attempt => ({...await host.reply(attempt === input ? config : addonTurnConfig(attempt, profile), {signal}), transport: 'realtime'});
    const first = stocked ? {text: stocked, model: 'stock', finishReason: 'stop', transport: 'realtime'} : null;
    // A remark is checked against the speaker's recent lines before anything is spoken. One that nearly repeats a recent line is written
    // once more (with those lines named), unless that could not arrive before the remark goes stale; a conversation reply is never checked.
    const making = remark ? addonHost.produce(input, generate, {first})
      : Promise.resolve(first ?? generate(input)).then(reply => ({reply, duplicate: false, retried: false}));
    making.catch(() => {});
    startV();
    const made = await making;
    const reply = made.reply;
    if (made.retried) note(input, {addonRetry: made.duplicate ? 'still-repeated' : 'new-line'});
    // The words are logged (like every spoken line in this log) so a drop can be judged: the line, and what it was taken to repeat.
    if (made.kept) console.error(`[Addons] ${profile.key}: remark ${input.addon?.event ?? '?'} repeats a recent line${made.retried ? ' even after a second try' : ''}; said anyway (repeatOk): "${reply.text}" ~ "${made.similar ?? ''}"`);
    if (made.duplicate) {
      console.error(`[Addons] ${profile.key}: remark dropped (${made.rule ? `it broke a rule: ${made.rule}` : 'it repeated a recent line'}${made.retried ? ', twice' : ''}): "${reply.text}"${made.similar ? ` ~ "${made.similar}"` : ''}`);
      await fail('', 'addon-duplicate');
      return;
    }
    result = voiced ? await synthesizeReply(input, reply, signal, current, profile) : {...reply, ttsEnabled: false};
  }
  if (ahead) { ahead.markReady(); await ahead.waitClaimed(signal); }
  if (!await current()) return;
  // A spoken turn carries the recognised words: a group round hands them to the next speakers (mod/group-chat.lua received).
  if (userText) result = {...result, userText};
  note(input, {resultReadyAt: Date.now(), requestToResultMs: Date.now() - request.receivedAt});
  if (await publishResult(input, profile, result, current, signal)) { published = true; addonHost.afterReply(input, result.text); }
  } finally {
    if (paceToken && !published && addonHost.remarkRefunded(paceToken)) {
      const refusal = reactionLeaseRefusal(input.requestId);
      console.error(`[Addons] ${profile.key}: remark ${input.addon?.event ?? '?'} did not reach the player${refusal ? ` (lease: ${refusal})` : ''}; it does not count towards the local pace`);
    }
  }
}

// ---- Characters the player made (bridge/custom-characters.mjs, docs/CHARACTER_EDITOR.md)
// A turn for one of them. No Convai character exists for it, so it never takes the Convai path (no knowledge route, Convai memory, connection or
// allowance); its text comes from the player's own provider through the main text host (Mistral or the local AI), with its persona from the
// persona book and its memory in the shared memory store, per key, as for a roster character. The game resolves such a character only while
// Mistral or the local AI is answering (mod/custom-characters.lua), so a turn that finds Convai here (the provider changed in between) is
// refused with one plain sentence. Conversation turns only: the game does not ask one for a battle or loot reaction.
function customTurnConfig(input, profile) {
  noteTurn(input);
  const blocks = intrinsicConversationContext.blocks(input);
  return {text: input.text, reaction: input.reaction, context: joinedContext(blocks), contextParts: contextPartsOf(blocks),
    local: {profileKey: input.profileKey, name: profile.name, channel: input.group ? 'group' : 'private'}};
}
// The composer opened for a custom character (a hint with no Convai route): the text route is warmed, and the voice that will speak is prepared.
function warmCustom(profileKey) {
  const profile = profileFor({profileKey}, roster);
  if (!profile || !mistral.active || stopped) return;
  mistralMemory.warmFor(memoryNamespace.keyFor(profileKey));
  if (mistral.route === 'local') void mistralHost.prewarm({local: {profileKey, name: profile.name}});
  else void warmConnection({provider: 'mistral'}).catch(() => {});
  if (localVoice.playbackEnabled === false || !localVoice.usesProfile(profileKey)) return;
  void localVoice.prepareProfile(localVoice.voiceKeyFor(profileKey, profileKey)).catch(() => {});
}
// A text to a character the player made (docs/CHARACTER_EDITOR.md, "Invite and phone"): the same text host and the same context blocks as its talk turns, on the phone channel. With Convai
// answering there is no route for it: the game closes the Chat with its own line, and a message that still arrives is refused with the code the talk path uses.
async function customPhoneReply(options) {
  const profile = profileFor({profileKey: options.profileKey}, roster);
  if (!profile || !mistral.active) throw Object.assign(Error('This character needs Google Gemini, Local AI or Custom to answer.'), {code: 'custom-provider'});
  const input = {...options.input, profileKey: options.profileKey, channel: 'phone'};
  noteTurn(input);
  const blocks = intrinsicConversationContext.blocks(input);
  return await mistralHost.reply({text: input.text, context: joinedContext(blocks), contextParts: contextPartsOf(blocks),
    local: {profileKey: input.profileKey, name: profile.name, channel: 'phone'}}, {signal: options.signal});
}
async function runCustomTurn(request, input, profile, current, clock, {userText = ''} = {}) {
  const {controller} = request, ahead = request.lookahead, signal = controller.signal;
  if (!mistral.active) {
    await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation, entity: input.entity,
      error: `${profile.name} is one of your own characters. They need Google Gemini, Local AI or Custom: choose one under Conversation provider in the settings.`, errorCode: 'custom-provider'}),
    {signal, isCurrent: current, isCurrentSync: current.sync});
    return;
  }
  note(input, {receivedAt: request.receivedAt, preparation: {mode: ahead ? 'lookahead' : 'none'}, reaction: input.reaction?.phase, customRoute: mistral.route});
  if (!ahead) void status('thinking', profile.name).catch(() => {});
  clock.mark('admitted');
  const config = customTurnConfig(input, profile);
  const voiced = localVoice.playbackEnabled !== false && turnUsesLocal(input) && audioAvailable(await readSpeechStateCached());
  throwIfCancelled(signal);
  let result;
  // V's voice for a line typed to this character (docs/V_VOICE.md): started once the text request is under way, like any companion's.
  let vLine = null;
  vVoice.noteGender(input);
  current.vLine = () => vLine;
  const startV = () => { if (!input.reaction && !ahead && !vLine) vLine = vVoice.start(input, {signal, clock, spoken: Boolean(userText)}); };
  if (voiced && !input.reaction && replyStreaming && !ahead) {
    // The first sentence goes to the voice while the rest is still being written, as for any text-provider turn.
    const stream = newReplyStream(config, profile);
    const final = Promise.resolve(mistralHost.reply(config, {signal, stream, deferRecord: deferExchange(input)})).then(reply => ({...reply, transport: 'realtime'}));
    final.catch(() => {});
    startV();
    result = await voiceStreamedReply(input, profile, {signal, current, stream, final, config, userText: () => userText});
  } else {
    const making = Promise.resolve(mistralHost.reply(config, {signal, deferRecord: deferExchange(input)})).then(reply => ({...reply, transport: 'realtime'}));
    making.catch(() => {});
    startV();
    const reply = await making;
    result = voiced ? await synthesizeReply(input, reply, signal, current, profile) : {...reply, ttsEnabled: false};
  }
  if (ahead) { ahead.markReady(); await ahead.waitClaimed(signal); }
  if (!await current()) return;
  // A spoken turn carries the recognised words: a group round hands them to the next speakers (mod/group-chat.lua received).
  if (userText) result = {...result, userText};
  await measure(input, {resultReadyAt: Date.now(), requestToResultMs: Date.now() - request.receivedAt});
  await publishResult(input, profile, result, current, signal);
}

async function runInput(request, prepared, clock) {
  let input = request.input;
  const {controller} = request;
  // A conversation turn: the frame buffer stops capturing (the view is on the companion now); the turn takes a buffered frame.
  companionVision.beginTurn(input);
  // A group speaker starts: the next speakers' pages get their picture now (a turn with no composer would publish it too late). Not awaited, and the turn waits for nothing.
  companionVision.stageForNext(nextSpeakerPages(input));
  // A scripted line prepares no live voice: its audio is a file (runScriptedTurn).
  if (input.reaction?.kind !== 'scripted') warmTalkTargets([input.profileKey], {persona: false});
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
    // A reaction held for the game to submit (a prepared follow-on or after-scene line) has no lease yet: the lease is the game's word that it is playing
    // the request it submitted, and it writes it with that submission. Held, such a turn only has to be wanted by its owner; once claimed the lease governs.
    return await request.owner.current() && (ahead?.isHeld() === true || await reactionCurrent(input))
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
    // A scripted quest line (docs/QUEST_PRIMITIVES.md section 4): the pack's own words and audio, no profile/knowledge/Convai step, no model, no allowance.
    if (input.reaction?.kind === 'scripted') { await runScriptedTurn(request, input, current, clock); return; }
    const profile = profileFor(input, roster);
    // A character the player made answers through the player's text provider, and never takes the Convai path either (docs/CHARACTER_EDITOR.md).
    if (profile && customCharacters.has(profile.key)) { await runCustomTurn(request, input, profile, current, clock); return; }
    // An add-on speaker never takes the Convai path below (no knowledge route, no Convai memory or connection, no allowance).
    if (profile && addonHost.isSpeaker(profile.key)) { await runAddonTurn(request, input, profile, current, clock); return; }
    if (!profile || !ids[profile.key]) {
      await status('unmatched-npc', `No verified profile for ${input.name} (${input.bodyType})`);
      await atomic(replyPath, JSON.stringify({...input, text: undefined,
        error: `${input.name} does not have a conversation profile configured yet.`}), {signal: controller.signal, isCurrent: current, isCurrentSync: current.sync});
      return;
    }
    // V's voice for typed lines (docs/V_VOICE.md) starts here, the moment the turn is known to be for a real companion: it needs only the typed
    // text, so its voice request goes out beside everything below (knowledge, memory admission, the transport hand-over, the model request)
    // instead of after them. It is a request of its own on its own renderer page, so it never stands in front of the reply: the reply's
    // audio waits only while V is audible and V is dropped when it is not audible in time.
    vVoice.noteGender(input);
    let vLine = null;
    current.vLine = () => vLine;
    if (!ahead) vLine = vVoice.start(input, {signal: controller.signal, clock});
    const prepareStarted = performance.now();
    knowledgeTurn = await knowledgeRouter.prepare(input, {worldToken: worldSession?.token, generation: worldSession?.generation});
    const preparedAt = performance.now();
    stages.knowledgePreparedMs = preparedAt - preparationStarted;
    // A knowledge stage over a second (two installs: 3.3 to 3.8 s on every turn) also records how long each part took, in the turn's record for the slow-turn report. Nothing is done below the limit.
    if (stages.knowledgePreparedMs > KNOWLEDGE_PARTS_MS) {
      try {
        clock.annotate({knowledgeParts: knowledgeParts({...knowledgeTurn.timings, totalMs: stages.knowledgePreparedMs, cancelMicrophoneMs: stages.cancelMicrophoneMs,
          beforePrepareMs: prepareStarted - preparationStarted - (stages.cancelMicrophoneMs ?? 0), prepareMs: preparedAt - prepareStarted})});
      } catch { /* the report is never worth a turn */ }
    }
    clock.mark('knowledge');
    input = knowledgeTurn.input; request.input = input; preparedInputs.set(input, knowledgeTurn);
    // A turn the admission refuses ends here without a reply: its reason goes to the log, or the turn would vanish without a trace.
    if (!knowledgeTurn.sendAllowed) console.error(`[Turn] ${profile.key} was not sent: ${knowledgeTurn.memoryReason ?? 'unavailable'}`);
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
    if (!ahead) void status('thinking', profile.name, {requestId: input.requestId, provider: mistral.active ? mistral.route : 'convai'}).catch(() => {});
    // A fresh read, not the cached copy: the copy can be about a second old, and a heartbeat that was due just then would read as
    // stale and skip the connection hand-over (the group look-ahead tests caught it).
    const canWarm = await audioReady(runtime);
    throwIfCancelled(controller.signal);
    // How warm this turn's page already was (opened at the talk key, the composer, a look or a partner).
    const turnRoute = realtimeConfig(input), connectionWarm = connections.warmState(input, turnRoute);
    // The speaker being heard already holds this round's group connections.
    if (canWarm && !ahead) await connections.setRequest(input, turnRoute);
    if (canWarm && !ahead && keys.singleSession && input.group?.index === 1 && groupLookaheadAllowed()) void warmRoundAhead(input, controller.signal);
    throwIfCancelled(controller.signal);
    // A reply the local renderer will voice (Pocket, Voxtral, OmniVoice): its page and a silent output device open now, while the model thinks,
    // instead of after the first sentence (0.15 to 0.75 s under the game in the live records). Not awaited; does nothing while the
    // renderer is busy with another reply.
    if (!ahead && canWarm && localVoice.playbackEnabled !== false && ['pocket', 'omni'].includes(turnVoice(input).engine)
      && (await readSpeechStateCached()).continuousAvailable === true) void realtime.standbyLocal?.()?.catch(() => {});
    clock.mark('transport');
    note(input, {transportRequestedAt: Date.now(), connectionWarm,
      submissionStages: {...stages, beforeTransportMs: performance.now() - preparationStarted}});
    const replying = respond(input, profile, {signal: controller.signal, prepared, current});
    const result = await replying;
    // The reply is complete: a reaction offer nobody took gets its one log line (a Convai action may still arrive for a few seconds).
    companionActions.endTurn(input);
    // Ready but not yet submitted by the game: hold until it is, or cancelled.
    // (Continuous speech already waited for this inside its own admission.)
    if (ahead) { ahead.markReady(); await ahead.waitClaimed(controller.signal); }
    // Do not show a late reply to a different target or a newer turn.
    if (!await current()) return;
    if (!result.liveDelivery?.generated) {
      await knowledgeRouter.activity(knowledgeTurn, 'generated-reply', {replyText: result.text});
      stagedKnowledgeTurn(knowledgeTurn, {replyText: result.text});
    }
    // Not awaited: a reply published as a whole (OmniVoice) goes to the game without waiting for the record's file write.
    note(input, {resultReadyAt: Date.now(), requestToResultMs: Date.now() - request.receivedAt});
    await publishResult(input, profile, result, current, controller.signal);
  } catch (error) {
    // A look-ahead that fails before the game submits it publishes nothing;
    // the submitted turn then runs as an ordinary request.
    if (ahead?.isHeld()) { lookahead.fail(ahead); console.error('[CyberpunkConvai] Look-ahead turn failed:', error.message); return; }
    if (companionActions.pending?.packet.requestId === input?.requestId) void companionActions.revoke();
    if (!await current()) return;
    await status('error', error.message, input ? {requestId: input.requestId} : null).catch(() => {});
    if (input) await atomic(replyPath, JSON.stringify({requestId: input.requestId,
      generation: input.generation, entity: input.entity,
      error: 'The conversation service could not reply. Please try again.', ...turnFailure(error, input)}), {signal: controller.signal, isCurrent: current, isCurrentSync: current.sync}).catch(() => {});
    console.error('[CyberpunkConvai] Bridge request failed:', error.message);
    // An automatic reaction that failed is a turn too; one cancelled by the player is not (reportableTurnFailure).
    if (input && !controller.signal.aborted) noteTurnFailure(error, input);
  } finally {
    if (knowledgeTurn && (controller.signal.aborted || !await current())) await cancelKnowledgeTurn(knowledgeTurn);
    if (active === request) active = null;
  }
}

// ---- Scripted quest lines (docs/QUEST_PRIMITIVES.md section 4, bridge/quest-lines.mjs)
// The game asks for a line of a story pack with a private turn of the speaking character (reaction kind 'scripted'). The words and the audio file come from the pack
// (bondPacks.lineFor), never from the request. No model, no knowledge route, no Convai memory or connection and no allowance belong to the turn, as for a stocked add-on line.
// With an audio file the line is played by the prepared voice (synthesizePrepared) whatever voice the player chose. With none it is shown, and the missing file is a pack
// error in the log. A line whose file is missing (or cannot be decoded) is NEVER spoken by a live voice, in Developer mode too (owner decision of 29 Oct 2026): the reply
// carries `missingAudio: true` for the game, which shows the subtitle and adds a Phone Chat line.
// Ogg, FLAC and MP3 files are decoded by bridge/prepared-audio.mjs (ffmpeg, else the Runtime Python); its decoded-sample cache lives in the state folder and is bounded.
const scriptedLogged = new Set();
// One ERROR line per pack and line (the pack id and the line id are in it), however often the line is asked for.
const scriptedPackError = (input, message) => {
  const key = `${input.reaction.pack}/${input.reaction.line}`;
  if (scriptedLogged.has(key)) return;
  scriptedLogged.add(key);
  if (scriptedLogged.size > 256) scriptedLogged.delete(scriptedLogged.values().next().value);
  console.error(`[QuestLines] ERROR pack=${input.reaction.pack} line=${input.reaction.line}: ${message}`);
};
// A published line is her own words from now on: a synthetic exchange in the local store of the text providers (Mistral, Local AI, Custom) with a bracketed note for V's side
// (an exchange needs both sides) and the extractor skipped (reaction). Convai learns from real turns only (docs/BOND_QUESTS.md 14.6), so nothing is written on that provider.
function rememberScripted(input, text) {
  if (!mistral.active || memoryQuiescing) return;
  try { mistralMemory.record({profileKey: memoryNamespace.keyFor(input.profileKey), channel: 'private', v: '[a scripted moment of the story you share with V]', r: text, reaction: true}); }
  catch (error) { console.error('[QuestLines] memory not recorded:', error?.message); }
}
async function runScriptedTurn(request, input, current, clock) {
  const {controller} = request, signal = controller.signal;
  const profile = profileFor(input, roster);
  const fail = (error, errorCode) => atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation, entity: input.entity,
    error, errorCode}), {signal, isCurrent: current, isCurrentSync: current.sync});
  note(input, {receivedAt: request.receivedAt, preparation: {mode: 'none'}, reaction: 'scripted'});
  if (!profile) { scriptedPackError(input, 'the speaker is not in the roster'); await fail('', 'scripted-line'); return; }
  void status('thinking', profile.name, {requestId: input.requestId}).catch(() => {});
  clock.mark('admitted');
  const {pack, line} = input.reaction;
  const resolved = bondPacks.lineFor?.(pack, line) ?? null;
  // A line the pack does not have (or a pack that is not active), or one of another character's: an error code, never a model call.
  const speaker = typeof resolved?.speaker === 'string' && roster.some(row => row.key === resolved.speaker) ? resolved.speaker : null;
  const reply = speaker && speaker !== input.profileKey ? null : scriptedResult(resolved);
  if (!reply) { scriptedPackError(input, 'the pack has no such line, the pack is not running, or the line belongs to another character'); await fail('', 'scripted-line'); return; }
  if (reply.missingAudio) scriptedPackError(input, 'the line has no prepared audio file, it is shown as a subtitle and is not spoken');
  throwIfCancelled(signal);
  let result;
  const route = scriptedRoute(reply, {playbackEnabled: localVoice.playbackEnabled !== false});
  // The renderer's page and a silent output device open now, beside the file being read, so the first sound waits for neither (as for any local voice, runInput). Not awaited.
  if (route === 'prepared') void Promise.resolve(readSpeechStateCached()).then(state => state.continuousAvailable === true ? realtime.standbyLocal?.() : null).catch(() => {});
  if (route === 'prepared') result = await synthesizeReply(input, reply, signal, current, profile);
  else { const {audioPath: _file, ...written} = reply; result = {...written, ttsEnabled: false}; }
  if (!await current()) return;
  note(input, {resultReadyAt: Date.now(), requestToResultMs: Date.now() - request.receivedAt});
  if (await publishResult(input, profile, result, current, signal)) rememberScripted(input, result.text);
}
// The prepared voice's delivery (the tail of synthesizeReplyBody, with the audio read from the pack's file): the same renderer, lease, face model and subtitles as a live
// reply. A file that cannot be read, decoded or played is never handed to a live voice: the line is written (a pack error in the log, `missingAudio: true` in the reply for the game) and no notice is raised.
async function synthesizePrepared(input, result, signal, current, profile) {
  const {audioPath, ...written} = result;
  const textOnly = {...written, audio: undefined, faces: [], captions: [], timing: {...written.timing, voiceProvider: 'none'}};
  if ((await readSpeechStateCached()).continuousAvailable !== true) {
    console.error(`[QuestLines] ${input.reaction.pack}/${input.reaction.line}: local streaming is unavailable, the line is written only`);
    return {...textOnly, missingAudio: true};
  }
  let pcm;
  try { pcm = await preparedAudio.decode(await readPreparedFile(audioPath)); }
  catch (error) { scriptedPackError(input, `${error.message}, the line is shown as a subtitle and is not spoken`); return {...textOnly, missingAudio: true}; }
  throwIfCancelled(signal);
  markStage('voiceStart');
  // The face: the line's own feeling when the pack names one (an ordered emotion), else what the words say. The prepared line is no answer to V's words.
  const who = personKey(input), plan = emotionSelection.plan({player: '', reply: result.text, profile: input.profileKey, who, convai: result.expressionSignal, breaks: []});
  let spoken = {...written};
  if (spoken.expressionSignal === undefined) { const cue = plan && plan.summary?.basis !== 'calm' ? planSignal(plan) : undefined; if (cue !== undefined) spoken.expressionSignal = cue; }
  if (plan) spoken.expressionPlan = plan;
  emotionSelection.remember(who, plan);
  console.error(`[QuestLines] ${input.reaction.pack}/${input.reaction.line}: ${input.profileKey} speaks from its prepared audio (${(pcm.length / 24000).toFixed(1)} s)`);
  const speech = continuousSpeech(input, profile, current, signal, undefined, true, undefined, {player: '', engine: 'prepared'});
  return deliverPocketSpeech({input, profile, result: spoken, current, signal, voice: createPreparedVoice({load: async () => pcm}), host: realtime, speech,
    phoneAnalysis: localVoice.phoneAnalysis, jaliFace, onAnalysis: timing => measure(input, {localLipAnalysis: timing})});
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
      if (!hint) {
        companionVision.closeComposer(); await connections.setComposer(null);
        // The composer of an add-on's voice (a cab, a gun) opens no connection, but V's typed line to it is spoken: warm V's voice page.
        try { if (JSON.parse(hintRaw)?.voiceOnly === true) vVoice.warmUp(); } catch { /* an unreadable hint warms nothing */ }
        // A character the player made has no Convai route to open: the text provider's connection (or the local AI's prompt) and its voice are warmed instead.
        try {
          const unread = JSON.parse(hintRaw);
          if (unread?.group === false && Array.isArray(unread.audience) && unread.audience.length === 1 && customCharacters.has(unread.audience[0])) warmCustom(unread.audience[0]);
        } catch { /* an unreadable hint warms nothing */ }
      }
      else if (await audioReady(runtime)) {
        if (mic.current || micPolling || stopped) { prewarmObserved = ''; return; }
        // A private hint for an ambient NPC carries its entity: open that NPC's own route now, while V types.
        const config = hint.scope === 'private' && hint.entity ? ambientWarmConfig(hint.audience[0], hint.entity) : null;
        vVoice.warmUp();
        warmTalkTargets(hint.audience);
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
//
// Two more kinds of command use the same file and the same hold-and-claim (bridge/group-lookahead.mjs, PREPARED_KINDS): Johnny's remark on a line that
// is still playing ({kind: 'follow', sourceRequestId, input}) and a companion's after-scene line ({kind: 'ahead', input}). They differ from a group
// speaker in three ways: the text providers may prepare them (as background-priority work, see realtimeConfig and bridge/text-provider-host.mjs), they are never allowed to stand in
// front of V (V opening the text box or the voice key, a recording, or any request of V's drops them at once), and they are held for 90 s at most.
let lookaheadPolling = false, lookaheadWaiting = {raw: '', at: 0}, lookaheadHandled = '';
// The prediction file is read when it changed (one stat tells), not on every 60 ms poll.
const readPrefetch = createStatCachedReader({stat, read: path => readFile(path, 'utf8')});
// V is about to talk, is typing or is recording: a line prepared ahead gives way. A recording that is only finishing the source's own turn does not count.
// The composer hint (runtime/conversation-prewarm.json: the talk key was pressed, whom V is about to talk to) is read here itself: pollPrefetch applies it to the
// connections only while no turn is active, and a companion's line is exactly such a turn. A hint it has already applied is old news (the game leaves the hint of
// V's last typed line in the file): only one that is new since then is V talking now. Read only while a prepared line is being decided or is held.
async function vEngaged(sourceRequestId) {
  if (connections.composer) return true;
  if (mic.current && !(mic.current.finishing && sourceRequestId !== undefined && mic.current.requestId === sourceRequestId)) return true;
  const raw = await readFile(prewarmPath, 'utf8').catch(() => '');
  if (raw === prewarmObserved) return false;
  try { return !!parsePrewarm(JSON.parse(raw), ids); } catch { return false; }
}
async function pollLookahead() {
  if (lookaheadPolling || stopped || memoryQuiescing || voiceRouteReservation || relationshipRouteReservation) return;
  // Nothing is allowed on this key and plan (a player's free Convai key): the file is not even read, as before.
  if (!lookaheadAllowedFor('group') && !lookaheadAllowedFor('follow')) { if (lookahead.entry) lookahead.cancel(); return; }
  lookaheadPolling = true;
  try {
    lookahead.prune();
    const held = lookahead.entry;
    if (held && held.kind !== 'group') {
      // A held prepared line is dropped when V engages, when the plan or provider no longer allows it, or when its source turn is gone.
      if (await vEngaged(held.sourceRequestId) || !lookaheadAllowedFor(held.kind)) lookahead.cancel();
      else {
        await lookahead.watchSource(async entry => {
          const source = lookahead.source;
          if (source?.input.requestId !== entry.sourceRequestId || source.signal?.aborted === true) return true;
          // A speak-up whose lease the game withdrew is cancelled even when nothing aborted its controller: tick() aborts only the turn that is still
          // active, and a turn that stopped by itself first ("Continuous speech owner changed") has left `active` already. Only a lease that is
          // read and bad counts (reactionCurrent answers null for a file it could not read), and watchSource's grace still applies.
          return source.input.reaction ? await reactionCurrent(source.input) === false : false;
        });
      }
    }
    const raw = await readPrefetch(prefetchPath);
    if (raw === prefetchObserved || raw === lookaheadHandled) return;
    let command;
    try { command = JSON.parse(raw); } catch { prefetchObserved = raw; dropPrefetch(); return; }
    // `{}` withdraws the prediction: audience change, an undelivered or
    // interrupted speaker, a new message or a dismissal.
    if (!command?.input) { prefetchObserved = raw; lookaheadHandled = ''; dropPrefetch(); return; }
    const kind = lookaheadKind(command);
    if (kind === null) { prefetchObserved = raw; dropPrefetch(); return; }
    // Not allowed on this provider or plan: the command is passed over (once; it would only be read again on every poll), the game's own submission runs as usual.
    // A group prediction on a Convai plan that may allow it later (the paid plan is read a moment after the start) is looked at again; everything else is not.
    if (!lookaheadAllowedFor(kind)) { if (kind !== 'group' || textProviderChosen()) lookaheadHandled = raw; return; }
    const source = lookahead.source;
    if (kind !== 'ahead' && (!source || source.input.requestId !== command.sourceRequestId)) {
      // The source reply is recorded just before the game can see it complete;
      // allow a late arrival a moment before giving up on this prediction.
      if (lookaheadWaiting.raw !== raw) lookaheadWaiting = {raw, at: Date.now()};
      if (Date.now() - lookaheadWaiting.at < 1500) return;
    }
    prefetchObserved = raw;
    const predicted = kind === 'group' ? validateLookahead(command, source) : kind === 'follow' ? validateFollow(command, source) : validateAhead(command);
    // A recording microphone owns the device; the first speaker's own reply
    // phase (which this prediction follows) does not.
    const micAllows = !mic.current || (mic.current.finishing && mic.current.requestId === source?.input.requestId);
    if (!predicted || !micAllows || !Object.hasOwn(ids, predicted.profileKey) || !profileFor(predicted, roster)
        || (kind !== 'ahead' && !await source.current()) || !await audioReady(runtime) || stopped) {
      dropPrefetch(); return;
    }
    lookaheadHandled = raw;
    if (kind === 'group') { lookahead.offer(predicted); return; }
    // A prepared line is not started while V is engaged, nor for a request the game has already submitted: the command is dropped for good.
    if (await vEngaged(command.sourceRequestId) || submittedRequests.has(predicted.requestId)) { dropPrefetch(); return; }
    lookahead.offer(predicted, {kind, sourceRequestId: command.sourceRequestId, maxHoldMs: Number(process.env.CYBERPUNK_CONVAI_TEST_PREPARED_HOLD_MS) || PREPARED_HOLD_MS});
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
    await vendorMemory.remember({memoryKey: key, profileKey: prepared.route.profileKey, scope: vendorScope(prepared),
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
    const lapse = {};
    let session = await readWorldSession(resolve(runtime, 'world-session.json'), {held: worldSession?.ready === true, lapse});
    const priorWorld = worldSession?.ready ? JSON.stringify([worldSession.token, worldSession.generation]) : null;
    // A game that stalls stops rewriting its heartbeat; the file still names the world we follow, only late. That is not a world change: no route is reset and no
    // turn cancelled for it. Every ordinary check still refuses the late world (the 5 s lease), so nothing new starts on it until the game writes again.
    // A save is loading (the game's lease says so before the world exists): V's helper voice may start (helperHolds).
    if (session?.loading === true && !loadBegun && !titleHoldOver) { loadBegun = true; timeline('a save is loading'); console.error("[VHelper] a save is loading: V's helper voice may load now"); localVoice.tickVHelper(); }
    if (!session) session = lateWorld(lapse.value, worldSession);
    worldSession = session;
    const nextWorld = worldSession?.ready ? JSON.stringify([worldSession.token, worldSession.generation]) : null;
    // The first world ends the title screen's hold on V's helper voice: it loads now (nothing else asks it to between two V lines).
    if (nextWorld && endTitle('the game has a world')) { console.error("[VHelper] the game has a world: V's helper voice may load now"); localVoice.tickVHelper(); }
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
      worldGeneration: worldSession?.generation, currentWorld: !!nextWorld && worldBoundary(worldSession) !== null}));
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
// every browser renderer through its control (the game no longer reads
// runtime/audio-delay.json, the file is still written for diagnostics).
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
    sessions.clear(); realtimeSessions.clear(); sceneryMemory.clear(); gearMemory.clear();
    await phone.forgetSessions().catch(() => {});
    console.error(`[CyberpunkConvai] Conversation key: ${own ? "the player's own" : "the installation's"}`);
    rewarmLocalVoice();
    await ownKeyControl.publishStatus().catch(() => {});
  } finally { keySwitching = false; }
}
// The conversation provider in use changes here, and only when nothing is running (same boundary as the Convai key): Convai
// sessions belong to the provider that opened them, so they are retired together. The transcript is kept.
let providerSwitching = false;
// The switch has two parts. The LIGHT part makes the new provider the one that answers turns (`mistral.apply()`), starts what it needs and drops predictions
// made for the old one: it closes nothing, so it can be made at once for a turn that must not go to the old provider. The HEAVY part retires what belonged to
// the old provider (Convai pages and sessions, the memory embedder) and runs only at an idle boundary, with the same test as the Convai key's switch.
let providerTeardownDue = false;
function lightApplyProvider() {
  mistral.apply();
  providerTeardownDue = true;
  // The cloud provider's connection (DNS, TCP, TLS) opens now, not in front of the first turn (docs/LATENCY_2026-10-13.md, 4.5/4.7).
  if (mistral.active && (mistral.route === 'mistral' || mistral.route === 'custom' || mistral.route === 'gemini')) void warmTurnConnections({provider: mistral.route});
  dropPrefetch(); prefetchObserved = '';
  console.error(`[CyberpunkConvai] Conversation provider: ${mistral.applied}`);
  // Local AI is chosen and down: its turns stay here (never Mistral or Convai) and say why.
  if (mistral.localDown) logLocalDown();
  // What the custom provider is set to, for a support report: the host and the model id (never the address's path, a query or the key).
  if (mistral.applied === 'custom') console.error(`[Custom] host ${customEndpoint.host}, model ${customEndpoint.model}, key ${customEndpoint.key ? 'saved' : 'none'}`);
  if (mistral.applied === 'gemini') console.error(`[Gemini] host ${geminiEndpoint.host}, model ${geminiEndpoint.model}, key ${geminiEndpoint.key ? 'saved' : 'none'}`);
  // Leaving the local AI gives its graphics memory back at once; arriving loads it (a first start compiles shaders for a while).
  if (mistral.applied === 'local') void localServer.ensure({background: true}).catch(() => {});
  else void localServer.stop().catch(() => {});
  void mistralControl.publishStatus().catch(() => {});
}
async function finishProviderSwitch() {
  providerTeardownDue = false;
  await Promise.allSettled([realtime.close(), phoneRealtime.close()]);
  sessions.clear(); realtimeSessions.clear(); sceneryMemory.clear(); gearMemory.clear();
  await phone.forgetSessions().catch(() => {});
  rewarmLocalVoice();
  // Back to Convai: the memory search's embedding process (CPU) is not needed either, and goes now instead of after its five idle minutes.
  // Add-on speakers answer through the text routes whatever the provider is, so with an add-on installed it stays on its idle timer.
  if (!mistral.active && !addonHost.hasSpeakers) void localEmbedder.close().catch(() => {});
  await mistralControl.publishStatus().catch(() => {});
}
// `ownTurn`: called for the turn the request poll is about to start (see providerForTurn).
async function applyProviderChoice({ownTurn = false, ownMic = false} = {}) {
  if (providerSwitching || stopped || !(mistral.pending || providerTeardownDue) || voiceBoundaryBusy({ownTurn, ownMic}) || voiceRouteReservation) return;
  providerSwitching = true;
  try {
    if (mistral.pending) lightApplyProvider();
    await finishProviderSwitch();
  } finally { providerSwitching = false; }
}
// The Conversation provider in the request the game has just written (mod/init.lua sendRequest) is the player's choice at that moment. The settings poll
// (every 500 ms) may not have read it yet, so a line sent right after picking Local AI would be answered by the provider in use before. So for a turn
// the request poll starts (never a look-ahead turn): the preference follows the request; the whole switch is made if nothing else is running; and when
// something else is (the microphone, Phone Chat, memory saving, a look-ahead, a voice change being applied) a switch TO Local AI is still made lightly,
// so that this turn never goes to the cloud, and its teardown waits for the settings poll's idle boundary. No file is read. Never throws.
async function providerForTurn(input, {mic = false} = {}) {
  try {
    const wanted = input?.provider;
    if (stopped || !PROVIDERS.includes(wanted)) return;
    // A switch the settings poll has already started finishes first: its teardown closes the pages and sessions this turn would use.
    for (let waited = 0; providerSwitching && waited < 3000; waited += 20) await new Promise(done => setTimeout(done, 20));
    if (wanted !== mistral.preference) await adoptProviderSetting({conversationProvider: wanted});
    if (!mistral.pending) return;
    await applyProviderChoice({ownTurn: true, ownMic: mic});
    // The whole switch had to wait (or was still running after the wait): a line for Local AI must still not go to the old provider.
    if (mistral.pending && mistral.requested === 'local') lightApplyProvider();
  } catch (error) { pollLog('[CyberpunkConvai] Provider for the turn:', error); }
}
// Resources the current settings do not use are released (docs/RESOURCE_LIFECYCLE.md). Due-checked from the 500 ms settings poll: a few property
// reads, nothing per frame, never while a turn, microphone or preparation is running (the page releases wait for the next poll).
//   - The facial model's worker thread leaves at once when voice playback is turned Off (V speaks no face) and comes back
//     at the first poll after playback is turned on.
//   - V's line renderer page closes when V's voice is off (or has no clips), and with the companions' page when playback is Off.
//   - The hidden browser closes when nothing uses it for BROWSER_IDLE_MS: no Convai page in the pool or kept for the party, no
//     recording, no renderer turn, and (text provider with playback on) no wish to keep the local voice's renderer warm.
const BROWSER_IDLE_MS = 300_000;
// The phone Chat host (a second hidden Edge, Convai only) keeps a conversation page for every contact V wrote to. A page nobody used for this long is closed, and the
// host's browser with the last one (the close is confirmed before the next look); the next message to that contact opens a page again (a Chat that is open keeps its
// page alive, bridge/phone-warm.mjs keepAlive, so the cold start is hidden while V types).
let releasingUnused = false;
async function releaseUnused() {
  if (releasingUnused || stopped) return;
  releasingUnused = true;
  try {
    const muted = localVoice.silent;
    if (jaliFace) { if (muted) await jaliFace.suspend(); else if (!jaliFace.active) void jaliFace.resume(); }
    // A story pack that stopped running takes its music and sounds with it, and the media page closes after a quiet half minute.
    await mediaLink.reconcile().catch(() => {});
    await realtime.releaseMediaIfIdle({idleMs: MEDIA_IDLE_MS}).catch(() => {});
    if (voiceBoundaryBusy() || voiceRouteReservation || keySwitching || providerSwitching) return;
    await realtime.releaseRendererPages({line: !vVoice.active || !vVoice.available, companion: muted});
    const keepRenderer = mistral.active && localVoice.playbackEnabled !== false;
    await realtime.releaseIfIdle({idleMs: BROWSER_IDLE_MS, keepRenderer});
    await phoneRealtime.releaseIfIdle({idleMs: BROWSER_IDLE_MS});
    const phoneReleased = await phoneRealtime.releaseIdlePages({idleMs: PHONE_HOST_IDLE_MS});
    if (phoneReleased.pages || phoneReleased.browser) console.error(`[Resource] phone chat host: ${phoneReleased.pages} idle page(s) closed after ${PHONE_HOST_IDLE_MS / 1000} s${phoneReleased.browser ? ', the hidden browser closed' : ''}`);
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
// The id of the model Local AI actually loaded (it can differ from the chosen one: a model that does not fit is replaced), for the model row, or null while none is loaded.
const localModelInUse = () => { try { return localServer.status().state === 'ready' ? localServer.modelId ?? null : null; } catch { return null; } };
const localModelDefaults = () => defaultModelIds({models: listLocalModels({pack: localPack, matureModels: maturePackModels, customModels: customScan.models}),
  matureOn: matureContent.enabled, freeMiB: localServer.lastFreeMiB ?? localServer.totalVramMiB ?? cardTotalMiB, totalMiB: localServer.totalVramMiB ?? cardTotalMiB, sizeOf: localModelSizeMiB});
// Models a pack's marker names whose file is not there (a zip that was not fully extracted): they are not in the list, and with only Mature models left and
// Mature content off Local AI cannot start, so the model row says which model is missing (docs/LOCAL_AI.md, "When a local turn fails"). A few stat calls at
// most every 5 s, and one log line when the answer changes.
let packIssues = [], packIssuesAt = 0, packIssuesKey = '';
function packFileIssues() {
  if (Date.now() - packIssuesAt < 5000) return packIssues;
  packIssuesAt = Date.now();
  try {
    packIssues = packFileProblems(describePackFiles({project}));
    const key = JSON.stringify(packIssues);
    if (key !== packIssuesKey) {
      packIssuesKey = key;
      if (packIssues.length) console.error('[LocalAI] the Local AI folder is incomplete: ' + packIssues.map(item => item.name).join(', ') + ' (named by a manifest, the model file is not there; a pack that was not fully extracted)');
    }
  } catch { packIssues = []; }
  return packIssues;
}
const customModelProblems = () => [...customScan.problems.map(({name, reason}) => ({name: String(name).slice(0, 60), reason})), ...packFileIssues()].slice(0, 8);
// The card's total memory marks a custom model that can never fit, and stands in for the free memory in the model the page shows as
// selected. The first start reads it from llama-server; before that one nvidia-smi call (once a minute at most, and only while more than
// one model is installed) stands in.
async function learnCardTotal() {
  if (localServer.totalVramMiB || cardTotalMiB || installedLocalModels().length < 2 || Date.now() - cardAskedAt < 60000) return;
  cardAskedAt = Date.now();
  cardTotalMiB = await nvidiaTotalMiB().catch(() => null);
}
let localModelChoiceKey = null, localModelListKey = '', localModelListCheckedAt = 0;
// Local AI failures a changed model choice (or Mature setting) may cure: tried again when the choice changes (syncLocalModelChoice).
const RETRY_ON_CHOICE = new Set(['low-memory', 'start-failed', 'crashed']);
// The poll calls this before it applies the saved provider (and reads Mature content just before): the first Local AI start takes the model
// choice and Mature content when it begins, and nothing reloads it afterwards (the first sync only records the choice). Cheap: no file, no process.
function syncLocalModelChoice(settings) {
  if (!settings || typeof settings !== 'object') return;   // a partial settings write: keep what is chosen
  const pin = normalisePin(settings.localModel);
  if (pin !== localModelPin) { localModelPin = pin; localModelFallbackNoted = ''; console.error(`[LocalAI] model choice is now ${pin}`); }
  if ((settings.localOffload === true) !== localOffloadAllowed) { localOffloadAllowed = settings.localOffload === true; offloadKeptNoted.clear(); console.error(`[LocalAI] partial offload to RAM is now ${localOffloadAllowed ? 'allowed' : 'not allowed'}`); }
  const choiceKey = `${localModelPin}|${localOffloadAllowed}|${matureContent.enabled}|${matureContent.pack}`;
  if (choiceKey !== localModelChoiceKey) {
    const first = localModelChoiceKey === null;
    localModelChoiceKey = choiceKey;
    if (!first && mistral.applied === 'local') void localServer.reselect().catch(() => {});
    // A Mature-only install could not start Local AI while Mature content was off ('mature-off'); turning it on lifts that: try again.
    if (!first && matureContent.enabled && mistral.clearLocalFailure('mature-off')) prepareLocal();
    // A start that failed for want of graphics memory, or did not start or crashed, may work with another model: the player was told to pick a
    // smaller one ('local-no-memory'), so the new choice is tried at once instead of the failure standing until another provider is chosen.
    else if (!first && RETRY_ON_CHOICE.has(mistral.localBroken) && mistral.clearLocalFailure(mistral.localBroken)) prepareLocal();
  }
}
// The pack, or a model of the player's own, can appear while the game runs (the pack extracted after choosing Local, a model added to the
// manifest). A start that was refused for what was missing is tried again at once, instead of staying on Convai until the player picks
// another provider and then Local again. Looked at with the 5 s refresh below: property reads, no file and no process unless it retries.
function retryLocalAfterInstall() {
  const why = mistral.localBroken;
  if (mistral.preference !== 'local' || (why !== 'not-installed' && why !== 'mature-off')) return;
  const lifted = why === 'not-installed' ? localAiUsable(localPack)
    : !matureOffBlocks(listLocalModels({pack: localPack, matureModels: maturePackModels, customModels: customScan.models}), matureContent.enabled);
  if (lifted && mistral.clearLocalFailure(why)) {
    console.error(`[LocalAI] ${why === 'not-installed' ? 'a model was installed' : 'a model that needs no Mature content was installed'}: starting the local model`);
    prepareLocal();
  }
}
// The installed models and the defaults for the settings page, after the provider is applied so the card probe never holds a start back.
async function publishLocalModelList() {
  if (Date.now() - localModelListCheckedAt >= 5000) {
    localModelListCheckedAt = Date.now();
    refreshLocalPack();
    scanCustomModels();
    retryLocalAfterInstall();
    await learnCardTotal();
    const listKey = JSON.stringify([installedLocalModels(), localModelDefaults(), customModelProblems(), localModelInUse()]);
    if (listKey !== localModelListKey) { localModelListKey = listKey; await mistralControl.publishStatus().catch(() => {}); }
  }
}
// The Conversation provider setting, as the settings poll reads it from settings.json and as a request carries it (providerForTurn): the preference follows
// it. Returns whether the preference changed.
async function adoptProviderSetting(settings) {
  if (!settings) return false;
  // Choosing the custom provider reads its file again first: a player may have written the address by hand while the game ran.
  if (settings.conversationProvider === 'custom' && mistral.preference !== 'custom') await customEndpoint.load().catch(() => {});
  if (settings.conversationProvider === 'gemini' && mistral.preference !== 'gemini') await geminiEndpoint.load().catch(() => {});
  if (!mistral.setPreference(settings.conversationProvider)) return false;
  // Said once per change, so a setting that did not take effect (Mistral without a key answers with Convai) shows in the log.
  console.error(`[CyberpunkConvai] Conversation provider setting: ${mistral.preference}${mistral.fallbackReason ? ` (${mistral.fallbackReason === 'mistral-no-key' ? 'no Mistral key is saved' : mistral.fallbackReason === 'gemini-no-key' ? 'no Google Gemini key is saved' : 'the custom provider has no address or model ID'}, so Convai answers)` : ''}`);
  if (mistral.preference === 'local') prepareLocal();
  // Choosing another provider unloads the local model at once when it is not answering turns (it was loaded ahead by prepareLocal and
  // never applied, or the player changed their mind); when it is answering, applyProviderChoice unloads it at the next idle boundary.
  else if (mistral.localUnused) void localServer.stop().catch(() => {});
  await mistralControl.publishStatus().catch(() => {});
  return true;
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
    // A byte-order mark (a hand edit saved by Windows PowerShell or an older Notepad) is dropped, as the game's own reader does (mod/manager.lua
    // readJSON): otherwise the file would not parse here and the bridge would keep other settings than the game shows.
    const raw = (await readFile(resolve(runtime, 'settings.json'), 'utf8').catch(() => '')).replace(/^﻿/, '');
    let settings; try { settings = JSON.parse(raw); } catch {}
    // Mature content and the saved model choice come first: the saved provider is applied below, and its first Local AI start (prepareLocal)
    // loads the model these two decide. They are the first thing this poll does with the file, so that start waits for nothing but this read.
    speechLanguage.update(settings);
    // Reply language (Settings > Voices): a fixed language skips the detection while Voice playback is on; Automatic detects (bridge/multilingual.mjs).
    // The game's own text language is the detection's weakest prior (read from runtime/ui-language.txt at most once in a few seconds, off this path).
    if (settings) {
      const reply = replyLanguageFrom(settings);
      if (multilingual.setFixed(reply.fixed)) console.error(`[ReplyLanguage] ${reply.fixed ? 'fixed to ' + reply.fixed : 'automatic'}`);
      void speechLanguage.refreshUi().then(code => multilingual.setPrior(code)).catch(() => {});
    }
    const matureBefore = matureContent.enabled, packBefore = matureContent.pack;
    if (maturePackInstalled() !== packBefore) await mistralControl.publishStatus().catch(() => {});   // the settings help says whether the uncensored models are installed
    const matureChanged = matureContent.update(settings) || matureContent.enabled !== matureBefore;
    if (matureChanged) console.error(`[MatureContent] setting is now ${matureContent.enabled ? 'on' : 'off'}`);
    // The guard's patterns compile on first use (about a second); do that now, in the background, not inside the first Mature turn.
    if (matureChanged && matureContent.enabled) void warmMatureGuard();
    syncLocalModelChoice(settings);
    // Own Convai key: the setting and the settings page's commands, then the switch itself once nothing is running.
    if (settings) {
      if (keys.setPreference(settings.useOwnConvaiKey === true)) await ownKeyControl.publishStatus().catch(() => {});
      await ownKeyControl.poll().catch(() => {});
      await applyKeyChoice();
      // Conversation provider (docs/MISTRAL.md): the setting and the settings page's commands, then the switch itself.
      await adoptProviderSetting(settings);
      await mistralControl.poll().catch(() => {});
      await customControl.poll().catch(() => {});
      await geminiControl.poll().catch(() => {});
      await remoteOmniControl.poll().catch(() => {});
      adoptMicDevice(settings);
      await micDevicesControl.poll().catch(() => {});
      await omniAmdSetup?.poll().catch(() => {});
      if (Date.now() - speechCheckedAt > 10000) {
        speechCheckedAt = Date.now();
        const stt = mistralSpeech?.available() === true;
        if (stt !== mistral.sttAvailable) { mistral.sttAvailable = stt; await mistralControl.publishStatus().catch(() => {}); }
      }
      await applyProviderChoice();
      if (mistral.active) {
        // A local voice: Pocket speaks when the Convai cloud voice is selected (there is no Convai audio).
        if (settings.voiceProvider === 'convai') settings = {...settings, voiceProvider: 'pocket'};
      }
    }
    // Voice activation (Settings > Voices, off by default): without it the game's listen request is not honoured and a listening tap is released.
    // Speak dialogue choices (Settings > Gameplay, off by default) listens the same way, but only while the game shows a choice list.
    if (settings) {
      const choices = settings.voiceChoices === true;
      if (choices !== voiceChoicesOn) { voiceChoicesOn = choices; if (!choices) void voiceChoice?.cancel('the setting is off'); }
      micLive.setAllowed(settings.voiceActivation === true || choices);
    }
    if (settings) { audioDelaySetting = settingDelay(settings); await applyAudioDelay(); }
    // Dialogue level match (docs/DIALOGUE_LEVEL.md): makeup gain for every voice.
    if (updateDialogueLevel(await readFile(resolve(runtime, 'dialogue-level.json'), 'utf8').catch(() => '')))
      console.error(`Dialogue level: ${JSON.stringify(dialogueLevel())}`);
    // Voice volume (every voice but V's) and V's voice volume (Settings > Voices): the next poll of a playing line and the next phrase use them.
    if (updateVoiceVolume(settings)) console.error(`Voice volume: ${voiceVolumePercentNow()}%, V's voice volume: ${vVoiceVolumePercentNow()}%`);
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
    if (!voiceSettingsRead) { voiceSettingsRead = true; timeline('the settings were read for the first time'); rewarmLocalVoice(); }
    // Multilingual packs installed (or removed) while the game runs are noticed within 30 s: one folder listing and a stat per manifest, never awaited by a reply.
    void languagePacks.refresh().catch(() => {});
    void pocketLanguages.refresh().catch(() => {});
    // Developer mode: the last reply's audio and reference are kept (bridge/last-reply-capture.mjs).
    if (replyCapture.update(settings)) console.error(`[Debug] keeping the last spoken reply is now ${replyCapture.enabled ? 'on' : 'off'}`);
    if (devTranscript.update(settings)) console.error(`[Debug] the Developer mode transcript is now ${devTranscript.enabled ? 'on' : 'off'}`);
    void placeCaptures.poll();
    // A prepared reply was written under the previous Natural speech instructions.
    const speechChanged = naturalSpeech.update(settings), emotionsChanged = expressiveEmotions.update(settings);
    // Settings > Dynamic info: the kinds of live game info the context may carry (bridge/dynamic-info.mjs); read by every provider's context builder.
    const dynamicInfoChanged = dynamicInfo.update(settings);
    if (dynamicInfoChanged) console.error(`[DynamicInfo] ${dynamicInfo.describe()}`);
    // V's voice row is one list (Off / Pocket / Voxtral / OmniVoice). A saved Voxtral stays Voxtral without a Mistral key: a cloud voice loads no local
    // model (owner rule), so V's line is skipped with the reason and shows as text, and no Pocket worker loads for it (the poll runs this every time, so
    // it speaks as soon as a key is saved). While Mature content is on there is no cloud voice (owner decision 2026-10-20), so V speaks with Pocket
    // then and is Voxtral again when the setting goes off. A saved OmniVoice counts as Pocket
    // unless the companions' chosen voice is OmniVoice and its pack is installed (a second big GPU model is never loaded for V): the same
    // two conditions as the row's greyed-out entry (mod/manager.lua vOmniBlock). An Omni voice that is merely failing or loading is not that:
    // the engine stays Omni and V's line is skipped with the reason (vVoice.omni.problem), so no Pocket worker loads beside it. One that has FALLEN BACK is the other case (out of
    // graphics memory, or no CUDA: both last for the session): the companions are on Pocket or text, so V reads as Pocket too and speaks with the Pocket worker that is loaded.
    const vOmniUsable = localVoice.requestedProvider === 'omni' && localVoice.omniPack?.installed !== false && !localVoice.omniNoMemory && !localVoice.omniNoCuda;
    const vSettings = vSettingsFor(settings, {cloudUsable: matureAllowsCloudVoice(matureContent.enabled), omniUsable: vOmniUsable});
    if (vVoice.update(vSettings)) console.error(`[VVoice] typed lines ${vVoice.enabled ? 'on' : 'off'}, engine ${vVoice.engine}, microphone lines ${vVoice.micEnabled ? 'on' : 'off'}`);
    if (vVoice.active) startVVoiceModScan();
    // Companions can see: Local AI loads its vision projector only while the setting is on (and restarts without it when it goes off, bridge/local-llm-server.mjs setVision), so the server is
    // told before the policy looks at what the model can do.
    if (settings && typeof settings === 'object') localServer.setVision(settings.companionVision === true && !visionDisabledByEnv());
    if (companionVision.update(settings)) console.error(`[Vision] setting is now ${companionVision.enabled ? 'on' : 'off'} (${companionVision.transport})`);
    localVoice.setVHelperWanted(vVoice.wantsPocket);
    void releaseUnused().catch(error => console.error('[CyberpunkConvai] Releasing unused resources:', error.message));
    await publishLocalModelList();
    if (speechChanged) console.error(`[NaturalSpeech] setting is now ${naturalSpeech.enabled ? 'on' : 'off'}`);
    if (emotionSelection.update(settings)) console.error(`Facial emotion selector: ${emotionSelection.mode}`);
    if (settings && typeof settings === 'object') replyStreaming = settings.replyStreaming !== false && !replyStreamingForcedOff;
    // A reply prepared ahead was written with the old Dynamic info (a place the player just turned off): it is not used.
    if (speechChanged || emotionsChanged || dynamicInfoChanged) { dropPrefetch(); prefetchObserved = ''; }
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
// Settings > Convai paid tier (docs/CONVAI_PAID_TIER.md): Convai's plans for this mod, bought with the player's own key (the one above).
// Idle until the settings page writes a command; the plan list may come from the sign-in backend (CYBERPUNK_CONVAI_PLANS_URL overrides).
const paidTierControl = await new PaidTierControl({keys, commandPath: resolve(runtime, 'paid-tier-command.json'),
  plansUrl: process.env.CYBERPUNK_CONVAI_PLANS_URL?.trim() || (authSettings.enabled ? plansUrlFor(authSettings.url) : null),
  publish: value => atomic(resolve(runtime, 'paid-tier-state.json'), JSON.stringify(value)),
  // The plan is read only while the player's key is the one in use (its answer sets the connection limit above).
  wantPlan: () => keys.singleSession && !mistral.active,
  // Sign in with Convai (bridge/convai-signin.mjs): Convai's login page hands the player's key back to a loopback listener that is open
  // only while a sign-in waits. The key is checked with Convai and saved exactly as Paste saves it.
  signIn: () => startConvaiSignIn(),
  validate: key => validateKey(key),
  saveKey: async key => { await keys.save(key); quota.clear(); await ownKeyControl.publishStatus().catch(() => {}); },
  log: message => console.error('[CyberpunkConvai] ' + message)}).open();
playerConnectionLimit = () => paidTierControl.connectionLimit();
const mistralControl = await new MistralControl({provider: mistral, commandPath: resolve(runtime, 'mistral-key-command.json'),
  inworldCommandPath: resolve(runtime, 'inworld-key-command.json'),
  localStatus: localAiStatus, localReason: localAiReason, localDetail: () => { const {state, reason, detail} = localServer.status(); return state === 'failed' ? unavailableDetail(reason, detail) ?? null : null; }, maturePack: () => maturePackInstalled(), localModels: installedLocalModels, localModelDefaults, localModelInUse, localModelProblems: customModelProblems, localDiagnostics: () => localServer.diagnostics(), model: () => MISTRAL_MODEL, publish: value => atomic(resolve(runtime, 'mistral-state.json'), JSON.stringify(value))}).open();
// The custom provider's settings page: three pastes and a connection test (bridge/custom-endpoint.mjs). Idle until the page writes a command.
const customControl = await new CustomControl({custom: customEndpoint, provider: mistral, commandPath: resolve(runtime, 'custom-provider-command.json'),
  publish: value => atomic(resolve(runtime, 'custom-provider-state.json'), JSON.stringify(value)),
  test: () => testCustomConnection(customEndpoint, {adapt: textRoutes.custom.adaptation()}),
  // The Mistral preset of this page keeps the cloud voice's key (player-mistral-key.txt, bridge/voxtral-voice.mjs) in step: Add saves it there too, Remove deletes it.
  presets: ['mistral'], onPreset: async (name, key) => { if (name === 'mistral' && parseMistralKey(key)) await mistral.save(key); }, onClearPreset: async name => { if (name === 'mistral' && mistral.key) await mistral.remove(); },
  log: message => console.error('[Custom] ' + message)}).open();
// Google Gemini's page (Settings > Conversation provider > Google Gemini): Add reads the key from the clipboard, Remove deletes it, Test connection sends one tiny request (the same control as the Custom page).
const geminiControl = await new CustomControl({custom: geminiEndpoint, provider: mistral, route: 'gemini', presets: ['gemini'], commandPath: resolve(runtime, 'gemini-provider-command.json'),
  publish: value => atomic(resolve(runtime, 'gemini-provider-state.json'), JSON.stringify(value)),
  test: () => testCustomConnection(geminiEndpoint, {adapt: textRoutes.gemini.adaptation()}),
  log: message => console.error('[Gemini] ' + message)}).open();
mistral.onChange(() => { void mistralControl.publishStatus().catch(() => {}); void customControl.publishStatus().catch(() => {}); void geminiControl.publishStatus().catch(() => {}); });
// Settings > Voices > OmniVoice for AMD (bridge/omni-amd-setup.mjs, docs/OMNIVOICE_AMD.md): one download of AMD's ROCm PyTorch, tested like omni-python.txt.
// Idle until the page writes a command, apart from one card list read a little after start-up when the OmniVoice pack is installed.
omniAmdSetup = await new OmniAmdSetup({stateDirectory, commandPath: resolve(runtime, 'omni-amd-command.json'),
  publish: value => atomic(resolve(runtime, 'omni-amd-state.json'), JSON.stringify(value)),
  runtimePython: () => process.env.CYBERPUNK_CONVAI_PYTHON || null,
  packInstalled: () => detectOmniPack({project, config: omniVoiceConfigs.long}).installed === true,
  cards: () => cachedGraphicsCards(),
  ownPython: () => omniOwnPython ?? omniOwnPythonNamed,
  ownFile: async () => { const setting = await readOwnPythonSetting({stateDirectory, managed: async () => null}); return setting.configured === true; },
  recheck: () => checkOwnPython({force: true}),
  // The AMD Python is let go before its files change: no worker is given it any more, and the one that runs from it is replaced at the next idle moment.
  release: async () => {
    if (omniOwnPython?.managed || omniOwnPythonNamed?.managed) {
      omniOwnPython = {configured: false}; omniOwnPythonNamed = null; omniOwnPythonRun = Promise.resolve(omniOwnPython);
      try { if (!localVoice.closed) localVoice.publish(); } catch {}
      await localVoice.releaseOmniWorkers?.().catch(() => {});
    }
  },
  log: message => console.error('[OmniAMD] ' + message)}).open();
// Remote OmniVoice's settings page: Paste address, Remove address and Test (bridge/remote-omni-control.mjs). Idle until the page writes a command.
const remoteOmniControl = await new RemoteOmniControl({address: remoteOmniAddress, commandPath: resolve(runtime, 'remote-omni-command.json'),
  publish: value => atomic(resolve(runtime, 'remote-omni-state.json'), JSON.stringify(value)),
  log: message => console.error('[RemoteOmni] ' + message)}).open();
// Settings > Voices > Microphone: the list of audio inputs, asked for when the page opens (bridge/mic-devices-control.mjs). Idle until the page writes a command.
const micDevicesControl = await new MicDevicesControl({capture: micCapture, commandPath: resolve(runtime, MIC_DEVICES_COMMAND),
  publish: value => atomic(resolve(runtime, MIC_DEVICES_STATE), JSON.stringify(value)),
  // The capture page opened only to list the inputs goes again when nothing records and no device lingers.
  releaseIdle: () => { if (micTap.state === 'closed' && !micTap.lingering && micCapture.deviceOpen !== true) void micCapture.close().catch(() => {}); },
  log: message => console.error('[CyberpunkConvai] Microphone: ' + message)}).open();
// The player's choice, from the settings poll. A change counts from the next open of the device; a tap that is listening (Voice activation) is let go so it reopens on the new input.
function adoptMicDevice(settings) {
  const next = settingMicDevice(settings);
  if (next === micPreferred) return;
  micPreferred = next;
  console.error('[CyberpunkConvai] Microphone: ' + (next ? `input chosen in Settings: "${next.slice(0, 80)}"` : 'input is the Windows default'));
  if (micTap.listening) void micTap.release(undefined, 'the microphone input changed');
}
const memoryControl = await PlayerMemoryControl.open({memory: playerMemory,
  commandPath: resolve(runtime, 'memory-command.json'),
  chatResetPath: resolve(runtime, 'memory-chat-resets.json'),
  chatResetFamilies: relationshipRoutes.providerFamilies,
  publish: value => atomic(resolve(runtime, 'memory-status.json'), JSON.stringify(value))});
// Help > Generate report: a redacted zip of versions, status and log tails.
// The key and provider IDs are passed only so they can be scrubbed from it.
const supportReport = await SupportReportControl.open({game, runtime, stateDirectory, project,
  secrets: () => [...keys.secrets(), ...mistral.secrets()], knownIds: () => Object.values(relationshipRoutes.providerIds ?? ids),
  bridge: () => ({busy: !!active, microphoneActive: !!mic.current, microphone: micDevicesControl.summary(micPreferred), voiceLanguagePacks: languagePacks.report(), pocketLanguageModels: pocketLanguages.report(),
    vVoiceMods: {...vVoiceModReport, references: Object.fromEntries(Object.keys(V_VOICE_KEYS).map(gender => [gender, vVoiceReferences.voices[gender] || playerVoices.has(V_VOICE_KEYS[gender]) ? vReferenceLabel(gender) : null]))}})});
// Help > Setup check (bridge/setup-check.mjs): codes the game turns into text. The first run, at the end of start-up, reads files only (no
// process, no connection); a request from the Help page runs it in full. The graphics card, browser and mod managers are looked up once.
const bridgeStartedAt = Date.now() - Math.round(process.uptime() * 1000);
const setupCheck = await SetupCheckControl.open({runtime, log: message => console.error('[CyberpunkConvai] ' + message),
  collect: (request, {light = false} = {}) => collectSetupCheck({game, modRoot: resolve(runtime, '..'), project, stateDirectory, request, light,
    plugin: resolve(game, 'red4ext/plugins/AiNpcCyberpunkMod'),
    settings: async () => JSON.parse((await readFile(resolve(runtime, 'settings.json'), 'utf8')).replace(/^\uFEFF/, '')),
    localAi: () => {
      const pack = refreshLocalPack(), matureInstalled = maturePackInstalled(), {state, reason, detail} = localServer.status();
      return {status: localAiStatus(), reason: state === 'failed' ? reason ?? null : null, packInstalled: pack.installed, tiers: pack.tiers,
        matureOnly: pack.installed && !pack.tiers.standard && !pack.tiers.lite && matureInstalled, ownServer: ownServerListed(), ownModel: ownModelRunnable(pack), models: maturePackModels,
        // The start failed because the server the player runs does not answer, is blocked, refuses the key or is no OpenAI-style address: their setup, so no error report (error-events.mjs setupChecked).
        playerServer: state === 'failed' && reason === 'start-failed' && isPlayerServerDetail(detail),
        // Windows blocked a file of the model server (Smart App Control / Application Control): the Help row names it.
        blocked: state === 'failed' && reason === 'start-failed' && detail === LOCAL_AI_BLOCKED};
    },
    omniPack: () => detectOmniPack({project, config: omniVoiceConfigs.long}),
    // The player's own Python for OmniVoice (only with omni-python.txt): a light run reports what is known, the Help page's run tests it (again after a refusal).
    omniPython: async ({light: lightRun} = {}) => {
      // The Help page follows its request for 15 s: a self-test still running after 8 s is reported as being tested, and the next check shows its result.
      if (!lightRun) {
        const done = await Promise.race([checkOwnPython({again: true}), new Promise(wait => setTimeout(wait, 8000).unref?.())]);
        if (done) return ownPythonSummary(done);
        const setting = await readOwnPythonSetting({stateDirectory});
        return setting.configured ? {...ownPythonSummary({configured: true, used: false, managed: setting.managed === true, reason: setting.problem ?? null}), testing: !setting.problem} : null;
      }
      if (omniOwnPython) return ownPythonSummary(omniOwnPython);
      const setting = await readOwnPythonSetting({stateDirectory});
      return ownPythonSummary(setting.configured ? {configured: true, used: false, managed: setting.managed === true, reason: setting.problem ?? null} : setting);
    },
    // Whether the Pocket voice (V's voice, the companions') has failed to start: a row of the Help page when it has.
    voice: () => localVoice.voiceProblem(),
    // The microphone in use (labels only): the input the latest recording opened and the one chosen in Settings; null before any (bridge/mic-devices-control.mjs summary).
    microphone: () => micDevicesControl.summary(micPreferred),
    // The saved endpoint of the custom provider (host, port), asked for only while that provider is chosen: its host is the one the internet check looks up.
    custom: () => { const chosen = mistral.preference === 'gemini' ? geminiEndpoint : customEndpoint;
      return chosen.ready ? {hostname: chosen.address.hostname, host: chosen.host, secure: chosen.secure, port: Number(new URL(chosen.origin).port) || (chosen.secure ? 443 : 80)} : null; },
    browser: () => cachedBrowserName(), graphics: () => cachedGraphicsCards(), modManagers: () => cachedModManagers({game}),
    nestedPacks: () => findNestedPacks({game, modRoot: resolve(runtime, '..'), plugin: resolve(game, 'red4ext/plugins/AiNpcCyberpunkMod')}),
    placement: () => readPackPlacement({stateDirectory, startedAt: bridgeStartedAt})})});
// Settings > Edit characters: a local page, served only while it is open (bridge/character-editor-server.mjs).
const characterEditor = new CharacterEditor({personas: personaBook, overrides: characterOverrides, memory: scopedMemory(mistralMemory, memoryNamespace.keyFor), route: () => mistral.route, custom: customCharacters,
  voices: playerVoices, worldRules, promptProfiles, addonContent: addonContent.installed ? addonContent : null, options: characterOptions,
  // Every turn reads the persona, the overrides, the memories and the player's characters with a plain lookup, so a save counts from the next turn with
  // no restart. A group reply prepared before the save was written from the old text: it is dropped, so the next one is written from the new.
  onChanged: () => { dropPrefetch(); prefetchObserved = ''; }});
const editorControl = await EditorControl.open({server: new EditorServer({editor: characterEditor, log: message => console.error('[Editor] ' + message)}),
  commandPath: resolve(runtime, 'editor-command.json'), statusPath: resolve(runtime, 'editor-status.json'),
  home: createHash('sha256').update(stateDirectory.toLowerCase()).digest('hex').slice(0, 12),
  log: message => console.error('[Editor] ' + message)});
await companionActions.revoke();
await status('waiting');
await pollSettings(false);
void setupCheck.run(null, {light: true}).catch(error => { console.error('[CyberpunkConvai] Setup check:', error.message); return null; }).then(noteSetupProblems);
void gameState?.poll();
// The saved provider is applied (or the settings file could not be read yet, and the default stands until a later poll): the status file
// says so from here on.
mistral.statusHeld = false;
await mistralControl.publishStatus().catch(() => {});
await pollKnowledge();
void localVoice.start().catch(error => console.error('[CyberpunkConvai] Local voice startup:', error.message));
// A text route (Mistral, the local AI) opens no Convai connection, so nothing else starts the hidden browser that renders the
// local voice; the first reply would wait for it (about a second and a half under a running game). Start it now.
if (mistral.active && localVoice.playbackEnabled !== false) void realtime.prewarmLocal();
console.log('[CyberpunkConvai] Convai conversation bridge ready');
// A quest left active in the save is handed to the game now, and the 500 ms poll starts only if one is.
questSync();
// A poll is one stat of the request file until Lua replaces it, so a short
// interval costs little and removes up to 150 ms from every turn's start.
// The media link looks at its command file from this loop, not awaited, only while a quest runs or a sound plays (bridge/media-link.mjs).
const timer = setInterval(() => { mediaLink.maybePoll(); return tick(); }, 50);
const micTimer = setInterval(() => { void pollMicrophone().catch(error => pollLog('[CyberpunkConvai] Microphone poll:', error)); }, 150);
// The key's down and up edges and the "listen for speech" request (microphone-live.json, mod/microphone.lua): read the moment the game writes it.
const liveTimer = setInterval(() => { void micLive.poll().catch(error => pollLog('[CyberpunkConvai] Microphone live poll:', error)); }, 500);
const prefetchTimer = setInterval(() => { void pollPrefetch().catch(error => pollLog('[CyberpunkConvai] Preparation poll:', error)); }, 150);
const lookaheadTimer = setInterval(() => { void pollLookahead().catch(error => pollLog('[CyberpunkConvai] Look-ahead poll:', error)); }, 60);
// Add-ons only: the state and settings files are also read once a second, in case the directory watcher missed a change.
const addonTimer = addonHost.active ? setInterval(() => { for (const read of Object.values(addonHost.watchHandlers(runtime))) void read(); }, 1000) : null;
addonTimer?.unref?.();
// A poll that is still running when the service closes is rejected with 'Voice service is closed': expected at shutdown, not a fault.
const settingsTimer = setInterval(() => {
  void gameState?.poll();   // a stat of each state file (bridge/game-state.mjs); a copy only when one changed
  void pollSettings().catch(error => { if (!stopped) pollLog('[CyberpunkConvai] Settings poll:', error); });
}, 500);
const phoneTimer = setInterval(() => { void pollPhone().catch(error => pollLog('[CyberpunkConvai] Phone poll:', error)); }, 150);
// The status file the game reads can be held open by the game for a moment (Windows refuses the rename: EPERM/EBUSY); the next poll
// writes it again, so the same message is logged at most once a minute, with how many were left out.
const knowledgeTimer = setInterval(() => { void pollKnowledge().catch(error => pollLog('[CyberpunkConvai] Knowledge poll:', error)); }, 500);
const memoryTimer = setInterval(() => { void memoryControl.poll().catch(error => pollLog('[CyberpunkConvai] Memory control:', error)); }, 500);
const supportTimer = setInterval(() => { void supportReport.poll().catch(error => pollLog('[CyberpunkConvai] Support report:', error)); }, 500);
const setupTimer = setInterval(() => { void setupCheck.poll().catch(error => pollLog('[CyberpunkConvai] Setup check:', error)); }, 500);
const paidTierTimer = setInterval(() => { void paidTierControl.poll().catch(error => pollLog('[CyberpunkConvai] Paid tier:', error)); }, 500);
// The same polls run a few milliseconds after the game replaces their file (bridge/file-wake.mjs): a typed or spoken turn and a
// phone message no longer wait half an interval (25 ms for the request, 75 ms for the microphone and the phone) to be seen.
// The intervals above stay as the fallback. The watcher never keeps the process alive.
watchFiles(runtime, {
  'last-input.json': tick,
  'microphone-command.json': () => pollMicrophone().catch(error => pollLog('[CyberpunkConvai] Microphone poll:', error)),
  // The key press opens the microphone tap with no wait for the 150 ms poll above.
  'microphone-live.json': () => micLive.poll().catch(error => pollLog('[CyberpunkConvai] Microphone live poll:', error)),
  // The choice list on screen (mod/voice-choices.lua): a recording of a list that has changed or closed is dropped.
  'choice-hub.json': () => readChoiceHub().then(hub => voiceChoice.hubChanged(hub)).catch(error => pollLog('[CyberpunkConvai] Choice list poll:', error)),
  'phone-chat-input.json': () => pollPhone().catch(error => pollLog('[CyberpunkConvai] Phone poll:', error)),
  // The game's playback lease releases the first sound: the playback pump polls the moment it is written (docs/LATENCY_2026-10-13.md, 4.2).
  'continuous-control.json': () => leaseWake.fire(),
  // The add-on state and settings the game writes (docs/ADDON_API.md); no entries without add-ons. The player's state files too: the copy
  // outside the game folder follows a save within milliseconds (no entries unless the launcher turned it on). addon-settings.json is both.
  ...mergeHandlers(addonHost.watchHandlers(runtime), gameState ? gameState.watchHandlers() : {}),
  // The lease (about 250 bytes) is read on the next turn of the event loop, not after a 4 ms timer (up to 15.6 ms on Windows): its
  // reader keeps its last good copy when it meets a half-written file and the wake is a latch (bridge/file-wake.mjs `delays`). The
  // request keeps the short delay: Lua rewrites that large file in place under Mod Organizer 2.
}, {delays: {'continuous-control.json': 0}, log: message => console.error('[CyberpunkConvai] ' + message)});
const editorTimer = setInterval(() => { void editorControl.poll().catch(error => pollLog('[CyberpunkConvai] Character editor:', error)); }, 500);
async function shutdown() {
  if (stopped) return;
  await gameState?.flush().catch(() => {});   // the Lua's last save is copied before anything else closes
  await companionActions.revoke();
  stopped = true; active?.controller.abort(); dropPrefetch(); audioWatch.stop(); tokenSource?.stop();
  companionVision.stop();
  settleVoiceRouteWaiters(Error('Voice service is closed'));
  phone.close(); clearInterval(phoneTimer);
  phoneKnowledge.clear();
  clearInterval(knowledgeTimer);
  clearInterval(memoryTimer);
  clearInterval(supportTimer); supportReport.close();
  clearInterval(setupTimer); setupCheck.close();
  clearInterval(paidTierTimer); paidTierControl.close();
  clearInterval(editorTimer); await editorControl.close().catch(() => {});
  clearInterval(timer); clearInterval(micTimer); clearInterval(liveTimer); micLive.stop(); micDevicesControl.close(); void micTap.release(undefined, 'the service stops'); clearInterval(prefetchTimer); clearInterval(lookaheadTimer); clearInterval(settingsTimer);
  if (stockTimer) { clearInterval(stockTimer); stockTimer = null; }
  questPoller.stop();
  stockCancel?.();
  await invitations.clear('service-stopped');
  await voiceRouteSync.catch(() => {});
  await relationshipRouteSync.catch(() => {});
  await Promise.allSettled([localVoice.close(), mic.cancel(), connections.clear(), mistralSpeech.close()]);
  await Promise.allSettled([realtime.close(), phoneRealtime.close(), jaliFace?.close()]);
  mistralHost.close();
  await mistralMemory.flush().catch(() => {});
  await lastTalk.flush().catch(() => {});
  await bondStore.flush().catch(() => {});
  await bondPacks.flush().catch(() => {});
  await Promise.allSettled([localServer.stop(), localEmbedder.close()]);
  await reputation.flush().catch(() => {});
  await vendorMemory.idle().catch(() => {});
  await memoryControl.close(); await playerMemory.close();
  await Promise.allSettled([metricsWriting, connectionMetricsWriting, voiceMetricsWriting]);
  await status('stopped'); process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
// However the bridge ends, the model servers it started end with it (their graphics memory must not stay taken).
process.on('exit', () => { try { localServer.killSync(); localEmbedder.killSync?.(); } catch { /* best effort */ } });
