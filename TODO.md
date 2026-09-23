# Cyberpunk Convai overhaul

This is the running request and verification list. A checked item means the behavior was seen in the game or directly verified; code alone does not close an item. Update this file when a request is added or a test changes the result.

## Companion experience

- [x] Spawn mod-owned copies of Judy and Panam without changing the role of ambient pedestrians. Judy was visible and followed V in a live save.
- [x] Support multiple characters and duplicate copies in one party. A Judy, Panam, second Judy party spawned and moved in a live save.
- [x] Keep stable side positions as V turns the camera; run to catch up when V runs. Both were observed in the live group test.
- [x] Spawn the nearest companion beside V without bumping V; bring the nearest side position to about 1.5 metres. Measured in-game after the latest spawn.
- [x] Give companions a subtle look toward V, a full body turn and small footstep when V looks at one, then turn back when V looks away. The latest footstep and softer upper-body look were accepted in the live Judy test.
- [ ] Recheck the latest look, footstep, return turn, and closer spacing with a group of at least three, including duplicate copies, during walking and running.
- [ ] Show each active managed copy on the minimap with a marker that follows it; remove the marker when that copy is dismissed or disappears. The first game mappin drew a missing-texture square on the actor. The later save-load crash was isolated to CET replaying a stale spawn diagnostic; the world-widget hook was removed during isolation. Both marker and hook remain disabled pending a safer implementation.
- [x] Settle facing the correct travel direction after following V at a run. Confirmed in the live Judy test.
- [ ] Confirm the attention step no longer causes a second sideways correction. The fix is coded but needs the next live check.
- [ ] Make group walking feel like friends beside V across turns, obstacles, sprint catch-up, and stopping, rather than an escort or a rigid formation. Continue live tuning of the current controller.
- [ ] Decide how companions persist across save loads, fast travel, vehicles, combat, and game reloads; restore or clean them safely.

## Interaction and conversation

- [x] Use a game-styled native text input that accepts typing without opening CET. Basic live text exchange with Convai worked.
- [ ] Finish the text conversation flow: per-character sessions, loading and error states, replies, cancellation, and return to gameplay.
- [ ] Add voice interaction, Convai Kokoro voices for each character, audible playback, and in-game lip sync; verify in a live conversation.
- [ ] Use the same LLM model as the Dawnwalker mod for Convai characters and check that the configured character IDs and voices are actually applied. The older Cyberpunk mod supplies existing IDs.
- [ ] Have one nearby NPC react to V looking at them before pressing Talk, selected by both gaze and distance; release the reaction when V looks away. Still or managed NPCs are the priority. Walking crowd NPCs are optional if a safe, reversible method is found.
- [ ] Ensure the look and conversation behaviors do not seize quest actors or leave pedestrians stuck. An earlier crowd-role experiment crashed; that approach is retired.

## In-game management and controls

- [ ] Replace the current native Codeware popup prototype with a proper full companion manager menu page, independent of Mod Configuration Menu if feasible.
- [ ] Make the manager operate on the actual party: enable/disable characters, create or dismiss multiple copies, choose voices, and show each copy's current state. Keep controls and saved settings in sync with the runtime.
- [ ] Add a summon/join control to the phone Contacts page beside the existing message and call actions for eligible characters. Let it add or dismiss the chosen companion copy.
- [ ] Match Dawnwalker-style controls. F5 manager and F6 text chat are configured; verify the final bindings and usability in game.
- [ ] Keep native UI styling for text boxes and menu controls, with mouse and keyboard navigation and a reliable way to close screens.

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
- The first NPC map pin showed a missing-texture square on Judy's chest. The experimental world-widget suppression hook is quarantined under ignored `vendor/unused-game-hooks/`. The save-load crash persisted after its removal, then disappeared when CET's stale diagnostic replay was removed. The same save loaded with redscript only and then with repaired CET. Do not re-enable the hook without a separate safe game test.
