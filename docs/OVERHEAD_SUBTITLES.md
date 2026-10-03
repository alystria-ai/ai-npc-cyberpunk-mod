# Native subtitle display

The default subtitle style is the previously accepted **Dialogue HUD**. Companion Manager → Settings → **Subtitle display** offers **Above speaker** as an optional alternative. The existing Subtitles toggle controls both. Phone Chat keeps its own conversation history UI. An explicitly saved Above speaker selection remains selected; installing the stability correction does not rewrite it.

The user rejected the first overhead presentation on September 30: it sat too high and split speech unnecessarily. Dawnwalker is a feature reference, not the presentation specification for Cyberpunk. Missing or invalid preferences and MCM's reset action now choose Dialogue HUD; an explicitly selected overhead preference still persists. The current live preference was restored through the running manager's save transaction.

## Rendering and ownership

- `mod/subtitles.lua` sends `scnDialogLineType.OwnerlessRegular` to the existing dialogue HUD by default. The optional `OverHead` route binds the exact attached, living speaker. Native `ChattersGameController` owns fonts, range, scanner visibility and entity projection.
- Optional overhead pages contain up to 120 Unicode code points. Complete short sentences stay together, including adjacent sentences; there is no word-count cutoff. Only overlong text wraps, preferring a late sentence/clause boundary. Dialogue HUD pages retain the previous 160-character limit and text-only reading time. No UTF-8 character is split.
- A verified `Head` slot on the exact actor's native slot component anchors the owned overhead projection to the animated head, including seated poses. It adds +0.25 m above that head centre. This follows the game's projection interface rather than sampling actor-root height each frame. If the rig has no readable Head slot, native `UI_Interaction`/`UI_Subtitles` anchoring retains the previously accepted +0.15 m offset. The original component, slot names and offset are restored on removal or root reuse; unload abandonment drops references without native calls.
- One overhead utterance owns one CRUID and projected widget. Transcript growth and page advancement update only that owned controller's plain-text normal/wide refs. They do not call `SetLineData` again, because native `SetLineData` resets projection entity and initially displays a bubble. Unsupported refs fall back to replacing only the owned caption and report `renderUpdateError`; foreign text is never edited. Dialogue HUD pages keep their native replacement path. Only exact mod-owned IDs are hidden; actor-wide removal is never used.
- The renderer receipt uses `ObserveAfter`, because CET's `Observe` is a before-hook. A unique **native CName value** plus exact actor ownership identifies the controller across different CET wrappers. Fresh `CName.new(text)` values need not have text in the game's name pool, so ownership never compares `NameToString` with a generated Lua string. The native value is read back before any root is concealed. An `IsBubble` override requests expanded text only for that owned root. Two regular Lua frame ticks suppress initial cached layout; the root then regains its original visibility even when native projection readiness or callback interception is unavailable. Only owned text/bubble children are clipped by native viewport/range status. Native `UpdateProjection` always runs. The owned controller ignores the unrelated nameplate's 30-pixel vertical adjustment, which otherwise moves text as aim changes. Foreign and retired roots delegate normally. The corrected hooks/private-ref bindings have source/fixture verification; fresh in-game visual acceptance is pending.
- A missing or mismatched speaker, or disabled native Overheads setting, falls back to the dialogue HUD. The mod does not change global game subtitle preferences. The native Cinematic setting still controls HUD visibility.
- When V or the speaking companion is mounted in a live vehicle, replies use the dialogue HUD even if Above speaker is selected. Mounting into a chair or an empty zero-parent mount record does not count. If boarding happens during a reply, the owned overhead is retired and only unread continuation enters the HUD, with the same audio cursor. That utterance remains in the HUD on exit; the next reply reevaluates the saved style. No subtitle preference is rewritten.

## Timing and lifecycle

Voiced text appears only once the actual audio cursor advances. Page timing is estimated by character length within the caption timeline passed by playback: the continuous Convai utterance, or the current Omni audio phrase. This is not forced word alignment. Pausing audio freezes page progression; streaming gaps never advance captions to text that is not playing. Improving an audio-duration estimate updates local timing without redisplaying unchanged text in either subtitle mode.

