# Cyberpunk Convai

Talk with Night City characters, invite travelling companions, and keep in touch through a native phone Chat tab. Conversations use Convai for dialogue, with a choice of local Pocket TTS character voices or Convai voices. The companion manager uses Cyberpunk's Mod Configuration Menu, and replies use native subtitles and facial animation.

**Development build for Cyberpunk 2077 2.31 on Windows x64.** This repository contains the working development integration. The proposed Scripts and Runtime downloads are not yet a portable release: setup still needs local dependencies, account configuration, and generated assets. Some gameplay features remain under testing.

[Features](#features) · [Requirements](#requirements) · [Install](#install-development-build) · [Controls](#controls) · [Customize](#customize) · [Support](#help-and-support) · [Limitations](#known-development-limitations) · [Remove](#remove)

## Features

### Conversations in the world and on the phone

- Private text and microphone conversations with supported nearby characters, with voiced replies, subtitles, and facial animation.
- Group conversations with up to three distinct speakers. The person you address speaks first, and the input box shows that person's name. Additional copies of the same character do not become extra speakers.
- An optional follow-up question keeps ordinary conversations going. In groups, only the final speaker asks; automatic comments do not ask questions.
- A dedicated **Chat** tab beside the phone's Messages and Contacts tabs. Choose a contact to open their conversation directly, then type in the composer at the bottom.
- Independent Chat histories and drafts that persist across launches. Contacts unlocked later become available when the phone catalog refreshes. Phone Chat works without summoning the character.

The catalog currently contains **79 conversation profiles**: 77 named characters and two ambient resident templates. Profiles have separate background, speaking-style instructions, and original dialogue examples without speaker-name prefixes. See [character profiles](characters/README.md), [phone Chat](docs/PHONE_CHAT.md), and [group voice](docs/GROUP_VOICE.md).

### Your companions

- Invite characters through **Companion Manager → Characters**, or use the selected phone contact's invite control.
- Keep up to **eight copies** in your party, including invitations being prepared. **Current party** lets you dismiss a particular copy or change its conversation profile.
- Search installed character models through **Model browser**, including characters outside the phone catalog. A model can follow without an AI profile, or use a profile you assign separately.
- Companions walk beside V, run to catch up, settle into loose positions, and respond to direct attention without reforming the whole group around camera turns. Close eye contact does not make a settled companion back away.
- Native combat AI, post-combat holstering, and moving green companion markers on the minimap.
- Summoned Johnny uses the game's solid appearance, including while seated and viewed up close. His story apparition remains separate.
- Passenger boarding and seated eye/head attention. The vehicle controller also includes overflow carpooling and fast-travel recovery; their wider gameplay checks are still pending.
- Ask a nearby companion to drive your summoned car to the selected map waypoint. They take the driver seat and wait for you to enter a passenger seat. You can change the waypoint during the trip; **Current party** shows its status and Stop trip.
- **Settings → Development → Developer mode** enables routine driving status popups. It defaults Off; important errors remain visible.

Selecting **Invite** reserves a place and immediately prepares memory configuration, the selected voice, and the conversation connection. A talking companion appears only after preparation succeeds and you return to gameplay. Progress reports the current preparation stage. This setup does not send an invented conversation or seed memories.

See [invitations](docs/COMPANION_INVITATIONS.md), [movement](docs/COMPANION_MOVEMENT_DESIGN.md), [combat](docs/COMPANION_COMBAT.md), and [vehicles](docs/COMPANION_VEHICLES_DESIGN.md).

### Voices, faces, and subtitles

- **Companion voices** offers **Pocket TTS (default), OmniVoice 16, OmniVoice 32, Convai**, in that order. The prepared development catalog has local references for **75 of 79 profiles**; characters without a prepared reference use their configured Convai voice. Saved valid choices remain selected, including older Omni settings.
- Each local backend uses **one shared model** and original character recordings. Pocket uses the approved six-layer student; its teacher stays in training. Neither backend needs a separate neural model or LoRA per character.
- Pocket uses **float32 on CPU**, with two threads by default and no model GPU allocation. This student is trained for English and uses one sampler step. Omni uses **FP16 on CUDA**, with 16 or 32 generation steps; those choices share the same model and cached references.
- Selecting a local voice option in Settings requests warm-up immediately, before Apply. Switching backends waits for owned work and confirmed retirement of the previous worker. An applied local choice stays warm; Convai releases local model memory after the current reply.
- Pocket and Convai use continuous PCM playback. Pocket receives the complete reply text once; Omni prepares its first native audio phrase while later phrases generate during playback. All modes keep the original Convai dialogue turn and avoid added EQ, denoising, pitch effects or audio crossfades.
- Native lip, jaw, and facial controls follow the actual playback clock. Pocket's prepared facial path uses resident CPU phone analysis with the shared calibrated native shapes; it warms during local-voice preparation and keeps original playback samples untouched. Omni retains its phrase analyser, and Convai uses its supplied facial data. [Phone analysis setup and qualification](docs/RESIDENT_PHONE_ANALYSIS.md) records the remaining native visual check.
- A light resting expression is standard behavior. Supported Convai emotional signals can adjust it, while native blinking and gaze remain available.
- **Dialogue HUD** subtitles are the default. **Above speaker** is optional; conversations in vehicles use the Dialogue HUD. On boarding, an overhead reply continues with its unread text rather than repeating the page already shown on foot. The game's subtitle preferences still affect native visibility.

All four options still need Convai and internet access for dialogue generation. Pocket's native Windows streaming/cancellation/cache checks pass, and live voice playback is confirmed; current facial and restored four-option acceptance remain separate game checks. See [local voices](docs/LOCAL_VOICES.md), [Pocket runtime](docs/POCKET_TTS_RUNTIME.md), [voice reference activation](docs/VOICE_SOURCE_ACTIVATION.md), [streamed audio](docs/CONVAI_AUDIO_STREAMING.md), [expressions](docs/COMPANION_EXPRESSIONS.md), and [subtitles](docs/OVERHEAD_SUBTITLES.md).

### Knowledge, memory, and relationships

- Characters receive the tracked quest and its active, revealed objectives, plus reviewed current-game facts. Tracked objectives are not treated as completed choices, and summoning a copy does not change the story.
- Character background and speaking direction draw on researched lore and verified game material. Major characters have more information than brief quest contacts.
- **One persistent player identity** is shared across characters, channels, and saves. Characters build memory through actual conversations; unused characters are not sent memory-seeding requests.
- **Settings → Memory** provides **Forget selected character** and **Forget all memories**, with confirmation. A successful reset also removes the matching phone Chat messages and drafts. It retains your player identity.
- **Settings → Relationships** has separate **Auto / On / Off** choices for Judy, Panam, River, Kerry, and Meredith. Auto uses reviewed relationship facts from the loaded save; On selects the alternate conversation profile; Off selects the ordinary profile. Meredith's alternate reflects an intimate encounter, rather than an ongoing romance. These choices do not write quest facts.
- In a group, a character can acknowledge their own save-confirmed relationship when relevant and respond with characteristic banter. Intimate scene details and earlier private chats remain private; On alone supplies no relationship history.

Quest coverage is selective: the current reviewed native pack maps **188 of 1,160 researched outcomes** through 195 rules. Other researched branches are not automatically usable as current-save knowledge. See [quest context](docs/QUEST_CONTEXT.md), [knowledge coverage](docs/CHARACTER_KNOWLEDGE_COVERAGE_2026-10-01.md), [player memory](docs/PLAYER_MEMORY.md), [Chat resets](docs/CHAT_MEMORY_RESET.md), and [relationships](docs/RELATIONSHIP_PROFILES.md).

### Reactions and interface languages

- Nearby companions can make a short comment when combat starts and another after it ends.
- Collected world loot can prompt a comment after a pickup batch. Storage transfers stay silent, and newly acquired Legendary equipment has a separate cooldown.
- Battle and loot comments play as separate turns, one after another. Manual conversations and scripted scenes take priority.
- The interface supports English, Simplified Chinese, Traditional Chinese, Spanish, Brazilian Portuguese, French, German, Russian, Japanese, and Korean. Automatic follows the game's interface language; manual selection changes the mod UI independently of voice or conversation language.

See [battle reactions](docs/BATTLE_REACTIONS.md), [loot reactions](docs/LOOT_REACTIONS.md), and [interface languages](docs/INTERFACE_LANGUAGES.md).

## Requirements

The current development setup targets **Cyberpunk 2077 2.31, Windows x64**, and uses these installed frameworks:

| Framework | Development version |
|---|---|
| Cyber Engine Tweaks (CET) | 1.37.1 |
| RED4ext | 1.30.0 |
| redscript | 0.5.31 |
| Codeware | 1.20.5 |
| TweakXL | 1.11.4 |
| Audioware | 1.9.9 |
| Mod Configuration Menu (MCM) | 0.10.3 |

Conversation setup also needs internet access, a Convai API key, and character mappings for the account you use. The development bridge uses Node.js, the dependencies pinned in `package-lock.json`, and Playwright with Microsoft Edge. It runs as a hidden helper and must currently be started explicitly.

Pocket additionally needs a prepared CPU Python environment, the approved student export, attributed reference recordings, and the local phonetic lip-sync tool. Shared weights occupy **417.74 MiB on disk**; the verified CPU benchmark peaked at about **1.69 GiB RAM** and used **no VRAM**. Dependency and reference storage are additional. Convai voices do not require the local model. [Pocket runtime setup and qualification](docs/POCKET_TTS_RUNTIME.md) distinguishes the controlled WSL benchmark, native Windows integration checks and pending game activation.

Native facial assets are generated from the installed game with the project's facial builder. Generated assets, credentials, account mappings, extracted dialogue, and Python environments are not supplied by a fresh source checkout. [Packaging](docs/PACKAGING.md) records the dependencies and remaining portability work.

## Install (development build)

There is no finished one-click or two-ZIP installation yet. Use the following flow with a prepared development checkout:

1. Install the required game frameworks and close Cyberpunk before replacing native files. Preserve other mods and your framework configuration.
2. From the project directory, install the pinned JavaScript dependencies and set your actual game path:

   ```powershell
   npm ci
   $gameDirectory = 'C:\Games\Cyberpunk 2077'
   $env:CYBERPUNK_CONVAI_GAME = $gameDirectory
   ```

3. Create the ignored local file `runtime/convai-key.txt` with one line:

   ```text
   api-key=YOUR_CONVAI_API_KEY
   ```

   Configure the account's `runtime/characters.json` mapping and any relationship profiles. See [character setup](characters/README.md) and [the three-field API contract](docs/CHARACTER_API.md). `npm run profiles:plan` previews provisioning; applying the plan is an explicit account operation.
4. Prepare the generated facial archive and speech assets. The facial builder requires its documented WolvenKit/.NET tools; [facial animation](docs/FACIAL_ANIMATION.md) describes that setup. Build the ambient-car Johnny guard from the reviewed 2.31 game resource with `python scripts/Build-AmbientJohnnyDriverGuard.py --game $gameDirectory --stage-development`; it stages a generated archive in this project. Use the explicit [Pocket voice preparation](docs/POCKET_TTS_RUNTIME.md), or select Convai in Settings. Local reference files are not automatically downloaded by the mod.
5. With the required generated assets available, prepare the speech bank and install the development adapter:

   ```powershell
   node scripts/Prepare-SpeechAudio.mjs $gameDirectory
   .\scripts\Install-DevelopmentMod.ps1 -GameDirectory $gameDirectory
   ```

6. Start the hidden conversation bridge, then launch Cyberpunk normally:

   ```powershell
   .\scripts\Start-ConversationBridge.ps1
   ```

7. Load a save. Open CET's **Bindings**, assign shortcuts to the mod actions, and save. Open **Companion Manager**, choose **Characters**, invite someone, and return to gameplay after preparation.

The installed game adapter is at:

```text
bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/
```

### Planned downloads

| Proposed archive | Contents | Status |
|---|---|---|
| `CyberpunkConvai-Scripts.zip` | Lua adapter and interface dictionaries | Planned |
| `CyberpunkConvai-Runtime.zip` | Catalogs, native scripts/assets, bridge/browser, local voice runtime and notices | Planned |

The intended release will use matching archives extracted into the game directory. Neither archive is currently a qualified portable installer. The [release plan](packaging/release-plan.json) and [packaging document](docs/PACKAGING.md) track the remaining work.

### Update and keep your data

Lua updates can be installed with `Install-DevelopmentMod.ps1 -LuaOnly`, then activated through CET's **Reload All Mods**. Loading a save does not activate new Lua code. Native scripts, archives, or plugin updates need a game restart. Bridge changes need a bridge restart; `Start-ConversationBridge.ps1` rebuilds its browser client before launch.

Preserve both the project's `runtime` state and the installed mod's `runtime` state. They hold account configuration, player identity, settings, sessions, Chat history, and drafts. In particular, retain both `player-memory.json` and `player-memory.json.identity`. Installers create local rollback receipts and backups; updates should preserve CET's global bindings and other mods.

## Controls

Open **CET → Bindings**, choose a suitable key or chord for each action below, and save. The mod registers these actions but does not assign or overwrite your shortcuts. In-game microphone hints use your current binding.

| CET action | Use |
|---|---|
| **Cyberpunk Convai: companion manager** | Open the native MCM Companion Manager |
| **Cyberpunk Convai: talk by text** | Open a private text conversation with the addressed character |
| **Cyberpunk Convai: talk by voice** | Start or finish private microphone capture |
| **Cyberpunk Convai: group text chat** | Open a group text conversation |
| **Cyberpunk Convai: group voice chat** | Start or finish group microphone capture |

Face the character you want to address before opening a conversation. A group requires at least two distinct enabled nearby profiles and uses at most three. Looking at an unsupported actor reports that target rather than silently selecting a different character.

For voice input, press the assigned shortcut, wait for **Listening**, speak, then press the same shortcut again. Opening a menu cancels recording. Microphone capture never starts automatically. The microphone flow is implemented, but its live gameplay check remains deferred.

The manager also appears through the game's pause-menu **MCM** entry. Use **Back** to navigate within the manager. Esc from a manager opened through the companion shortcut returns to gameplay.

### Phone

Open the phone through the game's assigned control (normally hold **T**). In **Contacts**, **J** invites the selected supported character and **L** dismisses a copy. Custom invite/dismiss icons appear on the selected row. Their competing menu actions are consumed while the phone is open; the normal journal shortcut works after closing it.

Switch to **Chat**, choose a contact, and use the phone's confirm/message action to open the conversation. **Enter** starts typing and sends; **Esc** stops typing. When you are no longer typing, use the game's normal back/close control. These phone controls are separate from CET conversation bindings.

## Customize

Open **Companion Manager → Settings**. Use **Apply** to save a settings draft or **Revert** to discard it. Memory, Relationships, and Character conversations have their own pages with Back controls.

| Setting | New-user default |
|---|---|
| Companion voices | Pocket TTS |
| Voice playback | On |
| Subtitles | On, Dialogue HUD |
| Follow-up questions | Off |
| React to battles | On |
| React to collected loot | On |
| Interface language | Automatic |
| Relationship choices | Auto |
| Eye contact height | Default |
| Head tracking strength | Gentle |
| Character conversations | Enabled |

Existing saved choices take precedence. Older Omni choices retain their 16/32 quality; a saved Convai choice remains Convai. The single voice selector contains Pocket TTS, OmniVoice 16, OmniVoice 32 and Convai. Local selection requests preparation before Apply; Revert or leaving unsaved Settings cancels that preview. There is no separate quality row, per-character voice-provider selector or disappearing-message option. Exploration observations do not trigger automatic replies.

Ordinary battle and loot reactions have independent ten-minute cooldowns. Newly acquired Legendary equipment has a separate two-minute loot cooldown. Save changes reset reaction context and cooldowns, while player identity and Chat history remain.

## Help and support

For a problem report, include the game/framework versions, the selected voice provider, the exact action you took, and what happened. State whether you restarted the game or used CET's **Reload All Mods** after installing changes. For voice issues, check the game's **Master Volume** and **Dialogue Volume**, and the Windows output mixer.

Useful local diagnostics include `party-connection-state.json`, `bridge-latency.json`, `local-voice-state.json`, and `speech-state.json` in the installed mod's `runtime` directory. Bridge startup errors are in the project's `runtime/bridge.stderr.log`; adapter messages appear in CET's log. Share the relevant error and reproduction steps, keeping API keys, player/session identifiers, and private conversations out of a public report. There is no packaged sanitized support-report button yet.

See the [runtime guide](bridge/README.md) for connection/playback details and the [development audit](docs/DEVELOPMENT_AUDIT_2026-09-30.md) for investigation methods. A feature change should update this README's behavior, controls, defaults, or limitations alongside its detailed document. Source checks, installed checks, and live acceptance should be recorded separately.

## Known development limitations

- **Companion chauffeur:** Johnny's boarding, manual passenger entry, changed-waypoint driving, arrival, exit and following afterward have user acceptance. A new report says he sometimes pauses on the approach to the driver's door until V catches up; that boarding case is under investigation. The mount-time subtitle replay correction has focused source coverage and awaits a live check. Overflow convoys and fast travel still need wider acceptance. Asking a companion to drive is the entry point; Current party exposes status and Stop trip.
- **Vehicles and travel:** ordinary passenger boarding and seated head attention have been checked. Overflow carpooling, convoy recovery, and fast-travel restoration have implementation/test coverage but need wider live acceptance. Regular save loading does not automatically respawn the party.
- **Special models and navigation:** different rigs, large bodies, story variants, and unusual combat behavior need individual gameplay checks. Collision/placement checks are installed, but walking around props and vehicles still needs live acceptance. A safe nearby spawn may be refused.
- **Conversation quality:** biographies, voice references, and current-save mappings have uneven depth. Cloned speech is not guaranteed to match every original performance, and facial animation still varies by rig. Provider availability, local GPU load, and power settings affect latency.
- **Memory:** all saves share one player identity. A remembered conversation can refer to another save; current game context takes priority. Generic resident templates share profile-level memory, rather than unique durable memory for each pedestrian.
- **Microphone and distribution:** private/group voice input has source tests but its live check was deferred. Portable runtime/bootstrap, complete release notices, and installation on a clean machine remain unfinished.

Summoned copies do not recruit, revive, or alter story actors. They are temporary mod-owned copies, and party membership is not restored after an ordinary save reload, game restart, or CET reload.

## Remove

Stop the hidden bridge with `scripts/Stop-ConversationBridge.ps1`, close Cyberpunk, and back up the runtime state if you want to retain your identity and histories. Remove only this mod's installed content:

```text
bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/
r6/scripts/CyberpunkConvai/
r6/audioware/CyberpunkConvai/
archive/pc/mod/convai_facial.archive
archive/pc/mod/cyberpunk_convai_ambient_driver_guard.archive
```

Keep CET, RED4ext, redscript, Codeware, TweakXL, Audioware, and MCM when other mods use them. The project-side runtime and extracted references remain in the development checkout unless you separately remove that checkout.
