# Pocket conditioning experiment checkpoint

This archive preserves the isolated implementation used for the October 4
conditioning comparison. Production voice models and game code remain on the
previously accepted versions. Audible improvement has not yet been established.

`manifest.json` records the exact base and candidate hashes of 16 changed files.
`speaker-conditioning.patch` reconstructs those files against the identified
Pocket source and the existing tracked training runner. The `files` directory
also preserves their exact bytes. Local reconstruction passed for all 16 files.
The directory's Git attributes preserve line endings because those hashes are
part of the experiment identity.

Apply only to a fresh experimental checkout matching the manifest's base hashes.
Use command-scoped `git -c core.autocrlf=false -c core.eol=lf apply` when checking
or reconstructing the patch. This archive does not contain audio, model weights,
character mappings, dataset proofs or credentials. A run needs its separately
verified input package and explicit configuration.

The implementation compares:

- Official audio conditioning from the target recording.
- A mixture using another verified recording of the same voice.
- That mixture plus a small learned, unspoken speaker ID.

The actual runner passes the ID inputs, stores raw and EMA mapping metadata,
checks identity during resume/export, and supports reference-only fallback.
The new ID table has an explicit learning-rate group. The diagnostic pilot uses
matched 500-update arms and retains the accepted models until results are judged.

Local checks include real pretrained forward/backward updates, FP16 scaling for
the paired and hybrid arms, checkpoint restoration, export and public streaming
with an actually updated speaker ID. These prove integration; the cloud pilot
and listening comparison determine whether the change helps voice quality.

See [the development findings](../../../docs/VOICE_MODEL_RESEARCH_2026-10-03.md)
and the local receipts under
`runtime/voice-data-expansion-20261003/current-parent-audit`.
