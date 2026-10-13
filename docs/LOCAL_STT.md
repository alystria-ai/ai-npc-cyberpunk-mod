# Local speech-to-text

Voice input when the player is on the Mistral text route (`docs/MISTRAL.md`). Convai recognises speech on its own servers; Mistral
has no speech recognition, so on that route the bridge records the microphone itself and recognises the speech on this computer. The Convai
route is untouched: it never starts the worker, the capture page or any of this code. One exception: the voice keys with an add-on
speaker (docs/ADDON_API.md) use this recogniser whatever the player's provider is, because the add-on's answer comes from Mistral or
the local AI and never from a Convai session (`bridge/addon-voice.mjs`).

Files: `bridge/local-stt.mjs` (recogniser API and worker process), `bridge/local-stt-worker.py` (the Python worker),
`bridge/local-stt-capture.mjs` (microphone capture and the voice channel), `scripts/Bench-LocalStt.mjs` (benchmark),
`scripts/Upload-SttModel.py` (puts the model into the Hugging Face bucket). Tests: `bridge/local-stt.test.mjs`,
`bridge/local-stt-capture.test.mjs`.

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
| Key pressed again | final decode if no live decode covered it; the reply is requested |

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
