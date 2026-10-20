# Settings matrix and audit, 2026-10-20

The audit write-up of branch `audit/settings-matrix` (from main 2c19ac29). It was meant for `deliverables/settings-audit-2026-10-20.md`; the file tool there was refused, so it lives here. Committed, NOT merged, NOT pushed, NOT installed, game not launched, no live cloud or Convai turn. `mod/` needs a CET reload (all committed Lua and the 15 locales), `bridge/` a bridge restart.

Scope: every player setting on Settings and Relationships, the credentials, the hidden keys of `runtime/settings.json`, and the install states that feed them. Method: read both rule sets (Lua `mod/manager.lua`, `mod/manager-ui.lua`; the bridge's settings poll in `bridge/convai-bridge.mjs` and the modules it feeds), list every pair of settings where one reads, forces or refuses the other, and walk each pair plus the triples provider × voice × Mature and provider × Multilingual × voice through the page, the load path (an old or hand-edited file) and the bridge. Left to other branches: the Mature pin and the Local AI model row (`fix/mature-off-models`, `bridge/local-model-choice.mjs`) and the free-VRAM fit (`bridge/local-llm-server.mjs`).

Counts: **36 page settings** (35 keys, the 5 relationship rows under one key), **3 credentials** (Mistral key, Convai key, Custom endpoint URL/key/model), **4 rows per add-on with speakers** plus its own items, **9 hidden file keys**, **31 interacting pairs**.

## 1. Inventory

Read sites: the Lua getter or rule in `mod/manager.lua`, and the bridge reader. A load rule is what `loadSettings` does with an old or hand-edited value.

| Key | Values | Default | Lua (read / rules) | Bridge (read) | Enables, disables, forces | Loads / unloads | Player text |
|---|---|---|---|---|---|---|---|
| `uiLanguage` | `auto` or 15 codes | `auto` | `ui.configure`; unknown → `auto` | `speech-language.mjs` `update` (mic language hint) | hint for non-English mic recognition | none | Interface language (see D5) |
| `archetypeConversations` | bool | on | `M.archetypeConversations`, `profileEnabled` | – | npc-* profiles talk | none | Talk to ordinary NPCs |
| `storyConversations` | bool | off | `M.storyConversations` | – | game characters talk (talk, face and audio only) | none | Talk to story characters |
| `johnnyInHead` | bool | off | `M.johnnyInHead` | – | gates the next two (`init.lua` 791, 810, 898) | none | Johnny in your head |
| `johnnyRemarks` | off/rare/normal | off | `M.johnnyRemarks` | – | needs Johnny in your head | free-tier turns | Johnny speaks up |
| `johnnyHologram` | bool | off | `M.johnnyHologram`; row only in developer mode | – | needs Johnny in your head | none | Johnny’s hologram (dev) |
| `vTalks` | off/rare/normal | off | `M.vTalks`; row only in developer mode | – | needs `vVoice` (`init.lua` 3215) | turns | V talks on their own (dev) |
| `multilingualConversations` | bool | off | `M.multilingualActive` (new), `resolveMultilingualVoice`, load rule | `multilingual.mjs` `update`, `voice-selection.mjs` `request`; forced off for a player key (`convai-bridge.mjs` 3184) and on text providers (3206) | in use only on the Convai free tier: voice never Pocket/Voxtral; without the Omni pack the tag settings are off | Omni or Convai voice instead of Pocket | Multilingual conversations |
| `autoConnectNearby` | bool | on | `M.autoConnectNearby` | – (connections: `party-connections.mjs` deferWarm) | pre-opens connections on the free tier | local voice prep | Auto-connect nearby characters |
| `gameDialogueContext` | bool | on | `M.gameDialogueContext` | – | records game dialogue | none | Continue from game dialogue |
| `holocallLiveImage` (+Chosen) | bool | on | an unchosen false becomes true | – | – | none | Live holocall picture |
| `relationshipModes.*` (5) | auto/on/off | auto | unknown keys dropped | `relationship-routing.mjs` | – | none | Relationships page |
| `conversationProvider` | convai/mistral/local/custom | convai | unknown (`groq`) → convai | `mistral-key.mjs` `setPreference` (same; mistral needs the key, custom an endpoint, local falls back) | Mature only on local/mistral/custom; Multilingual off off the free tier; Convai voice → Pocket on text providers | Local AI server starts on `local`, stops when unused | Conversation provider (5 entries) |
| `useOwnConvaiKey` (+`convaiProviderChoice`) | bool | off | entry 2 of the provider select; old switch migrated once | `convai-key.mjs` | single session: Multilingual off, nothing pre-opened | none | "Convai API key" entry |
| `matureContent` | bool | off | off beside Convai on load and Apply; `stageMature` | `mature-content.mjs` `update` | on from Convai selects Local AI, the uncensored model, Pocket for a cloud voice, V engine Pocket (new); Convai turns it off | guard compile; model choice | Mature content |
| `matureRestore` | record | none | `cleanMatureRestore` (provider, model, voice, V engine: new) | – | the way back on Mature off | – | – |
| `localModel` | auto, standard, lite, `mature:…`, `custom:…` | auto | `validModelId`, `goneLocalModelReplacement`; Apply pins the shown default | `local-model-choice.mjs` `normalisePin` | – | which model llama-server loads | Local AI model |
| `eyeContactHeight`, `headFollowStrength` | lists | 0, 1 | `M.gazeSettings` | – | – | none | Eye contact height, Head tracking strength |
| `bodyGestures` | bool | on | getter | – | – | none | Body gestures |
| `voice` | bool | on | native SetVoice | `voice-selection.mjs` `request` | off releases companion workers (Pocket kept for V) | releases | Voice playback |
| `voiceProvider` | pocket/omni/voxtral/convai | pocket | `normalizeVoiceProvider` (`inworld`, unknown → pocket; `hybrid` → omni); Omni needs the pack, Voxtral the key | `canonicalVoiceProvider` (same mapping) | tag settings off beside the Convai voice; Multilingual refuses Pocket/Voxtral | one worker (Pocket CPU or Omni GPU), none for cloud | Companion voices |
| `omniSteps`, `omniReference` | 16/32, short/long | 16, long | load rule | `voice-selection.mjs` | – | Omni variant | in the voice list |
| `audioDelay` | auto, 0…250 ms | auto | load rule | `audio-delay.mjs` | – | none | Lip sync delay (Bluetooth) |
| `voiceVolume` | 50…200 | 100 | `cleanVoiceVolume` | `dialogue-level.mjs` | – | none | Voice volume (%) |
| `naturalSpeech` | bool | off | off beside the Convai voice; on moves the Convai voice to Pocket | `natural-speech.mjs` (tags for local engines only) | – | none | Natural speech |
| `expressiveEmotions` (+Chosen) | bool | on | same | `expressive-emotions.mjs` (missing = on) | – | none | Expressive emotions |
| `followUpInterest` | bool | on | getter | `follow-up.mjs` | – | none | Follow-up questions |
| `vVoice` (+Chosen) | bool | on | an unchosen false becomes true | `v-voice.mjs` | – | V's own Pocket helper when the companions use another voice | V’s voice for typed lines |
| `vVoiceEngine` | pocket/voxtral | pocket | Voxtral needs the key; Pocket beside Mature + Local AI | `v-voice.mjs`; cloud refused by `matureAllowsCloudVoice` (`convai-bridge.mjs` 1119) | – | nothing for Voxtral | V’s voice engine |
| `subtitles`, `subtitleStyle` | bool, dialogue/overhead | on, dialogue | native / load rule | – | – | none | Subtitles, Subtitle display |
| `battleReactions`, `lootReactions` | bool | off | getters | – | – | turns | React to battles / collected loot |
| `errorReports` (+Noticed) | bool | on | `M.errorReports` | `error-events.mjs` (missing = on) | – | none | Send error reports automatically |
| `developerMode` | bool | off | `M.developerMode` | support report only | shows the two dev rows | movement trace | Developer mode |
| Mistral key | bridge file | none | commands only | `mistral-key.mjs` | Mistral provider; Voxtral for companions and V | none | Mistral free API key |
| Convai key | bridge file | none | commands only | `convai-key.mjs` | provider entry 2, paid tier | none | Convai API key, Convai paid tier page |
| Custom endpoint | bridge file | none | `custom-provider.lua` | `custom-endpoint.mjs` | Custom provider | none | Custom endpoint URL, API key, model ID, Test connection |
| Add-on rows | remarkGap, remarkCap, replaceGameLines, markLines, own items | add-on's | `addons.lua` `settingsSections` | `addons.mjs` (`addon-settings.json`) | – | route: the player's Mistral/Local AI, else the Mistral key, else Local AI | per add-on section (author's English) |
| Hidden keys | `decisionLedger`, `witnessReceipts`, `keepPreparedVoices` (always true), `enabledByKey` (Lua); `emotionSelector`, `replyStreaming`, `visionTransport`, `visionWaitMs`, `visionDebugLastSent` (bridge) | – | – | – | – | – | none |

Install states as inputs: the OmniVoice pack (unknown counts as installed; Omni entries greyed once it is known missing), Local AI Standard/Lite and Mature Standard/Lite (`localAi`, `maturePack`), mic packs (bridge only, no setting), the Runtime missing (model row "Service not running"), MCM or Native Settings UI (one page model; MCM applies a batch atomically, NSUI retries a refused batch row by row), card memory (model choice by free memory: other branch).

## 2. Interaction matrix (interacting pairs only)

| # | Pair | Rule |
|---|---|---|
| 1 | provider × Mature | only local/mistral/custom; on from Convai selects Local AI (refused without the pack); Convai turns it off. Bridge: never a layer on Convai. Agree. |
| 2 | provider × useOwnConvaiKey | one select; the key choice is kept while on another provider. |
| 3 | provider × Multilingual | in use only on the Convai free tier (bridge 3184, 3206); Lua now the same (`multilingualActive`). Was F2. |
| 4 | provider × companion voice | the Convai voice on a text provider plays Pocket (bridge 3206); the saved choice stays. |
| 5 | provider × V engine | Voxtral refused beside Mature + Local AI (Lua and bridge). |
| 6 | provider × localModel | the model is used on Local AI (and as the add-on fallback). |
| 7 | provider × Mistral key | Mistral needs the key; without it Convai answers and the provider help says so. |
| 8 | provider × Custom endpoint | Custom needs a ready endpoint, else Convai with a note. |
| 9 | provider × add-on route | the player's Mistral/Local AI, else the Mistral key, else Local AI; never Custom (D6). |
| 10 | provider × character editor | edits apply on Mistral, Local AI and Custom. Was F6 (texts). |
| 11 | provider × autoConnectNearby | connections pre-open on the shared free tier only (D7). |
| 12 | Mature × localModel | on selects the uncensored model; off puts the old one back (record). |
| 13 | Mature × companion voice | on beside Local AI moves a cloud voice to Pocket; off puts it back only if it is still Pocket and the old voice can be chosen now. Was F1. Later cloud choices allowed (D1). |
| 14 | Mature × V engine | beside Local AI, V moves to Pocket, named and recorded; off puts Voxtral back with a key. Was F4. |
| 15 | Mature × Mistral key | key removed: a Voxtral restore is skipped (F1). |
| 16 | Mature × Omni pack | an Omni restore is skipped while the pack is missing (F1). |
| 17 | Mature × Restore defaults | rows the batch sets are never put back. Was F5. |
| 18 | Multilingual × companion voice | in use: never Pocket/Voxtral; turning on moves to Omni Balanced or the Convai voice. |
| 19 | Multilingual × Omni pack | in use without the pack: the Convai voice. |
| 20 | Multilingual × tag settings | in use without the pack: both off, turning one on refused. |
| 21 | Multilingual × V voice | a V line in another language is skipped (`v-voice.mjs`); the V engine help says English only. |
| 22 | companion voice × tag settings | the Convai voice turns both off; turning one on moves the Convai voice to Pocket (Omni with Multilingual in use). |
| 23 | companion voice × Omni pack | Omni refused without the pack; a saved Omni without it falls back to Pocket with a notice. |
| 24 | companion voice × Mistral key | Voxtral refused without the key; key removed later: the Convai voice (or text) with a notice. |
| 25 | companion voice × V voice | Pocket companions speak V on their worker; any other voice loads V's own Pocket helper. |
| 26 | vVoice × vVoiceEngine × key | Voxtral needs the key; a saved Voxtral without one skips V (log only; the row reads "needs Mistral key"). |
| 27 | vVoice × vTalks | V talks needs V's voice. |
| 28 | voice playback × subtitles | both off: reactions silent (the help says so). |
| 29 | voice playback × local workers | off releases the companion workers, keeps Pocket for V. |
| 30 | johnnyInHead × remarks / hologram | both gated on it. |
| 31 | developerMode × hologram / vTalks | rows hidden without developer mode, values still active (D2). |

## 3. Findings, by player impact

| # | Finding | Evidence | Status | How a player hits it |
|---|---|---|---|---|
| F1 | **Mature content could not be turned off.** Off puts back the voice it replaced; when that was Voxtral and the Mistral key is gone (or OmniVoice and the pack is gone), Apply refused it ("Requires a Mistral key") and the whole batch failed; NSUI's row-by-row retry failed the same way. | `mod/manager-ui.lua` stageMature `turnedOff` (staged unconditionally); the Voxtral/Omni refusals in M.apply | **Fixed** 75d48d11: only a voice that can be chosen now is put back | Voxtral voice, Mature on (voice to Pocket, Local AI), remove the Mistral key, Mature off: the switch snaps back on with "Requires a Mistral key" |
| F2 | **Multilingual rules acted where the bridge ignores Multilingual.** The bridge turns it off on a player key and on Mistral/Local AI/Custom; Lua moved the voice off Voxtral/Pocket, refused both, turned the tag settings off without the pack, and the sidebar said "Multilingual: replies in your language". | `bridge/convai-bridge.mjs` 3184, 3206; `mod/manager.lua` resolveMultilingualVoice, the load rule, switchedVoice | **Fixed** 75d48d11 (`multilingualActive` = switch on + Convai free tier; choosing the free tier with the switch on applies the rules then), help text in adfbf89b | Mistral player turns Multilingual on: Voxtral is replaced and cannot be chosen back, replies do not change |
| F3 | **The bridge ignored a settings.json saved with a byte-order mark.** The game strips it, the poll did not: every update skipped, older or default settings kept (Convai at start). | `bridge/convai-bridge.mjs` 3166-3167 vs `mod/manager.lua` readJSON | **Fixed** 9eb4f081 | Hand-edit in Notepad or PowerShell: the page shows Mistral, Convai answers until an in-game Apply |
| F4 | **V's voice engine changed silently and never came back.** Mature + Local AI moved V from Voxtral to Pocket with a quiet reload, no "Also changed", no record; Mature off left Pocket; Mistral → Local AI with Mature on did the same. | `mod/manager.lua` applySettings (the rulesReload branch); stageMature had no V part | **Fixed** 75d48d11: staged, named, recorded, restored with a key | V on Voxtral, Mature on: V speaks Pocket; Mature off: still Pocket |
| F5 | **Restore defaults with Mature on gave the pre-Mature voice.** Defaults skip rows already at default, so the Mature way back restored the Convai cloud voice (and turned Expressive emotions off). | `mod/manager-ui.lua` M.defaults + `turnedOff` | **Fixed** 75d48d11: rows a batch sets are never put back; defaults name the Mature-touched rows | Convai voice, Mature on, Restore defaults: Convai cloud voice instead of Pocket |
| F6 | **Help text wrong for combos.** Custom missing from Edit characters, the editor page (3 lines), the own-characters notice, the bridge refusal and the provider help; the V engine help said Voxtral is "not with Mature content on" (allowed on Mistral/Custom since feat/mature-cloud); the Multilingual help did not say free tier only. | `mod/manager-ui.lua`, `mod/init.lua` 2376, `mod/character-editor.lua` 116/159/163, `bridge/character-editor-page.mjs` 456/579/595, `bridge/convai-bridge.mjs` 2594 | **Fixed** adfbf89b, 15 locales | Custom player reads that edits need Mistral or Local AI; Mistral player with Mature reads that Voxtral is unavailable |
| D1 | Companion cloud voice with Mature + Local AI: V's Voxtral is refused (Lua and bridge); the companions' Voxtral is moved only when Mature turns on; choosing it later, or Mistral → Local AI with Mature on, keeps it. | `manager.lua` applySettings Mature rule; `convai-bridge.mjs` 1119 (V only) | **Decision** | (a) refuse companion Voxtral beside Mature + Local AI and move it on the provider switch, like V; (b) allow Voxtral for V too; (c) keep and say so in the Mature help |
| D2 | Hidden dev rows stay active: Johnny’s hologram and V talks keep running after developer mode is turned off, with no row to see them; Restore defaults skips them. | `manager-ui.lua` (the `if not developer` removal); `init.lua` 898, 3215 | **Decision** | (a) the getters read Off unless developer mode is on; (b) turning developer mode off sets both to Off; (c) keep |
| D3 | Mature from Convai without the Local AI pack is refused even with a Mistral key saved. | stageMature `refusal` | **Decision** | (a) select Mistral when Local AI is missing and a key is saved; (b) keep |
| D4 | The Mistral key's Remove help says conversations go back to the Convai free tier also when the provider is Local AI or Custom and the key only feeds Voxtral. | `manager-ui.lua` Mistral key row | **Decision** | (a) provider-dependent help; (b) one line naming Voxtral; (c) keep |
| D5 | The Interface language help says the talk language is separate, but the mic uses an explicit interface language as its hint for non-English recognition when nothing else is known. | `bridge/speech-language.mjs` `current` | **Decision** | (a) reword the help; (b) stop using the setting as a hint; (c) keep |
| D6 | Add-on speakers never use the Custom endpoint; a Custom-only player gets "needs a free Mistral key or the Local AI pack". | `docs/ADDON_API.md` "Text providers", `AddonHost.routeFor` | **Decision** | (a) add Custom after the player's own provider; (b) keep |
| D7 | The Auto-connect help promises a ready conversation; connections pre-open only on the shared free tier. | `party-connections.mjs` deferWarm | **Decision** | (a) one line in the help; (b) keep |
| D8 | Convai voice + tag settings beside a text provider: Lua turns them off or moves the voice, the bridge plays Pocket there (tags would work). | `convai-bridge.mjs` 3206; `manager.lua` honourCloudVoice | **Decision** (low) | (a) the cloud-voice rule only on Convai providers; (b) keep one rule |
| D9 | Any Apply pins `localModel` to the shown default; with Mature on that is the uncensored model, so Mature off without a record leaves a Mature pin. | `manager.lua` applySettings (`localModel == 'auto'`) | for `fix/mature-off-models` | – |

Checked and consistent: `inworld`/`hybrid`/unknown voice and `groq`/unknown provider map the same in Lua and the bridge; Mature beside Convai is turned off on load and Apply and never layered by the bridge; `errorReports` missing = on on both sides; Omni unknown counts as installed and the fallback notice covers it; Voice playback Off releases workers (Pocket kept for V); the Johnny rows are gated; an old `matureRestore` naming a removed provider or voice drops that part.

## 4. Commits

- 75d48d11 Settings rules: Mature content can always be turned off, V's engine follows it, Restore defaults wins, Multilingual rules only on the free tier (`mod/manager.lua`, `mod/manager-ui.lua`, new `bridge/settings-matrix-lua.test.mjs`: 6 tests, written failing first)
- 9eb4f081 Bridge settings poll reads a settings.json saved with a byte-order mark (`bridge/convai-bridge.mjs`; test in `bridge/startup-saved-choices.test.mjs`, written failing first)
- adfbf89b Help text names Custom, the free tier for Multilingual and Local AI for V's Voxtral rule (15 locales, catalogue regenerated; tests updated to the new wording)

## 5. Live checks for the fixed ones

1. Mistral key saved, Companion voices Voxtral, Convai free tier, Local AI pack installed. Turn Mature content on: Local AI, Pocket, "Also changed" names them. Remove the Mistral key. Turn Mature content off: it stays off, provider Convai free tier, voice Pocket.
2. V’s voice engine Voxtral (key saved), Mature off, Convai. Turn Mature on: the line names V’s voice engine, the row shows Pocket. Turn it off: Voxtral again.
3. Mistral, Mature on, V engine Voxtral. Choose Local AI: the line names V’s voice engine, the row shows Pocket.
4. Convai cloud voice, Mature on (voice to Pocket), Restore defaults (MCM footer or the NSUI button): voice Pocket, Expressive emotions on, Mature off, Convai free tier.
5. Mistral, voice Voxtral, turn Multilingual on: voice stays Voxtral, no notice, Pocket can be chosen. Switch to Convai free tier: OmniVoice · Balanced (Convai cloud voice without the pack) with the usual notice. The Characters sidebar line shows only on the free tier.
6. Game closed: edit `runtime/settings.json` to `"conversationProvider": "mistral"` and save it as UTF-8 with BOM (Windows PowerShell 5 `Set-Content -Encoding UTF8`). Start the game: the bridge log says `Conversation provider: mistral`.
7. Read the new texts in two languages (German, Japanese): Edit characters, the provider help, V’s voice engine, Multilingual; with Custom chosen, the character editor's header line and the own-characters help.
