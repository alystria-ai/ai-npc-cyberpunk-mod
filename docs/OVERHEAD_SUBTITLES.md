# Native subtitle display

The default subtitle style is the previously accepted **Dialogue HUD**. Companion Manager → Settings → Voices → **Subtitles** is one list: Off, Cinematic subtitles (the Dialogue HUD) and **Above the speaker**. Off is what the old Subtitles switch off meant, and it keeps the style that was chosen. Phone Chat keeps its own conversation history UI. An explicitly saved Above speaker selection remains selected; installing the stability correction does not rewrite it.

The user rejected the first overhead presentation on September 30: it sat too high and split speech unnecessarily. Dawnwalker is a feature reference, not the presentation specification for Cyberpunk. Missing or invalid preferences and Restore defaults now choose Dialogue HUD; an explicitly selected overhead preference still persists. The current live preference was restored through the running manager's save transaction.

## Rendering and ownership

- `mod/subtitles.lua` sends `scnDialogLineType.OwnerlessRegular` to the existing dialogue HUD by default. The optional `OverHead` route binds the exact attached, living speaker. Native `ChattersGameController` owns fonts, range, scanner visibility and entity projection.
- Optional overhead pages contain up to 120 Unicode code points. Complete short sentences stay together, including adjacent sentences; there is no word-count cutoff. Only overlong text wraps, preferring a late sentence/clause boundary. Dialogue HUD pages retain the previous 160-character limit and text-only reading time. No UTF-8 character is split.
- A verified `Head` slot on the exact actor's native slot component anchors the owned overhead projection to the animated head, including seated poses. It adds +0.25 m above that head centre. This follows the game's projection interface rather than sampling actor-root height each frame. If the rig has no readable Head slot, native `UI_Interaction`/`UI_Subtitles` anchoring retains the previously accepted +0.15 m offset. The original component, slot names and offset are restored on removal or root reuse; unload abandonment drops references without native calls.
- One overhead utterance owns one CRUID and projected widget. Transcript growth and page advancement update only that owned controller's plain-text normal/wide refs. They do not call `SetLineData` again, because native `SetLineData` resets projection entity and initially displays a bubble. Unsupported refs fall back to replacing only the owned caption and report `renderUpdateError`; foreign text is never edited. Dialogue HUD pages keep their native replacement path. Only exact mod-owned IDs are hidden; actor-wide removal is never used.
- The renderer receipt uses `ObserveAfter`, because CET's `Observe` is a before-hook. A unique **native CName value** plus exact actor ownership identifies the controller across different CET wrappers. Fresh `CName.new(text)` values need not have text in the game's name pool, so ownership never compares `NameToString` with a generated Lua string. The native value is read back before any root is concealed. An `IsBubble` override requests expanded text only for that owned root. Two regular Lua frame ticks suppress initial cached layout; the root then regains its original visibility even when native projection readiness or callback interception is unavailable. Only owned text/bubble children are clipped by native viewport/range status. Native `UpdateProjection` always runs. The owned controller ignores the unrelated nameplate's 30-pixel vertical adjustment, which otherwise moves text as aim changes. Foreign and retired roots delegate normally. The corrected hooks/private-ref bindings have source/fixture verification; fresh in-game visual acceptance is pending.
- A missing or mismatched speaker, or disabled native Overheads setting, falls back to the dialogue HUD. The mod does not change global game subtitle preferences. The native Cinematic setting still controls HUD visibility.
- When V or the speaking companion is mounted in a live vehicle, replies use the dialogue HUD even if Above speaker is selected. Mounting into a chair or an empty zero-parent mount record does not count. If boarding happens during a reply, the owned overhead is retired and only unread continuation enters the HUD, with the same audio cursor. That utterance remains in the HUD on exit; the next reply reevaluates the saved style. No subtitle preference is rewritten.

## Timing and lifecycle

Voiced text appears only once the actual (heard) audio cursor advances, the same clock the face uses. Continuous speech (Pocket, Convai) pages from audio-aligned sentence cues (see October 8 below): a page changes only when the next page's first sentence is heard. Omni phrases and older producers keep the character-share estimate within the phrase's own audio. Pausing audio or a stalled stream freezes page progression; streaming gaps never advance captions to text that is not playing. A timing revision updates local timing without redisplaying unchanged text in either subtitle mode.

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

Read-only diagnostics: `subtitles-state:<nonce>` reports adapter state; `overhead-state:<nonce>` reports the native root and last exact render receipt. `subtitles-preview:<dialogue|overhead>:<nonce>` displays one eight-second test line only when the game is unpaused and no reply is active, without changing the preference. `overhead-probe:<nonce>` is an overhead preview alias. `subtitles-style:<dialogue|overhead>:<nonce>` intentionally changes the preference through the running manager's save transaction. `subtitles-refresh:<nonce>` refreshes Lua and the live reset default.

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

### October 4 source and installed audit

The boarding correction from `55dc2f9` is already installed. Source and installed
`subtitles.lua` both have SHA-256
`482b4e3a9894cc397d156be9f329bd28b93687d91d0500488cbc313b63783b44`;
`speech.lua` also matches its installed copy. The installed scheduler retains
`ownsUtterance()` while the overhead widget is retired.