Text-only replies use bounded reading times. Every voice-off/error/partial-stream fallback retains the exact speaker identity. Per-copy dismissal clears that copy's presentation before deletion. Detachment/death/load abandonment releases references without calling the old HUD. Manual interruption, completion and group speaker changes clear the prior owned line. Cleanup immediately conceals the exact owned root before restoring its original projection: `HideDialogLine` is delayed, so restoring while the root is visible would raise the caption for a frame before it disappears.

## Verification

September 30: the initial overhead route rendered on the exact Judy copy, but the user rejected its height, fragmentation and default selection. The correction restored the live and saved choice to Dialogue HUD without reloading CET or restarting the game. All conversation enable flags and voice settings were preserved.

A bounded live preview on Judy `11073355ULL` rendered the complete two-sentence example as one page, and the native projection read back `worldOffsetZ = 0.050000000745058`. This verifies the applied anchor and page count, not visual acceptance of the optional layout. Evidence is in ignored `runtime/subtitle-lower-anchor-live-20260930.json`.

The user then reported that placement was a little low. Raised it to +0.15 m without a reload; a new native preview confirmed the updated offset. Sixteen focused subtitle checks pass. Evidence: ignored `runtime/subtitle-height-raised-live-20260930.json`. The regular HUD remains the default; the user's current optional-overhead selection is preserved.

The subsequent default-layout preview reached `SubtitleLineLogicController` with a visible native dialogue widget, and both previews expired normally. The saved choice remained Dialogue HUD. Evidence: ignored `runtime/subtitle-dialogue-restored-live-20260930.json`. All 40 focused subtitle, manager (including the installed MCM API) and speech-stream playback checks pass in `runtime/subtitle-correction-final-checks-20260930.log`; installed Lua hashes match source.

Focused tests cover Unicode splitting, cursor/pause behavior, text-only paging, exact-copy binding and cleanup, native setting fallback, renderer reuse, wrong/stale render receipts, mute/partial-stream ownership, and cleanup before entity deletion. Manager tests cover defaults, persistence, failed writes, provider preservation and the installed MCM API.

