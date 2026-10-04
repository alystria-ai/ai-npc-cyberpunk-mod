# Native-primary corpus admission

## V2 adapter revision: explicit edge coverage

This directory contains only the replacement `native_primary_data.py` and its
contract/evidence revision for parent review. The frozen v1 module remains
unchanged at SHA `b8c13f7d948b4308b45240856f10dd73a0afddd89f4b8abeb2980a6e64cf1d5d`.
No full candidate tree is copied or installed by this revision.

The new exact kind is **`native_rendered_primary_edge_cache`**. Its contracts are:

- Scope: `voice_native_rendered_primary_edge_stitched_scope_v1`.
- Result: `voice_native_rendered_primary_edge_stitched_codec_cache_loader_proof_v1`.
- Qualification: `authenticated_native_rendered_primary_v2`.
- Conditioning: `official_aligned_short_fallback_v1`.
- Coverage: `actual_originals_all_cut_arithmetic_edge_stitches_v1`.
- Original worker SHA:
  `1c8410f005da77a387e04726a298e1370770607cd2985f0595f134614457f363`.
- Reviewed resource-only successor SHA:
  `a8950774db9a70323053732b876d7b976a0d394777b1031619a2a4a1d3b6a60b`.
- Successor's native GPU guard SHA:
  `b4fe88b7ce86e7ee6a201f3fb8397c1d22ac0e78882fb281def5f853e662465f`.

The renderer remains the exact v2 renderer, with separate original caption
identity/hash and spoken target/hash. Each original retains its actual Mimi
cache. Every reachable cut retains real raw/cached sampling and token equality
plus loader-declared prompt/target frame observations. **Only the first and last
reachable cuts have observed stitched encodes**, or one observed encode for the
single full-target fallback case.

The verifier independently identifies these cut positions. An interior cut
must have `stitched_encode_observed: false` and must omit encoded latent hashes
and actual encoded prompt/mask fields. Edge cuts must have observed masks,
prompt lengths and encoded latent hashes consistent with their loader-declared
frames. The counted observed encodes must equal the result's
`actual_stitched_cut_encodes`. The result must expressly declare
`every_interior_cut_reencoded: false`; the old all-cut
`loader_masks_and_suffix_tokens_verified` claim is forbidden in this schema.

The resource-only successor has the same audio/coverage contract. Its bound
guard receipt preserves independent native memory counters and forced probe
points before model load, each original/calibration encode and each recording's
stitched checks, plus the final release observation. It does not imply additional
audio encodes. No arithmetic or full-encode evidence is fabricated for interior
cuts.

Completed receipt readback covered edge105 (96 originals, 903 cuts, 192 observed
edge encodes), guarded106 (95 originals, 813 cuts, 190 observed edge encodes), and
the existing short101 fallback (23 originals, 23 full-target observations).
These are retained-artifact checks; no model, new cache or cloud job was run.
Final closed portable-bundle entry remains a separate readiness gate.

## Existing admission contract

Package implementation destination: `candidate/scripts/pocket_training/native_primary_data.py`.
No production trainer or active qualification worker is changed by this module.

## Entry and evidence ownership

`declared(bundle)` returns false only when `native_primary_admission` is absent.
An unknown or malformed declaration raises an error. For a declared corpus,
`verify_input(spec, bundle)` owns source, wording/word alignment, retained actual
codec/loader evidence, protected panels, references and cross-panel fences.
It does not load a model, decode/re-encode audio, recalculate a cache, write new
qualification receipts, choose rows or choose training parameters.

`teacher_data.verify_actual_cache` still checks the **newly prepared runtime
cache**. Passing this admission verifier is not a substitute for that check.

The enclosing bundle keeps `schema: teacher_staged_bundle_v1`, its existing
`manifests`, and ordinary portable audio paths. All five manifest roles are
required: `train`, `dev`, `test`, `teacher_regression`, `teacher_conditional`.

