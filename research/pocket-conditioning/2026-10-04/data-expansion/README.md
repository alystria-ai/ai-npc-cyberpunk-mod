# Authentic cast source expansion: code checkpoint

This is a small, byte-preserved source checkpoint for the October 4 game-dialogue collection. It contains no audio, models, API keys or large source receipts. `source-manifest.json` records the original runtime path, size and SHA-256 of every file. The copies preserve their original runtime-relative path assumptions; restore them to the recorded paths before execution rather than running them from this snapshot directory.

## Data objective

Inventory all 93 supported/research character targets and collect substantially more authentic dialogue for thin voices. The initial target is 300 usable, varied seconds per character where the game contains enough material; it is a floor, not a cap. Retain additional main- and minor-character speech, then balance training exposure separately. Existing qualified rich-voice TRAIN recordings can be reused without extraction.

Exact source-matched game dialogue is the primary transcript under the user's current policy. Local speech recognition is a fallback for ambiguous/suspicious cases, not an exact-spelling acceptance gate. Preserve original native captions, versioned qualification attempts, actual alignment/codec evidence and any corrected-text provenance.

## Source invariants

- New work stays under `runtime/voice-data-expansion-20261004`; frozen October 3 source/corpora, accepted models and original evaluation/reference artifacts remain intact.
- Finalized source-closure semantics and all 24 current listening references are preserved. References reserve exact source recordings/aliases; actual held-out delivery components keep their scene closure. Prior TRAIN may keep its role, but is not newly claimed as unseen evaluation.
- Discovery filenames, raw ID-byte matches and native voice tags alone do not identify a character's recorded line. Admission follows native actor/acquisition, screenplay speaker/item, dialogue event, explicit English variant and winning WEM joins.
- Existing direct-record, explicit two-source actor-continuity and registered MAIN recovery policies are reused without weakening them. Character identity and performer equivalence are separate; Mr. Hands' base/EP1 lineage remains explicit.
- Preserve full original WEM and decoded PCM, transcript and source receipts. No denoising, EQ, gain, trimming, model inference, cloud upload or training is performed by these collectors.
- Two global CPU slot leases bound source extraction/serialization/audio decoding. Helpers run hidden. Only explicit batches and contained paths are accepted.

## Collection and serialization

`decode_batch.py` records the first batch's exact implementation. `decode_batch_bulk.py` adds batch serialization authentication. `decode_batch_next.py` is the corrected current worker; it preserves the same source/audio checks and fixes interrupted-batch completion.

The production validator pins are:

| Source | SHA-256 |
|---|---|
| Cast-VoiceReferenceCandidates.py | `91c8c1ea1d7d5bfe1d2d3f54f6716040f9e43a108c3ec61ecc44e04f5c0a078a` |
| Extract-VoiceReferences.py | `565077b46ff96bfaf2a44dfd3addf792c1d2bf6b7eb9e14a68acf74a06f3144f` |
| native_source_contracts.py | `46aef2aaecd6ecd23cad9c7d214da440c3e4fd37754405cec3153aefb6e93ddb` |
| source_recovery_bridge.py | `1b0f8efb3f9b9300ae921a280682ac899a388862be796e24aac0f84692715c5a` |

WolvenKit's installed CLI accepts `convert serialize <file1> <file2> ...`. Passing explicit copied files without `--outpath` retains adjacent output paths and avoids a process startup for every scene. Each raw SHA-1/SHA-256, JSON source Header and full parsed Data comparison still runs. Actual 32-scene batches improved from 606 seconds with individual launches to 76.1 seconds with the explicit-file array. This was observed collection work, not a controlled hardware benchmark.

The first mixed 48-audio batch took 457.063 seconds; the first bulk-authenticated 48-audio batch took 110.922 seconds wall time. Different scene mixes affect timing. Per-batch receipts record actual counts, errors, elapsed time, source hashes and immutable output paths.

## Cancellation and resumption

The older workers could publish a partial receipt after noticing `collection/STOP`. They are retained here as historical implementation evidence. Use `decode_batch_next.py` and `run_plan_next.py` for subsequent execution.

The corrected worker raises on STOP and publishes no completed-batch receipt. Already published per-line original directories remain atomic and reusable. The runner verifies that a sealed receipt accounts for every requested candidate before skipping it; explicit `--resume-unsealed` preserves prior logs under a new attempt name and rechecks existing originals. Do not start two controllers for the same plan or manifest.

`Handoff-Controller.ps1` moved the active job to the corrected version at a clean boundary: it suspended only the owned coordinator, let its current child finish writing directly to its file log, verified the complete batch receipt, then retired the old coordinator. It never suspended the game or the decode child. Failure/timeout resumes the old coordinator. A new controller was launched only after the old one was retired.

A single source-backed cancellation check used valid batch inputs with a new receipt label and STOP present. It exited nonzero and produced no completed receipt. No broad test suite was run. Runtime check details are in `collection/controller-handoff.json` and `collection/cancellation-check.log`.

To pause at the next safe source boundary, create the owned `collection/STOP` marker; the current native subprocess may finish before the worker observes it. For an immediate stop, stop only verified owned collection controller/worker processes. Before resuming, verify they have exited, remove the owned stop marker, and use the corrected runner with `--resume-unsealed` if an interrupted log exists.

## Broad discovery and limits

The scene catalog contains 7,580 installed base/EP1 resources. The new binary discovery scan authenticated all 971,757,824 decoded bytes in 267.1 seconds and found discovery patterns in 2,915 scenes. This is an efficient shortlist, not speaker/line admission. A missing byte pattern does not establish source exhaustion.

Native voiceover, voice-tag and bark registries are also being inspected. Voiceover maps bind string IDs to WEMs but do not independently identify speakers. The typed voice-tag registries expose native IDs and explicit voiceset scene paths; these can guide subsequent source joins. A shared voice family is not automatically canonical character dialogue.

No collection counter is presented as usable training duration. The independent qualification lane performs source/role, transcript-policy, timing and codec admission before the final dataset is frozen. Final teacher training and student distillation remain separate work.
