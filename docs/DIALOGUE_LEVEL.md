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

`<game>/bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/runtime/dialogue-level.json`,
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

There is no Settings-menu row yet (it needs the label in all 18 UI languages).

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
to compare with by ear. With **Developer mode** on, **Companion Manager >
Current party** shows a "{name} · game voice" row (Play) under each ready copy.
It queues one of that character's vanilla voiceset lines and plays it when the
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
3. Within those 90 s: open Companion Manager > Current party, press Play on
   the companion's game voice row, close the menu, and wait for the line.
   Repeat (each press is another line) until two or three game lines have
   played. Then ask the companion one short question by text or voice and let
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
