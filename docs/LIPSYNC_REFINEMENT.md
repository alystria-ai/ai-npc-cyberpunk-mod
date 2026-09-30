# Lip articulation refinement, September 29

The user describes the current mouth as working but sometimes appearing to
move mainly the lower lip/jaw. Timing was not the reported problem. Judy's
small mouth makes subtle lip deformation harder to see.

## Research that informed this change

[JALI's original research](https://www.dgp.toronto.edu/~elf/jali.html) separates
jaw movement from lip shaping and relates their intensity to speech acoustics.
The [Cyberpunk production talk](https://history.siggraph.org/wp-content/uploads/2022/08/2020-Talks-Edwards_JALI-Driven-Expressive-Facial-Animation-and-Multilingual-Speech-in-Cyberpunk-2077.pdf)
describes coarticulation, expressive controls and preserving important mouth
shapes while layering other animation. Our code uses these general principles;
it does not reproduce JALI's learned language models or full production system.

[Rhubarb's documentation](https://github.com/DanielSWolf/rhubarb-lip-sync#mouth-shapes)
explains that its output is a small set of 2D mouth poses. Applying each as a
rigid 3D pose has a quality ceiling. A round mouth, a narrow consonant, a closed
P/B/M and a lower-lip/upper-teeth F/V need different trajectories.

[NVIDIA's Audio2Face SDK](https://github.com/NVIDIA/Audio2Face-3D-SDK) is a possible
future neural route with Windows support and TensorRT/CUDA dependencies. Its
stated recommendation is at least 4 GB GPU memory; that is not a measurement
of incremental memory on this laptop. It was not installed during this change.

## Implemented

- 21 whitelisted native speech controls, using the already installed 50-control
  graph. Mouth-corner stretching is added; the two individual upper-lip raisers
  are reserved at zero. No native archive or redscript change is needed.
- Jaw, rounded lips, other lip controls and tongue contacts have separate
  anticipation/release windows. Rounded lips can prepare before the jaw moves.
- Closures reach their full target even in short cues. Quiet consonants retain
  their shape rather than being gated off by low amplitude.
- Syllable energy varies vowel opening and lip extension independently. The
  envelope is interpolated between analysis frames instead of stepping.
- Jaw opening varies by sound category while upper/lower lip shaping remains
  independent. The live v3 check then requested more opening; v4 increases
  open-mouth categories without lifting the upper lip further.
- No random facial jitter, imposed smile, gaze change or processed audio.
  Pause/cancel/unload and the actual native playback cursor retain ownership.

The native timeline still uses `local-phonetic` and adds
`articulation: coarticulated-v4` to live diagnostics. The Lua adapter whitelist
accepts only its 21 named controls and keeps the existing weight limits.

### Live correction

The first `coarticulated-v2` check exposed occasional distortion of Judy's right
upper lip. That version layered individual upper-lip raisers onto the existing
`lips_apart_up` opening. Version 3 removes the additional raisers on both sides,
while retaining jaw timing, rounding, corner movement and the existing upper
opening. The reserved channels explicitly receive zero so previous weights
cannot persist. Overlapping controls are the current hypothesis; the correction
still needs a fresh visual check before calling the distortion resolved.

The next user observation was that the mouth did not open enough. The v3 native
receipt confirmed 293 applications and cleanup over 7.32 seconds. Its emitted
jaw weights had a 0.049 active median, 0.196 95th percentile and 0.310 maximum;
both individual upper raisers were zero. Version 4 increases jaw targets for
B/C/D/E/F/H (maximum 0.40), keeps the existing energy variation, and leaves
closed P/B/M, F/V lip contact, lip shaping and timing unchanged. This is a
controlled opening adjustment.

**Live v4 result:** the user confirmed **"Natural opening"** on Judy's next
F6 reply. The native receipt reports 173 applications over the 4.44-second
utterance, `coarticulated-v4`, and a completed face reset. First audio was
estimated at 4.108 s from bridge receipt; local generation took 1.520 s and
phonetic analysis 0.923 s. Evidence:
`runtime/latency-investigation-20260929/v4-accepted-*.json`.
This accepts Judy's opening adjustment, not every rig or expressive behavior.

## Verification and limits

21 affected Node tests pass after this correction, including zeroed upper
raisers and active corner delivery to the native
feature, distinct trajectories, closure/rest, unchanged audio, pause/resume,
speaker changes and cleanup. The live speech-install diagnostic accepted the
adapter without restarting/reloading the game. Visual acceptance remains a
separate in-game check; Judy's acceptance above applies to the latest v4 change,
while other characters and broader expressive quality still need inspection.

The recognizer still supplies nine acoustic categories, not a full phoneme
alignment or a trained 3D performance. English transcript-guided recognition
was previously measured much slower and has not replaced this low-latency path.
Emotion, smiles and blink coordination remain separate TODO items.

## Convai opening calibration, September 30

After switching from local OmniVoice to Convai voice, the user reported a
smaller mouth opening. The voice selection also selects a different facial
source: OmniVoice uses the local phonetic poses above; Convai supplies timed
ARKit-61/Neurosync values. Those values were still being retargeted with the
earlier `0.35 * JawOpen * (1 - MouthClose)` mapping. This is a difference in our
retargeting, not evidence that the voice audio needs processing.

The first September 30 opening adjustment reports `articulation: arkit61-open-v2`:

- A fixed monotonic curve increases small and medium jaw openings. Its maximum
  is 0.40, the same ceiling as the locally accepted D-vowel pose. Zero remains
  zero; there is no minimum opening or adaptive peak normalization.
- MouthClose still gates the jaw after calibration. A full closed-mouth pose
  keeps the jaw and aperture at zero; the existing closure weights are unchanged.
- Upper and lower aperture receive smaller increases, retaining their existing
  0.12 and 0.16 ceilings. The individual left/right upper-lip raisers stay zero.
- Funnel, purse, lateral stretch, tongue and other reserved channels are
  unchanged. The local phonetic and audio-envelope paths are unchanged.
- Calibration is a function of the current provider pose, not the speaker or
  the range of values in a file. Matching continuation poses therefore remain
  equal across audio chunks. Real silence, pause/cancel cleanup, and first/final
  boundary easing retain their existing behavior. PCM is not changed.

### Captured Judy reply

The five Convai segments of request `1790723645-3-11078476ULL` contain 155 native
face frames. The last three-frame audio-envelope tail is excluded and unchanged.
The full reply lasts 5.0347 seconds. The preserved source identity is the
installed `speech-stream.json` SHA256
`962d7cf98b2ab3bafe9c6b4a403a60f0eef76521b8bca3d26a1f7895ca06499f`.

The manifest retains mapped native frames rather than raw ARKit arrays. For
this offline comparison, effective ARKit inputs were recovered from the previous
linear mapping and replayed through the old and new actual builders with the
matching captured WAV files. The round trip reproduced old weights within
0.0001, their stored rounding precision. These are predicted native weights,
not a new rendered or audible test.

| Control | Active median before → after | Active p95 before → after | Peak before → after |
| --- | --- | --- | --- |
| Jaw | 0.0237 → 0.0397 | 0.1150 → 0.1756 | 0.1606 → 0.2332 |
| Upper aperture | 0.0290 → 0.0334 | 0.0706 → 0.0764 | 0.0786 → 0.0840 |
| Lower aperture | 0.0414 → 0.0451 | 0.1180 → 0.1217 | 0.1600 → 0.1600 |

“Active” excludes zero weights separately for each control. No neutral frames
became non-neutral, and no unrelated articulation weights changed in this replay.
The shape remains bounded, but visual comfort across different rigs is not
proven by these numbers. **Judy still needs an in-game check for sufficient
opening, preserved consonant closure, and absence of upper-lip distortion.**

Behavioral tests cover weak/mid/strong input, monotonic bounded travel,
MouthClose, real silence, unchanged waveform/provider arrays, upper-lip limits,
unrelated articulation, and matching poses through real PCM chunk boundaries.

## Continuous Convai reply: jaw range and source cadence, September 30

After continuous voice playback sounded smooth, the user still described mouth
shapes as simple or barely open. The latest retained Judy reply contains 445
ARKit frames at **60 Hz**, spanning 0 to 7.4 seconds of a 7.4167-second WAV.
Its native receipt confirms 289 applications and a successful final reset.
There are no neutral facial dropouts among the 158 sampled frames with PCM RMS
above 0.01. This is therefore a different defect from the earlier per-file
energy gate, which erased quiet articulation.

The retained source identity is `last-speech-timing.json` SHA256
`fde43ee505449412b1ba4eaf9897d735bd1082c4684b492c00722779da3e3213`.
Ignored evidence: `runtime/facial-aperture-audit-20260930.json` and
`runtime/facial-aperture-v3-replay-20260930.json`.

Two bounded changes now identify themselves as `arkit61-open-v3`:

- Jaw retargeting uses `0.40 * (3 * j / (1 + 2 * j)) * (1 - MouthClose)`.
  This fixed monotonic curve expands the source's compressed small/mid range.
  Zero remains zero, full closure remains closed, and the maximum stays 0.40.
  There is no per-voice normalization or minimum opening.
- Output cadence derives from the median positive spacing of validated source
  timestamps, bounded to 30–60 Hz. The current provider's 60 Hz single-frame
  poses survive instead of being discarded by a fixed 30 Hz resample. Sparse
  feeds retain interpolation at 30 Hz; a 50 Hz source remains 50 Hz. This never
  scales source timestamps or audio duration, and a full 120-second output
  remains inside the native 7202-frame limit.

The upper/lower aperture curves and caps, closure, funnel, purse and stretch
gains are unchanged. All ten reserved articulation controls remain zero,
including the individual upper-lip raisers that previously distorted Judy's
right lip. The local phonetic and envelope routes are unchanged.

Replay of the same retained PCM and raw source gives the following **predicted
native jaw weights at the same 158 audible sample times**:

| Measure | v2 | v3 |
| --- | ---: | ---: |
| Median | 0.0413 | 0.0740 |
| 95th percentile | 0.1297 | 0.1916 |
| Maximum | 0.1706 | 0.2332 |

The 60 Hz timeline contains 446 frames including final cleanup, versus 224
previously. Its retained intermediate jaw peak is 0.2486. Pucker's peak becomes
0.2492 versus 0.2083 solely because the previously skipped source frame is now
present; its mapping gain did not change. At shared timestamps every non-jaw
control matches the previous mapped value exactly. Audio and provider arrays
are unchanged.

Regression coverage includes a genuine one-frame 60 Hz jaw/pucker peak, several
source cadences without time stretching, continuous monotonic opening through
partial/full closures, quiet consonants, immutable inputs, upper-lip limits,
and a full two-minute timeline. Native cursor ownership, cancellation, pause
and final reset retain their existing tests.

These changes are source and offline replay evidence, **not a new visual
acceptance**. Additional lower-lip contact, corner shaping or expressive retargets
remain deferred until their native rig mapping can be validated; louder or
wider deformation alone would not prove correct phonetics.

## September 30: preserve quiet provider articulation

The later Judy reply contained six isolated all-zero facial frames between
non-neutral frames. One jaw sequence was `0.0715 -> 0 -> 0.0383` in 66 ms.
The per-file PCM energy floor gated every ARKit track, discarding legitimate
quiet articulation. A neutral interval at one file join was genuine silence;
that interval alone was not evidence of a faulty facial handoff.

For validated `arkit61` data, source frames now own articulation and rest;
PCM loudness no longer gates those frames. The established jaw curve and
upper-lip limits are unchanged. Local phonetic/envelope paths are unchanged.
Provider-neutral frames close the mouth, a missing source tail expires after
100 ms, and first/final easing and pause/cancel/unload cleanup remain in place.
A provider that itself holds an expression during silence can retain that
expression until it changes or expires; this fix does not invent silent poses.

The quiet-closure and whole-versus-split reproducers failed before correction.
The focused face tests now pass, including identical boundary poses and
agreement within stored 0.0001 precision away from boundaries. Raw source
arrays and PCM are unchanged. Rendered improvement still needs a live check.
