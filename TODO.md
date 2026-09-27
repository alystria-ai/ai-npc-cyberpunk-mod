# Cyberpunk Convai overhaul

This is the running request and verification list. A checked item means the behavior was seen in the game or directly verified; code alone does not close an item. Update this file when a request is added or a test changes the result.

## Companion experience

- [x] Spawn mod-owned copies of Judy and Panam without changing the role of ambient pedestrians. Judy was visible and followed V in a live save.
- [x] Support multiple characters and duplicate copies in one party. A Judy, Panam, second Judy party spawned and moved in a live save.
- [x] Keep stable side positions as V turns the camera; run to catch up when V runs. Both were observed in the live group test.
- [x] Spawn the nearest companion beside V without bumping V; bring the nearest side position to about 1.5 metres. Measured in-game after the latest spawn.
- [x] Give companions a subtle look toward V, a full body turn and small footstep when V looks at one, then turn back when V looks away. The latest footstep and softer upper-body look were accepted in the live Judy test.
- [ ] Recheck the latest look, footstep, return turn, and closer spacing with a group of at least three, including duplicate copies, during walking and running.
- [x] Show each active managed copy on the minimap with a marker that follows it and disappears on dismissal. The game's follower role supplies a green marker per copy: Judy, Panam, and a second Judy showed three distinct markers with our custom pin disabled; dismissing Panam left two. The extra custom mappin and world-widget hook were removed.
- [x] Settle facing the correct travel direction after following V at a run. Confirmed in the live Judy test.
- [x] Prevent a second sideways attention step after Judy first repositions. A fresh live test showed one 0.16-metre step, a full turn toward V, and no extra backward move.
- [ ] Make group walking feel like friends beside V across turns, obstacles, sprint catch-up, and stopping, rather than an escort or a rigid formation. Continue live tuning of the current controller.
- [ ] Decide how companions persist across save loads, fast travel, vehicles, combat, and game reloads; restore or clean them safely.

## Interaction and conversation

- [ ] Fix the current missing response to "hey". The managed Alex was reported by the engine as Alena Xenakis; the legacy router did not match her and the bridge was stopped. Added canonical managed identity, Alex/Kerry profiles, a hidden bridge launcher, explicit reply errors and a 40-second timeout. Direct Alex API reply succeeded; the adapter is installed; in-game display still needs verification.
- [ ] Add a native text composer inside each contact's phone message panel, with per-contact conversation history and replies in that panel, without opening CET.
- [x] Use a game-styled native text input that accepts typing without opening CET. Basic live text exchange with Convai worked.
- [ ] Finish the text conversation flow: per-character sessions, loading and error states, replies, cancellation, and return to gameplay.
- [ ] Add F7 single-character voice interaction with press to start and press again to finish, Convai Kokoro voices for each character, audible playback, and in-game lip sync; verify in a live conversation.
- [ ] Add F8 group text and F9 group voice. Follow Dawnwalker's individual-client coordination: addressed or nearest speaker first, up to two other distinct nearby identities, listener-scoped context, and orderly reply playback. Multiple copies of one identity remain one speaker.
- [ ] Use the same LLM model as the Dawnwalker mod for Convai characters and check that the configured character IDs and voices are actually applied. The older Cyberpunk mod supplies existing IDs.
- [ ] Have one nearby NPC react to V looking at them before pressing Talk, selected by both gaze and distance; release the reaction when V looks away. Still or managed NPCs are the priority. Walking crowd NPCs are optional if a safe, reversible method is found.
- [ ] Ensure the look and conversation behaviors do not seize quest actors or leave pedestrians stuck. An earlier crowd-role experiment crashed; that approach is retired.

## In-game management and controls

