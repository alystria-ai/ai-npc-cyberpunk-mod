# Conditional student-training readiness candidate

This directory is a code-only overlay against the exact `hybrid-v2` files named
in `base-manifest.json`. It is not a runnable training package, a selected model,
or an installed runtime. No weights, corpus, job, or accepted model were changed.
Use `changes.patch` or the five files under `files/` only after checking the base
hashes. Recompute the assembled runner/source seals before any future job; do not
point an existing published job or resume receipt at this candidate.

## What changed

1. **Old-model comparison:** `control_weights.load_control` checks the selected
   source file hash and every original tensor's inventory, shape and dtype before
   loading. It permits exactly one missing tensor, the internal identity table,
   only as an explicit all-zero comparison extension. Every original loaded
   tensor is then compared with its source; the existing context restores the
   full candidate, modes, gradients and RNG afterward. This helper is not used
   for training initialization: the student still receives its trained teacher
   table through the existing builder, which excludes that table from the old
   student overwrite.
2. **Selected checkpoint evaluation:** a candidate is built from architecture,
   then loaded with exact run identity, table/mapping ABI, strict state inventory
   and actual selected table hash checks. Final heldout evaluation no longer
   tries to load baseline weights into a hybrid model before reading its selected
   checkpoint. The original student control uses the explicit zero extension.
3. **Heldout metrics:** a new hybrid training specification runs two separately
   labeled passes: `id0` and `bound`. They retain the same original heldout
   utterances, prompt crops and per-row seeds. The specification must explicitly
   choose which pass supplies the legacy top-level selection score; both results
   remain in `conditioning_scores`, with known-ID and fallback counts. This does
   not create a cross-utterance heldout corpus or new generalization claim.
4. **Stage contract:** the new `pocket-conditioning-training-v1` policy requires
   explicit settings for each trained role, including its base learning rate and
   ID learning-rate multiplier. It cannot silently inherit the pilot's 10x ID LR
   choice. Resolved exposure and LR must match the declared stage. Existing
   diagnostic-only pilot caps and the CLI prohibition on pilot student training
   remain intact.

## New specification fields; values deliberately not chosen

The existing pairing plan, mapping and reference-binding descriptors remain
unchanged. Replace only the policy/admission section in a newly reviewed spec.
Do not edit an existing run's spec or input identity.

`speaker_conditioning.policy` = `pocket-conditioning-training-v1`.
`speaker_conditioning.stages` contains one or both keys `teacher` and `distill`.
Each role must provide exactly:

| Field | Required relationship |
|---|---|
| `max_steps` | Equals the runner's corresponding `<stage>_max_steps` |
| `learning_rate` | Equals explicit `<stage>_learning_rate` |
| `id_learning_rate_scale` | Explicit 0.1–10; exactly 1 for audio-only arms |
| `rollout_steps` | Sorted unique integer steps including 0 and `max_steps`; equals `teacher_rollout_steps` or `rollout_steps` |

The actual upstream step ceilings, batch contract, corpus gates and speech
qualification still apply. No numeric stage settings are supplied here.

Hybrid training also requires:

- `heldout_bindings`: path to a separately reviewed source-evidence manifest.
- `heldout_bindings_sha256`: exact bytes of that manifest.
- `heldout_selection_mode`: explicit `id0` or `bound`; no default choice.

## Required heldout evidence; not generated here

The binding manifest has schema `reviewed-heldout-speaker-ids-v1`, the exact
existing `mapping_sha256`, and `rows`. Each row identifies `split`, `row_id`,
`audio_sha256`, and `speaker_id`. Allowed splits are `dev`, `test`,
`teacher_regression`, and `teacher_conditional`.

A positive ID requires its exact `speaker_identity` from the existing mapping
and nonempty `segment_proofs`, each with `path`, `sha256`, and the matching
`speaker_identity`. ID0 instead requires an explicit `fallback_reason`.
Every actual heldout row must have an exact matching binding before a model is
allocated. The reader does not infer IDs from names or manufacture new identities.
The current corpus/ID mapping is not expanded by this patch.

**Open input:** no heldout binding file, selection-mode decision, final method,
or new training recipe has been supplied. If a historical panel lacks an
`audio_sha256`, its existing source evidence must supply the exact hash before
it can be bound; do not silently guess it or weaken the match. Any change to
dataset membership or identity semantics requires a separate review.

## Runtime binding design only

If paired audio-only B wins, the exported architecture remains compatible with
the current audio-only Pocket runtime. If hybrid C wins, its trained table needs
a deliberate runtime integration after student qualification:

- Pin the reviewed hybrid-capable source and selected six-layer student export;
  verify the table ABI and mapping hash. Keep the accepted bundle available.
- Bind each installed reference's exact bytes to a reviewed internal ID. A known
  character name alone is not sufficient, especially across performer versions.
- Pass `speaker_id` and `reference_sha256` to `get_state_for_audio_prompt` while
  preparing the cached voice. No names or ID tokens enter spoken text.
- Keep reference audio for every voice. Untrained/ambiguous/custom references
  use explicit ID0; they remain reference-conditioned audio-only fallbacks.
- Bind cache entries to model hash, table/mapping hash, speaker ID, reference
  hash and truncation policy. Changing any binding invalidates the old voice
  state. The candidate public API already has this cache identity mechanism;
  the production worker/registry still needs to pass the reviewed bindings.

No production pins, registry or workers were edited. Current mod student stays
unchanged. A pilot preference alone is not final student/runtime acceptance.

## Verification boundary

Only Python syntax/source checks were performed for this overlay. No neural
model, inference, GPU work, training job, upload or broad test suite was run.
After method selection and source/data review, the remaining execution gate is
one bounded real distillation update with a known nonzero teacher ID, strict
checkpoint/export readback, and the selected runtime's CPU prompt/stream path.
Listening remains necessary for likeness and naturalness.
