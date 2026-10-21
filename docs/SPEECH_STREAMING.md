# Phrase playback and local lip sync

## Scope and current evidence

September 29, 2026: implemented and installed for the local OmniVoice voices
(Johnny, Judy and Panam), retaining the warm FP16 CUDA model and the 32/16 setting.
Convai still supplies the reply text. The first phrase is synthesized and published
before the remaining phrases are generated. This is phrase streaming, not partial
decoding inside an OmniVoice inference. Convai/Kokoro's browser capture still
returns a complete audio turn; it retains Convai's facial frames.

146 automated checks passed, one installed-MCM environment check skipped.
The new producer/consumer checks exercise delayed chunks, pause, cancellation,
stale identities, ring reuse, partial failure, quality changes and save unload.
**In-game phrase gaps, latency and visible articulation remain to be measured.**

Group rounds generate the next speaker while the previous one is audible and hold it
until the game submits it (docs/GROUP_VOICE.md, "Look-ahead"). An Omni look-ahead waits
until the previous speaker's phrases have all been produced before queueing GPU work, so
the FIFO worker never delays that speaker's own next phrase.

## Producer and consumer contract

- `splitSpeechText` prefers sentence/clause boundaries, with a shorter first
  phrase (6–22 words) and longer subsequent phrases (12–34 words). It preserves
  every word and merges tiny tails. A phrase split can alter TTS prosody; listening
  acceptance is required. No EQ, normalization, resampling, silence trimming,
  denoising or crossfade is added to the generated WAV.
- The utterance captures its chosen 16/32 steps. Changing Settings affects the
  next utterance, not a later phrase of the current voice.
- `reply.json` carries the full written reply/history and the first playable
  phrase. `speech-stream.json` carries append-only, numbered, ready audio/face
  chunks, with request ID, generation, exact entity, random stream ID, total,
  completion and partial-failure status.
- WAV writes finish before their manifest is atomically replaced. Eight existing
  on-demand Audioware slots are leased; a slot cannot be reused until the matching
  consumer acknowledges its chunk. The native currently playing slot is excluded
  even when a new request supersedes an old owner.
- At most one playing phrase and two prepared phrases are outstanding. Pause
  backpressure prevents generating an entire long reply into the slot ring.
  One serialized resident worker performs GPU inference; no second model loads.
- The native consumer retains the utterance's request ID while buffering. Group
  chat cannot advance to another speaker between phrases. New phrases start
  captions and facial interpolation from their own actual native audio cursor.
- Pause freezes playback/queue progress and resets the speech face. Resume joins
  the existing audio cursor. Cancellation, mute, target loss and unload stop the
  entire utterance; late chunks cannot change owners. Unload does not query old
  world components. Microphone cancellation also aborts local queued generation.
- On later synthesis failure the already-spoken portion finishes, then the full
  written reply remains available. First-phrase voice failure uses the existing
  text fallback. The face analyser failing does not discard valid voice audio.
- Reply duration is bounded to 120 seconds and 32 phrases. Native buffer/start
  failures time out. Native audio is still started once per WAV; zero-gap playback
  is not assumed from component tests.

## Phonetic face driver

> **2026-10-21:** the bridge no longer runs Rhubarb and the Runtime does not ship it; a phrase without cues from the lip-sync model plays on the audio envelope. This section is the history of that driver (the cue renderer, `phonetic-poses.mjs`, is still used for mouth cues).

Rhubarb Lip Sync 1.14.0's phonetic recognizer runs on two CPU threads, one job at a
time. It analyses a byte-for-byte temporary WAV copy and produces timed mouth
cues. Our `phonetic-poses.mjs` retargets them to 17 of the already installed native
facial controls at 60 Hz, with continuous transitions and limited anticipation:

| Cue | Articulation |
| --- | --- |
| A | Closed P/B/M lips; jaw remains closed even through silent closure |
| B | Narrow opening/stretched lips for consonants and EE |
| C/D | Increasing vowel opening |
| E/F | Rounded/funnelled and pursed lips |
| G | Lower lip raised toward the upper teeth for F/V |
| H | Tongue tip raised for L |
| X | Relaxed rest |

Short closures retain their centre instead of being smeared by smoothing.
Audio energy modulates jaw travel gently; it does not choose the lip shape or
erase quiet consonants. Native idle/gaze remain separate. Every timeline ends at
neutral. This is not a trained photorealistic face model, and individual rigs
still need visible validation. Amplitude-only movement is an explicit failure
fallback, not the selected local lip-sync method.

### Measured analyser cost

Same raw 30.4-second Judy reply, two CPU threads, game open:

| Run | Analysis time | Result |
| --- | ---: | --- |
| Phonetic CLI | 4.09 s | 211 cues |
| English PocketSphinx + known text | 25.86 s | 205 cues |
| Integrated phonetic adapter, test suite running concurrently | 5.59 s | 211 cues, 1,825 frames, 17 tracks |

These are full-file analysis costs, **not first-voice latency**. Short-phrase
generation/analysis costs and native inter-phrase gaps are recorded separately in
`bridge-latency.json`, `speech-stream.json` and `speech-state.json`. The native
receipt records per-phrase start cursor, gap estimate, slot and facial source.
Evidence: ignored `runtime/lipsync-eval/`.

## Setup, licensing and rollback

Run `scripts/Setup-PhoneticLipsync.ps1` for the pinned official Windows release.
The archive SHA-256 is a project-verified pin, not an upstream signed digest.
Keep its `LICENSE.md`, resources and third-party notices with any distributed
copy. Rhubarb itself uses MIT; its bundled dependency notices remain applicable.
The tool and voice models stay under ignored `vendor/`; local conversation/audio
scratch stays under ignored `runtime/`.

Installed Lua before this change is saved at
`backups/phrase-speech-20260929-045358/`, with original hashes. Source rollback is
available from the local Git checkpoint. Native redscript/archive assets were
already loaded and do not need replacement for this change. One CET reload loads
the `init.lua` guard that retains conversation focus until the utterance ends.

Sources: [Rhubarb implementation and shape documentation](https://github.com/DanielSWolf/rhubarb-lip-sync),
[v1.14.0 release](https://github.com/DanielSWolf/rhubarb-lip-sync/releases/tag/v1.14.0),
[license and bundled notices](https://github.com/DanielSWolf/rhubarb-lip-sync/blob/master/LICENSE.md).
