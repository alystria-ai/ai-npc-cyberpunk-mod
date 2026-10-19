# Local speech-to-text

Voice input when the player is on the Mistral text route (`docs/MISTRAL.md`). Convai recognises speech on its own servers; Mistral
has no speech recognition, so on that route the bridge records the microphone itself and recognises the speech on this computer. The Convai
route is untouched: it never starts the worker, the capture page or any of this code. One exception: the voice keys with an add-on
speaker (docs/ADDON_API.md) use this recogniser whatever the player's provider is, because the add-on's answer comes from Mistral or
the local AI and never from a Convai session (`bridge/addon-voice.mjs`).

Files: `bridge/local-stt.mjs` (recogniser API and worker process), `bridge/local-stt-worker.py` (the Python worker),
`bridge/local-stt-capture.mjs` (microphone capture and the voice channel), `scripts/Bench-LocalStt.mjs` (benchmark),
`scripts/Upload-SttModel.py` (puts the model into the Hugging Face bucket); for other languages `bridge/speech-language.mjs` (language and
engine choice) and `bridge/voxtral-stt.mjs` (Mistral transcription). Tests: `bridge/local-stt.test.mjs`,
`bridge/local-stt-capture.test.mjs`, `bridge/local-stt-worker.test.mjs`, `bridge/speech-language.test.mjs`, `bridge/voxtral-stt.test.mjs`,
`bridge/local-stt-multilingual.test.mjs`.

**English only on the first pages.** Everything from "The model, and why" to "Audio path" describes the English path. For any other language see
"Other languages" below.

## The model, and why

**Moonshine Tiny, English, int8 ONNX** (Useful Sensors / Moonshine AI, 27 M parameters, MIT), run by **sherpa-onnx 1.13.6**
(Apache-2.0) on the CPU, in the Python that already ships for the Pocket voice. The model folder is 124 MB
(`preprocess.onnx`, `encode.int8.onnx`, `uncached_decode.int8.onnx`, `cached_decode.int8.onnx`, `tokens.txt`, `LICENSE`); the
two sherpa-onnx wheels add about 30 MB installed. English Moonshine models are MIT, so they may be redistributed in the free mod.

Measured on the development laptop (i9-13980HX, Windows "Balanced", the game running, 2026-10-11). 26 clips, 130 s of audio:
8 lines from the game's actors (accents, effects, the hardest set), 12 LibriSpeech read sentences, 6 Windows-voice lines with game
names. WER is over all 26 clips; the clips are not committed (game audio); `--synth` and `--dir` rerun it on anything.

| Candidate (all int8, 2 threads) | Size | WER | Final decode, p50 / p95 per 4-8 s clip | Notes |
|---|---|---|---|---|
| faster-whisper tiny.en | 75 MB | 12.0% | 0.82 / 0.88 s (1.06 s on 4 E-cores) | Whisper always pads to 30 s, so short clips cost the same as long ones; needs `av` and ctranslate2 wheels |
| faster-whisper base.en | 145 MB | 10.4% | 1.90 / 3.0 s | too slow |
| faster-whisper small.en | 484 MB | 7.6% | 8.0 / 9.1 s | most accurate, far too slow and large |
| Moonshine Tiny, own onnxruntime loop (merged, quantised) | 28 MB | 14.2% | 0.45 / 0.66 s | needs a new onnxruntime wheel and a hand-written decoder loop; slower than sherpa's |
| Moonshine Base, same | 63 MB | 13.6% | 0.87 / 1.34 s | |
| sherpa-onnx streaming Zipformer (en, 2023-06-26) | 71 MB | 12.7% (LibriSpeech 2.5%, game 28%, names 16%) | streams: 0.07-0.13 s after the last audio | true partials, but poor on names and acted speech |
| sherpa-onnx streaming Zipformer 20M | 43 MB | 35% | 0.32 / 0.47 s | too inaccurate |
| sherpa-onnx Moonshine Base (merged `.ort`, 2026-02-27) | 141 MB | 12.7% (one clip returned nothing) | 0.51 / 0.88 s | no gain over Tiny for 3x the size |
| sherpa-onnx Moonshine Tiny (merged `.ort`, 2026-02-27) | 44 MB | 12.3-13.3% | 0.26-0.33 / 0.4-0.5 s | same model as the chosen one, slower decoder |
| **sherpa-onnx Moonshine Tiny int8 (chosen)** | **124 MB** | **11.4-11.7%** (game 22%, LibriSpeech 8.8%, names 3.2%) | **0.18 / 0.28 s** (2 threads, 2 pinned E-cores, below normal) | |