Source references: the local game scripts `UI/subtitles/chattersControllers.script`, `baseSubtitlesControllers.script` and `core/ui/screenProjection.script`; [CET observer semantics](https://wiki.redmodding.org/cyber-engine-tweaks/patch-notes).

### October 2 stability correction

The user reported text appearing close to the head, moving upward, then briefly flickering. Installed 2.31 source identified three relevant paths: native `SetLineData` starts with a bubble before projection, native nameplate visibility changes the projection margin by 30 pixels, and our cleanup restored the original offset before the delayed hide callback. Revisions also recreated the native widget when only the duration estimate changed.

The correction retains the overhead root throughout the utterance, binds a verified animated Head slot, suppresses its initial cached position, removes the owned nameplate offset, and hides before placement restoration. `samples/ink/sampleUIControllers.script` demonstrates `Item_Attachment_Slot`/`Head` projection; the actual component name comes from the actor's verified slot component. Previous live seated-head research established CET's one-input `GetSlotTransform(CName.new('Head'))` binding; no root-height guess is used.

The affected gate passed **82/82 checks, no skips**: subtitles, continuous speech, native WAV/phrase playback and installed 2.31 projection/text-ref source contracts. New regressions cover pre-spawn transcript growth, one-root paging, duration-only revisions, hidden cleanup ordering, nameplate/offscreen projection, standing/seated Head slots, original-slot restoration, foreign root reuse, unsupported native text refs and native visibility when an override API is absent. This is source/fixture evidence, not a fresh in-game visual result. Evidence: ignored `runtime/verification/oct02-overhead-subtitle-stability.log` and its adjacent JSON receipt.

Install these changed hooks through a CET mod reload. Hot-loading the file over the old hook version would leave the previous observers registered. `status()` exposes `projectionReady`, `rendered.anchor`, `rendered.worldOffsetZ`, `textUpdates` and `renderUpdateError` for the existing read-only subtitle diagnostics. No new speech, microphone capture, preference change or live-game mutation was performed during this correction.

### Visibility regression found in the first live check

After the combined reload, the user reported no overhead captions. An active eight-second local preview reached the correct actor and Head projection, but its root remained concealed. The live identity probe found that the actual and expected CNames had identical hashes and compared equal natively; both text lookups were empty. The v6 string comparison therefore rejected its own valid root and never released the initialization guard. This was an ownership defect, not evidence of subtitle-duration expiry or a renamed native root.

The v7 correction uses native CName equality and verifies the written name immediately. It also releases initialization concealment after two ordinary Lua frame ticks, independently of the `UpdateProjection` hook and of `IsInScreen`. This avoids a deadlock if native projection ticking depends on root visibility. After that guard, only owned text is hidden outside the native viewport/range; the original root visibility and native projection work are retained. No dynamic names are added to the global CName pool. [CET's constructor/equality implementation](https://github.com/maximegmd/CyberEngineTweaks/blob/master/src/reverse/BasicTypes.h) and [separate name-pool insertion](https://github.com/maximegmd/CyberEngineTweaks/blob/master/src/reverse/BasicTypes.cpp) explain this distinction.

Root diagnostics captured `runtime/verification/oct02-overhead-active-preview.json` and `oct02-overhead-cname-identity.json`. Those local previews did not start audio, send provider requests, change memory or alter preferences. New regressions emulate unavailable dynamic-name text, registered hooks that never receive native calls, repeated callbacks within one frame, silent failed name writes, and offscreen/invalid readiness throughout initialization. The corrected affected gate passed **86/86 checks with no skips**, including the installed 2.31 source contract: `runtime/verification/oct02-overhead-cname-visibility.log`. This gate is separate from the initial 82-check source pass; fresh visual acceptance remains pending.

`status()` additionally exposes `projectionCallbacks`, `projectionFrames`, `projectionError` and `renderVisibilityError`. A positive callback count verifies interception; regular-frame visibility has its own path and does not require that count. The corrected code still needs CET reload rather than an additional hot-load over v6 observers.

Read-only diagnostics: `subtitles-state:<nonce>` reports adapter state; `overhead-state:<nonce>` reports the native root and last exact render receipt. `subtitles-preview:<dialogue|overhead>:<nonce>` displays one eight-second test line only when the game is unpaused and no reply is active, without changing the preference. `overhead-probe:<nonce>` is an overhead preview alias. `subtitles-style:<dialogue|overhead>:<nonce>` intentionally changes the preference through the running MCM provider's save transaction. `subtitles-refresh:<nonce>` refreshes Lua and the live MCM reset default without disturbing drafts.

### October 2 vehicle presentation

The user requested no floating captions inside vehicles. The native mount check
now selects Dialogue HUD when V or the exact speaker occupies a live vehicle.
Boarding during an existing overhead reply conceals and retires its owned root
before continuing unread text and the playback cursor in the HUD. It does not
rewrite the saved subtitle style or native Cinematic preference.
The original page boundaries also remain fixed for that utterance's subsequent
stream revisions, avoiding skipped words when the two layouts have different
line-length budgets.

The focused subtitle/continuous/phrase playback gate passes 57 checks; the
optional installed-source contract check was skipped without its source-path
environment. The live preview explicitly requested overhead with V seated, then
recorded `vehicle-interior` and `native-dialogue`, with a visible native widget.
A game-window capture confirmed the named bottom caption. Evidence is under
ignored `runtime/verification/vehicle-subtitle-native-read.json` and
`runtime/verification/johnny-vehicle-dialogue-caption-active/`. No reply-service
request or saved-setting change was needed for this preview.

### October 3: boarding without replaying a reply

The user reported that the reply to a driving request appeared overhead on foot,
then appeared again as a cinematic caption after entering the car. The previous
transition called `showPage()` on the same page, which created a fresh native HUD
line and reading duration. Its test also expected that unwanted repetition.

The correction records the Unicode character frontier already presented on foot,
retires that widget, and preserves the audio cursor or text-only reading countdown.
Growing transcripts retain that frontier across pagination changes; only newly
available continuation enters the HUD. A genuinely new utterance resets it, even
when the character repeats the same sentence.

`ownsUtterance()` separates caption ownership from visible-widget state. Automatic
comments and group turns continue waiting while a retired page owns unread text;
manual cancellation and world abandonment release that ownership normally. The
113 focused subtitle, playback, automatic-reaction and lifecycle checks passed,
with one optional installed-source check skipped. The new transition and scheduler
regressions failed before their corrections. Live boarding acceptance remains
pending.
