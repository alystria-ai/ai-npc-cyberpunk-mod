# Wider-cast voice preparation status

Generated from current local lane receipts at 2026-10-01T12:13:45.950Z. Rebuild with
`node scripts/Build-VoiceCastReview.mjs`; this document is a snapshot, not a
declaration that incomplete casting work is finished.
An existing generated run can be selected explicitly with
`--auditions runtime/voice-cast/auditions/<run-name>/results.json`.
The default local October 1 run is optional; a checkout without it still builds
the original-reference review.

## Current evidence

- 79 registered profiles across 11 lanes.
- 3 accepted Johnny/Judy/Panam references preserved and hash-checked.
- 59 additional profiles have 234 attributed, decoded original clips available for listening.
- 15 unprepared profiles and 2 profiles without a unique canonical cast voice retain Convai.
- 0 candidates failed aggregate verification; their playback links are withheld.
- 62 generated comparison samples match their current chosen original reference and exact transcript hashes. 0 comparison links are withheld.
- 0 new listening approvals and 0 new runtime promotions were made by the aggregate.
- Playable original WAVs total 127.59 MiB. This is candidate audition storage, not a per-character model size.
- Verified generated audition WAVs total 10.17 MiB.

| Lane | Profiles | Accepted | With verified candidates | Original clips | Generated comparisons | Unprepared | Unavailable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| accepted-existing | 3 | 3 | 0 | 0 | 3 | 0 | 0 |
| main-core-a | 7 | 0 | 7 | 14 | 7 | 0 | 0 |
| main-core-b | 6 | 0 | 6 | 13 | 6 | 0 | 0 |
| silverhand-cast | 8 | 0 | 7 | 40 | 7 | 1 | 0 |
| aldecaldos | 8 | 0 | 7 | 41 | 7 | 1 | 0 |
| river-peralez | 7 | 0 | 6 | 12 | 6 | 1 | 0 |
| fixers-city | 8 | 0 | 7 | 42 | 7 | 1 | 0 |
| phantom-main | 7 | 0 | 7 | 40 | 7 | 0 | 0 |
| phantom-gigs | 8 | 0 | 7 | 21 | 7 | 1 | 0 |
| minor-generic | 12 | 0 | 0 | 0 | 0 | 10 | 2 |
| minor-named | 5 | 0 | 5 | 11 | 5 | 0 | 0 |

## Audition artifact and verification

Open [the offline audition index](../runtime/voice-cast/review/index.html).
The companion [machine-readable inventory](../runtime/voice-cast/review/inventory.json)
lists all current profiles, exact transcripts, verified WAV format/duration,
source receipts, provisional primary/alternate selections and explicit gaps.
Generated comparisons are paired beside their chosen originals, clearly labeled
as source-qualified auditions with listening pending. These are not benchmark
results, listening acceptance or runtime promotions. Generation timing fields are
intentionally excluded from this comparison report.
Both artifacts are ignored local research outputs; this tracked document contains
only preparation status.

Identity projection v1 preserves exact keys,
names, aliases and native record strings. Biography or speaking-style edits may
change the complete roster file without changing speaker identity. The historical
collection fingerprint is retained separately from the current source fingerprint:

- Historical roster SHA-256: `85c0adf1752da550fa84999f6a81cc18a6d9dd0075d41e8e136de08c20618370`
- Current roster SHA-256: `3fdd4db8f1c1c4fdd0df3d6c7aadbf16b7f378d44dba5d97a34894fc40496600`
- Canonical identity SHA-256: `854f78a679fdce00b0abad7cb75f358529dfd5b2eea9f5aaabf819b4c3e43946`
- Full source changed: yes; canonical identity remains exactly verified.

The aggregate rechecks local immutable receipt/source/WAV hashes and native line joins. A decoded waveform or clean metadata is not a listening verdict. Source archive receipts originate in the bounded casting extractor; this report does not re-extract archives.

The original PCM is linked without gain, EQ, denoising, resampling, trimming or
concatenation. No synthesis, GPU job, cloud call, game/save change or configuration
write is performed by the aggregate. A candidate remains pending until an actual
audible review qualifies intelligibility, identity, overlap and delivery. This is
not an approval gate for unrelated knowledge or runtime work.

## Shared model and remaining work

All characters use one pinned OmniVoice model. A profile contributes a short
attributed reference, its exact text and bounded cached conditioning; it does not
add a separately trained model. The three accepted references are preserved.

1. Finish missing native identity/acquisition joins and targeted scene discovery.
2. Listen to original primary/alternate candidates; choose canonical clean speech
   or explicitly documented canonical processed speech (for example, Smasher).
3. Promote only qualified immutable reference descriptors through the coordinator's
   registry; preserve Convai fallback for unprepared/unavailable profiles.
4. Listen to the existing generated comparisons, then perform any additional
   bounded conditioning checks through the single shared worker, without writing
   synthetic dialogue into conversation memory.
5. Rebuild this report after any lane or selection changes.

## Current gaps

- **Spider Murphy** (spider-murphy): No attributed decoded original reference has been completed yet\.
- **Jim Jarry** (jim-jarry): Five canonical GlobalTV media scenes and four Phone race scenes were reviewed\. No suitable ordinary Spoken reference was selected; keep Convai\.
- **Coach Fred** (coach-fred): No attributed decoded original reference has been completed yet\.
- **Pepe Najarro** (pepe-najarro): No attributed decoded original reference has been completed yet\.
- **Mark Bana** (mark-bana): No attributed decoded original reference has been completed yet\.
- **8ug8ear** (8ug8ear): Default scene has actual Bugbear actor/lines but no en\_us descriptors\. Gig actor named 8ug8ear has empty English speech content\. Strict scene English qualification remains unresolved\.
- **Cynthia Najarro** (cynthia-najarro): Ordinary exact scene/English/WEM joins found\. Canonical scene-acquisition record binding and decoded/listening qualification remain\.
- **Dennis Cranmer** (dennis-cranmer): Ordinary exact scene/English/WEM joins found\. Canonical scene-acquisition record binding and decoded/listening qualification remain\.
- **Frank Nostra** (frank-nostra): Ordinary exact scene/English/WEM joins found\. Canonical scene-acquisition record binding and decoded/listening qualification remain\.
- **Jake Estevez** (jake-estevez): Ordinary exact scene/English/WEM joins found\. Canonical scene-acquisition record binding and decoded/listening qualification remain\.
- **Liam Northom** (liam-northom): Ordinary exact scene/English/WEM joins found\. Canonical scene-acquisition record binding and decoded/listening qualification remain\.
- **Life Coach** (life-coach): Five native Coach lines are explicit Vo\_Expression\_Phone with isHolocallSpeaker=true\. Retain Convai under ordinary clean-reference policy; spawn-set identity edge also remains\.
- **R3n0** (r3n0): Ordinary exact scene/English/WEM joins found\. Canonical scene-acquisition record binding and decoded/listening qualification remain\.
- **Sandra Dorsett** (sandra-dorsett): Ordinary exact scene/English/WEM joins found\. Canonical scene-acquisition record binding and decoded/listening qualification remain\.
- **Sergei Karasinsky** (sergei-karasinsky): Ordinary exact scene/English/WEM joins found\. Canonical scene-acquisition record binding and decoded/listening qualification remain\.
- **Night City Resident Male** (resident-male): Template identity has no unique canonical native actor\. Retain Convai unless an explicit generic selection policy is agreed\.
- **Night City Resident Female** (resident-female): Template identity has no unique canonical native actor\. Retain Convai unless an explicit generic selection policy is agreed\.