Why this one: the fastest by a wide margin (its encoder cost scales with the audio length, not a fixed 30 s window), accurate on
plain speech and on this game's names (Judy, Panam, Afterlife, Jackie, Watson, Pacifica came out right), MIT, one small extra
dependency (`sherpa-onnx` only; numpy is already there), and it runs in the Python the package already carries. whisper.cpp was
not measured: it needs a native executable downloaded from GitHub and a new binary in the package, for no expected gain over the
Python route. Vosk and Whisper tiny are less accurate; a GPU is not used (the card belongs to the game and the CPU is fast enough).

**Threads.** The default is **one** thread. onnxruntime's thread pools spin-wait, so measured per 4.5 s clip: 1 thread 0.41 s wall /
0.40 CPU-s, 2 threads 0.28 s / 1.28 CPU-s, 4 threads 0.28 s / 3.1 CPU-s. Two threads would be 30% faster for 3x the CPU, which is
the wrong trade next to a running game. Final decode with one thread over the whole 130 s set: p50 0.45 s, p95 0.67 s on all
cores; p50 0.51 s, p95 0.82 s pinned to 4 E-cores (a rough mid-laptop proxy), worker CPU 0.08-0.10 core-seconds per second of
audio. The `threads` option allows up to 4.

**The usual latency is much lower.** While recording, a live-words decode runs about every 1.2 s. If one has already decoded the
whole recording (up to 8 s) and only silence follows, `finish()` returns that text without decoding again: about 3 ms. Measured
with real-time pacing, 4 of 6 clips finished in 2-4 ms, the others in 0.33-0.45 s.

The first recording after a quiet period starts the worker: Python, sherpa-onnx and the model take about 3-4 s to load. The load
overlaps with opening the microphone and with the player speaking, so it only shows when a recording is shorter than that.
The worker exits after 90 s without a recording and gives its memory (about 250 MB) back.

On a laptop in Silent power mode all numbers are slower; compare like with like.

## What runs when

| Moment | Work |
|---|---|
| No recording, and 90 s after the last one | nothing: no process, no timer except the one that ends the worker |
| Voice key pressed ("Connecting microphone") | worker spawned if needed; the capture page opens the device |
| "Listening" | the page sends a 100 ms Int16 chunk 10 times a second (a few KB each); the worker decodes the newest 8 s about every 1.2 s, never more than about 15% of one core, for the live words |
| "Listening", the player pauses (quiet 300 ms after speech) | one extra live-words decode at once, once per pause, at most 6 per recording, never while a decode runs, so the newest words are read before the key is pressed again |
| Key pressed again | on the Mistral route, if the newest live decode read all the speech and the quiet after it, the reply is requested at once on its words and confirmed (or cancelled and asked again) when the final words are known (`docs/LATENCY_2026-10-14.md` 1.1); final decode if no live decode covered the recording |

The worker runs at below-normal priority with one thread. Nothing runs on the game's side per frame: the Lua side is the existing
state/words file poll.

## Audio path

`LocalSttCapture` opens one small page in the bridge's hidden browser (the same browser the Convai voice pages use), served from
memory with every other request blocked. It grants the microphone through `context.grantPermissions` exactly as the Convai voice
route does and clears it when the recording ends. An AudioWorklet at 16 kHz mono downmixes, converts to Int16 and posts 100 ms blocks;
a `exposeFunction` binding carries them to the bridge. Ending a recording flushes the last block and waits for every chunk before
the device is released. The page stays open between recordings, but the device is open only while recording.

`createLocalSttChannel` / `createLocalSpeech` wrap it in the voice-channel shape `MicrophoneSession` already uses
(`beginVoice`, `finishVoice`, `heard`, `close`). So the voice key, `microphone-state.json` (starting, recording, reply, off,
no-speech, error), the "Listening" notice, the 700 ms minimum recording, the overdue-reply rule, the 30 s finish and the live
words (`microphone-heard.json` from `mic.heard()`) all run through unchanged code.

- Empty transcript: `finishVoice` rejects with `No speech was heard`, which the bridge already turns into the `no-speech` state
  and the game's "No speech was heard" notice. The recogniser has its own energy gate (150 ms above -52 dBFS and 9 dB over the
  recording's noise floor), so silence is never sent to the model and cannot be hallucinated into words.
