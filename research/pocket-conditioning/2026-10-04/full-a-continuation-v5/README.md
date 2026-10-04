# Final A continuation source

This code-only checkpoint preserves all 19 source files from the reviewed V5
candidate. It contains no models, audio, credentials or account receipts, and
does not replace the installed voice runtime.

The frozen manifest SHA256 is
`27d1d2f3b12f95b9456175df82b04162d4ae34073b03d18a360405f6d381d2f1`.
Every copied source was checked against that manifest. The root reviewed the
STT authority and explicit target supersession changes; the earlier checkpoint
preserves the preceding training implementation.

The source keeps native captions for matching audio. Four specifically audited
Songbird MAIN recordings use separately labelled local STT targets because their
lookup captions describe different recordings. Five matching holocall recordings
retain their native captions. One ambiguous MAIN recording remains excluded.
Raw recordings, captions and prior evidence are preserved. Supersession is exact,
never based on which file is newest.

Training uses the chosen standard A conditioning. The teacher and student retain
resumable optimizer state, pending evaluation state, a best eligible checkpoint,
and a separately labelled best diagnostic checkpoint. The accepted models stay
available until an actual replacement is qualified.

This checkpoint establishes source readiness only. Final corpus closure, numeric
recipe binding and the actual Kaggle execution receipts establish training
readiness and results separately. No final teacher or student had run when this
checkpoint was created.
