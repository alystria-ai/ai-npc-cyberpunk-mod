# Group voice

## Controls

Assign any suitable key or chord to **Cyberpunk Convai: group voice chat** in
CET. Press it to begin, wait for Listening, speak, then press that same shortcut
again to finish. **Talk by voice** is the separate private action. The wrong
mode's shortcut cannot submit or redirect an ongoing capture; the hint names
the action that started it. Capture auto-finishes
after 30 seconds. Opening a menu cancels it, including paused frames with zero
simulation delta. Starting a conversation never silently enables the microphone.

Registered actions do not assign or rewrite a player's CET bindings. Action IDs
stay stable so existing choices survive updates. Bind an unassigned action in
CET when choosing to test microphone input. Runtime hints read CET's `IsBound`
and `GetBind` on demand, so changed keys and modifier chords are reflected
immediately. Missing APIs or unbound actions fall back to the action name.
No runtime hint assumes a function key. The optional local development setup recommends keys and preserves any
existing assignments; it is not automatic mod initialization.

## One captured utterance, one ordered group round

- Private/group text and voice share target resolution. The addressed supported character goes
  first. Group mode requires at least two distinct enabled profiles and selects
  at most three. Duplicate copies do not produce duplicate speakers. A looked-at
  unsupported NPC is reported rather than silently replaced by another person.
- Starting group voice freezes the participating entities/profiles and follow-up setting.
  The first request contains microphone input and its group context. Finish
  refreshes quest/battle/world facts without changing the captured audience or
  player identity. Only the last remaining scheduled speaker may ask a follow-up
  when the captured option is On.
- Convai generates the primary response directly from microphone input. That
  response is played once; it is not regenerated as a text request.
- The SDK's recognized user transcription is returned as optional `userText`
  in `reply.json`. SDK 1.7.0 emits finalized STT segments into `user-transcription`
  chat rows while they accumulate, then may replace them with a consolidated
  `isStreaming:false` row. The latter is preferred. Interim STT events, old
  message IDs, bot text and text-chat prompts cannot become V's recognized speech.
- After actual first playback, later speakers use this same recognized text,
  the delivered group history and the existing group prefetch/delivery rules.
  Missing/invalid transcription or first-turn errors cancel later speakers.
  The first audible reply may still be shown when no transcript was returned.
- The transcript is whitespace/control normalized and bounded to 1,200 UTF-16
  units without splitting a surrogate pair. Lua validates its UTF-8 and matching
  limit before continuing. No extra cloud turn is sent to invent a transcript.
- Lost primary, save/world changes, explicit cancellation and recording errors
  retire the owner. A late callback cannot resurrect that group round. Other
  participants may leave and are skipped by the existing live audience checks.
- Text and voice rounds keep each admitted actor's entity and conversation
  profile together. Reassigning, dismissing or disabling the current speaker
  cancels that round's pending reply and owned playback. A changed later
  participant is skipped; the remaining audience and prepared next turn are
  refreshed without substituting the new profile into the old round.

One persistent player identity is retained across private/group/microphone and
phone conversations. Group session separation does not create extra player IDs.

## Verification and limits

`npm run test:group-voice` exercises the real registered Lua hotkeys, recording
command files, reply polling, first reply, later speakers, prefetch, wrong-mode
keys, lost targets, zero-delta menus, save restoration, missing transcription,
timeouts and automatic finish. SDK transcript tests use the installed SDK event
contract with mocks. These checks never access a microphone or submit cloud
dialogue. Audible microphone acceptance remains deferred at the user's request.

Microphone's first Convai reply currently retains the existing full-reply
collection path. This change does not claim streaming onset for that first
microphone response; later text-routed group replies use the normal voice path.
