# Wider-cast voice preparation status

Generated from current local lane receipts at 2026-10-01T18:13:18.436Z. Rebuild with
`node scripts/Build-VoiceCastReview.mjs`; this document is a snapshot, not a
declaration that incomplete casting work is finished.
An existing generated run can be selected explicitly with
`--auditions runtime/voice-cast/auditions/<run-name>/results.json`.
The default local October 1 run is optional; a checkout without it still builds
the original-reference review.

## Current evidence

- 79 registered profiles across 11 lanes.
- 3 accepted Johnny/Judy/Panam references preserved and hash-checked.
- 72 additional profiles have 247 attributed, decoded original clips available for source-qualified preparation.
- 2 unprepared profiles and 2 profiles without a unique canonical cast voice retain Convai.
- 0 candidates failed aggregate verification; their playback links are withheld.
- 62 generated comparison samples match their current chosen original reference and exact transcript hashes. 0 comparison links are withheld.
- 0 new listening approvals and 0 new runtime promotions were made by the aggregate.
- Playable original WAVs total 136.01 MiB. This is candidate audition storage, not a per-character model size.
- Verified generated audition WAVs total 10.17 MiB.

| Lane | Profiles | Accepted | With verified candidates | Original clips | Generated comparisons | Unprepared | Unavailable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| accepted-existing | 3 | 3 | 0 | 0 | 3 | 0 | 0 |
| main-core-a | 7 | 0 | 7 | 14 | 7 | 0 | 0 |
| main-core-b | 6 | 0 | 6 | 13 | 6 | 0 | 0 |
| silverhand-cast | 8 | 0 | 8 | 41 | 7 | 0 | 0 |
| aldecaldos | 8 | 0 | 8 | 42 | 7 | 0 | 0 |
| river-peralez | 7 | 0 | 7 | 13 | 6 | 0 | 0 |
| fixers-city | 8 | 0 | 8 | 43 | 7 | 0 | 0 |
| phantom-main | 7 | 0 | 7 | 40 | 7 | 0 | 0 |
| phantom-gigs | 8 | 0 | 8 | 22 | 7 | 0 | 0 |
| minor-generic | 12 | 0 | 8 | 8 | 0 | 2 | 2 |
| minor-named | 5 | 0 | 5 | 11 | 5 | 0 | 0 |

## Audition artifact and verification

Open [the offline audition index](../runtime/voice-cast/review/index.html).
The companion [machine-readable inventory](../runtime/voice-cast/review/inventory.json)
lists all current profiles, exact transcripts, verified WAV format/duration,
source receipts, provisional primary/alternate selections and explicit gaps.
Generated comparisons are paired beside their chosen originals, clearly labeled
as source-qualified auditions without a listening verdict. These are not benchmark
results, listening acceptance or runtime promotions. Generation timing fields are
intentionally excluded from this comparison report.
Both artifacts are ignored local research outputs; this tracked document contains
only preparation status.

Identity projection v1 preserves exact keys,
names, aliases and native record strings. Biography or speaking-style edits may
change the complete roster file without changing speaker identity. The historical
collection fingerprint is retained separately from the current source fingerprint:

- Historical roster SHA-256: `85c0adf1752da550fa84999f6a81cc18a6d9dd0075d41e8e136de08c20618370`
- Current roster SHA-256: `d110ae724ef7afd90e438d39c287686d78378825aee0189464202245d46547a3`
- Canonical identity SHA-256: `854f78a679fdce00b0abad7cb75f358529dfd5b2eea9f5aaabf819b4c3e43946`
- Full source changed: yes; canonical identity remains exactly verified.

The aggregate rechecks local immutable receipt/source/WAV hashes and native line joins. A decoded waveform or clean metadata is not a listening verdict. Source archive receipts originate in the bounded casting extractor; this report does not re-extract archives.

The original PCM is linked without gain, EQ, denoising, resampling, trimming or
concatenation. No synthesis, GPU job, cloud call, game/save change or configuration
write is performed by the aggregate. Source-qualified preparation does not require
listening or a perceived-quality verdict. Native Phone, GlobalTV and custom-event
performances retain explicit delivery metadata; those flags do not establish
whether a WEM contains audible processing. Intelligibility, similarity and overlap
are not inferred from source qualification.

## Shared model and remaining work

All characters use one pinned OmniVoice model. A profile contributes a short
attributed reference, its exact text and bounded cached conditioning; it does not
add a separately trained model. The three accepted references are preserved.

1. Keep the explicit source gaps and preserve Convai fallback for those profiles.
2. Prepare exact original descriptors with the source-qualified activation command;
   the identity, transcript, hash and supported PCM bounds remain required.
3. Activate the staged registry through the coordinator. Listening is optional and
   no listening approval or clean-waveform claim is manufactured during preparation.
4. Rebuild this report after any lane or selection changes.

## Current gaps

- **8ug8ear** (8ug8ear): Default scene has actual Bugbear actor/lines but no en\_us descriptors\. Gig actor named 8ug8ear has empty English speech content\. Strict scene English qualification remains unresolved\.
- **Jake Estevez** (jake-estevez): Ordinary exact scene/English/WEM joins found\. Canonical scene-acquisition record binding and decoded/listening qualification remain\.
- **Night City Resident Male** (resident-male): Template identity has no unique canonical native actor\. Retain Convai unless an explicit generic selection policy is agreed\.
- **Night City Resident Female** (resident-female): Template identity has no unique canonical native actor\. Retain Convai unless an explicit generic selection policy is agreed\.