- A pause before the first word: Moonshine returns no text at all for most speech that follows a second or more of quiet (29 of 36 test
  clips at 1.5 s of leading quiet), and a player presses the key (a click in the microphone), thinks, then speaks. Cutting only the quiet
  before the first sound was not enough (live record 2026-10-15: a click, 8 s of quiet and the words in a 12 s recording: the live decode
  of the newest 8 s read the words, the decode of the whole recording came back empty, and the fallback below could not apply because the
  click sat in the part the live decode had left out; 6 of 12 test clips were empty in that pattern). The worker therefore splits a
  recording into pieces of sound (`speech_groups`: runs of 3 frames above the gate, sounds under 720 ms apart together, 240 ms of quiet
  kept around each piece) and decodes each piece on its own, live decodes and finals alike, so no decode ever sees a long quiet. If the
  full decode is still empty after speech, the newest live words of the same recording stand instead of "No speech was heard" (even
  when the live decode left an early part out: words are better than a failed turn; the worker logs it). A final then costs one decode
  (about 0.2-0.4 s) when the live decode did not cover the whole recording, as before. `bridge/local-stt-worker.test.mjs` runs
  `local-stt-worker.check.py` against a stand-in model that has these quirks.
- Words made out of nothing (live record 2026-10-15: "random V lines" nobody said or typed). The live words of a recording are shown as V's
  own subtitle, and the final words are what V "said" to the model, so a decode of a breath, a key press, a fan or a dead input must never
  reach either. The worker measures the sound itself (`evidence`: loudest sound in dBFS, ms of sound, ms of it voiced, meaning a 70-400 Hz
  pitch repeating inside the 30 ms frame, which vowels have and noise does not) and refuses words (`judge`) when: no sound reached -50 dBFS
  (`quiet`), less than 150 ms of sound (`short`), less than 60 ms of it voiced (`not-voiced`), more than 7.5 words a second
  (`too-many-words`), a loop (`repeating`: one word three times in a row among others, a 2-3 word chunk three times in a row, or one content word making up a third or more of a text of six words or more, which caught "Destiny, destiny, destiny, ..." and "tooth tooth on tooth tooth" on 2026-10-15), a long piece of sound that is mostly not voiced (3 s or more of sound with under 35% of it voiced: `not-voiced`; speech measured 51% and up, a headset's hiss with a few vowels in it about 30%), or a stock phrase (Thank you., you, bye, so ...) on a weak sound
  (under 240 ms voiced or quieter than -36 dBFS: `stock-phrase`). A piece of sound that cannot be a voice is not decoded at all. Refused
  live words are sent as an empty partial with `rejected`, a refused final is empty with `rejected` and `ignored` (the words that were held
  back), and the turn ends as "No speech was heard". Moonshine itself gives no confidence scores (`ys_log_probs` is empty) and does not
  produce words from stationary noise, so the acoustic test is what stops the rest. Measured on the 36 test clips and the two V voice
  references at -30 dB, with room noise at -41 dBFS and with a click: none refused.
- The bridge log says what the microphone did, once when a recording opens and once when it ends: the input the browser chose (its
  default; every input it could have chosen; echo cancellation, noise suppression and gain control), then the length, loudest sound, ms of
  sound and ms voiced, and the words (`heard "..."`), the words that were ignored and why, or `no words` (with "the input is almost
  silent, check the Windows input device" below -55 dBFS). A wrong or muted device shows as a label that is not the headset or laptop
  microphone in use, or a near-silent peak.
- A device that sends no sound (loudest moment under -55 dBFS, measured on the whole recording, not only on pieces that were decoded): the turn ends
  with `error.code === 'MIC_SILENT'` and the device's name, the bridge writes the state `silent` with `device`, and the game shows "The microphone
  {name} sends no sound. Check your Windows input device." (notice `mic-silent`) instead of "No speech was heard". A quiet room with no words,
  or a breath, still gets the ordinary notice.
- The talk key (live record 2026-10-15: "when I press F8 it doesn't stop recording", two recordings ran to the 30 s cap on a Bluetooth headset
  microphone). F8 and the group key are CET inputs (`registerInput`), not hotkeys: a hotkey runs only when the key comes back UP, so a held key
  did nothing until it was let go and a stop press was seen late or lost behind the 2 s a Bluetooth microphone takes to open. Now the key reports
  both edges (`mod/init.lua voiceKeyEdge`): a press that finds a recording finishes it on the press itself; a press that begins one is a tap if the
  key is up within 300 ms (the next press finishes) or a hold (letting go finishes it, source `release`), except when the device is still opening
  (it stays a toggle). Every edge, its recording state and the command source (`press`, `release`, `cap`, `*-delayed`, or the cancel reason) are logged
  in the game's log, and the bridge logs each command with its source and how many ms into the recording it arrived, then "capture closed N ms after
  the stop command": the device is closed the moment the stop arrives (`MicrophoneSession.stopCapture`, `channel.endCapture`), before the context
  refresh and the 700 ms minimum that come before the final decode. Nothing the mod speaks plays into a recording: the key stops all voices and clears the
  subtitle before the device opens, and automatic add-on remarks and battle/loot reactions wait while a recording is open. The game's own sound and
  the headset's own sidetone cannot be controlled from the mod.
- Not installed (Python, worker, model or sherpa-onnx missing): `availability()` says which; `beginVoice` rejects before the microphone
  opens with `error.code === 'local-stt-unavailable'` and `error.reason`.
- Spam, cancel, supersede: a new `start` cancels the open recording; late audio for an old id is dropped; cancel releases the device
  and tells the worker.

## Interface

```js
import {LocalStt} from './local-stt.mjs';
import {LocalSttCapture, createLocalSpeech, hostBrowser} from './local-stt-capture.mjs';

const stt = new LocalStt({project, pythonExecutable});      // threads (1), partials (true), partialIntervalMs (1200), idleMs (90000), fixups
stt.available();                    // boolean
stt.availability();                 // {available, reason}  reason: python-missing | worker-missing | model-missing | engine-missing | null
await stt.start(requestId);         // begin a recording (spawns the worker; audio pushed meanwhile is held)
stt.pushAudio(chunk, requestId?);   // Buffer / Uint8Array / Int16Array: 16 kHz mono Int16; returns false when ignored
stt.on('partial', ({requestId, text}) => {});   // live words, newest last, at most 100 characters
stt.heard(requestId?);              // the latest partial ('' when none)
const {text, seconds, ms, speech, reused} = await stt.finish(requestId?);   // text is '' when nothing was said
await stt.cancel(requestId?);
await stt.warm();                   // optional: start the worker ahead of time
await stt.close();                  // cancel and stop the worker
stt.on('failure', error => {});     // the worker died or could not start during a recording
```

The bridge hook for the Mistral route (in `bridge/convai-bridge.mjs`, passed to `attachMistral`):

```js
const mistralSpeech = createLocalSpeech({
  stt: new LocalStt({project, pythonExecutable: voiceConfig.runtime?.pythonExecutable}),
  capture: new LocalSttCapture({getBrowser: hostBrowser(realtime)})});
mistralSpeech.available();                  // boolean, polled every 10 s for the settings page's `stt`
mistralSpeech.availability();               // {available, reason}
mistralSpeech.voiceChannel({reply});        // a fresh channel for one recording; reply(config, options) is the text provider's reply
mistralSpeech.warm(); mistralSpeech.close();
```

`reply` receives the turn's configuration with `text` set to the transcript (the same call a typed turn makes) and `options.signal`,
and returns the reply the bridge publishes; `finishVoice` adds `userText`, `local: true` and `timing.sttMs`.
The transcript gets a short fix-up list for names the model mishears ("pan am" to Panam, "after life", "Ares Acha" to Arasaka,
"silver hand"); replace it with the `fixups` option. The text provider's prompt should still say that the player's words come from
speech recognition and names may be misspelled.

Paths: Python is `CYBERPUNK_CONVAI_LOCAL_STT_PYTHON`, else the Pocket Python (`voiceConfig.runtime.pythonExecutable`), else
`CYBERPUNK_CONVAI_PYTHON`. The model is `CYBERPUNK_CONVAI_STT_MODEL`, else `models/stt/moonshine-tiny-en-int8` in the application
folder (packaged), else `runtime/stt-model/moonshine-tiny-en-int8` (development). In development `sherpa-onnx` is installed in
`vendor/pocket-tts-env` (`pip install sherpa-onnx==1.13.6 sherpa-onnx-core==1.13.6`).

## Other languages

Moonshine Tiny hears English only. A Russian player on the Mistral route reported (Nexus, 2026-10) that "the microphone recognizes only
English" while typed Russian and spoken replies worked: the recording was decoded by an English model. Since this change a recording in
another language is recognised by another engine; **English keeps exactly the path above** (Moonshine, live words, the 3 ms reuse of a live
decode), and none of the code below runs, loads or opens a connection for it.

### Which language, and how the bridge knows

`bridge/speech-language.mjs` (pure logic; `SpeechLanguage` holds the little state). At the moment a recording opens, in this order:

1. **Evidence from the player**: the language of the last text they typed (`detectLanguage`, `bridge/reply-language.mjs`; a short or mixed line says
   nothing; automatic reactions are not counted) or the language Mistral reported for the last recording. Both live in memory for the life of
   the bridge. English evidence wins like any other, so an English speaker with a Russian game keeps the English path.
2. **The interface language**: the explicit "Interface language" setting (`settings.json` `uiLanguage`), else the language the mod resolved from
   the game (`runtime/ui-language.txt`, written by `mod/microphone.lua publishLanguage` from the one place in `mod/init.lua` that already learns
   of a change; nothing per frame). The bridge reads the file when a recording opens, at most once in 3 s.
3. **English.** A game language the mod does not support (Arabic, Thai) counts as English.

Only the 15 non-English interface languages of the mod are considered (`mod/locales`: de, fr, es, it, pt-br, pl, ru, uk, tr, cs, hu, ja, ko,
zh-cn, zh-tw; Portuguese and the two Chinese variants share one base code each).

### Which engine hears it

`planRecording()` decides once per recording:

| Route | English | Other language |
|---|---|---|
| **Mistral** | Moonshine (unchanged) | **Mistral transcription** (`voxtral-mini-latest`, `bridge/voxtral-stt.mjs`) with the player's key. If it fails or is cooling down: an installed local pack that hears the language, else the English recogniser on the same audio (the log says so) |
| **Local AI**, **custom endpoint**, add-on voice keys on Convai | Moonshine (unchanged) | an installed **local pack** that hears the language; with none, the English recogniser and one notice "Voice input only understands English for now. Typing works in any language." (`mic-english-only`, once per game session, under the Listening line) |

When an optional pack hears the language but is not installed (`plan.note` `pack-available`), the notice is "Voice input in this language needs the optional Microphone pack from the mod page. Typing works in any language." (same id `mic-english-only`, same once-per-session rule); when nothing hears it (Turkish, Japanese, Korean) it stays the plain English-only sentence.

Audio is sent to Mistral **only while Mistral is the player's conversation provider** (their words already go there). The Local AI and custom routes
never send a recording to Mistral, even when a Mistral key is saved: a player who chose a local or private route did not choose that.

A recording in another language on the Mistral route is **kept in memory** (16 kHz mono, at most 45 s) while the player speaks, with the same
speech-activity gate as the local recogniser (`bridge/stt-activity.mjs`: audio without speech is never sent, so silence costs no request and cannot
be hallucinated into words; a dead input still gives the "microphone sends no sound" notice). When the key is pressed again it is sent as one WAV
(`POST /v1/audio/transcriptions`, multipart: `model`, `file`, and `language` only when the player's own text or an earlier recording named it
and Mistral lists it; an interface-language guess is never sent as a hint, so an English speaker with a Russian game is still heard as English).
There are **no live words** for these recordings (batch mode has no partial results). No Moonshine worker starts, so nothing is loaded: no worker, no 250 MB.

What Mistral answers with (`language`) is remembered, so after the first recording the bridge knows the language from the voice itself, and a player who
switches to English is moved back to the English path by the next recording's result.

Failure handling (`VoxtralStt`): one quick second try for a 5xx, 408, network error, a 403 or a short 429; a 401 (refused key), a repeated 403 or an
allowance of 0 (`x-ratelimit-limit-req-minute: 0`, how the free plan refuses models it does not include) put the transcriber into a cool-down (10 min;
a 429 waits its Retry-After, at most 60 s; a different key clears it), during which recordings go straight to the fallback instead of paying a failed
request each. Requests go through the shared Mistral scheduler (`bridge/mistral-rate.mjs`, text priority), the key only ever appears in the
Authorization header, and every message is redacted.

### Options considered (2026-10-19; nothing was downloaded or called)

| Engine | Languages | Size | Speed (one CPU thread unless noted) | Licence | Verdict |
|---|---|---|---|---|---|
| **Mistral Voxtral Mini Transcribe 2** (`voxtral-mini-latest`, API) | 13: en, zh, hi, es, ar, fr, pt, ru, de, ja, ko, it, nl (not pl, uk, cs, hu, tr; those are asked without a hint and may still work) | none | batch; estimated 0.5 to 1.5 s for a 3 to 8 s clip (TLS is opened ahead; 32 KB per second of audio goes up). **Not measured: no call was made.** Price $0.003 per minute; limits of the free Experiment plan for this model are not published | API terms | **Chosen for the Mistral route**: no download, no memory, best accuracy, and the player already has the key. Unverified: whether a free key may use it (the free plan gave the chat models Small and Medium an allowance of 0 on 2026-10-11, while Voxtral speech synthesis works on it); the fallback covers a refusal |
| **NVIDIA Parakeet TDT 0.6B v3** int8 (sherpa-onnx `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`) | 25 European, auto-detected: **ru, uk, pl, cs, hu, de, fr, es, it, pt** of the mod's (also en, nl, sv and others); no tr | 487 MB archive (encoder 622 MB unpacked) | sherpa-onnx's own figures at 2 threads: RTF 0.325 on a 3.8 s clip including set-up, 0.028 on long audio. Estimated 0.4 to 1.0 s for a 5 s clip at one thread; load 4 to 10 s; about 1 GB resident while loaded. **Not measured here** | CC-BY-4.0 | **Chosen as the local pack for European languages** (Russian WER 5.5% on Fleurs, Polish 7.3%, Czech 11%, Hungarian 15.7% per NVIDIA) |
| **FunAudioLLM SenseVoice Small** int8 (`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09`) | zh, en, ja, ko, yue | 166 MB | RTF about 0.05 on desktop CPUs; estimated 0.25 s for a 5 s clip; about 300 MB resident | FunASR model licence (attribution; check before redistributing) | **Chosen as the local pack for zh, ja, ko** (Parakeet has none of them). **Measured 2026-10-19: this archive's model reads Mandarin only** (see "Measured with the real models"); the pack is listed for zh |
| Whisper tiny / base / small, multilingual, int8 | 99, auto | 116 / 208 / 639 MB archives | Whisper always pads to 30 s: this project measured tiny.en 0.8 s, base.en 1.9 s, small.en 8 s (two threads, table above); the multilingual models share the architecture | MIT | Rejected: tiny and base are far less accurate than Parakeet in Russian, small costs about 8 s per recording. Would be the only local route for Turkish |
| Moonshine language variants (sherpa-onnx 2026-02-27: ar, ja, ko, uk, vi, zh, es) | 7, none of ru, de, fr, pl, cs, hu, it, pt, tr | 48 to 119 MB | fast | Moonshine Community Licence for non-English models (non-commercial) | Rejected: misses the languages that matter and its licence blocks the free mod |
| GigaAM v3 Russian (`sherpa-onnx-nemo-transducer-giga-am-v3-russian-2025-12-16`) | ru only | 167 MB | fast | MIT | Not chosen: Russian only; the best small option if a Russian-only pack is ever wanted |
| Canary 180M Flash int8 | en, es, de, fr | 154 MB | fast | CC-BY-4.0 | Not chosen: a subset of Parakeet's languages |
| Qwen3-ASR 0.6B int8 (2026-03-25) | 30+ | 879 MB | not known at one thread | Apache-2.0 | Not chosen: size, no speed figure |

Turkish is the only one of the mod's languages that neither Mistral's list nor the two packs name. A Turkish player on the Mistral route is still sent to
Mistral (auto-detect); on Local AI the notice above says voice is English only for now.

### The optional packs

A pack is **used only when its files are present** (they ship as the two optional MicPack zips, "Packaging" below); without them the code behaves as described above
(Mistral transcription on the Mistral route, the English recogniser and the one-time notice elsewhere). Place the files in `models/stt/<id>/` (packaged)
or `runtime/stt-model/<id>/` (development), or in `<CYBERPUNK_CONVAI_STT_PACKS>/<id>/`:

| Pack id | Folder contents (from the sherpa-onnx `asr-models` release archive of the same name) | Download |
|---|---|---|
| `parakeet-tdt-0.6b-v3-int8` | `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt` | `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` (487 MB; unpacks to `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/`, rename it to the id), CC-BY-4.0, model card `huggingface.co/nvidia/parakeet-tdt-0.6b-v3` |
| `sense-voice-int8` | `model.int8.onnx`, `tokens.txt` | `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2` (166 MB; rename the folder to the id), FunASR model licence |

Behaviour of a pack: a second `LocalStt` per pack (`bridge/local-stt.mjs`, `engine` option) in the same Python worker (`bridge/local-stt-worker.py --kind
nemo-transducer|sense-voice`), one thread at below-normal priority, same sound gate and refusal of words that are not speech as Moonshine (the English-only
stock-phrase list is harmless for other languages). It decodes once, when the key is pressed again (no live decodes, no pause decodes); it starts when
a recording opens (the model loads while the player speaks) and **exits 60 s after the last recording**, giving its memory back; the page that holds the
microphone is released once no recording is open (`createLocalSpeech`). The Parakeet loader leaves the feature size to the model (read from its
metadata); it is written against sherpa-onnx 1.13.6's signatures, tested with a stand-in recogniser and, since 2026-10-19, with the real files
(next section). In the bridge log the first real run reads `speech language ... local pack ...`, then `recorded ... heard "..."`.

Packaging: `micPacks` in `packaging/release.config.json` pins both archives and every file; `node packaging/build-release.mjs --version <v> --packages
micpack-european,micpack-asian` builds `AI-NPC-Cyberpunk-Mod-MicPack-European-<v>.zip` and `...-MicPack-Asian-<v>.zip` (opt-in, never in the default set, hosted
on Hugging Face only, one zip each, extract-into-game-folder layout `red4ext/plugins/AiNpcCyberpunkMod/app/models/stt/<id>/`, no path shared with the
Runtime), each with a `NOTICE.txt` (CC-BY-4.0 attribution for Parakeet; FunASR licence name, source and link for SenseVoice) and a `mic-pack.json` marker.
`THIRD_PARTY_NOTICES.md` has both lines. The FunASR licence text itself is linked, not bundled: it was not among the approved downloads.

### Measured with the real models (2026-10-19)

The two archives were downloaded (sizes and SHA-256 in `packaging/release.config.json`), unpacked as untrusted data, and run through the mod's own
`LocalStt` and `bridge/local-stt-worker.py` (python.exe of the dev environment, sherpa-onnx 1.13.6, **one thread, below-normal priority, CPU only**,
no GPU), on the development laptop (i9-13980HX, Balanced, nothing else heavy running). Clips: the models' own test clips (de, es, fr, en, ja, ko, zh, yue)
and 14 languages x 3 sentences synthesised with OmniVoice from known text (game names in them: Judy, Afterlife, Watson, Jackie, Arasaka), 2.5 to 4.3 s each.
The clips are not committed.

**Parakeet TDT 0.6B v3 int8** (33 synthetic clips, 11 languages): word error 5.8% over all; by language: de 0, fr 0, en 0, es 3.6, it 3.7, cs 3.8,
uk 4.2, pt 6.9, hu 7.1, ru 16.0, pl 24.0. Almost every error is a name or an inflection (Judy heard as "Judi" or "Gyudi", "Afterlife" written as two words in Russian,
"Dziakiego" for Jackiego in Polish); the sentences themselves came out right. The models' own de, es, fr, en clips are exact.
Latency from the key press to the transcript (the pack decodes once, so this is the wait): 0.9 to 2.5 s for a 2.5 to 4.3 s clip (mean 1.6 s), 3.0 to
3.6 s for an 11 to 13 s sentence group at one thread, 1.8 to 2.1 s at two threads (2.5 times the CPU: one thread stays the default). Load: 4 to 5 s
with the files in the Windows file cache, **67 s the first time after they were written** (the worker's first decode includes ONNX set-up; Windows
was reading and scanning a 650 MB file), so a pack's startup allowance is 150 s (`startupMs` in `bridge/convai-bridge.mjs`); the model loads while the
player speaks, and the wait shows only on the first recording after installing. Resident memory 830 MB while loaded, gone 60 s after the last recording
(the worker exits; checked: no process left).

**SenseVoice Small int8, archive 2025-09-09** (3 clips each): Mandarin: character error 2.5% (a 10.4 s three-sentence clip: 1 error in 40), decode
0.45 to 0.7 s for 3 s clips, 1.4 s for 10.4 s, load 2.3 to 2.6 s warm, 356 MB resident. **Japanese: 84% character error, Korean: 96%, on the model's own clips
and on the synthesised ones; the language option (`ja`, `ko`, `zh`, `auto`) changes nothing** (every result carries the `<|yue|>` tag). The reason is in
the archive's own README: this model is the ASLP-lab Cantonese fine-tune of SenseVoice Small (WSYue-ASR), not the original model. So `sense-voice-int8` is listed for **zh only**
(`LOCAL_PACKS`), a Japanese or Korean player gets the plain "English only for now" notice on the local routes, and the Asian pack is described to players
as Mandarin Chinese. The original model (`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`, same file names `model.int8.onnx` and `tokens.txt`) is
expected to read ja and ko: it has not been downloaded or tested (not approved). If it is approved and passes, put its two files in the same folder,
re-pin them in `packaging/release.config.json`, add `'ja', 'ko'` to the pack's `languages` and rebuild the pack. Traditional Chinese speakers are read as
Mandarin and shown in simplified characters.

A fix that the real files forced: `-I` ignores `PYTHONUTF8`, so the worker's standard streams were in the console code page and the first Korean or
Cyrillic transcript raised `UnicodeEncodeError` (the stand-in tests never produced one). The worker now switches its streams to UTF-8 at start
(`use_utf8`, checked in `bridge/local-stt-worker.check.py`), which also protects accented names in English transcripts.

### Live checks in the game (for the owner)

Prepare: a dev install of this branch (bridge restart, CET reload), `AI-NPC-Cyberpunk-Mod-MicPack-European-0.2.3.zip` and `...-MicPack-Asian-0.2.3.zip`
extracted into the game folder (or the two folders copied to `.../app/models/stt/`), the bridge log open.
1. Settings > Conversation provider: **Local AI** (with a Local AI pack installed). Interface language English, English text typed so far.
2. Speak English with the voice key: the old path, live words, no pack in the log. Task Manager: no extra python.exe holding 800 MB.
3. Settings > Interface language: **Russian** (or type two Russian sentences to a companion). Press the voice key, wait for "Listening", say a Russian sentence
   of 4 to 5 seconds (in Russian), press again. Check: the bridge log shows `speech language ru (...): local pack
   parakeet-tdt-0.6b-v3-int8, no live words`, then `recorded ... heard "..."` with your Russian words; the transcript line shows Cyrillic, the
   companion answers. Note the seconds from the second key press to the transcript (expected 1 to 3 s; the very first use may take about a minute).
4. Task Manager during step 3: one extra python.exe near 830 MB for the pack, below-normal priority, about one core while decoding; FPS unchanged while
   you talk (watch the FPS counter before and during the decode: no drop is expected, nothing runs per frame).
5. Wait 70 s without recording: that python.exe is gone (the pack unloaded). Press the key again: it loads again in about 5 s.
6. Delete or rename the European pack's folder, press the key in Russian: "Listening" with the second line "Voice input in this language needs the optional
   Microphone pack from the mod page." (once per game session), the recording is read as English. Put the folder back.
7. Mandarin: set the interface language to Chinese (Simplified) and say a short Chinese sentence: the Asian pack's log line, Chinese characters in the
   transcript. Then **Japanese**: with only the Asian pack installed you should see the plain "Voice input only understands English for now" notice (the
   pack does not read Japanese; this is expected until the original SenseVoice model is shipped).
8. Mistral as provider (key saved): Russian speech goes to Mistral's transcription as before; the packs are not loaded (no 830 MB python.exe).

### Log lines

`Microphone: speech language ru (ui): kept for Mistral transcription, language detected by Mistral`, then
`recorded 4.1 s from "..." (peak -14 dBFS, 2400 ms of sound) by mistral-voxtral [ru] in 640 ms: heard "..."`. On a failure:
`Mistral transcription failed (... [voxtral-stt:limit]); local pack ... reads the same audio` or `English recogniser reads the same audio`; with no
engine left the turn ends with the `mic-english-only` notice. `timing.sttEngine` in the turn record names the engine that answered.

## Packaging

- Python: `packaging/python/pocket.in` and `pocket.lock.txt` gain `sherpa-onnx` and `sherpa-onnx-core` 1.13.6 (hash-locked cp312
  wheels). The locked install was checked on the official 3.12.10 embeddable Python.
- Model: Hugging Face bucket `final/stt-model/moonshine-tiny-en-int8/` (6 files, listed with sizes and SHA-256 in `final/MANIFEST.json`
  by `scripts/Upload-SttModel.py`), a group in `packaging/release.config.json` (`--models local` reads `runtime/stt-model/...`),
  copied by `packaging/build-release.mjs` to `app/models/stt/moonshine-tiny-en-int8/`, with the licence text beside it and a line in
  `THIRD-PARTY-NOTICES.txt` / `THIRD_PARTY_NOTICES.md`.
- Code: `bridge/local-stt.mjs` and `bridge/local-stt-capture.mjs` are in the import closure (`BRIDGE_MODULES`),
  `bridge/local-stt-worker.py` in `bridgeWorkers` and `BRIDGE_AUXILIARY_FILES`. `packaging/test-release-install.mjs` transcribes the
  Pocket sentence with the packaged Python and model.

## Trying it

1. Restart the bridge (new bridge code); the voice client bundle is not involved, no `npm run build:voice`.
2. Settings: conversation provider Mistral (with a key). The voice key now records; "Listening" appears, words show as you speak.
3. Say a sentence with a name ("Hey Judy, want a drink at the Afterlife?"), press the key again; the transcript goes to Mistral.
4. Press the key and stay silent: "No speech was heard". With the model folder removed: the voice notice for Mistral.
5. Bench: `node scripts/Bench-LocalStt.mjs --synth --live` (real-time pacing with live words) or `--dir <folder of wavs>`.
