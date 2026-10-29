# Voice input: hold to talk, and Voice activation

2026-10-23, branch `feat/instant-ptt`. Player feedback (Nexus): voice input should be push-to-talk (hold the key while you speak) instead of
"press to start, press to end"; Discord (VR players): a voice activator instead of a key press. Owner decisions: the talk key records the
instant it goes down, with no "connecting", "speak now" or "finished" notice, and the transcript shows as it arrives; releasing the key ends V's
turn; audio from the press on is never lost while a connection opens; Voice activation is a setting, off by default.

## What the talk key did before

`mod/init.lua` already had hold detection (`voiceKeyEdge`), but it worked only after the device was open:

1. Key down wrote `microphone-command.json` (`start`) and showed "Connecting microphone - wait for Listening".
2. The bridge then prepared the turn (knowledge, memory, provider choice, up to seconds on a first turn), opened the Convai connection or
   the local recogniser, and only then opened the microphone. Everything said before that was lost.
3. "Listening - press {key} again to finish" appeared when the device was open.
4. A hold longer than 0.3 s finished the recording at the release **only if** the device was already open; a release before that
   ("the device is still opening, press again to finish") left the recording running until the next press. That is why it felt like
   press-to-start / press-to-end: for most real presses the release came too early to count, so a second press ended it.
5. A tap (up within 0.3 s) toggled. There was no separate tap mode setting.

## Live test of 2026-10-23: what was wrong, and the fix (`fix/instant-ptt-live`)

The first build did not work in the game (Convai, Pocket voice): no reply on any voice turn. The bridge log showed two causes.

