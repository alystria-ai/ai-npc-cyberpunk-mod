# Phone and holocall clips in the voice data (October 6, 2026)

Question: do Cyberpunk's phone and holocall lines (filtered, band-limited) leak that sound into the reference clips and the training data?

## Detector

Code: `scripts/phone_detect/` (`extract.py` features, `flag.py` flags and statistics, `validate.py` sample sheets, `build_nophone_refs.py` phone-free sets). Output: `runtime/voice-data-phone-flags.json` (gitignored with the rest of `runtime/`; rebuild with `extract.py` then `flag.py`).

A clip is `phone` when either test fires.

- **Spectral** (primary). Long-term spectrum of the speech frames at 48 kHz, compared with the same voice's median clip:
  - 4–8 kHz at least 12 dB below its normal level and under -28 dB relative to the 300–3,400 Hz band;
  - or 8–16 kHz at least 15 dB below and under -45 dB;
  - or the spectrum reaches the noise floor below 9 kHz (hard bandwidth limit);
  - or missing bass (50–200 Hz at least 15 dB below the voice's median and under -15 dB) together with a weak top end.
- **Metadata** (supporting). The dataset's `source_delivery`: delivery kind phone or media, `Vo_Expression_Phone` or `GlobalTV`, `isHolocallSpeaker`, a holo, screen or speaker custom VO event. A holocall/phone word in the scene file name only adds to the score; it does not flag by itself, since one scene mixes in-person and phone lines.

`score` (0–1) combines both; `reasons` lists what fired.

## Validation (hand-checked sample)

`E:\CyberpunkConvai-offload\work\phone-detect\validation\` holds `sample.json` (20 flagged and 20 unflagged clips with scores and reasons), `flagged.png` and `unflagged.png` (spectra, the orange band is 0.3–3.4 kHz).

- All 20 unflagged clips are full band: a smooth roll-off to the 18–20 kHz codec cutoff, score 0 (three stray scores of 0.15–0.5 came from the mild bass or scene hints, none flagged).
- The 10 spectral-flagged clips show a real band limit: shelves and cliffs at 3–5 kHz, noise floor from 8–15 kHz, or no bass (for example `alex/2911540295898255360`, `solomon-reed/3032540176703721472`).
- The 10 metadata-only flagged clips look like ordinary speech: a smooth roll-off to the 18–20 kHz codec cutoff (one has a flat high floor).

Finding: **the metadata and the spectrum disagree.** Of 8,472 clips (all splits), 1,856 carry phone metadata but only 164 are spectrally band-limited, and only 75 are both. In the stored audio, most phone and holocall lines are not filtered: the game applies the filter at run time. The "vibe" that could leak is then the performance and mix of those lines (close, conversational, `Vo_Expression_Phone`), not a bandwidth limit. Only about 2% of the data is truly band-limited. Which is worse for likeness is a listening question.

## Share of phone clips

Training set (8,140 train clips, 79 voices): **23.4% phone** (1,902 clips). Metadata 22.4%, spectral 1.9%. 43 of 79 voices have none.

| Voice | Clips | Phone | Share |
|---|---|---|---|
| songbird | 1,048 | 721 | 69% |
| solomon-reed | 1,088 | 333 | 31% |
| regina-jones | 208 | 174 | 84% |
| river-ward | 495 | 113 | 23% |
| t-bug | 82 | 77 | 94% |
| takemura | 335 | 63 | 19% |
| rogue-amendiares | 295 | 60 | 20% |
| alex | 213 | 59 | 28% |
| johnny-silverhand | 357 | 39 | 11% |
| muamar-reyes | 37 | 31 | 84% |

Full per-voice table: `summary.training_dataset.per_voice` in the flags file. Among the 29 shown characters: adam-smasher 2 of 2, hanako-arasaka 70%, songbird 69%, padre-ibarra 38%, solomon-reed 31%, alex 28%, river-ward 23%, lizzy-wizzy 23%, rogue 20%, takemura 19%, mr-hands 19%, mama-welles 15%, meredith 12%, johnny 11%, kerry 10%; the rest under 5%.

| Set | Phone |
|---|---|
| Live single references (`pocket-voices.json`, `local-voices.json`) | 6 of 75 voices: dennis-cranmer, jim-jarry, life-coach, mark-bana, r3n0, spider-murphy. None are among the 29 shown. (Several references are not dataset clips; those were judged from the config's own `sourceDelivery` plus the file's spectrum.) |
| Proposed 18 s sets (Pocket and Omni) | 14 of 175 clips (8.0%); 9 of 65 sets (13.8%). Shown voices: hanako 1, ozob-bozo 1, padre-ibarra 1, songbird 2 |
| Proposed 10 s sets | 13 of 129 clips (10.1%); 9 of 61 sets. Shown voices: johnny 1, kerry 1, ozob-bozo 1, solomon-reed 2, songbird 1 |
| Held-out evaluation lines | 18 of 134 lines (13.4%): 17 metadata, 3 spectral. Among the 29 shown voices, 10 of 58 lines (adam-smasher both, mr-hands both, rogue both, hanako line 1, johnny line 2, solomon-reed line 2, takemura line 1) |

A phone-flagged original line distorts scoring: its PLS and ECAPA targets are the filtered recording. The report page's scores include them. Without those lines (26 voices, 48 lines) the Original column scores 96.3 PLS instead of 106.2 and generated columns drop about 3–5 points; the ordering does not change (`summary-table-shown-no-phone-lines.md` next to the main tables).

## Phone-free references

`runtime/*.multiref.nophone.json` (18 s) and `runtime/*.multiref10.nophone.json` (10 s), for Pocket and Omni, audio in `runtime/voice-references/multiref-nophone-proposed/` and `multiref10-nophone-proposed/`. Same "most typical" rule (ECAPA closest to the voice centroid, evaluation lines, duplicates and the live reference excluded), with phone clips removed from the pool and from the centroid. 64 voices changed in the 18 s sets (16 differ from the earlier proposal) and 60 in the 10 s sets (14 differ); 15 and 19 voices are left on their live reference, as before. ozob-bozo has no phone-free pool left for a multi-clip set (the old proposal contained a phone clip); adam-smasher has no dataset clips.

Phone-free single references: none could be proposed. The six voices with a phone live reference have no non-phone clips in the dataset (dennis-cranmer, life-coach, mark-bana, r3n0, spider-murphy have no clips at all, jim-jarry only phone clips), so there is nothing to swap in. They are not among the 29 shown characters.

## Scores

The 29 shown characters, 2 held-out lines each (58 lines), PLS / ECAPA / WER, scored with the research tools (anchors recomputed on the same subset: Pocket base 60, OmniVoice 32 = 90). Scores for the other columns are in `summary-table-shown.md`.

| Column | Current 18 s | Phone-free 18 s | Change |
|---|---|---|---|
| Pocket student 5,000 + new decoder | 125.0 / 0.558 / 4.0% | 121.7 / 0.563 / 3.8% | -3.3 PLS |
| OmniVoice 32 steps | 108.8 / 0.689 / 3.9% | 106.3 / 0.692 / 3.9% | -2.5 PLS |
| OmniVoice 16 steps | 103.7 / 0.691 / 3.9% | 98.8 / 0.683 / 4.1% | -4.9 PLS |

Reading it:

- Only 8 of the 29 voices got a different clip set (hanako, meredith, mitch, padre, river, solomon-reed, songbird, takemura; mitch has no real-clip statistics) and ozob-bozo and adam-smasher fell back to their live reference, so a few points of macro change is a large per-voice change. Per-voice results scatter a lot (one OmniVoice render per line).
- Pocket noise: a control render of the **current** 18 s sets in the same 29-voice batches (`ft6-s5000raw__decA_multiB_shown`) scores 123.4, 1.6 under the earlier 125.0, which is the batch-seed noise. Against that control the phone-free Pocket is -1.7, within noise.
- ECAPA (right speaker) and WER do not move.
- PLS compares each render with the voice's own real clips, and phone clips are part of those. For songbird (69% phone) and hanako (70%) a phone-style reference matches the benchmark by construction, so a lower PLS is not evidence that the phone-free set sounds worse. The decision needs listening; the phone-free columns sit next to their counterparts on the page, and the Recommended filter shows both.
- Excluding the phone-flagged original lines (26 voices, 48 lines) gives the same picture: Pocket 120.5 vs 119.3, OmniVoice 32 105.8 vs 99.5, OmniVoice 16 99.9 vs 93.2 (current vs phone-free).

Render details: Pocket on CPU with `exports/s5000-raw-decA`'s decoder (`POCKET_DECODER` = the final EMA decoder) and the research `gen.py`/`run_gen.py` code (batch 16, 1 flow step, temperature 0.3); OmniVoice 16 and 32 steps on the GPU through the bridge's own backend (`vendor/reference-voicestudio`, guidance 2.0, seeds 1042+line), as `run_omni.py`. Scripts: `exp-scripts/np_run_gen.py`, `np_run_omni.py`, `np_score.py`. The run scored WER on the GPU (the same Whisper small.en); the other numbers are the research tools unchanged.

## Auto-selected references (re-check, not re-run)

A phone-free selector re-run is not cheap: it needs phone-free loudness-matched candidate sets, dev-line renders per candidate on the GPU for every voice and fresh evaluation renders. The earlier selector (dev-line MCD with an ECAPA tiebreak) only tied "most typical". On the 29 shown voices with the existing renders, auto-selected vs most typical: OmniVoice 16 106.3 vs 103.7 PLS (ECAPA 0.669 vs 0.691), OmniVoice 32 108.5 vs 108.8 (0.675 vs 0.689). That is a tie on PLS and a slightly worse speaker match, so the finding stands: not worth it. It was never tried with the new Pocket decoder (it only used OmniVoice renders).
