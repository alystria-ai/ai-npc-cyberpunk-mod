# Character dialogue prompting experiment

Text-only pilot for Johnny, Judy and Panam: 36 measured replies across three
prompting approaches, with a completed independent blinded review of two-turn exchanges.
Production profiles and the game are unchanged.

- [Unblinded condition comparison](COMPARISON.md)
- [Independent reviewer's interpretation](UNBLINDED_REVIEW.md)
- [Recorded run and timings](RESULTS.md)
- [Anonymous A/B/C conversations](BLIND_SAMPLES.md)
- [Structured anonymous conversations](blind-samples.json)
- [Blind scoring rubric](RUBRIC.md)
- [Method and limitations](DESIGN.md)
- [Primary-source prompting research](PROMPTING_RESEARCH.md)
- [Disposable-profile cleanup](CLEANUP.md)

The reviewer avoided DESIGN.md, conditions.mjs and ignored .private files until
the score sheet was frozen. Those contain condition identities or the unblinding
key. A/B/C are reshuffled separately for every character/scenario comparison.

The tested source lines have exact installed-scene, speaker and localization
provenance. Prompt references and held-out review references use different
scenes. They are a small research specimen, not a dialogue dataset for release.

## Commands

Run from the project root:

```powershell
python -B research/cyberpunk/dialogue-style/select_references.py
node research/cyberpunk/dialogue-style/run.mjs
node research/cyberpunk/dialogue-style/run.mjs --preflight
node research/cyberpunk/dialogue-style/run.mjs --cleanup-only
node research/cyberpunk/dialogue-style/summarize.mjs
node research/cyberpunk/dialogue-style/compare.mjs
```

The no-argument runner is a local plan. Preflight builds and opens the owned
headless browser without credentials or remote profile requests. The completed
durable receipt prevents --run from accidentally creating another experiment.
Cleanup reads only that receipt's explicitly owned test profiles and verifies
their absence. The one-time --resume-after-id-change option records the already
authorized setup interruption; it is not a general retry mode.

The key is read only from the project's existing runtime/convai-key.txt when an
authorized remote run or cleanup is needed. It is never printed, included in the
sample sheet, or copied into the experiment directory. Raw remote IDs remain
inside the ignored .private recovery receipt.