1. **The device took 1.5 to 2.5 s to open** ("microphone tap open for a turn in 2455 ms"). A real input device needs 0.4 s idle (measured here, Realtek array,
   Edge) and several times that in a running game; the fake device used for the first tests opened in 54 ms. A hold shorter than that ended before the
   device opened, and the first words were never heard. What can be done (owner's decisions, 2026-10-23): the device opens on the key press, the press is a HOLD and everything from the moment it opens is kept; a
   release before it opened ends the turn once what was captured is in (no notice); after each voice turn the device **lingers** open and unread for 15 s
   (`MicTap` `lingerMs`, `LocalSttCapture` keeps the page's stream and worklet), so the next press of a conversation starts at once (about 37 ms to the first
   chunk, measured on the real Buds and on the built-in array), and then it closes. A menu, a loading screen, a scene, a dialogue with choices, a call or voice
   input being impossible closes it at once and nothing lingers while it lasts: `mod/init.lua` `convaiMicLingerTick` looks only while a voice turn runs or
   ended less than 17 s ago and writes `blocked` to `microphone-live.json` (the shared `mod/voice-activation.lua` `sample`, cached 0.5 s on the 10 Hz tick).
   `CYBERPUNK_CONVAI_MIC_LINGER=0` closes the device with each recording. No microphone is open while walking around. The cold open is Windows' Bluetooth
   profile switch (below); the AudioContext and worklet are now built in parallel with `getUserMedia` instead of after it.
2. **The relay played the pre-roll before the track existed.** `PcmRelay` consumed its FIFO from the moment it was created, so everything pushed while the
   Convai connection opened (the whole pre-roll, and the first live seconds) was played into a track nobody had published, and Convai heard only the
   tail ("Who are", never a final transcript, then "No speech was heard" after 15 s). Fix: the worklet collects and plays nothing until `start()`, which
   `beginVoice` calls once the SDK has published the track (`bridge/realtime-client.mjs`); `drain()` now waits for the real backlog (its fixed 2 s limit could cut
   a long backlog off in the middle of the words). Proof, in real Edge over a WebRTC loopback (`pcm-relay.test.mjs`, `mic-relay-e2e.test.mjs`): nothing arrives
   before `start()`, and then the whole pre-roll plus the live audio arrives.

## Live test of 2026-10-24: about 2 of 6 turns lost (Convai, game 2.31, Bluetooth headset, keyboard key and controller L3)

The player's words showed as a subtitle, no reply came, and the game said "Microphone unavailable" (`bridge.stderr.log` and `runtime/probe.log`, 08:26 to 08:28 UTC). Four turns, four findings (the first is what the logs prove, the second was found in the code and reproduced, the third and fourth are the visible results).

1. **A stalled game was read as a world change.** The game's own movement trace (`runtime/movement-trace.ndjson`, a sample every 0.5 s of game time) has no sample for 5.3 s after the second turn's
   release and none for 17 s after the retry press, and `probe.log` is silent in the same spans. `world-session.json` (the game's heartbeat, rewritten every 2 s) and `speech-state.json` are leased
   for 5 s, so both expired. `pollKnowledge` then read "no world", took it for a changed world and ran `resetLiveRoutes`: every route reset, the hidden browser closed, and the running voice turn
   cancelled with nothing said to the game ("the voice turn was cancelled", then "No current world for conversation warmup"). The game waited 8 s for a reply, the next press (the retry) found the bridge
   still resetting and failed with "Conversation world changed", which the game showed as "Microphone unavailable. Check your Windows input device." although nothing was wrong with the microphone.
   Why the game stalled is not known (the Bluetooth profile switch of a cold open, the vision capture and Windows suspending a process of a sandboxed launch are the candidates; the cold opens of the second turn and of the
   retry stalled, those of the first and the third turn did not). **Fix** (`bridge/world-session.mjs`, `bridge/convai-bridge.mjs`): a heartbeat that is only late (valid, the same ready
   world, less than 2 minutes old) is that world, not a change: nothing is reset (`lateWorld`). Every ordinary check still refuses it after 5 s, so nothing new starts on a stalled game; a voice
   turn that is running (key held, recording or reply under way, `micTurnRunning`) accepts it for 30 s (`MIC_LEASE_MS`, `worldBoundary`, and `audioReady(runtime, MIC_LEASE_MS)` for the speech service),
   so it rides out a stall of the game instead of being ended. When the bridge does end a turn for its world it now tells the game (`abandonMicrophone`: an error with reason `connection`,
   "Voice input could not reach Convai. Hold the voice key again, or type."), and a start or finish that fails with "Conversation/Phone world/memory changed" is the same reason instead of a plain
   microphone error (`microphoneErrorState`). `audioReady` reads a torn `speech-state.json` once more after 15 ms.
2. **The key's hold signal could take the microphone back from the turn.** The game writes `microphone-live.json` (the hold) and then, after it has captured the turn's context, the start command.
   The bridge reads the first every 500 ms and the second every 150 ms, so the start command is often read first and the request opens the tap. The hold that followed called `open('hold:...')`
   on a tap whose `holdId` matched, which handed the tap to `hold:...`: the request no longer owned it, `whenReady` rejected with "The microphone was released before it opened", the relay
   could not attach and the key release did not stop the tap. The log cannot show which order a turn took, so this may not have hit these turns; it is a real race that the 150/500 ms polls make common. Fix: `MicTap.hold` does nothing when the tap is already open for that key press.
3. **A release before the device opened waited 15 s.** A Bluetooth headset opens in 1.5 to 2.5 s; a 2.2 s hold ended before it, nothing was captured, and Convai waited out its 15 s recognition
   window before "No speech was heard". A recording with less than 120 ms of audio now fails at once with that same notice, without asking Convai (`RealtimeHost.finishVoiceOnce`, `MIN_CAPTURED_MS`).
4. **Words heard, no final transcript.** The turn with a 2.5 s open and 4.7 s of recording had its first words in the live transcript (Convai's recogniser heard it) and then nothing: no final
   transcript, no reply, "No speech was heard" after the 15 s window. This is the symptom of the 2026-10-23 relay bug ("Who are", never a final one), but the relay is correct here (the pump,
   the track and the drain are the ones the tests prove) and the log has no sign of lost audio, so the cause on Convai's side is not known. Fix: when words were heard (the interim transcript) and
   no final transcript or reply exists 4 s after the finish (`HEARD_WITHOUT_FINAL_MS`, `bridge/realtime-client.mjs`), the heard words are sent to the character once as the player's line, and the turn goes
   on. They are not recorded as `userText` (a partial transcript is still never taken for what V said). Nothing changes when the final transcript arrives in time, and a recording with no heard words
   still fails as no speech after 15 s.
5. **A tiny final transcript and no reply (error signature `cbb775b3`, 20 reports, all voice-key or voice-activation turns).** Convai wrote down 1 to 3 characters (a cough, a click) and never
   answered. Owner decision 2026-10-26: a microphone turn whose final transcript is 1 to 3 characters and that has no reply text and no thinking 15 s after the transcript last changed ends as
   "No speech was heard" (`TINY_TRANSCRIPT_CHARACTERS`, `bridge/realtime-client.mjs`), so no 60 s wait and no report. Typed turns and longer transcripts keep the 60 s rule.

## Why the device takes so long to open (measured 2026-10-23, game closed, `scripts/Measure-ColdOpen.mjs`)

Default input here: a Bluetooth headset (realme Buds Air7); the laptop's own microphone array (Realtek) is the other input. Medians, in ms:

| Step | Time |
|---|---|
| (a) the game's write noticed by the bridge's directory watcher (the 150 ms / 500 ms interval polls only back it up) | 15 |
| (b) `page.evaluate` to the capture page (reused) / creating the page (once per browser) / `grantPermissions` | 1.2 / 210-240 / 1 |
| (c) `getUserMedia`, Bluetooth headset, recently used / cold (about 8 s since the last close) | 350-380 / 1,350-1,500 |
| (c) `getUserMedia`, Realtek array, cold | 440 |
| (d) AudioContext + worklet + first frame, after the stream | 30-100 (none with `MediaStreamTrackProcessor`) |

The constraints (echo cancellation, noise suppression, gain control all on or off), the context's sample rate and `latencyHint` change nothing measurable (357 vs
380 ms). Keeping the context and worklet alive saves 60-100 ms; reading with `MediaStreamTrackProcessor` (no AudioContext) saves about 70 ms. The cold 1.4 s is
Windows switching the Bluetooth headset from stereo to its call (hands-free) profile when the microphone opens; the link stays in call mode for about 4-8 s after
the last close, then a new open pays it again. It is not in the bridge, the browser or the page, and nothing in software shortens it. So on a Bluetooth input a cold
press cannot start instantly without keeping the device open, and keeping it open is what holds the headset in call quality. A built-in microphone opens
in 0.4 s cold (0.9-1.2 s through the whole real path, which includes the page, the AudioContext and the first 40 ms chunk). Press to first chunk through the real path
(`scripts/Measure-PressToFrame.mjs`): Buds cold 1.6-2.1 s, within the linger 35-41 ms; built-in array cold 0.9-1.2 s, within the linger 35-41 ms.
Voice activation keeps the device open while it listens, so a Bluetooth headset used as the microphone stays in call quality then; the setting's description says so.

## What it does now

- **Key down**: `toggleVoice` finds the target, then writes `runtime/microphone-live.json` (`holdId`, `down: true`) *before* the preparation.
  The bridge (`bridge/mic-live.mjs`) opens the **microphone tap** (`bridge/mic-tap.mjs`) at once and keeps every 40 ms chunk
  (pre-roll). The `start` command that follows names the tap's owner (`hold` field); the tap is handed to the turn with everything kept.
- **Key up**: `microphone-live.json` (`down: false`) stops the tap on the spot (the device closes, the last block is flushed) and the `finish`
  command is written in any recording state, also while the bridge is still opening. A hold shorter than 0.2 s (`HOLD_S`) is a bounce: the
  recording is cancelled silently.
- **The cold-start cue (2026-10-23, after the live test).** A press whose device is NOT already open (cold, outside the 15 s linger) shows one instant held
  notice: "Opening microphone…" at once (the bridge says so through `cue` in `microphone-state.json`, keyed by the press's hold id), changed in place to "Speak
  now" the moment the first audio arrives, and taken down 1.5 s later, at the key release, or when the turn ends (`convaiNotices.cue` / `cueEnd`: its own held
  line, not the loading board's, which takes down any held notice when nothing loads). Nothing when the device is open and nothing for Voice activation. The old
  "Connecting microphone - wait for Listening" string was already retired with the other press-to-finish notices (the two new strings replace it in all 15 locales).
- **No notices for a normal turn.** Removed: "Connecting microphone", "Listening - press {key} again to finish", "Use {key} to finish this
  recording", the voice key's "Preparing connection to {name}". Kept, each once: a language this setup cannot hear, no speech (new text:
  "Hold the talk key while you speak"), the microphone sends no sound, microphone unavailable, no connection to Convai.
- **Live transcript** is the existing path: the words recognised so far (`microphone-heard.json`) show as V's line in the cinematic
  subtitles, or as the `mic-heard` notice when subtitles are off.
- Tap mode no longer exists (it never was a setting). Hold is the only mode, and it is the instant one.

### No audio lost, per route

The tap is the only thing that opens the device; each route takes its audio from it when ready:

| Route | Taker | Pre-roll |
|---|---|---|
| Local AI, Custom, Mistral with the English recogniser, multilingual packs | `TapCapture` adapter under `createLocalSttChannel` | the kept audio is pushed into the recogniser first (`engine.pushAudio`), then live chunks |
| Mistral transcription (Voxtral, other languages) | same channel, `plan.mode === 'voxtral'` keeps the audio | the kept audio is part of the recording sent to Mistral (only if speech was heard) |
| Convai | `RealtimeHost.beginVoiceOnce` relay pump -> `window.convaiRealtime.pushAudio` -> `bridge/pcm-relay.mjs` -> the track the SDK publishes | the audio from 250 ms before the first speech frame goes (silence earlier never leaves the PC); then live |

Convai's SDK normally opens the device itself. With the relay, `enableAudio()` is answered with a `MediaStreamAudioDestinationNode` stream fed by
the pump; if the relay cannot open, the page falls back to the SDK's own microphone (the old path, `relay: false`), and
`CYBERPUNK_CONVAI_MIC_RELAY=0` switches the relay off. The backlog drains before the track is disabled at the release, so the last words reach Convai.

What cannot be recovered: the audio between the physical key press and the device being open (the key-down file write, the file watch
wake, `getUserMedia`, the AudioContext). The capture page (a blank renderer) is opened ahead when the hidden browser starts (creating it cold costs about 220 ms) and stays 10 minutes after the last recording, going with the hidden browser. The bridge logs "microphone tap open for a turn in N ms" for each press. Voice activation has no such gap
(the device is already open). Within the linger the gap is the signal's file write and watch wake, tens of milliseconds.

## Voice activation (Settings > Voices, off by default)

- **Off**: nothing listens and the microphone is closed except while the key is held and for the 15 s linger after a voice turn. The module is loaded for the
  shared "conversation possible / busy" answer; the detector's tick runs one boolean. The bridge ignores listen requests (`MicLive.setAllowed`), and turning the setting off releases the
  device, the pre-roll buffer and the detector (`voice activation is off` in the bridge log).
- **On**: `mod/voice-activation.lua` (10 Hz tick, the "can a conversation happen" test twice a second) writes `listen: true` to
  `microphone-live.json` only while: the world is playable, no menu or text box is open, a profiled character is faced (the existing 0.2 s gaze
  scan notes it) or a companion is within 8 m, the game is not in a scene (tier 3+), a dialogue, a dialogue choice or a phone call, no turn is in
  flight, and **no AI line is playing or ended less than 0.9 s ago** (echo guard: the microphone is *closed*, not filtered, while a voice
  plays). Anything else writes `listen: false` and the bridge closes the device.
- **Detection runs in the bridge** (`bridge/voice-activity.mjs`, fed by the tap's 40 ms chunks), never in CET Lua, never per frame. The
  game thread only reads one small field of `microphone-state.json` (`vad`: `{id, phase}`) at 4 Hz while listening.
- **Start** -> Lua begins the turn exactly like the key (`toggleVoice(false, 'vad', ...)`, notices muted), the tap is taken over from 300 ms
  before the detected onset. **End** -> the bridge publishes `phase: 'ended'`, `mod/microphone.lua` writes the `finish` command (fresh game
  context, as for the key). A sound that turns out not to be speech ends as "no speech" with no notice.
- **Privacy**: while listening the audio stays in the bridge's memory (the newest 1.5 s). Nothing is sent anywhere until the detector says
  speech began; then only the turn's route gets it (local routes keep it on the PC; Convai gets it from 250 ms before the first speech frame).

### The detector and its numbers

Same judgement as `bridge/stt-activity.mjs` (30 ms frames, dBFS, noise floor) plus the recogniser worker's "voiced" test, in JS, no model, no download:

| Constant | Value | Why |
|---|---|---|
| frame | 30 ms | the recogniser worker's frame |
| speech gate | `max(-50 dBFS, noise floor + 12 dB)` | the floor is learned while idle (falls fast, rises at most 1 dB/s, -80..-35) |
| voiced | autocorrelation peak >= 0.30 over 70-400 Hz | vowels have it, fans, hiss and key clicks do not (a loud -30 dBFS fan never starts a turn) |
| start | 8 voiced frames in the last 12 (~240 ms) | a cough, a click or one syllable does not start a cloud turn; detected 240-330 ms after the onset, and the 300 ms pre-roll covers it |
| hangover | 300 ms after a voiced frame | unvoiced consonants ('s', 'f', 't') inside words still count as speech |
| **end silence** | **900 ms** | see below |
| pre-roll | 300 ms before the onset | the first phoneme is never clipped |

**Why 0.9 s.** Pauses inside one person's turn are mostly well under half a second, with a tail that thins out between 0.6 and 0.9 s (someone
thinking mid-sentence). Below about 0.7 s people get cut off mid-thought; every extra 100 ms of end silence is 100 ms added to *every* reply.
The owner's range was 0.8-1.2 s; 0.9 s keeps a 200 ms margin over the 0.7 s pauses the tests must survive (`voice-activity.test.mjs`: a 700 ms
pause does not end the utterance, 1000 ms does), and costs 0.9 s + at most 0.25 s of poll before the reply path starts. It is a judgement from
those ranges, not a measurement on the owner's voice: it is one constant (`VAD.endSilenceMs`), and the live checks in the TODO ask for a
verdict (cut off, or too slow). Mid-turn the tap keeps the detector running only for turns it started; hold-to-talk has no detector.

Known limit: music or a voice from the game's speakers that is *not* a mod line (radio, a vanilla NPC) can start a turn when the player uses
speakers. Headphones avoid it; the setting's description says so. A false start costs one local "no speech" (nothing for local routes; a
Convai interaction on the Convai route).