- [x] Prevent phone J/L actions from also triggering normal game shortcuts. A scoped CET menu-action guard was installed live; the user confirmed J/L work in Contacts and J works normally after closing.
- [ ] Support contacts unlocked later in the same playthrough automatically when they appear in the phone; include inactive journal contacts in the catalog without unlocking quests or contacts for the player.
- [ ] Replace the current native Codeware popup prototype with a proper full companion manager menu page, independent of Mod Configuration Menu if feasible.
- [ ] Make the manager operate on the actual party: enable/disable characters, create or dismiss multiple copies, choose voices, and show each copy's current state. Keep controls and saved settings in sync with the runtime.
- [ ] Add custom cyan person-plus/person-minus icons to the selected phone contact beside message and call. User rejected the first build's alignment and requested **J invite / L dismiss**. The corrected native source reserves name-label space and matches native keyboard-hint dimensions. Installed; the user confirmed the phone action worked. A screenshot of the latest alignment is still needed. In-row invite/dismiss confirmation is compiled and installed; live visibility still needs checking. The phone is keyboard operated, not mouse clickable.
- [ ] Support all phone contacts, not only the initial four conversation profiles. `characters/phone-contacts.json` now covers all 101 journal contacts (including inactive entries) plus Misty: 77 contact mappings to existing character records, including aliases, and 25 explicit unavailable entries for services, drones or unmapped physical characters. New contacts use the same native selected-row path when the game unlocks them; no quest state is changed. The expanded 102-entry catalog is installed. Record existence is verified; most newly mapped characters still need live spawn/follower checks. Delamain drone support remains open.
- [ ] Match Dawnwalker's five controls: F5 manager, F6 single text, F7 single voice, F8 group text, F9 group voice. The local reference confirms this in `bridge/ModKeyBindings.cs` and `README.md`. Bind F5/F6 now; add the remaining bindings as their modes are implemented. Phone join and dismiss use their own on-screen controls.
- [ ] Keep native UI styling for text boxes and menu controls, with mouse and keyboard navigation and a reliable way to close screens.

## Updated Dawnwalker reference: 0.5.5 (September 28)

Port the intent to V and Cyberpunk systems; do not assume Dawnwalker APIs, Coen's relationships, or Horde events exist here. Reference archives: `ref mods/DawnwalkerConvai 0.5.5 Scripts*` and `*Multilingual*`. These are requested features, not completed behavior.

- [ ] Blend smiles, blinking and emotion-driven facial reactions with speech and lip sync; avoid competing face animations and restore normal expressions afterward.
- [ ] Native head tracking with adjustable first-person eye contact; retain the accepted subtle side glance/full focused look and natural footstep behavior.
- [ ] Optional natural follow-up questions. In a group, only the final speaker asks V a follow-up; coordinate turn completion so speakers do not repeatedly reopen the conversation.
- [ ] Optional reactions to V's solo exploration observations and batches of newly collected loot, both default On with independent settings and cooldowns. Suppress reactions during scripted dialogue and storage withdrawals. Newly acquired Legendary-tier equipment can receive a special reaction.
- [ ] Discuss the active quest and only objectives revealed in the current save. Supply verified game context without spoilers or invented quest progress.
- [ ] Battle opening/ending reactions, default On; ten-minute cooldown after combat, reset reaction cooldowns on save load. Combine battle context, V's observation and recent loot into one post-battle reply instead of overlapping comments.
- [ ] Retain recent battle context: observed actor names, enemy types and relevant encounter progress. Adapt Dawnwalker's cleared-Horde-wave context only if Cyberpunk provides an equivalent verified event.
- [ ] Text and microphone conversation privately or in groups of up to three distinct nearby speakers, with voiced replies, subtitles, facial animation and gentle distance-based volume. Duplicate companion copies do not become duplicate speakers.
- [ ] Ten interface languages with automatic detection and manual selection, English, Simplified Chinese, Traditional Chinese, Spanish, Brazilian Portuguese, French, German, Russian, Japanese and Korean (confirmed in the new reference). Keep interface language independent of conversation voices.
- [ ] Optional multilingual conversation profile pack with separate character IDs and voices supporting 25 languages, including Russian, Spanish, French, Arabic and Japanese. Verify Convai voice capability and preserve the default Kokoro setup.
- [ ] Native overhead subtitles advancing in short spoken phrases above the current speaker, default On; offer the regular subtitle/conversation HUD in settings. Synchronize with actual speech timing.
- [ ] Per-character relationship profiles: Auto follows verified relationship history in the current save, On selects a romantic profile, Off selects the ordinary profile. Adapt Anca/Lacra behavior to appropriate Cyberpunk companions rather than copying their identities or flags.
- [ ] When the save verifies multiple relevant relationships and those characters are in group chat, allow character-specific relationship acknowledgement and banter without inventing relationship history.

