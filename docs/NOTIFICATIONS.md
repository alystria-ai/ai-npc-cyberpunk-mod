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
A companion's Convai connection is prepared before she joins: the invitation is ready, and so "joined" is posted, only once her connection is open (on a player's own free key, which holds one connection at a time, her connection is opened for the join and the others open when V talks to them). That is why "Preparing connection to {name}…" is rare for a party member: it appears only when V starts a conversation with someone not connected, never from looking.
Companion invitations (manager, phone and party) show three kinds of line, the same to a player and a developer: "Preparing connection to {name}…" while her connection is being prepared, "{name} joined your group." once she has joined, and failures. The preparing line is the existing wait notice string (no new translation). It shows once per join, when the invitation is first seen with its connection not yet open; when the connection is already open (or the invitation is first seen ready) only "joined" shows. No other progress is posted: no "Connecting", ready or "joining" text. The party list shows each copy's stage, and the mod log keeps every stage.
Talking: "Preparing connection to {name}…" (only when V starts a conversation, by the talk key, the composer or voice, with a character, a party copy included, who is not connected yet, with Auto-connect nearby characters on or off; never from gaze or a warm-up),
"Connecting microphone - wait for Listening", "Listening - press {key} again to finish". Failures: the conversation service starting, missing
its key, stopped or failed; no reply; the microphone unavailable or timed out; a companion action that was refused; a voice engine that fell
back (once; an OmniVoice that is only being loaded again says "not ready yet" and its return is silent). Hints for a key press that did nothing: no one to talk to, group chat needs two characters, finish the recording with the other key.

## Inventory

Window = seconds in which the same text is not shown again (Developer mode off). "once" = the source posts it once per event.

