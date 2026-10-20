# Dialogue level and position

October 8, 2026. In-game report: Pocket, OmniVoice and Convai replies sound
clearly quieter than the game's own dialogue (tested with only Master and
Dialogue up, all other sliders at 0, on an NC resident and on Judy).

## Where the audio plays today

| Voice | Renderer | Position | Game sliders |
| --- | --- | --- | --- |
| Pocket, Convai | Hidden Edge page, one AudioWorklet stream per reply (`continuous-pcm-player.mjs`), its own Windows audio session | Lua lease (`mod/continuous-speech.lua`): camera-relative equal-power pan, smoothstep distance gain 2 to 18 m | Master x Dialogue read from `/audio/volume`, linear |
| OmniVoice | Audioware (Kira, in the game process) `DynamicEmitterEvent` on the speaker's entity, `voices` track, phrase WAVs in 8 on-demand slots | Kira spatial track at the entity (strength 0.75, min 2 m / max 18 m) | Master and Dialogue through Audioware's own curve (its routing docs: `voices` follows DialogueVolume) |

Neither path is the game's Wwise mixer. Audioware is a separate Kira engine
with its own output stream inside the game process.

## Findings

- **Source levels match the game's files.** ITU-R BS.1770 integrated loudness
  of 21 extracted game voice-over lines (Judy, Johnny, Ana, Blue Moon, Adam
  Smasher): median -23.6 LUFS, most within 0.2 LU of it (EBU R128 mastering).
  Generated speech: Omni slot WAVs -21.5 to -24.1, Convai -22.7 to -23.2,
  Pocket -24.3 to -26.4 LUFS. So the gap is not the TTS being quiet; it is the
  playback chain. Wwise plays its -23.6 LUFS files louder than unity playback.
- **Both mod paths play at about unity.** Browser: gain 1 at 100/100 and the
  StereoPanner centre law (0.707 per ear, -3 dB). Audioware maps the
  0..100 settings through `OutPowf(3)` onto -60..0 dB (100 = 0 dB), and a Kira
  emitter (spatialization strength 0.75) straight ahead gives each ear about
  0.77 (-2.3 dB). Kira's distance law is linear in dB from 0 dB at 2 m to
  -60 dB at 18 m, much steeper than the browser's. These are within
  1 dB of each other, which is why all three providers sounded equally quiet.
- **Windows per-app volume is not the cause.** The loopback tool's session list
  shows Cyberpunk2077 and msedge both at 1.0, unmuted.
- **Audioware cannot stream.** v1.9.9 (installed, latest release) has no
  append-PCM call. Manifest sounds are `in-memory`, `on-demand` (whole file
  loaded per play) or `streaming` (from a file fixed at load). A runtime WAV can
  only be played whole; Omni already does this per phrase.
- **Wwise external sources are not reachable.** Game VO plays Wwise .wem
  streams from the archive depot; producing and registering those at runtime
  is not possible with the installed tools.

## Choice

Keep each renderer, and make both behave like game dialogue:

1. **Level.** One calibrated makeup gain (`DIALOGUE_MAKEUP_DB`, default 6 dB,
   to be confirmed by the loopback check below) for every provider and every
   group speaker, behind a peak limiter so the boost cannot clip.
   - Browser: `worklet -> panner -> air low-pass -> gain -> limiter -> device`.
     The limiter is a `DynamicsCompressorNode` (threshold -4 dBFS, ratio 20,
     1 ms attack, 80 ms release); its automatic makeup (`0.6 x |T(1-1/R)|`)
     is subtracted in the gain stage. Real Edge, offline render: requested
     +6 dB measured as +6.000 dB, a 0.9 sine boosted 6 dB peaks at 0.857, the
     look-ahead is exactly 6 ms. The heard-position clock (subtitles and lip
     sync) is held back by those 6 ms while the limiter is in the path.
   - Audioware (Omni and the complete-WAV Convai fallback): `storeSpeech`
     writes the slot WAV with the same gain and a 5 ms look-ahead limiter
     (ceiling -1 dBFS), timing compensated, so `Position()` and the facial
     timeline are unchanged. Cost: about 2 ms per second of audio in the bridge.
2. **Slider.** Unchanged: Master x Dialogue from the game settings, refreshed
   every 0.5 s, applied before the makeup.
3. **Position.** Unchanged gain law, pan narrowed to 0.7 (a speaker at V's side
   is about 12 dB down in the far ear instead of silent, close to Audioware's
   emitters), and gain/pan/low-pass changes are smoothed (30 ms) so motion
   does not step. The lease now carries the camera-to-speaker distance.
