# Battle awareness and automatic comments

MCM Settings has **React to battles**, enabled by default. A nearby managed
companion may give a short opening warning and another brief comment after the
fight. One speaker owns each comment; duplicate copies share one identity.
Ordinary F6/F8, microphone and phone conversations also receive recent battle
facts, independently of the automatic-comment setting.

## Encounter rules

| State | Behavior |
| --- | --- |
| Save attached / CET reloaded | Clear prior observations and cooldowns. Establish a baseline; loading during combat does not replay its opening. |
| Combat begins | Record nearby companion identities and the hostile NPCs V actually looks at. An eligible opening can be requested after two seconds, within a twelve-second window. |
| Brief break in combat | Wait for four continuous noncombat seconds before declaring the encounter ended. |
| Combat ended | Offer the closing comment after another four seconds, within forty seconds of the confirmed end. |
| Cooldown | A qualifying encounter starts a ten-minute wall-clock cooldown at its confirmed end. Later fights during that cooldown still supply conversation facts. |
| Recent context | Retain the latest encounter for fifteen minutes of unpaused gameplay. |

Opening and closing comments require an enabled, configured companion within
twenty metres who was present during the fight. Selection prefers a different
identity from the previous automatic speaker. No combat, facing, follower or
movement commands are issued by this feature.

Text input, group conversation, recording, phone chat, an existing reply and
existing playback have priority. Automatic comments are blocked during scripted
dialogue, dialogue choices, calls, higher scene tiers, vehicles and replacer
sequences. Opening a menu, starting a conversation, leaving the speaker, disabling
the option or changing combat phase cancels pending automatic work and its owned
playback. Missed windows are skipped, not replayed later.

## Data and ownership

- `mod/battle-observer.lua` samples native state without retaining native
  references. The player's broad `IsEntityInScene` flag is diagnostic only:
  it was true during ordinary gameplay. Actual scene tier/dialogue/call/choice
  checks determine whether a comment may start.
- `mod/battle-reactions.lua` owns bounded encounter state, witness identities,
  eligibility and timing. A capture is plain data, with at most twelve observed
  enemy entities and eight companion identities. Opponent names/types are partial
  observations, not kill totals or a count of all enemies. Ending combat proves
  neither victory nor deaths, quest completion or acquired loot.
- Private text captures on submission, group chat freezes one snapshot for all
  speakers, microphone captures on recording start, and phone chat captures on
  send. Companions absent from a fight receive reported facts, not false memories
  of witnessing it. Unavailable/new-save states replace old assumptions.
- `bridge/battle-context.mjs` validates the snapshot and reaction metadata. The
  realtime path uses a Convai trigger, without presenting the event as something
  V said. Observed facts and short-comment limits also appear in that trigger;
  dynamic context alone did not reliably prevent rhetorical follow-ups.
- Each automatic request owns a request-ID lease, refreshed once per second.
  Explicit cancellation is immediate. Missing/partial files during Lua's
  replacement get bounded retries; they cannot authorize stale playback.
- The request expiry prevents **starting** a late comment. Once accepted into
  playback, it has up to thirty seconds to finish while the same gameplay and
  ownership checks remain active. An old manual focus timeout cannot discard a
  newer automatic request. Save detach/death releases native references without
  accessing unloaded actors.

No remote character descriptions, save progression, quest flags or game settings
are changed. Voice-provider selection and the existing subtitle/lip-sync route
are reused.

## Evidence and remaining work — September 29

- Adapted encounter pacing and priority from the supplied Dawnwalker 0.5.5
  `battle_comments.lua` and `reaction_policy.lua`, using Cyberpunk's own APIs.
- A live read-only probe confirmed ordinary gameplay, Judy/Alex speaker
  availability, and the scene-membership caveat above. The first fight later
  confirmed hostile observations and combat transitions, as described below.
- Executable Lua/bridge checks cover encounter transitions, cooldowns, reset,
  bounds, witness selection, group snapshots, manual priority, timeout ownership,
  admission versus playback expiry, native scene guards, protocol validation,
  preparation identity, phone context and MCM persistence. The lease tests cover
  missing/partial writes, explicit cancellation and unchanged-input retry.
  All 88 affected checks passed with the real installed MCM API; nine changed
  Lua files parsed, and the realtime bundle rebuilt successfully.
- Isolated text-only Convai sessions exercised the production trigger builder.
  The revised opening and closing both returned replies without follow-up
  questions (approximately 7.8 and 8.2 seconds including fresh-session setup).
  These are transport/prompt checks, not warm in-game voice-latency measurements
  or a guarantee of model adherence on every reply.
- The first live fight captured Beat Cop / Patrol Officer observations and Judy
  as a witness, but the user heard neither comment. Both automatic requests
  reached the bridge, then the Lua adapter cancelled them before delivery. The
  original combined `priority-or-stale` reason does not identify which gate
  failed; no speculative timing changes have been made.
- Specific cancellation reasons and a bounded evidence ledger are now installed.
  They distinguish manual/menu interruption, output settings, missing/unavailable
  speakers, native scene gates, combat-phase changes and expiry. Explicitly
  disabling both voice and subtitles suppresses automatic generation while
  retaining battle facts for manual conversation.
- Forty-two focused phone/battle checks pass in the resumed run; all five changed
  Lua files parse. Installation was hash-verified on September 29 while the game
  was closed, then the game and hidden bridge were launched. The saved Convai
  voice choice remains active. No CET reload is needed for this launch.
- In-game opening/closing audio, cooldown and save-load behavior remain
  unaccepted. The next fight must be checked against the new cancellation ledger.
- Combining loot and exploration observations with the closing comment is still
  pending. No Horde-wave or kill-count equivalent is invented for Cyberpunk.

## Live check and diagnostics

After loading the save with the installed update, invite a companion and enter a short fight.
Listen for at most one opening comment and one closing comment after combat has
settled. Ask in F6 who V fought and compare the answer with what was visible.
Manual conversation should cancel an automatic reply; a second fight within ten
minutes should remain silent automatically while updating factual context.

Request `battle-context:<unique nonce>` through the existing diagnostic request
file for `runtime/battle-context-probe.json`. This is read-only. Installed runtime
logs record automatic starts/releases; bridge latency metadata labels the phase.
No credentials or character session IDs enter these diagnostics or metrics.
`runtime/battle-cancellations.json` retains at most 32 automatic release records,
including the guard snapshot, speaker distance/availability, encounter phase and
request/playback timing. It contains no dialogue or native object references.