## Choosing the microphone (Settings > Voices > Microphone, 2026-10-28)

Windows can send a player's chat microphone somewhere the mod never hears it (the Volume Mixer routes an app to another device, or a mixer such as a GoXLR takes it onto a sampler
channel). The Microphone row picks the input for every way of talking: the talk keys (a controller button too) and Voice activation, on every route (Convai, Mistral's transcription,
the local recogniser). They all open the device in one place, the capture page of `bridge/local-stt-capture.mjs`, so the choice is applied there and nowhere else.

- **The setting**: `micDevice` in `runtime/settings.json`, the LABEL of the input as Chromium lists it (`Headset Mic (USB Audio Device)`). No key means the Windows default. It is kept
  with the other settings, so it is mirrored outside the game folder like them. Labels, not ids: Chromium's device ids are per origin and per browser profile and change.
- **The list**: when the Voices page is built the game writes `runtime/microphone-devices-command.json` (`{version, id, action: 'list', issuedAt}`, at most once in 15 s); the bridge
  (`bridge/mic-devices-control.mjs`, polled with the settings) asks the capture page, which grants itself the microphone permission the way a recording does, lists `audioinput`
  devices (one short probe of the default input only when the labels are still empty), leaves out Windows' virtual `default` and `communications` entries and answers in
  `runtime/microphone-devices.json`. The page redraws when the list arrives. Nothing lists devices on the way to a recording, per frame or per turn. The capture page opened for the
  listing is closed 20 s later when nothing records (the hidden browser follows its own idle release).
