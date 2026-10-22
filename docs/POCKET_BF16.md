# Pocket English as bfloat16 (ships from 0.2.9)

The Runtime stores the English Pocket student as bfloat16: 219,029,196 bytes instead of 438,033,312, the same 214 tensors. The owner listened to it on 2026-10-22 ("same") and
decided to ship it. The five Pocket language models are Kyutai's own files, already bfloat16 (219 MB, the same 109,502,146 parameters), so English now has the same shape.

## What changes and what does not

Only the weight file and the pins that name it. The worker (`bridge/pocket-voice-worker.py`) reads the weights with `TTSModel.load_model` into float32 modules
(`inference.yaml` says `dtype: float32`), so the bfloat16 file is widened on load, `require_cpu_float32` passes, and every computation is float32 exactly as before. Memory,
speed and the worker are unchanged. No worker, bridge or launcher code changed. Weights were rounded once to bfloat16 (7 mantissa bits; the largest relative change of any weight is 0.39 percent).

## How the build makes it

The release build (`packaging/build-release.mjs`, `runtimePackage`) converts at package time, so nothing new has to be uploaded or kept:

1. The Hugging Face bucket still holds the float32 student and a `pocket-voices.autobest.json` that pins it. `verifyPocketModel` checks the float32 files against those pins first.
2. `packaging/lib/pocket-bf16.mjs` (`makePocketBf16`, plain Node, no torch, about 6 s) writes `model.safetensors` as bfloat16 (round to nearest even, header and tensor order as the safetensors
   library writes them) and `receipt.json` with `model_sha256` set to the new file and a `provenance.bfloat16` entry (`from_model_sha256`, the cast, the tool). The receipt is edited as text so its
   line endings and numbers (`1.0`) stay as they were.
3. The configuration the Runtime carries (`app/defaults/pocket-voices.autobest.json`) gets `model.sha256` and `model.receiptSha256` of the converted files (`configSha256` and `tokenizerSha256`
   are the same files and stay), and `app/release.json` `pocketModel` is the new model sha256. `verifyPocketModel` runs again over what is packaged.
4. `app/models/pocket/model.safetensors` and `receipt.json` in the zip are the converted files; `inference.yaml`, `tokenizer.json` and `decoder-receipt.json` are the originals.

Every start, `app/launcher/prepare-state.mjs` rewrites the data folder's `pocket-voices.autobest.json` from the Runtime's defaults, so an updated Runtime pins the new model at its first start. The prepared
voice states are keyed by the model's sha256 (`PreparedVoiceStore`), so a player's saved Pocket voice states are made again once.

Pinned values for the 0.2.9 student (v2 step 2000 EMA, decoder v2), from the build's own conversion (the Python reference below and the Node converter give the same bytes):

| | float32 (source) | bfloat16 (ships) |
|---|---|---|
| `model.safetensors` sha256 | `c6bdd31eebf476e8c855c2174c7ea1030535789af387ce718009eba2e0fe20cd` | `b0e3358ee5e3dd01159e34d25df86f877a0dcfd148e925ee50971ddef5323ec5` |
| `receipt.json` sha256 | `9e83b77a8e11aee9c5335b5ad5ffd859666282f188156de6d4bf43f0c68113c4` | `e3a7e62f222ece9b1f603462f4ad0beb963e73dab86c24270a7abbf65b22fdf9` |
| bytes | 438,033,312 | 219,029,196 |

The bucket's configuration and the developer's `runtime/` stand-ins stay float32; a developer's game that uses an unpackaged student keeps the float32 pins (`scripts/Switch-VoiceConfigs.mjs` reads
the pins from whatever export it is pointed at).

## Update step

The Runtime update zip (`packaging/build-runtime-update.mjs`) is a byte comparison of two full Runtimes, so the 0.2.8 to 0.2.9 step carries the new `model.safetensors` (219 MB unpacked),
`receipt.json`, `app/defaults/pocket-voices.autobest.json` and `app/release.json` with nothing special done (`packaging/pocket-bf16.test.mjs` checks it with a fixture). The Runtime is 219 MB smaller unpacked; the zipped saving is to be read from the
built zips (the build agent records it).

## Checks

- Python reference: `scripts/Convert-PocketBf16.py --export <app/models/pocket> --out <folder>` gives the same model and receipt bytes as the Node converter (compared with `cmp`).
- The real worker (`PocketVoice`) started on the Node-converted export with the pins above and spoke a line; the trial measurements are below.
- `packaging/pocket-bf16.test.mjs`: the cast (ties, NaN, infinity), the file layout, metadata, refusal of non-float32, the receipt edit (CRLF, `1.0` kept), pins, and the update step.

## The trial that decided it (this laptop, CPU, 4 threads, power mode Silent; the machine was not idle, 28 to 39 percent busy while timing)

- Worker start: fp32 20.7 s then 15.1 s, bf16 15.8 s then 14.5 s (alternating order, the first is cold). Worker memory 788 to 792 MB for both, 1,983 to 1,992 MB after 70 lines.
- Ten lines, five voices, first audio (mean ms) / real-time factor: back to back fp32 first 157 / 0.498, bf16 172 / 0.514; bf16 first 180 / 0.546, fp32 198 / 0.577; alternated fp32 168 / 0.537, bf16 173 / 0.540.
  The same within the noise: after load every operation is float32.
- Speaker similarity, ECAPA, 15 line/voice pairs, 2 renders each: bf16 vs fp32 0.877 mean (min 0.744); two renders of fp32 against each other 0.880 mean (min 0.761), so the conversion moves the
  voice no more than the run-to-run randomness does. Per voice (bf16 vs fp32 / fp32 vs fp32): Judy 0.844 / 0.838, Panam 0.894 / 0.877, Jackie 0.921 / 0.923, V male 0.877 / 0.884, V female 0.849 / 0.880.
  Against the reference clip: fp32 0.602, bf16 0.608.
- Intelligibility, Moonshine tiny en int8 (the mod's English mic model), 30 renders each: mean WER fp32 0.047, bf16 0.047; mean CER 0.020 and 0.022.

The listening page (labeled, original game line, fp32, bf16, similarity per row) and the harness are in `deliverables/pocket-bf16/`.
