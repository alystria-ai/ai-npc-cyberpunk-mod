# Native subtitle display

The default subtitle style is the previously accepted **Dialogue HUD**. F4 → Settings → **Subtitle display** offers **Above speaker** as an optional alternative. The existing Subtitles toggle controls both. Phone Chat keeps its own conversation history UI.

The user rejected the first overhead presentation on September 30: it sat too high and split speech unnecessarily. Dawnwalker is a feature reference, not the presentation specification for Cyberpunk. Missing or invalid preferences and MCM's reset action now choose Dialogue HUD; an explicitly selected overhead preference still persists. The current live preference was restored through the running manager's save transaction.

## Rendering and ownership

- `mod/subtitles.lua` sends `scnDialogLineType.OwnerlessRegular` to the existing dialogue HUD by default. The optional `OverHead` route binds the exact attached, living speaker. Native `ChattersGameController` owns fonts, range, scanner visibility and entity projection.
- Optional overhead pages contain up to 120 Unicode code points. Complete short sentences stay together, including adjacent sentences; there is no word-count cutoff. Only overlong text wraps, preferring a late sentence/clause boundary. Dialogue HUD pages retain the previous 160-character limit and text-only reading time. No UTF-8 character is split.
- Only the exact owned overhead projection receives a lower `fixedWorldOffset`: +0.05 m instead of the native NPC chatter's +0.30 m. Native `UI_Interaction`/`UI_Subtitles` slot anchoring stays intact. The original offset is restored on removal or root reuse; unload abandonment drops references without native calls. If the adjustment fails, the caption keeps native placement.
- Each phrase receives a new mod-owned CRUID. Only those exact IDs are hidden; actor-wide removal is never used.
- The renderer receipt uses `ObserveAfter`, because CET's `Observe` is a before-hook. An `IsBubble` override requests expanded text only for the owned root. Ownership uses a unique token for each render, because CET may supply different Lua wrappers for the same native widget. Foreign and retired roots delegate normally. The override is covered by unit tests, but its interception has not been observed in the live game, so always-expanded text is not a verified guarantee.
- A missing or mismatched speaker, or disabled native Overheads setting, falls back to the dialogue HUD. The mod does not change global game subtitle preferences. The native Cinematic setting still controls HUD visibility.

## Timing and lifecycle

Voiced phrases appear only once the actual native audio cursor advances. Page timing is estimated by character length **within the current audio chunk** and driven by that cursor. This is not forced word alignment. Pausing audio freezes page progression; streaming gaps never advance captions to text that is not playing.

Text-only replies use bounded reading times. Every voice-off/error/partial-stream fallback retains the exact speaker identity. Per-copy dismissal clears that copy's presentation before deletion. Detachment/death/load abandonment releases references without calling the old HUD. Manual interruption, completion and group speaker changes clear the prior owned line.

## Verification

September 30: the initial overhead route rendered on the exact Judy copy, but the user rejected its height, fragmentation and default selection. The correction restored the live and saved choice to Dialogue HUD without reloading CET or restarting the game. All conversation enable flags and voice settings were preserved.

A bounded live preview on Judy `11073355ULL` rendered the complete two-sentence example as one page, and the native projection read back `worldOffsetZ = 0.050000000745058`. This verifies the applied anchor and page count, not visual acceptance of the optional layout. Evidence is in ignored `runtime/subtitle-lower-anchor-live-20260930.json`.

The subsequent default-layout preview reached `SubtitleLineLogicController` with a visible native dialogue widget, and both previews expired normally. The saved choice remained Dialogue HUD. Evidence: ignored `runtime/subtitle-dialogue-restored-live-20260930.json`. All 40 focused subtitle, manager (including the installed MCM API) and speech-stream playback checks pass in `runtime/subtitle-correction-final-checks-20260930.log`; installed Lua hashes match source.

Focused tests cover Unicode splitting, cursor/pause behavior, text-only paging, exact-copy binding and cleanup, native setting fallback, renderer reuse, wrong/stale render receipts, mute/partial-stream ownership, and cleanup before entity deletion. Manager tests cover defaults, persistence, failed writes, provider preservation and the installed MCM API.

Source references: the local game scripts `UI/subtitles/chattersControllers.script`, `baseSubtitlesControllers.script` and `core/ui/screenProjection.script`; [CET observer semantics](https://wiki.redmodding.org/cyber-engine-tweaks/patch-notes).

Read-only diagnostics: `subtitles-state:<nonce>` reports adapter state; `overhead-state:<nonce>` reports the native root and last exact render receipt. `subtitles-preview:<dialogue|overhead>:<nonce>` displays one eight-second test line only when the game is unpaused and no reply is active, without changing the preference. `overhead-probe:<nonce>` is an overhead preview alias. `subtitles-style:<dialogue|overhead>:<nonce>` intentionally changes the preference through the running MCM provider's save transaction. `subtitles-refresh:<nonce>` refreshes Lua and the live MCM reset default without disturbing drafts.