## Architecture and release readiness

- [ ] Complete a fresh Cyberpunk overhaul guided by the Dawnwalker AI companion philosophy and features. Reuse or port good code when it fits, but do not carry over the old Cyberpunk mod's janky structure.
- [ ] Review the old Convai Cyberpunk mod, the Dawnwalker source, and the supplied `ref mods` archives when implementing each feature; record important compatibility choices.
- [ ] Keep the Convai key outside the project and out of published files. Character configuration and local bridge must work with the user's own account.
- [ ] Add repeatable diagnostics and real-game acceptance checks for the manager, phone action, text, voice, lip sync, multi-copy lifecycle, and minimap markers.
- [ ] Prepare a distributable mod with clear prerequisites and install instructions after the live feature checks pass.
- [ ] When publishing is authorized, use the user's personal account rather than the work account; confirm the intended account before GitHub or mod-site actions.

## Current setup notes

- Game: `E:\SteamLibrary\steamapps\common\Cyberpunk 2077`.
- Sources: `mod/`, `r6/scripts/CyberpunkConvai/`, `bridge/`, and `characters/`.
- Reference sources: `vendor/reference-convai-github/`, `vendor/reference-dawnwalker/`, and `ref mods/`.
- The game is running for live testing. Ask the user for in-game observations; they retracted Computer Use. When a restart is needed, install first and launch the game EXE for them.
- The follower role already provides a clean green minimap marker per managed copy. The custom mappin experiment added a missing-texture square and proved unnecessary; its game scripts are quarantined under ignored `vendor/unused-game-hooks/`. The save-load crash was caused by CET replaying a stale diagnostic spawn request and was fixed separately.
- September 28 phone recovery: the Lua live preview's path lookup resolved to the contact-row root. Clearing its children blanked the phone. Preview callbacks were disabled through diagnostics, the loader was removed, and the failed helper was quarantined under ignored `vendor/retired-phone-preview/`. User's subsequent screenshot confirmed the list returned. Do not repeat this raw Lua widget-path approach or call `RemoveAllChildren` on unresolved widgets. Typed redscript references are used by the replacement.
- Installed September 28: corrected J/L native controls, initial 52-entry catalog, and explicit wait until the phone closes. The user confirmed spawning worked. The journal-conflict guard is also active live and user-confirmed. Installed in the combined restart: in-phone action confirmation, expanded 102-entry catalog, authoritative companion identity in text requests, reply errors/timeouts. Redscript compilation, CET Lua syntax checks and bridge protocol tests pass. The user-selected key is now stored in ignored runtime/convai-key.txt. Alex and Kerry profiles were provisioned with Kokoro voices; Alex returned a text reply and session ID in a direct API test. The hidden bridge is running. The updated game adapter is installed; the in-game reply check remains. Voice and lip sync remain unimplemented.
- Input testing helper: `scripts/Test-GameInput.ps1` restricts input to the verified game process, supports held keys, releases in `finally`, and captures the game viewport. Background PrintWindow capture worked; background window-key messages did not close the pause menu. Foreground held-T injection was delivered, but the game was in Settings, so phone opening was not validated. User switched back to manual game testing; do not send further input without renewed authorization.