- **Opening**: `LocalSttCapture` asks for the choice at each open (a variable read) and the page matches it (`matchInput`: exact label, then the same label without case, spacing or the
  trailing `(vid:pid)`), then opens `deviceId: {exact}`. An open device is kept for the linger only while the choice is the same; a changed choice reopens on the next press, and a
  listening Voice-activation tap is released when the choice changes so it reopens on the new input. The open path gets no extra wait: the match is one `enumerateDevices`.
- **Gone**: when the label is not listed (or the exact id is refused) the default input opens, the recording carries the note `mic-device-gone` (`microphone-state.json`), and the
  game says it once per session (`mic-device-gone`, mod/notices.lua). The row keeps the saved name and marks it "(not connected)".
- **Report**: the setup check has a Microphone row (`microphone`: `default`, `chosen`, `missing`) and the report's `bridge.microphone` and setup lines carry the label of the input in
  use (`device=`), never an id. The log line of each open names the input and whether it was chosen.
- **The Convai page's own microphone** (the fallback when the relay cannot open) gets the same choice: `RealtimeHost` hands the label to `beginVoice` (`micDevice`), and the page rewrites the SDK's
  `getUserMedia` request while it enables audio (`chosenInputConstraints` in `bridge/realtime-client.mjs`): the input matched by label as an exact device (`bridge/mic-match.mjs`
  `matchInput`, the one function the capture page embeds too), a retry on the default if the browser refuses it. Without a choice the SDK asks exactly as before.