4. **Distance low-pass.** Open within 4 m, falling to about 5 kHz at 30 m
   (`airCutoff`). Only while level matching is on.

Moving Pocket and Convai to Audioware phrase files was rejected for now: the
first file must be complete before anything plays (Pocket at RTF 0.6 needs
about 0.6 to 0.9 s more before the first word than its 0.2 s stream), each file
handoff left measured 19 to 27 ms gaps in the earlier Convai trial, and Omni on
Audioware was reported just as quiet, so it would not fix the level.

## Settings and fallback

`<game>/bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/runtime/dialogue-level.json`,
read by the bridge every settings poll (no restart):

```json
{"enabled": true, "makeupDb": 6}
```

- `"enabled": false` restores the previous path exactly: no makeup, the gain
  stage connected straight to the device, the low-pass open, slot WAVs written
  byte for byte.
- `makeupDb` is clamped to 0..12. Missing or unreadable file: default on, 6 dB.
- If the browser cannot build the low-pass or limiter, the player falls back
  to the previous graph by itself.

There is no Settings-menu row for this level (it needs the label in all 18 UI languages). The player's own trim is a different row, below.

## Voice volume (Settings > Voices)

A slider, 50 to 200 percent (steps of 5, default 100), saved as `voiceVolume` in `runtime/settings.json` and read by the bridge on every
settings poll (`updateVoiceVolume`, `bridge/dialogue-level.mjs`). It is added, in dB, to the makeup above (`activeMakeupDb`), so it reaches
every spoken voice through the two paths that already exist, and V's typed-line voice through its renderer control:

- **Browser renderer** (Pocket, Voxtral, Convai): `makeupDb` rides in the playback control the bridge answers on every renderer
  poll (`ConvaiContinuousSpeech.control`; for V's line `VLine.onFrame`, which has no dialogue makeup, so it carries the volume alone and
  nothing at all at 100). The player sets its gain stage and switches the limiter in whenever the total is not 0 dB. Boosting runs
  through the same limiter as the dialogue level, so 200% on top of +6 dB never reaches full scale (real Edge, offline render: peaks of
  0.90 to 0.95 for full-scale speech at +12 and +18 dB). Below 100 it is a plain attenuation. With no limiter node (an old browser) a
  boost is skipped, as before, and an attenuation still applies.
- **Audioware slot WAVs** (OmniVoice phrases, the complete-WAV Convai fallback): `storeSpeech` writes the same total with the look-ahead
  limiter (ceiling -1 dBFS), timing compensated. A total of exactly 0 dB writes the original bytes.

Why sample gain and not a game-side volume: both renderers already take a gain stage the bridge controls, with a limiter and a measured
latency compensation, so one number covers every voice with no per-frame Lua, no extra buffering and no change to lip-sync or subtitle
timing. The game's own dialogue and sounds are not touched. With level matching switched off by hand (`dialogue-level.json`), the volume
still applies and the distance low-pass stays open.

## Phone and group

Phone Chat is text only; no spoken phone path exists, so nothing changes there
(Audioware's `PlayOverThePhone` is available if one is added later). Group
chat: each speaker has its own lease, so its own distance, pan and low-pass;
the makeup is one process-wide value.

## Calibration (loopback)

`scripts/audio-level/Measure-OutputLoudness.ps1` records what the player hears
(WASAPI loopback of the default output, read only) and logs each application's
peak meter, then prints every sounding segment's loudness and which process
made it: `Cyberpunk2077` (vanilla Wwise and Audioware Omni) or `msedge`
(Pocket, Convai). The last line gives the browser-minus-game difference; add it
to `makeupDb`.

```powershell
scripts\audio-level\Measure-OutputLoudness.ps1 -Sessions
scripts\audio-level\Measure-OutputLoudness.ps1 -Seconds 90
```

### The game's own voice for a companion

Companions are copies without the game's Talk interaction, so there is nothing
to compare with by ear. The "{name} · game voice" row (Play) that **Companion
Manager > Current party** used to show under each ready copy in Developer mode
was removed on 2026-10-15; the queue function behind it (`gameVoice` in
`mod/manager-party.lua`) is kept, but no menu row calls it now. It queues one of that character's vanilla voiceset lines and plays it when the
menu closes, through the game's VO path (a `SoundPlayVo` event on the copy,
what `GameObject.PlayVoiceOver` sends; frustum and distance checks off). Each
press asks for the next context: `greeting`, `bump`, `start_combat`,
`combat_ended`, `danger`, `enemy_warning`, `stlh_curious_grunt`. A character
without a line for that context stays silent; press again. The CET console
prints `[CyberpunkConvai] Game voice line "<context>" for copy <n>: <route>`.
One event per press, nothing per frame.

