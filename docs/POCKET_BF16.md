# Pocket English as bfloat16 (trial, 2026-10-22)

Status: a trial for listening. The Runtime still ships the English student as float32 (438 MB). Nothing in the worker, the pins or the packages changed.

## What it is

The five Pocket language models are Kyutai's own files, already stored as bfloat16 (219 MB, 214 tensors, the same 109,502,146 parameters as the English student). The English student is
the same layout stored as float32 (438 MB). `scripts/Convert-PocketBf16.py` makes the same thing for English: every float32 tensor cast with torch's round-to-nearest-even
`float32 -> bfloat16` (the largest relative change of any weight is 0.39 percent), the other files copied, `receipt.json` rewritten with the new `model_sha256` and a `provenance.bfloat16`
entry. The result is 219,029,196 bytes, byte-for-byte the size of the French model, and the script prints the model block (`sha256`, `configSha256`, `tokenizerSha256`, `receiptSha256`) the
worker's configuration pins.

```
<Runtime python> scripts/Convert-PocketBf16.py --export <Runtime>/app/models/pocket --out <new folder> [--config-out pins.json]
```

## The worker needs no change

`pocket-voice-worker.py` reads the weights with `TTSModel.load_model` into float32 modules (`inference.yaml` says `dtype: float32`), so a bf16 file is widened on load and `require_cpu_float32`
passes unchanged. The language models already take this path. Only the pins differ: the configuration's `model` block must carry the bf16 file's sha256 and receipt sha256 (the script prints
them). The trial ran the real worker through `PocketVoice` with a configuration whose `exportDirectory` is the converted folder.

## Measurements (this laptop, CPU, 4 threads, power mode Silent; the machine was not idle, 28 to 39 percent busy while timing)

- Worker start: fp32 20.7 s then 15.1 s, bf16 15.8 s then 14.5 s (alternating order, the first is cold). Worker memory 788 to 792 MB for both, 1,983 to 1,992 MB after 70 lines.
- Ten lines, five voices, first audio (mean ms) and RTF: back to back fp32 first 157 / 0.498, bf16 172 / 0.514; bf16 first 180 / 0.546, fp32 198 / 0.577; alternated line by line fp32 168 / 0.537,
  bf16 173 / 0.540. The two are the same within the noise: after load every operation is float32.
- Speaker similarity, ECAPA, 15 line/voice pairs, 2 renders each: bf16 vs fp32 0.877 mean (min 0.744); two renders of fp32 against each other 0.880 mean (min 0.761), so the conversion
  moves the voice no more than the run-to-run randomness does. Per voice (bf16 vs fp32 / fp32 vs fp32): Judy 0.844 / 0.838, Panam 0.894 / 0.877, Jackie 0.921 / 0.923, V male 0.877 / 0.884,
  V female 0.849 / 0.880. Against the reference clip: fp32 0.602, bf16 0.608.
- Intelligibility, Moonshine tiny en int8 (the mod's English mic model), 30 renders each: mean WER fp32 0.047, bf16 0.047; mean CER 0.020 and 0.022. Both misread the same dialect words
  (V female's "Assumin'").

The listening page (labeled, original game line, fp32, bf16, similarity per row) is `deliverables/pocket-bf16/index.html`; the harness is in `deliverables/pocket-bf16/tools/`.

## If it ships

- `app/defaults/pocket-voices.autobest.json` and every manifest that pins the English model (`model.sha256`, `receiptSha256`) change; the Runtime build, the install test and the update step's file list follow.
- Disk and download: -219 MB in the Runtime; an existing player's update step carries the new 219 MB file once.
- Nothing about the language models, voices or settings changes.
