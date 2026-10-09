# On-screen notifications

Every popup the mod shows is the game's neutral warning line (`PlayerPuppet:ConvaiPhoneFeedback`). There is one gate in front of it,
`mod/notices.lua`, and every notice belongs to an entry in its catalog. This page lists the catalog; `bridge/notices.test.mjs` keeps the two
in step and fails when a notice is added without a class.

The rule: a player should see as few notices as possible, only where they are waiting on something and would otherwise wonder, or where
something really failed and they have to act. Everything routine is for developers.

| Class | Shown | Meaning |
| --- | --- | --- |
| **Player** | always | An intuitive wait (a conversation starting, the microphone connecting), its outcome, or a real failure the player must act on. Short wording. An identical notice is not repeated inside its window (the "Window" column) while Developer mode is off. |
| **Developer** | Developer mode only | Routine status: dismissals, driving steps, acknowledgements, tactic outcomes, diagnostics. |
| **Removed** | never | Noise even for developers (it repeats something already on screen). |

Settings > Development > Developer mode is off by default and read with a cheap boolean when a notice is about to be shown; nothing here runs
per frame. With Developer mode on every occurrence shows (no repeat windows), so a developer sees the routine notices too.

Not notifications, and not gated: the in-menu status lines (Settings status line, Party page feedback, the phone row's own "INVITE QUEUED -
CLOSE PHONE"), the character's spoken reply and subtitles (`ConvaiShowReply`), and the chat input dialog.

## What a player sees with Developer mode off

Invitation: "{name} joined your group." when the companion arrives (every time, quick or slow), and "{name} could not prepare/join: {reason}" on a failure.
Companion invitations (manager, phone and party) show no progress in any mode: no "Preparing", "Connecting", ready or "joining" text, to a player or a developer. The party list shows each copy's stage, and the mod log keeps every stage. A player sees "joined" and failures, and so does a developer.
Talking: "Preparing connection to {name}…" (only while Auto-connect nearby characters is off and the character is not connected),
"Connecting microphone - wait for Listening", "Listening - press {key} again to finish". Failures: the conversation service starting, missing
its key, stopped or failed; no reply; the microphone unavailable or timed out; a companion action that was refused; a voice engine that fell
back (once; an OmniVoice that is only being loaded again says "not ready yet" and its return is silent). Hints for a key press that did nothing: no one to talk to, group chat needs two characters, finish the recording with the other key.

## Inventory

Window = seconds in which the same text is not shown again (Developer mode off). "once" = the source posts it once per event.

| Id | Class | English text | Fires when | Window |
| --- | --- | --- | --- | --- |
| `invite-board` | Player | {name} joined your group. / {names} joined your group. (merged with failures on one line) | The invitation board: only the joined and failure lines. A joined line waits up to 4 s for the other invitations of its burst; each notice stays up at least 3 s (5 s after a final outcome). Developers see the same notices | board |
| `party-joined` | Player | {name} joined your group. / {names} joined your group. | The companion appeared. Every joined notice shows to a player (quick or slow), and developers see it too. Several in a burst merge into one, shown 5 s | board |
| `party-failed` | Player | {name} could not prepare: {reason} | Preparation failed (the player cancels and invites again) | once |
| `party-failed` | Player | {name} could not join: {reason} | The game refused or lost the spawn | once |
| `party-failed` | Player | {count} more companions also failed. | More than two failures in one burst | once |
| `party-dismiss-failed` | Player | {name}: {error} | The game refused a dismissal | once |
| `phone-invite-reply` | Player | The queue's refusal reason (for example Load a save before inviting a companion.) | The phone's invite was refused | 20 |
| `phone-dismiss-ack` | Developer | {name} will leave when you return to the game. | The phone's dismissal was accepted | none |
| `phone-dismiss-reply` | Player | The refusal reason (for example That copy is no longer in your party.) | The phone's dismissal was refused | 20 |
| `phone-not-in-group` | Player | {name} is not in your group. | Dismiss from the phone for someone who is not in the party | 20 |
| `phone-unavailable` | Player | The contact's reason | The phone contact has no usable companion | 20 |
| `phone-queue-refused` | Player | This contact has no companion mapping yet. / the contact's own error / Close the phone to finish the pending companion requests. | The native phone queue refuses a request | 20 |
| `phone-queued` | Removed | {name}: invite queued. / {name}: dismiss queued. | The native queue accepted a request; it appeared only after the phone closed and repeated the row's own text | never |
| `party-dismissed` | Developer | {name} dismissed. | A dismissal finished | none |
| `service-down` | Player | The conversation service needs your Convai API key. Add it, then restart the game. | Once per supervisor failure, in gameplay | once |
| `service-down` | Player | The conversation service could not start. Restart the game, or see Help in Settings. | Once per supervisor failure, in gameplay | once |
| `service-blocked` | Player | The conversation service is starting. Try again in a few seconds. | The player starts a conversation while the service is starting | 15 |
| `service-blocked` | Player | The conversation service restarted. Please try again. | The service restarted after the request was sent | 15 |
| `service-blocked` | Player | The conversation service is not running. Restart the game to start it again. | The service is stopped (and the two failure texts above) | 15 |
| `conversation-timeout` | Player | No reply arrived. The conversation service may not be running. | 90 s without a reply and no better explanation (or the service texts above) | 15 |
| `reply-error` | Player | Voice conversation failed. Check your microphone and try again. | The bridge reports a failed voice turn | 15 |
| `reply-error` | Player | The conversation service could not reply. Please try again. | The bridge failed to produce a reply | 15 |
| `reply-error` | Player | {name} does not have a conversation profile configured yet. | The bridge has no profile for the speaker | 15 |
| `quota-exhausted` | Player | The conversation limit has been reached. Get a free API key at convai.com, then add it in Settings > Development. | Convai refused a turn because the plan the conversations use is used up (also shown for an automatic reaction). Once per game session | 86400 |
| `quota-exhausted` | Player | Your Convai API key has reached its plan limit. Try again later or add a different key in Settings > Development. | The same refusal while Use my own Convai API key is on | 86400 |
| `quota-exhausted` | Player | Convai did not accept your API key. Check it in Settings > Development. | Convai refused the player's own key | 86400 |
| `talk-no-target` | Player | Face a nearby character to talk. | The talk key is pressed with no one in range | 20 |
| `talk-no-profile` | Player | {name} does not have a conversation profile configured yet. | The talk key is pressed at a character without a profile | 20 |
| `group-needs-two` | Player | Group chat needs two characters nearby. Use {key} for one person. | The group key is pressed with fewer than two characters | 20 |
| `talk-connecting` | Player | Preparing connection to {name}… | A conversation starts with a character that is not connected yet (Auto-connect nearby characters off) | 10 |
| `mic-connecting` | Player | Connecting microphone - wait for Listening | The voice key is pressed | none |
| `mic-listening` | Player | Listening - press {key} again to finish | The microphone is recording | none |
| `mic-finish-hint` | Player | Use {key} to finish this recording. | The other chat's voice key is pressed during a recording | 10 |
| `mic-error` | Player | Microphone unavailable. Check your Windows input device. | The recorder reports an error | 15 |
| `mic-timeout` | Player | Microphone connection timed out. Please try again. | The recorder did not start in 35 s | 15 |
| `voice-fallback` | Player | {requested} is unavailable. Companions are using {voice} instead. | The chosen voice engine could not run and the bridge fell back for good (not configured, pack missing, Pocket failed, or OmniVoice's background retries ran out), once per fallback | 600 |
| `voice-fallback` | Player | {requested} is not ready yet. Companions are using {voice} for now. | The chosen OmniVoice failed or timed out; the bridge keeps the next voice and loads OmniVoice again in the background. Once per episode. The switch back at an idle reply boundary posts nothing | 600 |
| `voice-switched` | Developer | Natural speech needs a local voice, so Companion voices was switched to {voice}. (and the Expressive emotions, Multilingual variants) | After a Settings Apply that changed the voice; the Settings status line already says it | none |
| `action-rejected` | Player | The driving request could not be queued. / That action is not available. / Your companion could not start that. / The target changed. Ask again. / Step out of the vehicle first. / the action's reason | A companion action the character agreed to was refused | 15 |
| `action-queued` | Developer | Your companion is preparing to drive. / {name} is going to distract {target}. | A companion action was accepted | none |
| `party-stop-trip` | Player | Stopping the trip. Wait for the car to stop before stepping out. | Stop trip pressed in the Manager | 15 |
| `trip-failed` | Player | The trip's error or failure reason | A driving trip failed | 15 |
| `trip-guidance` | Developer | Your companion is driving to the selected waypoint. / Your companion is ready. Get in the passenger seat to start the trip. / The car has stopped. Step out so your companion can leave the driver seat. | Driving steps | none |
| `tactic-outcome` | Developer | {name} called off the distraction. / The distraction target is gone. / The distraction fell apart: combat started. / {name} could not reach the target. / {name} could not engage the target. | A companion tactic ended | none |
| `support-report-saved` | Developer | Support report saved: {path} | A Help report finished | once |

## Adding a notice

1. Add an entry to `M.catalog` in `mod/notices.lua` with its class (and a `repeatS` window for a Player notice a key press can repeat).
2. Show it with `convaiNotices.send(player, 'my-id', text)` (or `sendLines`, `permit`); never call `ConvaiPhoneFeedback` directly.
3. Add its rows to the table above. `node --test bridge/notices.test.mjs` fails on an unknown id, a raw call, a catalog entry nobody
   uses, or a row missing from this page.
4. Wording: short, friendly, no file names or internal words; add all 15 locales and run `node scripts/Extract-UiCatalog.mjs`.

## History

2026-10-09: this audit. The gate (`mod/notices.lua`) replaced the per-site Developer checks; "{name}: invite queued." / "dismiss queued."
(redscript, after the phone closed) is removed; the phone's acknowledgement of an invitation the board follows, tactic outcomes and the
Apply voice-switch popup are Developer-only; identical hints and errors are rate-limited; three wordings were shortened (no log file names,
no "bridge", no "eight metres"). Earlier: 248c14c, a20c7a1, e7e9760 (calmer invitation notices) and the 2026-10-07 settings review.

2026-10-09 (later, user decision): "joined" is shown to a player only after a visible wait; key-press hints stay. (Superseded the same day, see below.)

2026-10-09 (in-game feedback): the intermediate step and "joined" came back to back, so for a player "Connecting" and the "ready" lines now show only after the invitation has stayed in that step for 3 s (`STAGE_DELAY_MS` in `mod/manager-party.lua`). Until then the board keeps naming the step already shown (Preparing, if it was), and a step that "joined" follows sooner is skipped; the joined notice still replaces the previous toast in place, after that toast's 3 s minimum. "Preparing" keeps its one-second delay, so a genuinely long wait still shows. Developers see every step at once.

2026-10-09 (invitation long wait): the first line a player saw was "Preparing", which had no stage delay (only Connecting and ready waited 3 s), and the 3 s minimum show time then held "joined" behind it. Progress now shows to a player only after the invitation has been in flight for 10 s (`LONG_WAIT_MS` in `mod/manager-party.lua`), so a normal invitation shows only "joined". "Joined" now shows for every companion that arrives, quick or slow, which supersedes the "joined only after a visible wait" decision above. Developers still see progress after 1 s and the ready line at once.

2026-10-10 (voice startup): a slow OmniVoice start no longer ends the session on Pocket. The fixed 180 s startup limit is replaced by a progress-based one (`docs/LOCAL_VOICES.md`, "Startup limit, background retry and switch back"), and a failed or timed-out OmniVoice is retried in the background. While that is pending the fallback notice reads "{requested} is not ready yet. Companions are using {voice} for now." (once, same 600 s window); the return to OmniVoice is deliberately silent because nothing is being waited on. The permanent "is unavailable" text remains for a voice that cannot run at all. The Settings status line says "not ready yet" instead of "unavailable" for the temporary case.

2026-10-10 (follow-up): a join that was still pending after 10 s (a voice model loading after a bridge restart) still showed "Preparing", "Connecting" or the ready line to a player. All progress now shows in Developer mode only, at any wait length; the phone acknowledgement of an accepted invitation is Developer-only even when the board does not follow it. A player sees only "joined" and failures. `LONG_WAIT_MS` is removed.

2026-10-10 (no progress text): companion invitations post no progress in any mode, Developer mode included: no "Preparing", "Connecting", ready or "joining" line on the board, in the manager status line, the MCM banner or the phone. The phone acknowledgement of an accepted invitation is removed, and `invite-joining` and `phone-invite-ack` leave `mod/notices.lua`. A player and a developer see "{name} joined your group." and failures only.