```json
{
  "native_primary_admission": {
    "schema": "teacher_native_primary_admission_v1",
    "evidence_index": {"path": "evidence/index.json", "sha256": "FULL_SHA256"},
    "protected_snapshot": {
      "path": "ORIGINAL_SNAPSHOT_PATH", "sha256": "FULL_SHA256",
      "original_base": "ORIGINAL_LEGACY_BUNDLE_ROOT"
    },
    "history": {
      "path": "ORIGINAL_HISTORY_PATH", "sha256": "FULL_SHA256",
      "original_base": "ORIGINAL_LEGACY_BUNDLE_ROOT"
    },
    "role_reservations": {"path": "ORIGINAL_CORRECTED_RESERVATIONS_PATH", "sha256": "FULL_SHA256"},
    "reference_sources": {"path": "ORIGINAL_REFERENCE24_MANIFEST_PATH", "sha256": "FULL_SHA256"},
    "legacy_bundles": [{
      "bundle": {"path": "ORIGINAL_STANDARD_BUNDLE_RECEIPT", "sha256": "FULL_SHA256"},
      "original_base": "ORIGINAL_LEGACY_BUNDLE_ROOT",
      "admitted": [{"role": "train", "id": "EXACT_ORIGINAL_ID"}]
    }],
    "scopes": [{
      "kind": "native_primary_cache",
      "scope": {"path": "ORIGINAL_SCOPE_PATH", "sha256": "FULL_SHA256"},
      "cache_result": {"path": "ORIGINAL_RESULTS_PATH", "sha256": "FULL_SHA256"},
      "helper_source": {"path": "ORIGINAL_EXECUTED_HELPER_PATH", "sha256": "FULL_SHA256"},
      "admitted": [{"role": "train", "id": "EXACT_SCOPED_ID"}]
    }]
  }
}
```

Only `evidence_index` and enclosing manifest/audio descriptors are staged paths.
The admission proof descriptors are **original paths** resolved by that index.
`original_base` is an explicit context for relative references inside unchanged
legacy snapshot/history/bundle JSON. No working-directory or basename search is
performed.

## Closed portable mapping

```json
{
  "schema": "teacher_native_primary_evidence_index_v1",
  "files": {
    "runtime/original/run.json": {"path": "evidence/objects/HASH/run.json", "sha256": "HASH"},
    "C:\\original\\source.py": [
      {"path": "evidence/objects/HASH1/source.py", "sha256": "HASH1"},
      {"path": "evidence/objects/HASH2/source.py", "sha256": "HASH2"}
    ]
  }
}
```

The index binds **(exact original path, exact SHA256)** to portable bytes. A
list allows a historical source path with multiple retained versions. Lookup
without a SHA fails when there is more than one version. Windows, WSL and
project-relative aliases must each be listed explicitly. Their source bytes
remain unchanged. No path stripping, host fallback, network lookup or guessed
alias is allowed. Every mapped destination must remain under the staged root.

In addition to scope/result/helper files, include:

- Original source gates, their sibling `inputs.jsonl`, all pinned dependencies,
  and original WAV/receipt paths.
- Actual CTC run JSON, its sibling `hypotheses.jsonl`, and pinned executed helper
  dependencies. Native caption disagreement is retained as diagnostic data.
- For rendered targets, original `targets.json`, its inputs, the original source
  gate, reviewed renderer source and game parser evidence.
- Cache result siblings: `data/train.jsonl`, `data/train_latents.jsonl`,
  `data/train_latents.meta.json`, `actual-cache-rows.jsonl`,
  `actual-loader-cuts.jsonl`, and every retained latent tensor. The cache's WSL
  audio paths require explicit aliases to the original WAV bytes.
- Legacy proof dependencies, corrected reservations, the immutable reference24
  source bindings, original protected snapshot and historical ledgers.

## Supported routes

| Kind | Caption authority | Evidence |
|---|---|---|
| `native_primary_cache` | Unchanged plain native caption | Actual source gate + separate CTC word alignment + actual codec/cache/loader proof |
| `native_rendered_primary_cache` | Engine-proven rendering of original native caption | Separate original identity/text/hash and spoken target/hash, plus source/alignment/cache proof |
| `native_rendered_primary_short_fallback_cache` | Same original/rendered target authority | Fresh explicit aligned-short scope and actual full-target/same-recording-prompt codec/loader observations |
| `native_rendered_primary_edge_cache` | Exact renderer-v2 authority | Actual original caches, all-cut sampling/token/frame observations, expressly limited first/last stitched observations |
| `legacy_exact_native_v1` | Actual previous exact-native qualification | Only the four pinned October 3 (65/93/19) and October 4 (21) scope/result pairs; original ASR/alignment and cache records |
| `legacy_bundles` | Original standard teacher bundle | Unchanged `teacher_data.verify_input` executed with an isolated portable resolver; admitted subset retains its original role |

`legacy_bundles` accepts the original 1,744-row standard bundle receipt, SHA
`297fda549036dec15b6b137b910e1872aec30f123d901213894843d6e6ff577c`.
It does not claim the later expanded 1,020-row overlay passes that verifier.
The four legacy cohorts are not retroactively described as native-primary
runs, and their old exact-agreement evidence is not recreated.
The first October 4 legacy cohort also requires its original `proposal.json`
and source gate; the proposal's source/input hashes bind that existing source
authentication to its existing CTC/Whisper run.

