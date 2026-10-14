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

## Text visemes: rounding, closures and tucks from the reply text (branch `lipsync-text-visemes`, 2026-10-15)

The text-conditioned second stage of the model (`bridge/jali-face-text.mjs`, live since 2026-10-08) already turns the reply text
into phones and aligns them to the audio with the model's own phone head (a Viterbi over the known phone sequence). So no
second aligner was built: the phone, how far the audio's best phone is from it (the margin) and whether the alignment holds are
decided for every 10 ms row already. The TTS providers give nothing finer (Voxtral's stream carries audio only; Pocket and Omni
give audio and the subtitle cues), so the model's alignment is the timing source on every path (Voxtral, Pocket, Omni, Convai
audio through the model).

### What it does

`bridge/face-visemes.mjs` reads those decisions and adds four shapes on top of the model's rows, in the facial worker:

| Phones | Added |
| --- | --- |
| UW OW W (AW AO UH weaker) | funnel and purse on the vowel, with a 30 ms ramp in and out |
| SH CH JH ZH | funnel (.20 to .22, the game's own height for them) |
| M B P | the model's own closure is lifted towards full contact (its timing is kept; only the height changes), only where the model shows at least .3 of one |
| F V | the model's lower-lip contact is lifted the same way (the upper lip is left alone) and the lip roll goes to .30 to .35 |

Heights come from the game's authored curves by phone (6,584 lines): purse UW .25 OW .22 W .25 AW .25 AO .14 UH .11; funnel
.21 on SH CH JH ZH and about 0 on every rounded vowel; contacts 1.0; lip roll F .39 V .32. The game rounds "oo" with purse alone.
Funnel on the rounded vowels is therefore an addition of ours (funnel height x1.4, tuned by eye on Alex: the purse alone points the
lips at the camera, funnel opens the round shape to the front). Purse is in model units; the Lua writer scales the model's purse by
1.35, so UW's .30 is written at about .40.

Only ever up: every control is `max(model, shape)` or `model x gain`, then capped at the playback limits (funnel and purse .5,
contacts 1, roll .8), and never below what the model already wrote. Controls other than the shape ones are untouched (tested).

Trust: a phone's weight follows the mean margin of its rows (full to .6 nats, none from 2; on held-out clones the phones were right
90 to 95 % at the low margins and 60 to 85 % above 1). A rounded shape also needs the model's own jaw to be open (.03 to .10). A one-row
run is not a phone. When the alignment is given up (confidence, text revised, worker behind) the rows go out at once and unchanged.

Where it sits: the facial worker (`TextSession.process`), so the timeline the game receives is already finished and the game does
no new work. `Convai`'s own blendshapes and the game's own curves are untouched; only `local-jali` timelines are affected.
Dev switch: `CYBERPUNK_CONVAI_FACE_VISEMES=off` in the bridge's environment (bridge restart) gives the model's rows as before.

### Timing

Gestures peak at the centre of the aligned phone in head-row terms (checked against both the game's curves and the model's rows:
the peak sits 58 ms before the PocketSphinx label centre in both). A stream-mode phone is decided 3 rows after its row and the ramp
needs 3 more, so in stream mode rows are released 3 rows behind the decisions, 60 ms of face coverage while the alignment holds, and
at once when it does not. First audio never waits on the face (the renderer buffers 400 ms before it starts). Phrase mode (Omni)
has all decisions at the end and holds nothing extra.

### Cost

Warm, a 6 s reply costs about 1 ms of worker time (.13 to .35 ms per audio second; the worker warms the code at start so the first
reply is not slower). Nothing is added in the game.

### Numbers

150 held-out Pocket clones with PocketSphinx labels and the game's own targets; model rows read in a 7-row window around the
expected peak. Stream mode / phrase mode, before then after:

| Measure | Game | Stream before | Stream after | Phrase before | Phrase after |
| --- | --- | --- | --- | --- | --- |
| M B P closures reaching .9 | .91 | .82 | .90 | .85 | .92 |
| F V lower-lip contact reaching .8 | .91 | .81 | .85 | .88 | .88 |
| rounded vowels, purse reaching .18 | .73 | .76 | .89 | .75 | .89 |
| rounded vowels, funnel reaching .10 | .00 | .01 | .88 | .01 | .88 |
| SH CH JH funnel reaching .12 | .86 | .91 | .93 | .93 | .95 |

The share of rows changed is 14 %; no entry anywhere is lowered. Alignment precision at the segment level (class right): rounded .89,
M B P .92, F V .86, SH CH JH .92 in stream mode.

The test line (a Pocket clone of a Panam line, 5.9 s, replayed on Alex through `face-play`; Alex's own Voxtral audio was not kept, so
a line with the same kinds of sounds stands in) as written by the Lua writer, speaking frames:

| Control | before p95 / max | after p95 / max |
| --- | --- | --- |
| funnel | .068 / .225 | .267 / .307 |
| purse | .188 / .290 | .283 / .351 |
| lip roll (suck_dn) | .311 / .400 | .324 / .411 |
| M B P closure peaks (min of the two contacts) | 1.0, 1.0, .98, .91 | 1.0, 1.0, .98, 1.0 |
| F V contact peaks (lower minus upper) | .99, 1.0, .98, 1.0, .41 | .99, 1.0, .98, 1.0, .44 |

That line already had SH and CH words, so its funnel was not the near-zero of Alex's Voxtral line; the rounded-vowel rows are where it
changed. The captures (session scratchpad, `tv/panam-delta-final.png`, row 1 before, row 2 after) show UW/OW/W frames visibly rounder
and narrower; M/B/P and F/V frames look almost the same because the model already closed them there. A stronger funnel (x1.6) looked
good too; 1.4 is the value shipped (`funnelScale`).

### Tests

`bridge/face-visemes.test.mjs` (caps equal the playback limits; rounding adds funnel and purse at the vowel only; never lowers;
nothing on a closed mouth, low trust or a one-row run; closures and tucks lift only where the model has a contact; packets equal one
pass and rows are held back by no more than the look-ahead; lost alignment, no aligner and failure release rows unchanged; cost) and
one case in `bridge/jali-face-text.test.mjs` (off by default, same row count, only adds, a failing pass hands its rows back).

### Left for later

- Alex's own Voxtral line: compare before and after on a live reply once the branch is merged and the bridge restarted.
- The F/V lift is small (the model has no contact at all on about 10 % of them, and nothing is invented there).
- `funnelScale` and the recipe heights are one table in `bridge/face-visemes.mjs` (`VISEME_CONFIG`, `RECIPES`).