An F Talk interaction on the copies was not added: it needs a custom
interaction hub in redscript (game restart) and per-frame blackboard work.

Any world NPC, in the CET console while looking at them:

```lua
ChatterHelper.PlayVoiceOver(Game.GetTargetingSystem():GetLookAtObject(Game.GetPlayer(), false, false), CName.new('greeting'))
```

### Procedure (90 s)

1. Settings as normal play (here Master 100, Dialogue 100, others 0); no
   other app playing sound. Stand 1 to 1.5 m in front of the companion,
   facing them, with the camera still.
2. Developer start: `scripts\audio-level\Measure-OutputLoudness.ps1 -Seconds 90`.
3. Within those 90 s: play two or three of the companion's own game lines by
   another route (the console line above on the copy, as with any world NPC;
   the Current party Play row is gone). Then ask the companion one short question by text or voice and let
   the whole reply play. Keep 2 s of quiet between sounds.
4. The table lists each segment with its source; `Cyberpunk2077` rows are the
   game lines (or Omni replies), `msedge` rows are Pocket/Convai. Set
   `makeupDb` = current value + the printed difference. For Omni, compare the
   Omni reply row with the game line rows by hand (both are `Cyberpunk2077`).

## Tests

`bridge/dialogue-level.test.mjs` (meter against a known sine, gain and
limiter, slot WAVs on/off, settings file, control validation, graph routing)
and `bridge/dialogue-level-browser.test.mjs` (real Edge offline render).
In-game loudness and position acceptance remain open.

## Lip-sync clock (October 8)

In-game report after install: the mouth led the voice slightly (Judy, Pocket).
`scripts/audio-level/measure-playback-clock.mjs` plays three faint (-50 dBFS)
2 kHz ticks through the real renderer in Edge, logs its heard position on the
wall clock, and finds the ticks in a loopback recording of the Windows mix
(sample 0 of the recording is tied to the system clock).

| Renderer clock | Limiter | Audio reached the mix after the clock said |
| --- | --- | --- |
| before (output timestamp only) | off | 49.2, 49.3, 49.2 ms |
| before | on (6 dB) | 49.4, 49.3, 49.3 ms |
| after (timestamp minus base + output latency) | off | -0.7, -0.7, -0.9 ms |
| after | on (6 dB) | -0.9, -0.9, -0.9 ms |

Edge reported `baseLatency` 10 ms and `outputLatency` 40 ms; its output
timestamp does not include them, so the heard cursor (subtitles, face) ran
about 49 ms ahead of the sound. The limiter's 6 ms look-ahead was already
compensated exactly (on and off agree). The player now subtracts the reported
latency, which puts the cursor within 1 ms of the mixed sample. Delay after
the Windows mix (the device buffer, and a Bluetooth headset's link, often
100 ms or more) is not visible to software and is not compensated; the game's
own dialogue has the same delay. Omni plays through Audioware, whose
`Position()` clock is unchanged.

## Lip sync delay (Bluetooth)

After the clock fix the user still saw the lips slightly ahead: they listen
through Bluetooth earbuds, whose link delay comes after the Windows mix where
no API reports it. **Settings > Voices > Lip sync delay (Bluetooth)**: Auto,
Off, 50, 100, 150, 200, 250 ms (`audioDelay` in `runtime/settings.json`:
`'auto'` or the number; Off is 0). It holds back the clock the face,
expressions and subtitles follow, for every voice:

- Pocket and Convai: the bridge sends `delayMs` with each control; the player
  subtracts it from its heard cursor (`bridge/continuous-pcm-player.mjs`).
  The reply is also reported finished that much later, so group turns wait
  until the speaker is actually heard to the end.
- Omni (Audioware): the bridge writes `runtime/audio-delay.json`; `mod/speech.lua`
  reads it once per utterance and subtracts it from the Audioware cursor for
  the face and subtitles. The phrase itself still ends at its native end, so
  the last moment of mouth movement of each phrase is cut by that delay.

Auto uses 150 ms while the default Windows output device is Bluetooth, and 0
otherwise. Detection: `bridge/audio-output-probe.ps1`, one hidden below-normal
PowerShell process started with the first conversation turn (not at idle
startup), printing the default device every 60 s and exiting with the bridge.
A device counts as Bluetooth if its enumerator is BTHENUM/BTHLE or any text
property names BTHENUM, BTHLE or "Bluetooth": the user's realme Buds Air7 run
through Intel Smart Sound Bluetooth offload, enumerate as INTELAUDIO, and are
recognised by those properties. The game's own dialogue has the same Bluetooth
delay and the game does not correct it.