Native renderer v1 remains SHA `40a5bfa6...6cf068`. Renderer v2 is separately
recognized at SHA `a8cee883...e17af2`, with its bound Kiroshi game-parser proof.
Kiroshi uses `b + o + a`; the `t` field remains translation metadata. Rendering
support alone is neither language qualification nor an actual codec pass.
The same short-fallback admission kind accepts the **exact** v2 tuple:
qualification policy `authenticated_native_rendered_primary_v2`, scope
`voice_native_rendered_primary_aligned_short_fallback_scope_v2`, result
`voice_native_rendered_primary_aligned_short_fallback_actual_codec_cache_loader_proof_v2`,
and worker SHA `7c3b948a...30de4e`. Arbitrary version-prefix matching is not used.

Each admission member must match one current manifest row's original identity,
target, exact word stream/times, duration, source audio and delivery scenes.
Every train/dev/conditional row needs exactly one admission. Evidence scopes
may contain additional already-qualified rows; those do not enter training
unless explicitly listed. Protected rows cannot appear in admission lists.

## Fences

The original 94-row regression panel and 76-row test panel use the existing
`teacher_data.verify_protected` content/order/metadata checks. The actual
historical 2,743-row training record and prior manifests remain heldout-exposure
sources. The current 24 rich references remain immutable and source-bound.

Corrected role reservations replace the historical overbroad global-caption
and entire-conditioning-scene vetoes. Exact source/recording aliases stay
reserved. Same-character caption duplicates cannot cross panels. A genuinely
protected delivery component cannot acquire new training audio. Previously
accepted training may retain its documented same-role component exposure;
exact evaluation/reference reservations still take precedence.

New `dev` rows cannot be previously trained recordings or exposed training
scenes. New `teacher_conditional` rows must be separate recordings with known
historical scene exposure. Existing legacy dev/conditional membership is
validated by its unchanged original bundle rather than relabeled as new unseen
evaluation.

## Aligned short utterances

`allow_overlap(row)` is the runner/cache bridge for the separately qualified
official aligned-short fallback policy. It uses a per-process registry of exact
source identity, word stream, target transcript, duration and start. A manifest
flag cannot authorize overlap. Registration occurs only after complete source,
actual no-cut codec/loader evidence and panel fences pass in `verify_input`.
Audio path relocation does not change the tuple. Missing/nonfinite word times
are never excused by the fallback.

The historical native scopes and their existing helper hashes remain unchanged.
The new short scope is `voice_native_rendered_primary_aligned_short_fallback_scope_v1`;
the result is `voice_native_rendered_primary_aligned_short_fallback_actual_codec_cache_loader_proof_v1`.
Both declare `conditioning_policy: official_aligned_short_fallback_v1` and the
exact `loader_cut_helper` descriptor. The helper SHA is `6f84a1f3...103616`, the
actual codec worker SHA is `267af860...2db20a`, and its isolated observation
verifier SHA is `09a5fb9f...92e112` (full constants are in the source).

Every scope row and cut records `loader_sampling_policy`, `sampling_mode` and
`prompt_target_overlap`. The no-cut case is one real record at frame/word zero
with the complete transcript, `interior_boundary: null`, mode
`aligned_full_utterance_fallback` and overlap true. The ordinary prefix case
uses `aligned_disjoint_prefix` and overlap false. The verifier independently
computes which case the pinned upstream loader can reach. No empty-cut-list or
fabricated interior boundary is accepted. Only selected, actually qualified
no-cut tuples are registered by `allow_overlap`.

## Qualification boundary

Source-parsing controls have read actual plain-native, rendered-native and
legacy scope/source/alignment/cache/cut records, and the original 94/76 protected
snapshot. No model was loaded and no cache was recalculated. A final corpus has
not been chosen or built by this module's owner; full portable `verify_input`
acceptance therefore remains a required check of that eventual bundle.
The v1 controls included 32 actual pinned-loader short-row arithmetic receipts,
with missing/nonfinite spans and bare overlap flags rejected. Those method
receipts alone do not substitute for a completed actual short codec/cache
result. This v2 revision additionally parsed completed short101 evidence.
The six actual Mama v2 target records preserve their Spanish original speech
separately from the English UI translation. They have been parsed here as
source/target evidence only, not claimed as completed CTC or codec qualification.
