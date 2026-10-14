# Lip sync application on the companions (2026-10-15)

User report: "not much variety in lipsync shapes ... it is missing a lot of shapes and is just simple up and down opening",
with the guess that "maybe our model is good but the application on the character not so much". The guess was right.
This note covers what reaches the face, what was wrong, and what changed in `mod/facial-playback.lua`.

## Path checked

The game-trained model (`bridge/jali-face*.mjs`, source `local-jali`, 25 tracks) goes to `mod/facial-playback.lua`.
`M.sync` interpolates the model's tracks and writes them to the `ConvaiFaceFeature`, or to the native speech vector,
which the C++ `faces` system copies unchanged. From there they reach the prepared face graph: the `LipsyncPoseOutput`
deltas, then `speech_owner`, then the Sermo solver.

Measured with `face-trace` while a saved reply is replayed through the real writer (`face-play`, below). Every lip,
contact, roll, puff and tongue control reached the feature unchanged (ratio 1.00). There was no clamping, no dropped
track and no timing offset beyond the probe's own latency, and updates ran at 39 to 52 Hz. The expression layer writes
only corners, chin and brows, inside the mouth budget. Only one thing differed: the jaw.

## Root cause 1: the jaw lift outlived the reason for it

On October 9 the jaw was lifted per head type (woman_average q=2 with floor .21; the man heads q=1.5 with floor .17;
docs/GAME_LIPSYNC_MODEL.md). Every sweep that set those values ran before `speech_owner` existed (October 10). At the
time, the idle clip's own `lips_together` (.7 to 1.0) was still being added under the speech deltas, so the "sealed until
.20" that the lift was fitted to was the idle clip's seal, not the head's.

Static captures with the idle mouth handed over (`speech_owner` 1):

- **Alex (woman_average):** the lips part at jaw .06, teeth show at .12, and the mouth is clearly open at .20.
- **Jefferson Peralez (man_average):** a thin gap at .06, the teeth line at .10, and open from .20.
- **Rounded and spread poses at jaw .12:** OO (purse .45) and EE (stretch .25) read as distinct shapes on both heads.

With the lift on, the written jaw on a real Alex reply was 1.5 times the model's at p95. Low jaws were doubled, so the
mouth seldom closed between syllables. Rounded and spread vowels opened into the same "ah". The game's own authored
curves for Rogue, replayed through the same writer on the same head type, looked as flat as the model's.

**Fix.** The lift now applies only when the face graph has no `speech_owner` input (an archive from before October 10).
The head's lift entry is still read, because it marks the head types whose chin raise and corner depressors give way
while speaking (the ducks). The duck thresholds are unchanged and stay keyed on the written jaw:

- chin raise: gone at a written jaw of .10, now a model jaw of about .087;
- corner depressors: gone at .20, now about .174.

So expression corners survive a little more of quiet speech than before.

## Root cause 2: the model under-reaches the shape controls

The model's shape controls reach only part of the game's own peaks:

| Control | Share of the game's peak reached by the model |
|---|---|
| corner stretch, stretch, lower raise (the "ee"/spread family) | 66 to 70 % |
| purse | 75 % |
| jaw | 85 % |
| upper-lip raise (Rogue line) | about 40 % |

Source: held-out corpus, docs/LIPSYNC_V2_RESEARCH_2026-10-14.md. On the Rogue line itself, the model's jaw p95 was .43
against the game's .50, and its upper raise .055 against .135.

**Fix.** A model (`local-jali`) timeline is scaled per control towards the game's reach (`modelReach`), then clamped to
the validation bounds:

| Control | Scale |
|---|---|
| jaw | 1.15 |
| purse | 1.35 |
| corner stretch, stretch | 1.45 |
| lower raise | 1.3 |
| upper raise | 1.4 |

Contacts, rolls, funnel (which overshoots on the test set), puffs and tongue keep the model's values. Other sources
(Convai ARKit, phonetic, envelope) are never scaled. The cost is one table lookup and one multiply per written track,
inside the loop that already interpolates every track. No new per-frame call is added, and latency is unchanged.