| Id | Class | English text | Fires when | Window |
| --- | --- | --- | --- | --- |
| `invite-board` | Player | {name} joined your group. / {names} joined your group. (merged with failures on one line) | The invitation board: "Preparing connection to {name}…" once per join while her connection is prepared (one line per character, none when it is already open), then the joined and failure lines. A joined line waits up to 4 s for the other invitations of its burst; each notice stays up at least 3 s (5 s after a final outcome). Developers see the same notices | board |
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
| `quota-exhausted` | Player | The conversation limit has been reached. Try again later, or add a free Mistral key and set Conversation provider to Mistral in Settings > Development. | Convai refused a turn because the plan the conversations use is used up (also shown for an automatic reaction). Once per game session | 86400 |
| `quota-exhausted` | Player | Your Convai API key has reached its plan limit. Try again later or add a different key in Settings > Development. | The same refusal while Use my own Convai API key is on | 86400 |
| `quota-exhausted` | Player | Convai did not accept your API key. Check it in Settings > Development. | Convai refused the player's own key | 86400 |
| `quota-exhausted` | Player | Your Convai plan cannot hold the memory these conversations need. Free a memory user in your Convai account or use another key. | The player's own key was refused because it cannot serve memory-enabled characters even without an end-user identity | 86400 |
| `daily-limit` | Player | You’ve reached today’s free conversation limit. Convai (better quality responses) is back tomorrow. To keep talking now, add a free Mistral key and set Conversation provider to Mistral in Settings > Development. A fully local option is coming. | The shared plan's daily conversation allowance (about 100 turns a local day, bridge/shared-key-guard.mjs) is used up and V asked for a turn: talk box, voice, group round or Phone Chat message (Phone Chat words the same line on its status row). Never for an automatic reaction (battle, loot), which just stops, and never on a player's own key. Once per game session | 86400 |
| `mistral-key` | Player | Mistral did not accept your key. Check it in Settings > Development. | Mistral is the conversation provider and refused the saved key, on a turn V asked for (talk box, voice, group round or Phone Chat message; Phone Chat words the same line on its status row). Never for an automatic reaction (battle, loot) | 60 |
| `mistral-limit` | Player | Mistral’s free limit is reached for now. Try again in a moment. | Mistral's free limit (about one message a second, plus a monthly allowance) is reached, on a turn V asked for (same places and the same rule for automatic reactions as `mistral-key`) | 60 |
| `mistral-model` | Player | The Mistral model is unavailable right now. Try again in a minute. | The Mistral model cannot be used right now, on a turn V asked for (same places and the same rule for automatic reactions as `mistral-key`) | 60 |
| `mistral-no-key` | Player | Mistral has no key yet, so Convai is used. Add your key in Settings > Development. | Conversation provider is Mistral but no Mistral key is saved, so conversations use Convai. Sent by the bridge with the first reply of a game session | 86400 |
| `mistral-voice` | Player | Mistral replies are spoken by a local voice instead of the Convai cloud voice. | Mistral is in use and Companion voices is the Convai cloud voice, so a local voice speaks the replies. Sent by the bridge with the first reply of a game session | 86400 |
| `groq-key` | Player | Groq did not accept your key. Check it in Settings > Development. | Groq is the conversation provider, a key is saved and Groq refused it (and no Mistral key could answer the turn), on a turn V asked for (same places and the same rule for automatic reactions as `mistral-key`; Phone Chat words the same line on its status row) | 60 |
| `groq-limit` | Player | Groq’s free limit is reached for now. Try again in a moment. | Groq's free limit is reached and no Mistral key could answer the turn instead (bridge `errorCode` `groq-limit`), on a turn V asked for (same rule as `mistral-key`) | 60 |
| `groq-model` | Player | The Groq model is unavailable right now. Try again in a minute. | The Groq model cannot be used right now and no Mistral key could answer the turn instead, on a turn V asked for (same rule as `mistral-key`) | 60 |
| `groq-no-key` | Player | Groq has no key yet, so Convai is used. Add your key in Settings > Development. | Conversation provider is Groq but no Groq key is saved, so conversations use Convai. Sent by the bridge as `keyNotice` with the first reply of a game session | 86400 |
| `local-fallback` | Player | Local AI could not start, so a cloud provider is used. Check Local AI in Settings > Development. | Conversation provider is Local but the Local AI pack could not start (not installed, not enough graphics memory, or failed), so conversations use Mistral when a Mistral key is saved, else Convai. Sent by the bridge as `keyNotice` on the first reply of a game session, or as `errorCode` on a failed turn V asked for (never for an automatic reaction) | 86400 |
| `key-memory` | Player | Your Convai plan has no room for conversation memory, so companions will not remember past talks. | The player's own key hit the plan's memory-user limit (Convai's free plan allows one): conversations went on without long-term memory. Shown with the first such reply, once per game session | 86400 |
| `talk-no-target` | Player | Face a nearby character to talk. | The talk key is pressed with no one in range | 20 |
| `talk-no-profile` | Player | {name} does not have a conversation profile configured yet. | The talk key is pressed at a character without a profile | 20 |
| `group-needs-two` | Player | Group chat needs two characters nearby. Use {key} for one person. | The group key is pressed with fewer than two characters | 20 |
| `talk-connecting` | Player | Preparing connection to {name}… | A conversation starts (talk key, composer or voice) with a character, a party copy included, who is not connected yet; never from gaze or a warm-up | 10 |
| `voice-needs-convai` | Player | Speaking to companions needs Convai for now. Set Conversation provider to Convai free tier in Settings > Development, or type your message. | A voice key (talk by voice or group voice chat) is pressed while Mistral is in use and this computer cannot recognise speech locally; no recording starts | 15 |
| `mic-connecting` | Player | Connecting microphone - wait for Listening | The voice key is pressed, and again when it is pressed while the microphone is still connecting (that press is ignored) | none |
| `mic-listening` | Player | Listening - press {key} again to finish | The microphone is recording | none |
| `mic-finish-hint` | Player | Use {key} to finish this recording. | The other chat's voice key is pressed during a recording | 10 |
| `mic-error` | Player | Microphone unavailable. Check your Windows input device. | The recorder reports an error | 15 |
| `mic-timeout` | Player | Microphone connection timed out. Please try again. | The recorder did not start in 35 s | 15 |
| `mic-heard` | Player | You: {text} | While V speaks a voice message and the game's subtitles are off: the words Convai has recognised so far (newest 100 characters), replaced as they grow, until the reply starts. With subtitles on the same words show as V's line in the cinematic subtitles instead (no notice) | none |
| `mic-no-speech` | Player | No speech was heard. Wait for Listening, then speak before you finish. | The recording held no speech: Convai returned no transcript or reply within 15 s of the finish | 15 |
| `voice-fallback` | Player | {requested} is unavailable. Companions are using {voice} instead. | The chosen voice engine could not run and the bridge fell back for good (not configured, pack missing, Pocket failed, or OmniVoice's background retries ran out), once per fallback | 600 |
| `voice-fallback` | Player | {requested} is not ready yet. Companions are using {voice} for now. | The chosen OmniVoice failed or timed out; the bridge keeps the next voice and loads OmniVoice again in the background. Once per episode. The switch back at an idle reply boundary posts nothing | 600 |
| `voice-switched` | Developer | Natural speech needs a local voice, so Companion voices was switched to {voice}. (and the Expressive emotions, Multilingual variants); The Convai cloud voice cannot use Natural speech or Expressive emotions, so they were turned off. | After a Settings Apply that changed the voice, or that turned the tag settings off because the cloud voice was chosen (not when only the Expressive emotions default was on); the Settings status line already says it | none |
| `action-rejected` | Player | The driving request could not be queued. / That action is not available. / Your companion could not start that. / The target changed. Ask again. / Step out of the vehicle first. / the action's reason | A companion action the character agreed to was refused | 15 |
| `action-queued` | Developer | {name} is going to distract {target}. | A companion action was accepted | none |
| `party-stop-trip` | Player | Stopping the trip. Wait for the car to stop before stepping out. | Stop trip pressed in the Manager | 15 |
| `trip-failed` | Player | The trip's error or failure reason | A driving trip failed | 15 |
| `load-progress` | Player | Loading the OmniVoice voice… / Loading the Pocket voice… / Local AI is warming up… | A slow component is loading (the OmniVoice or Pocket voice engine the player chose, Local AI while its model server warms up), once the load has lasted 1.5 s. Shown again every 3 s (never on top of another notice that is younger than 3 s) until the ready line replaces it | none |
| `load-ready` | Player | OmniVoice voice is ready. / Pocket voice is ready. / Local AI is ready. | The component finished loading, only when its loading line was shown. Once; waits for gameplay if it finished in a menu | none |
| `load-failed` | Player | OmniVoice could not load. See Help in Settings. / Pocket could not load. See Help in Settings. / Local AI could not start. Check Local AI in Settings > Development. / Not enough graphics memory for Local AI. A cloud provider is used instead. | The component failed while its loading line was up (a voice failure that has a fallback is left to `voice-fallback`). Once | none |
| `trip-guidance` | Developer | Your companion is driving to the selected waypoint. / Your companion is ready. Get in the passenger seat to start the trip. / The car has stopped. Step out so your companion can leave the driver seat. | Driving steps | none |
| `tactic-outcome` | Developer | {name} called off the distraction. / The distraction target is gone. / The distraction fell apart: combat started. / {name} could not reach the target. / {name} could not engage the target. | A companion tactic ended | none |
| `support-report-saved` | Developer | Support report saved: {path} | A Help report finished | once |

## Loading notices

A switch that takes time (an OmniVoice voice after a voice change or at start, Local AI warming up for about a minute the first time) says so
instead of leaving the player wondering. The loading board in `mod/notices.lua` (`convaiNotices.loading`) keeps one entry per component:
the loading line appears when the load has lasted 1.5 s and is shown again every 3 s, because a notice is gone after a few seconds and the
next one replaces it, until the "ready" line (or a failure line that says what to do) replaces it. A load that finishes quickly shows nothing.
Popups only show in gameplay, so an outcome reached in a menu is shown on the first gameplay tick.

Status signals read, all of them already published by the bridge and read on a slow tick (never per frame; nothing is read while nothing loads
except the once-a-second check):
- OmniVoice and Pocket: `runtime/local-voice-state.json` (`workerBackend`, `requestedProvider`, `state` loading / ready), decoded by `mod/manager.lua` anyway.
  Only the engine the player chose counts, and only the model load (`loading`), not a per-character preparation (`warming`).
- Local AI: `localAi` in `runtime/mistral-state.json` (warming, ready, failed, no-memory), read only while Local is the conversation provider.
No signal exists yet for the Mistral cloud voice's reference preparation (it is a cached, sub-second step), the voice browser's warm-up or the
Inworld voice; each can add a state to `manager.loadStatus` and two lines to `loadingText` in `mod/mcm.lua` when it has one.

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

2026-10-10 (driving preparing line): "Your companion is preparing to drive." is removed in every mode. A queued driving request posts nothing: `companion-vehicles.lua` returns no text, `gameplay-actions.lua` reports the queued drive with an empty reason, and `init.lua` posts no `action-queued` notice for an empty reason.

2026-10-10 (wait notice back): "Preparing connection to {name}…" shows whenever a character the player talks to is not connected yet, with Auto-connect nearby characters on or off. Since the settings review (2026-10-07) it was silent with the setting on, so a wait looked unexplained. The text and its translations are unchanged; the warm-up itself is still silent.

2026-10-10 (wait notice, party copies): a talk with a party copy that is still connecting now shows the wait notice too (the composer skipped every party copy before, which is why Lizzy Wizzy never showed it). A short-lived gaze notice that posted it while V looked at a character being warmed is removed: it showed "Preparing connection" before any talk key was pressed. The notice shows at conversation start only, and a warm-up queues nothing.

2026-10-10 (connect before joined): on a player's own Convai key the invited companion's connection was never opened at all: the single-session plan treated every invitation as ready at once, so "joined" came with no connection and the first talk showed "Preparing connection" (the shared key was unaffected, and none of the notice changes touched this). An invitation now opens its own companion's connection before she is ready, one at a time, and a failed attempt does not fail the invitation. The wait notice is unchanged: it shows at a talk, composer or voice start only, never from gaze.

2026-10-10 (preparing line back, once per join): a companion whose connection is being prepared on spawn or join gets "Preparing connection to {name}…" (the existing wait notice string, so no new translation), then "{name} joined your group." once she has joined. It is decided when the board first sees the invitation (`mod/manager-party.lua`, `openConnection`, one read of `runtime/party-connection-state.json` through `autoConnect.connected`): connection open or invitation already ready means no preparing line. The line is posted once per invitation (a paused menu that hides it gets one gameplay presentation, like every board notice); several companions share one notice with a line each, and two copies of one character share a line. The old "joining" progress line, the ready line and "Connecting" stay removed. Event-driven: the board is sampled by the existing update that already runs it; nothing new per frame.

2026-10-13: loading notices (`load-progress`, `load-ready`, `load-failed`): a slow OmniVoice, Pocket or Local AI load is announced until it is ready.
