# Full A teacher and student continuation candidate

Code only. Production qualification/trainer sources, accepted models and every earlier run remain unchanged. This candidate has not run a neural model or a training job.

## Chosen method and model lineage

- Use official A conditioning: the target recording supplies the audio prompt. The upstream aligned-short fallback is permitted only through authenticated source/alignment/actual-codec evidence; overlapping prompt/target is recorded honestly. No cross-utterance pairing, learned speaker IDs, LoRA, concatenation or duplicated short rows is introduced.
- The new teacher starts from **A's EMA at additional step 500**, checkpoint SHA `045b8432713e0a7d3456b445d71c4a945b246725874bebaefcac5ed814ea463f`. This is a deliberate new-corpus initialization: import the selected model weights and frozen codec, then create a fresh optimizer, schedule and run identity. Do not restore the pilot optimizer or call the new data a seamless pilot resume.
- Retain accepted teacher `95d91ae4b970e51bc6270326dccf1294d576f9cb9df4f9667ebb2838c7cb0d27` as the separately declared evaluation control. Its step, weight kind and input identity are explicit receipt fields, not the old hardcoded 1200-step comparison.
- The later student uses the selected completed teacher as a frozen target and the accepted student `373a0df2115b1e5dc1c583bb0033838ba4ae337499831261e3938218d239a391` as its separate immutable control/initialization. Teacher and student are separate specifications and jobs. Explicit compact raw-teacher imports are supported; they are never mislabeled as EMA.

## Entry points

```text
candidate/scripts/Pocket-KaggleTrain.py --spec <final-teacher.json> --mode teacher-only
candidate/scripts/Pocket-KaggleTrain.py --spec <final-student.json> --mode student
```

These use the standard A trainer and official pinned source, not the experimental pilot CLI or its fixed 500-step/source-ID policy. The model source, tokenizer, configuration, weights, complete corpus, native admission contract and code must all be bound in the final package.

At the **first line of the Kaggle execution**, before installation or staging, the launcher sets `POCKET_PROVIDER_DEADLINE_UNIX` to that execution's provider/quota deadline. Queue time is excluded. The code requires it for patient continuation and never resets it after setup. The provider session ceiling is 12 hours; the obsolete 3.5-hour and 11-hour project caps are removed.

## Explicit recipe contract — values await the corpus census

Teacher: `teacher_continuation.policy = patient_audio_reference_teacher_v1`.

Student: `student_continuation.policy = patient_audio_reference_student_v1`.

Both policy objects require these fields:

| Field | Meaning |
|---|---|
| `minimum_corpus_passes` | Minimum actual sampler exposure before any plateau decision |
| `minimum_speech_evaluations` | Multiple completed candidate evaluations, not one noisy observation |
| `stop_on_plateau` | Explicit opt-in; no silent inherited early stop |
| `plateau_patience` | Consecutive completed EMA evaluations without an eligible improvement |
| `candidate_weights` | Explicit retained `ema` and/or `raw` candidates; both are evaluated |
| `keep_candidates` | Upper bound on compact retained candidates; best and recent results are prioritized |
| `per_speaker_regression_limits` | Explicit speaker-to-limit maps for `dev`, `old_dev`, `conditional` |

The stage also requires explicit `<stage>_max_steps`, `<stage>_schedule_steps`, `<stage>_min_steps`, `<stage>_warmup_steps`, `<stage>_learning_rate`, `<stage>_ema_decay`, `<stage>_learning_rate_schedule`, and a final ratio if cosine is chosen. `<stage>` is `teacher` or `distill`. Minimum exposure and every planned speech checkpoint must be reachable under the actual prepared-row count/execution ceiling.

Declare `valid_freq`, `ckpt_freq`, `checkpoint_seconds`, `checkpoint_reserve_seconds`, explicit precision/fallback policy, relative improvement and regression criteria. No LR, maximum step count, cadence or patience values are selected by this code-only candidate.

Teacher uses `teacher_rollout_steps` and `teacher_reference_expectations`; student uses `rollout_steps` and `student_reference_expectations`. Schedules include baseline, intermediate and final steps. Expectations map each reference ID to its prompt count. The actual rollout uses the entire declared panel; the old three-reference truncation is retained only for historical policies.

## Patient evaluation and selection

- Keep identical heldout utterances, seeds, voice references and sampling settings between candidates and their controls. Distinguish unseen-scene development, seen-scene conditional monitoring and the immutable original regression/test panels. Exact source/reference/heldout aliases remain protected; corrected current role semantics replace old overbroad caption/conditioning-scene bans for new native data.
- Record raw and EMA speech plus per-character objective scores. Aggregate development improvement alone cannot hide a declared per-character regression. ASR output is diagnostic and fallible; it cannot override authenticated native training captions or alone veto valid generated PCM. Genuine missing/nonfinite/capped speech still rejects a numeric candidate.
- Keep numeric candidate selection separate from listening acceptance and runtime promotion. No code here replaces the mod's current model automatically.
- An optional plateau stop is considered only after warmup, explicit minimum steps/exposure and multiple completed speech evaluations. Rank zero makes one decision and broadcasts it to every worker.

