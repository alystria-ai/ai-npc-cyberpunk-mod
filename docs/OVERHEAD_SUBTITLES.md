# Native overhead subtitles

The default subtitle style is **Above speaker**. F4 → Settings → **Subtitle display** can select **Dialogue HUD** instead. The existing Subtitles toggle controls both. Phone Chat keeps its own conversation history UI.

## Rendering and ownership

- `mod/subtitles.lua` sends `scnDialogLineType.OverHead` through the game's existing dialogue blackboard, with the exact attached, living speaker. Native `ChattersGameController` owns positioning, fonts, range, scanner visibility and the projection above that entity.
- Overhead pages contain at most 64 Unicode code points and 12 whitespace-delimited words, preferring sentence/clause boundaries. Dialogue HUD pages retain the previous 160-character limit. No UTF-8 character is split.
- Each phrase receives a new mod-owned CRUID. Only those exact IDs are hidden; actor-wide removal is never used.
- The renderer receipt uses `ObserveAfter`, because CET's `Observe` is a before-hook. An override prevents only the exact currently owned chatter widget from collapsing into a bubble when another NPC talks closer to screen centre. Native/recycled/stale widgets keep their original behavior.
- A missing or mismatched speaker, or disabled native Overheads setting, falls back to the dialogue HUD. The mod does not change global game subtitle preferences. The native Cinematic setting still controls HUD visibility.

## Timing and lifecycle

Voiced phrases appear only once the actual native audio cursor advances. Page timing is estimated by character length **within the current audio chunk** and driven by that cursor. This is not forced word alignment. Pausing audio freezes page progression; streaming gaps never advance captions to text that is not playing.

Text-only replies use bounded reading times. Every voice-off/error/partial-stream fallback retains the exact speaker identity. Per-copy dismissal clears that copy's presentation before deletion. Detachment/death/load abandonment releases references without calling the old HUD. Manual interruption, completion and group speaker changes clear the prior owned line.

## Verification

September 30: a live diagnostic reached `ChatterLineLogicController.SetLineData` on the requested Judy entity `11072108ULL`, with a native screen projection and visible chatter root. This proves the native route and exact entity binding; visual phrase/layout acceptance remains pending until a real reply is checked.

Focused tests cover Unicode splitting, cursor/pause behavior, text-only paging, exact-copy binding and cleanup, native setting fallback, renderer reuse, wrong/stale render receipts, mute/partial-stream ownership, and cleanup before entity deletion. Manager tests cover defaults, persistence, failed writes, provider preservation and the installed MCM API.

Source references: the local game scripts `UI/subtitles/chattersControllers.script` and `baseSubtitlesControllers.script`; [CET observer semantics](https://wiki.redmodding.org/cyber-engine-tweaks/patch-notes).

Read-only diagnostics: `subtitles-state:<nonce>` reports adapter state; `overhead-state:<nonce>` reports the native root and last exact render receipt. `overhead-probe:<nonce>` displays one eight-second test line on the nearest managed companion only when the game is unpaused.