- **Echo cancellation, noise suppression and gain control are on for every open** (the capture page's constraints, the fallback's rewritten request, the SDK's own defaults). The log
  line of each open prints what the browser applied (`echoCancellation=true ...`) and says so when it is NOT active. They change nothing measurable in the time to the first frame
  (see the table above), so there is no reason to turn them off. They do not remove a call's far side, though: the browser can only cancel sound the hidden browser itself plays (the
  mod's own replies). Sound that reaches the chosen input from another program is not an echo to it.
- **Why the far side of a call can be heard (player report, 2026-10-29).** The mod does not capture system audio. It opens one input device. With no choice made that is the Windows
  default input, and when the default is a loopback or virtual input (Stereo Mix, What U Hear, CABLE Output, a VoiceMeeter or GoXLR mix, Wave Link's stream) Windows hands the browser
  whatever that device mixes, including a call's other side. The Volume Mixer or a mixer app can also route the apps' sound into the default input. Choosing the real microphone in
  Settings > Voices > Microphone fixes it. The same applies to the "several sources" a player sees in their audio software: the hidden browser is the only program that records, and
  its capture page and the Convai page (fallback only) are two pages of one browser process.
- **Loopback inputs are marked, never picked** (`looksLikeLoopback` in `bridge/mic-match.mjs`, a name test, "likely" only). The list file carries `loopback: [label]` beside `inputs`. The row
  shows " (!)" after such a name and explains it in its description (and warns plainly when the saved choice is one). The setup check row says `loopback` (a note, not a problem) for the
  input in use. A recording that opened a loopback-looking Windows default carries the note `mic-loopback` and the game says so once a session (`mic-loopback`). Nothing is left out
  of the list and nothing is switched automatically.

## Performance

- Game thread: hold-to-talk adds two small file writes (key down, key up; 1-3 ms each, only at the edges). Voice activation adds one boolean
  per 0.1 s tick when off; when on: the existing gaze scan writes one clock value, a companion walk once a second, scene flags twice a second
  (only when somebody could be talked to), one small file read at 4 Hz while listening (a cached string with the native plugin), and one
  write per change of "listening". No per-frame work.
- Bridge: 40 ms chunks (25 messages/s instead of 10 while recording), the detector costs well under a million multiply-adds per second
  (60 s of audio in 25 ms), the relay is one `evaluate` per chunk. All of it in the bridge, the hidden browser and its audio thread.
- Latency: the release stops the device at once (before the context refresh), the minimum-recording wait (700 ms) is gone, the first word
  is no longer waited for. See `scripts/Measure-VoiceKey.mjs` for the numbers.

## Files

Bridge: `mic-tap.mjs` (tap, pre-roll, `TapCapture`), `mic-live.mjs` (the two live signals), `voice-activity.mjs` (detector), `pcm-relay.mjs`
(page side of the Convai relay), `realtime-host.mjs` (pump, `endCapture`), `realtime-client.mjs` (`beginVoice(config, {relay})`,
`pushAudio`, `drainAudio`; the page bundle `realtime-client.js` must be rebuilt with `npm run build:voice`), `local-stt-capture.mjs` (chunk size),
`convai-bridge.mjs` (wiring, `microphone-state.json` carries `vad`), `mic-devices-control.mjs` (the input list and the choice). Lua: `microphone.lua`, `init.lua`, `voice-activation.lua`, `manager.lua`,
`manager-ui.lua`, `notices.lua`. Tests: `mic-tap`, `mic-live`, `mic-wiring`, `voice-activity`, `voice-activation`, `pcm-relay`, `realtime-client`,
`microphone-adapter`, `knowledge-integration`, `manager`, `ui-catalog`, `mic-devices-control`, `mic-device-browser` (real Edge, fake devices).