## Durable evaluation/resume boundary

Before a long evaluation, all ranks share a unique pending-evaluation ticket, then write the full `last.pt` with that ticket. After complete exact receipts are committed, a small completion record binds the ticket and file hashes.

On resume, step N's pending evaluation is completed or reused **before optimizer step N+1**. A committed heldout result applies counters once; already committed raw/EMA speech is reused by ticket, selection identity and exact audio/receipt hashes. The same synchronized plateau decision is considered at N before advancing. Incomplete work remains pending rather than disappearing at the session boundary.

Within an unchanged finalized corpus/recipe, restore model, optimizer, scaler, EMA, per-rank RNG, global step and original schedule. Use the same DDP world size and stable logical input/output paths. Do not reset warmup or treat a changed dataset as an ordinary resume. Preserve quality-anchor receipts, candidate index, pending/completed evaluation receipts and prepared-cache metadata with the full checkpoint.

## Saved-output strategy

Retain one full resumable `last.pt`, bounded compact selected-weight candidates, audio and receipts. A latent-only `best.pt` duplicate is no longer written for patient runs. Candidate files contain selected model state only, with no optimizer or redundant EMA dictionary. The selected candidate is a hash-bound index entry, not a second copied model.

The output bound is conservatively below Kaggle's 20 GB publication limit (18,000,000,000 bytes), with space reserved for the next atomic full-checkpoint rewrite and final export. Only obsolete, unselected, hash-matched files inside this run's candidate directory may be pruned. The externally preserved accepted baseline is untouched.

## Native corpus contract

See `NATIVE_PRIMARY_ADMISSION.md`. The adapter distinguishes unchanged native captions, engine-rendered spoken targets, actual legacy evidence, and explicitly verified upstream short fallback. Original proof bytes and raw-caption identities remain separate from derived training text. There is no fabricated ASR agreement or renamed legacy execution.

`final_corpus_assembly` owns the new corpus. Inputs include eligible prior TRAIN, the actual 177 legacy expansion rows, and completed new qualification receipts, with current protected-role/reference exclusions. The old capped 1020-row pilot is not the full eligible pool. No fixed duration cap is applied by this candidate.

## Private input / dispatch plan

Reuse the existing private common assets and accepted teacher/student inputs when hashes agree. Mount the exact completed A pilot output to derive its selected EMA warm-start export; bind that export's actual hash and provenance before `load_spec`. Only the new source/corpus package needs a fresh private input. No publication or model download is implied by this note.

A new teacher job stages one frozen corpus/recipe/code set, runs preparation once, then teacher training/evaluation. Each provider-bound segment publishes a coherent full resume package. A resumed segment mounts the prior immutable output and restores the same experiment namespace; it does not reset the run's quota ledger. Recheck actual account allowance before each dispatch; do not assume all 30 hours remain. The later student job imports only the explicitly selected teacher after its receipts are complete.

## Remaining launch gates

1. Final all-cast usable census and role split, including completed new short/rendered codec receipts; no evolving count is a frozen dataset.
2. Final native admission bundle and portable evidence map pass the actual candidate entry; no missing or ambiguous original-path dependency.
3. A EMA500 initialization export and accepted-control receipts are bound; fresh optimizer/schedule choice is explicit.
4. Choose the full teacher/student recipes from actual row/duration/coverage and measured hardware costs, with enough account budget reserved for both roles. No further A/B/C training comparison is needed.
5. Root reviews the frozen candidate/diff and finalized data before any private training Save. A small real entry/resume failure check may close a concrete remaining seam; broad baseline test expansion is unnecessary.

Current verification is source parsing plus narrowly scoped control/evidence readback. It is not a claim that a new teacher or student has been trained.

## V2 native admission delta

This source revision changes only native_primary_data.py from the independently reviewed v1. It adds explicit engine-rendered v2/edge qualification: actual original-recording encoding and all-cut token/frame arithmetic, with observed stitched encode/mask evidence for the first and last reachable cut only. It never labels unencoded interior cuts as observed. The later resource-only guarded worker is bound separately. Official short-overlap authorization and original/native target separation remain unchanged. Exact real receipt readbacks and two bounded coverage misrepresentation controls are retained in staging/adapter-revision. Final portable corpus entry has not yet run; production qualification workers and frozen v1 remain unchanged.