Solver geometry for the same Alex line (Judy rig, `scripts/lipsync/native_mouth.py`, mm, relative to neutral):

| | AA inner aperture | EE width | OO width | OO protrusion | width std | shape share* |
|---|---|---|---|---|---|---|
| lifted (before) | 13.3 | +0.6 | -9.9 | 2.1 | 2.56 | .55 |
| raw | 9.0 | +1.4 | -9.3 | 2.7 | 2.46 | .63 |
| raw + reach | 9.0 | +2.6 | -12.2 | 3.7 | 3.25 | .68 |

\* (width std + protrusion std) / (aperture std + width std + protrusion std) over the speaking frames: how much of the
motion is shape rather than opening.

In the lifted row, OO's outer aperture was 3.8 mm against 1.9 mm raw: the rounded vowel was being opened.

## Per-control numbers, the same Alex line (Voxtral reply, 6.24 s), written by the Lua writer

| Control | model p95 | written p95 before | written p95 after |
|---|---|---|---|
| jaw_mid_open | .329 | .503 (x1.53) | .382 (x1.15) |
| lips_l_purse | .248 | .247 | .344 |
| lips_l_corner_stretch | .129 | .128 | .197 |
| lips_l_stretch | .108 | .108 | .157 |
| lips_l_lower_raise | .108 | .107 | .140 |
| lips_l_upper_raise | .067 | .066 | .094 |
| lips_together_dn | .983 | .984 | .980 |
| lips_suck_dn | - | - | .349 (= model) |

The written jaw's median fell from .263 to .171. Over all speaking frames, the share at .21 or more fell from 63 % to
36 %, and the share under .08 rose from 24 % to 28 %.

## Visual check

The captures are in the session scratchpad (`lipsync-capture/`), not the repo. Each one replays the same line on Alex:
staged with `face-stage`, facing the camera, with time running, cropped around the mouth at 30 FPS.

- `final-alex1-mouths.png` and `final-rogue-mouths.png`: the before, no-lift and final rows at the F/V, AA, EE, M/B/P
  and OO moments.
  - **Before:** AA is a wide oval, while EE and OO are the same smaller oval.
  - **Final:** F/V tucks the lower lip and M/B/P seals. EE is a wide, flat slit, OO a small rounded opening, and AA
    stays open.
- `man-jaw-owner/sheet.png`: the man_average jaw ramp and the OO and EE poses.

The rounded shape remains the weakest-reading one from the front: its protrusion points at the camera. The model also
almost never writes funnel (max .009 on the Alex line, where the game's Rogue curve reaches .21), so there is no funnel
for the writer to scale. That is a model-side gap, not an application one.

## Tools added

- `face-play <who> <name> [rate] | off` (mod/face-test.lua, dev only). Plays runtime/<name>.json (`{tracks, frames,
  duration}`, a reply's face flattened) silently through the real writer as a `local-jali` reply, after a .4 s lead.
  It ends the reply at the end of the line and refuses while a real reply owns the face.
- `face-reload` re-runs `facial-playback.lua` in place (the module table is reused).
- `face-trace` records 19 fields: the jaw, contacts, purse and funnel, stretch, the lip raises, rolls, puffs, tongue,
  corners, chin and `speech_owner`.

## Tests

`bridge/companion-expression-playback.test.mjs`:

- The jaw lift now applies only on a graph without `speech_owner`.
- Every head writes the jaw at its reach when the graph has `speech_owner`.
- `model reach` scales the listed controls, clamps them at their bounds, leaves the rest alone, and leaves other
  sources unscaled.
- `face-play` is covered.
- The duck tests now use raw-jaw units.

Other updated tests:

- `bridge/facial-playback.test.mjs`: the world NPC lift, with and without `speech_owner`.
- `bridge/speech-replay-probe.test.mjs`: the jaw at its reach.
- `native/core/tests/fixtures/faces-frames.json`: regenerated. The C++ engine is unchanged, and only the Lua-side
  speech vector moved.