The source review followed normal playback, streamed transcript revisions,
mount transitions and completion. Boarding hides the current overhead page
without starting another timed caption or resetting playback. Its character
frontier survives later transcript revisions; genuinely new seated speech
selects the dialogue HUD. No mount-driven playback restart was found in these
paths. Existing regression cases already cover completed replies, unread
continuation, changing pagination, Unicode and repeated wording in a new reply.
They were inspected without rerunning the suite or adding production code.

This confirms the correction is present on disk, not that the currently loaded
Lua or native presentation has been observed during another trip. Fresh native
boarding acceptance remains open; review and installation are complete.

### October 8: captions timed by the heard audio

The user saw a Cinematic subtitle disappear while Judy (Pocket) was still
saying it. Cause: dialogue HUD pages were cut at 160 characters regardless of
sentences (a sentence could start on one page and end on the next), and the
page change came from that page's character share of a duration estimate
(words / 2.5, then the final buffered duration), not from the audio. Real TTS
puts 0.4-1.4 s pauses between sentences and speaks phrases at different rates,
so the change landed seconds away from the words, early or late. Secondary:
the caption was removed at the very last sample, Omni removed each phrase's
caption at its end and showed nothing until the next phrase played, and the
native HUD's `HideDialogLineByData` removes every ownerless line (ours has no
speaker in dialogue mode) when the game ends some other line by data.

Fix:
- `bridge/caption-cues.mjs` splits the displayed text into sentences (very
  long ones at a clause) and aligns each to the audio using the silences in
  the continuous mouth timeline (`speechActivity`/`findPauses` from
  `expression-timeline.mjs`), with a speech-rate model that excludes pauses.
  It errs late: a boundary snaps only to a silence near where the rate puts it
  and never inside the first part of the previous sentence; while streaming,
  a boundary with no silence yet is `null` until the analysed voiced audio is
  0.6 s past its estimate. The cues ride in `runtime/continuous-speech.json`
  as `captions` `{version 1, cues [{text, start, finish}], complete, revision}`.
- `mod/subtitles.lua` merges whole sentences into pages within the layout
  budget (160 HUD, 120 overhead) and shows the page whose first sentence has
  started at the heard position; an unknown boundary keeps the current page.
  A sentence longer than a page is split and timed within its own audio span.
  Without cues it keeps the previous estimate.
- `M.linger`: finished speech keeps its last page 0.6 s, an Omni phrase up to
  3 s until the next phrase is heard. A held caption owns nothing, so group
  turns, reactions and the next speaker are not delayed and replace it at once.
- A `SubtitlesGameController.OnHideLineByData` observer notes when the native
  HUD removed our exact dialogue line and presents the same page again (at most
  20 times per reply). `status()` reports `cueTimed`, `lingering`,
  `nativeRemovals` and `restores`. Hook version 8: install by CET reload.

Tests (`bridge/subtitles.test.mjs`): cue alignment against a mouth timeline
with the live October 8 pause pattern (complete, and growing 50 ms at a time:
no boundary is ever published early), sentence pages through simulated
playback, a slow stream with an unknown boundary, a 10 s stall, a sentence
longer than a page, overhead on one root, the reading hold, native removal,
and an end-to-end run of the real bridge cue builder through `speech.lua` and
`subtitles.lua` (a 3 s buffer lead, a 50 ms lead, and a 2 s stall) asserting
that every audible sentence is on screen. The old Lua fails it: at 7.85 s the
HUD still showed the first page, which ended mid-sentence at "on your".

Regression after the first install (same day): no voiced Cinematic caption
appeared after the CET reload, while a `subtitles-preview:dialogue` line
rendered (`SubtitleLineLogicController.SetLineData` receipt, serial 4) and the
bridge published correct cues. The three replies had used CRUIDs 1-3, because
every CET reload restarted the serial at 0. When the HUD removes one of our
lines by data, that ID stays in its pending-hide list after our own hide, and
the next line spawned with the same ID is removed as it appears; the earlier
sessions' by-data removals (the original vanishing captions) had left IDs 1-3
in that state. The serial now starts from the load clock (100 IDs per second),
so no ID repeats within a game session, and `OnHideLine` is observed as well as
`OnHideLineByData`: any native removal of the exact current dialogue line
re-shows the page (our own hide clears `M.line` before its delayed callback).
Hook version 9; install by CET reload.

Second in-game report: with captions timed and visible, the Cinematic line
blinked at some sentence ends on the same page. The adapter recorded two
native removals of our current line in two replies (`nativeRemovals` 2); each
was re-shown with a new line, which is the blink. Sentence revisions on one
page never reposted the line. The HUD's `RemoveLineByData` drops every line
without an owner whenever any other line is hidden by data, and our dialogue
line had no speaker. It now carries the exact speaker (still
`OwnerlessRegular`, still the bottom HUD; the chatter HUD shows no main-dialogue
line), so only that speaker's own native line can remove it. A page change now
shows the next line before hiding the previous one, which is hidden on the new
line's `SubtitleLineLogicController.SetLineData` receipt or after 0.25 s, so
pages swap without an empty frame. `status()` splits removals into
`removedByData` and `removedOnHide`. Hook version 10; install by CET reload.
The native line duration is not a lifetime: the 2.31 scripts use it only for
the Kiroshi text animation.
