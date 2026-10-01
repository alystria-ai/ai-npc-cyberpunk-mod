# Source-qualified cloned voice activation

The user authorized enabling all prepared character references without another
listening or perceptual-quality acceptance stage. Source attribution, transcript
agreement, actual WAV hashes and path containment remain required.

`Prepare-LocalVoices.py --source-qualified-inventory` consumes the current review
inventory and its immutable candidate receipts. It selects the provisional primary
when supplied, otherwise the same deterministic technical choice used by the
audition helper. It verifies the actor, line, English payload, subtitle source set,
original WEM/WAV and current canonical key/name/aliases/records. Biography edits
may change the current full roster hash while the historical casting fingerprint
and canonical identity remain valid.

This mode does not require or manufacture listening approval, cloned-output
similarity acceptance or a `cleanIntelligible` flag. New local descriptors are
`status: ready`, `qualificationStatus: source-qualified`, `listeningVerified:
false`; they retain the source receipt path/hash. The three previously accepted
Johnny/Judy/Panam descriptors remain exactly unchanged. Profiles without a
suitable attributed reference remain unprepared and use their Convai voice.

## Prepare an activation artifact

Default dry-run:

```powershell
python -B scripts/Prepare-LocalVoices.py --source-qualified-inventory runtime/voice-cast/review/inventory.json
```

Explicit staged write:

```powershell
python -B scripts/Prepare-LocalVoices.py --source-qualified-inventory runtime/voice-cast/review/inventory.json --write
```

This copies the chosen original PCM unchanged to the ignored
`runtime/voice-references/full-cast-draft/<key>/reference.wav`, reusing a copy only
when its hash agrees. Existing accepted descriptors continue using their exact
original paths. It atomically writes only these activation artifacts:

- `runtime/voice-cast/activation/local-voices.source-qualified.json`
- `runtime/voice-cast/activation/activation-receipt.json`

The source-qualified CLI refuses a production output path. The parent installer
owns activation of the staged configuration. Preparation does not start a GPU
worker, edit the running bridge/game, contact Convai, train weights or modify
promotion/listening flags in the source receipts.

## Runtime contract

All characters share the pinned pretrained OmniVoice weights and warm model.
The registry uses version2,32 generation steps by default, lazy preparation,
three accepted startup profiles, at most eight conditioning prompts in memory
and the adapter's existing32-entry disk cache. Invite prepares a new profile
through the same serial worker before spawn permission is granted. There are
no separate per-character neural models or additional training stages.

The activation receipt records source admission and configuration hashes; it
does not claim the generated voice was listened to. Audition samples can remain
available for voluntary comparison without gating this activation.

## Offline verification

The preparation and audition tests exercise real temporary WAVs, native scene
receipts and a subtitle index. They cover activation with no listening or clean
intelligibility approval, exact preservation of the accepted descriptors,
missing/changed source files, altered actor identity and transcript evidence,
stale admission inputs, and refusal to write directly to the live configuration.

```powershell
python -B -m unittest discover -s scripts -p test_prepare_local_voices.py
python -B -m unittest discover -s scripts -p test_generate_voice_cast_auditions.py
```
