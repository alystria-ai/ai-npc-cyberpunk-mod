# Game-trained lip sync (JALI audio model)

**Status: built and measured offline; in-game visual check pending.**

## What the game ships, and why it matters

Every English voice-over line in `lang_en_voice.archive` has a JALI-authored
lipsync animation: `base\localization\en-us\lipsync\<scene>\<actor>.anims`
(5,688 files), one `animAnimation` per line named `f_<HEX>`/`m_<HEX>`. The hex
matches the voice file `base\localization\en-us\vo\<actor>_<quest>_f_<hex>.wem`
and its `locVoLineEntry.stringId`. Durations agree to about 10 ms.

Each animation keys the face rig's 414 float tracks. The mouth performance is
written to the **same `<control>LipsyncPoseOutput` tracks that the mod's
ConvaiFace feature adds to** (`AdditiveFromRefPose`, reference value 0), plus
matching `<control>AnimOverrideWeight` tracks (reference 1, keyed to `1 - pose`)
that fade the idle animation under the lipsync pose, and the JALI envelopes
(`lipSyncEnvelope`, `jaliJaw`, `jaliLips`, `muzzleLips`, ...). So the game's
own dialogue curves are direct ground truth in the units we already write.

Findings from 3,483 extracted lines (3.9 h, 109 speakers):

- Left/right pairs are always identical: JALI is symmetric.
- The game never uses `lips_apart_up/dn` or `lips_tighten_*`. Vertical lip
  separation comes from jaw + funnel/purse/lower-raise; closures use
  `lips_together_up/dn` up to 1.1 (the solver clamps at 1). Our previous
  paths capped contact at 0.85; on Judy's rig 0.85 at jaw 0.3 still leaves a
  ~1.2 mm gap, 1.0 at jaw 0.2 closes to 0.1 mm.
- Typical speech values: jaw median 0.12 (p95 0.37, max 0.66), purse p95 0.21,
  corner stretch p95 0.16, lower raise p95 0.13, lower roll (suck_dn) p95 0.17
  (max 0.72), upper roll up to 0.29, puff up to 0.38.
- JALI also animates tongue (base up/back, lift, tip), throat/neck and the
  upper face (blinks, brows, squints); those are outside the speech layer.
- Restricting the game's curves to the 50 controls already in our facial
  graph reproduces the full native mouth geometry almost exactly (inner
  aperture r 0.994, width/protrusion r ≥ 0.996, aperture error 0.27 mm). **No
  graph or archive change is needed** to reach native-quality mouth shapes.

## Tooling used

- WolvenKit CLI 9.0.1 (already in `vendor/`): `archive -l`, `unbundle`,
  `export` (anims → glTF with `trackKeys`/`constTrackKeys` extras).
- vgmstream-cli r2055 (already on this PC, used earlier for voice references)
  to decode Wwise Vorbis `.wem`.
- The reconstructed Sermo solver from the WolvenKit Blender add-on (in
  `vendor/`) for CPU mouth geometry. Nothing new was downloaded or installed.

## Objective measurement

`scripts/lipsync/lipsync_eval.py` replays held-out game lines (speakers never
seen in training: Kerry, Takemura, Rogue, Mitch and 12 others) through:

- **pocket**: the production Pocket path (PocketSphinx allphone phones →
  calibrated shapes → `PocketFacialStream` with ideal phone availability → Lua
  `local-phonetic-smooth-v1` easing),
- **omni**: the production Omni path (Rhubarb phonetic cues →
  `buildFacialTimeline` → Lua easing),
- **model**: the game-trained audio model,

and compares them with the game's own curves, in track space and in native
mouth geometry on Judy's rig (inner/outer lip aperture, mouth width, lip
protrusion, chin drop; lip contact = inner aperture < 1 mm during speech).

### Results (150 held-out lines, 10.0 min of speech, 16 unseen speakers)

| Metric | Pocket (before) | Omni (before) | Game-trained model | game curves (graph controls) |
| --- | ---: | ---: | ---: | ---: |
| Inner lip aperture r | 0.41 | 0.51 | 0.82 | 0.99 |
| Inner aperture error (mm) | 2.19 | 1.98 | 1.24 | 0.37 |
| Mouth width r | 0.19 | 0.22 | 0.51 | 1.00 |
| Lip protrusion r | 0.21 | 0.27 | 0.67 | 1.00 |
| Chin drop r | 0.44 | 0.56 | 0.86 | 1.00 |
| Jaw control r | 0.48 | 0.58 | 0.86 | 1.00 |
| Lip contact control r | 0.14 | 0.31 | 0.66 | 1.00 |
| Purse r | 0.28 | 0.31 | 0.60 | 1.00 |
| Corner stretch r | 0.16 | 0.38 | 0.66 | 1.00 |
| Lower roll r | 0.24 | 0.22 | 0.69 | 1.00 |
| Lip-contact recall | 0.12 | 0.38 | 0.54 | 0.88 |
| Lip-contact precision | 0.12 | 0.19 | 0.38 | 0.72 |
| F/V contact recall | 0.00 | 0.00 | 0.64 | 1.00 |
| Rounding recall | 0.29 | 0.43 | 0.64 | 1.00 |
| Rounding precision | 0.28 | 0.26 | 0.37 | 0.53 |
| Timing (ms late vs game) | 67 | 67 | 0 | 0 |

"Game curves (graph controls)" is the ceiling: the game's own curves played
through only our 50 graph controls. "Timing" is the best cross-correlation lag
of inner lip aperture at 30 fps: both previous paths trail the game's
animation by about two frames (phone boundaries plus the 35 ms Lua easing).

Previous-path findings: the Pocket path (allphone recognizer → 9 Rhubarb
shapes) almost never reaches lip contact (12 %) and never produces F/V contact;
Omni's Rhubarb path reaches 38 % contact. Both use `lips_apart` (which the
game never uses) and mostly move the jaw, with weak width/rounding (r ≈ 0.2–0.3).

On the mod's own cloned-voice output (retained Omni Judy/Johnny/Panam, Pocket
Dex and Convai Judy WAVs; `scripts/lipsync/tts_domain_check.py`) the model's
speech-time mouth statistics match its statistics on game audio (lip contact
~5–7 % of speech frames, aperture quartiles ≈ 2.5/4/5.5 mm, similar motion per
frame), so it transfers to TTS rather than collapsing. Known limit: it widens
the mouth less than the game does (width p95 +1.5 mm vs +7.5 mm in the game's
curves); wide "ee" shapes are under-articulated relative to the source.

These are objective proxies on bone-origin landmarks, not a rendered visual
judgement; the in-game check remains the acceptance test.

## The model

`scripts/lipsync/lipsync_model.py`: 80-band log-mel (16 kHz, 10 ms hop) →
dilated 1-D conv network (6 residual blocks, 160 channels, ~0.66 M weights,
670 ms receptive field, 200 ms lookahead) → 15 symmetric JALI controls
(23 native tracks): jaw, lip contact up/down, purse, funnel, corner stretch,
stretch, lower/upper raise, upper/lower roll, lip puff, cheek puff, tongue tip
up/forward. It is trained on the game's curves (mean-squared error plus a per-output
quantile map that restores the authored range of sparse events such as lip
contact and rounding; plain L1 collapsed those to zero) with gain, tilt,
band-limit, noise and ±12 % speed augmentation. A 200 ms lookahead beat
120 ms on held-out lip contact and rounding (the game anticipates rounding). Unpadded convolutions over silence-padded
features make streamed and whole-utterance output identical.

Inference is pure JavaScript (`bridge/jali-face-model.mjs`) on a worker
thread (`bridge/jali-face-worker.mjs`, client `bridge/jali-face.mjs`); about
0.13 s CPU per second of audio, no GPU, no Python. Output parity with the
NumPy/PyTorch reference is exact at 16 kHz (resampling from 24 kHz differs by
< 0.006 in weight).

## Integration per route

- **Pocket (streamed PCM):** `PocketFacialStream` feeds the same copied PCM
  packets to the model; poses are available ~215 ms behind received audio,
  inside the 0.4 s playback start buffer. Uncovered audio uses the
  existing envelope fallback; the model blends in over 60 ms once heard audio
  is covered. The PocketSphinx/Rhubarb analysers are not started while the
  model is available.
- **Omni (phrase WAVs):** each phrase is analysed whole by the model instead of
  Rhubarb (Rhubarb remains the fallback). This is also faster: the retained
  2.96 s Judy phrase took 0.48 s through the worker versus 1.99 s in Rhubarb,
  and a 30.4 s file 3.6 s versus 4.1 s (measured while training ran).
- Timelines use source `local-jali`, articulation `jali-audio-v1`, 25 tracks
  (`JALI_TIMELINE_TRACKS`), no Lua easing (the curves are already smooth), and
  a 35 ms lead that offsets the bounded past lag of the Lua facial cursor.
- **Convai (continuous streamed PCM):** the browser keeps a read-only
  analysis copy of the provider PCM and returns it by absolute frame offset
  only when the host's snapshot poll asks for it (`continuousSnapshot(token,
  pcmFrom)`); `ConvaiContinuousSpeech` feeds it to the same worker. Where the
  model covers the heard audio the mouth uses its native controls (source
  `local-jali`); before coverage, after any PCM gap or worker fault, the
  NeuroSync ARKit retarget (v10) continues in the same fixed 25-track layout.
  Provider brow/corner expressions are kept in both cases. The rare
  complete-WAV Convai fallback route still uses ARKit only.

Why replace NeuroSync's mouth for Convai too: on the retained Judy Convai reply
the v10 retarget keeps the lips in contact in only ~6 % of speech frames
(median inner aperture 5.2 mm, mouth width mostly narrower than rest), whereas
the game's own Judy dialogue has contact in ~16 % of speech frames (median
aperture 4.1 mm) and widens up to ~5.6 mm. One reply is indicative only; the
in-game comparison below is the real test.

Lua (`mod/facial-playback.lua`, `mod/speech-replay-probe.lua`) accepts the new
source and five more graph controls, and its validation bounds now cover the
game's own ranges (jaw .7, contact 1.0, lower roll .8, upper roll .3, puff
.45, cheek puff .35, other mouth controls .5).

## Activation

No archive, redscript or game restart is needed. Copy `mod/facial-playback.lua`
and `mod/speech-replay-probe.lua` into the installed CET mod and reload CET;
restart the bridge so it loads the new JavaScript, the local weights in
`runtime/lipsync-model/` and rebuilds `runtime/realtime-client.js`. Deleting
`runtime/lipsync-model/face-model.*` (or `CYBERPUNK_CONVAI_FACE_MODEL=off`)
restores the previous paths on the next bridge start.

`scripts/lipsync/stage_ab_fixture.mjs <wav> old|new --install` stages the same
audio with the previous local mouth or the model for the replay probe
(`speech-fixture:<profile>:<nonce>`), for a controlled side-by-side check.

## Data handling

The corpus (`runtime/lipsync-corpus2`) and trained weights
(`runtime/lipsync-model/face-model.{json,bin}`) are derived from game assets.
They stay in the ignored `runtime/` folder and are rebuilt locally from the
user's own install; they are not committed or redistributed. Without weights
the bridge keeps the previous phone/Rhubarb paths unchanged
(`CYBERPUNK_CONVAI_FACE_MODEL=off` also disables the model).

## Reproduce

```powershell
$py = 'vendor\pocket-tts-env\Scripts\python.exe'
& $py scripts\lipsync\extract_game_lipsync.py                       # corpus
cd scripts\lipsync; & ..\..\$py make_split.py; cd ..\..
& $py scripts\lipsync\lipsync_model.py --split runtime\lipsync-corpus2\split.json --out runtime\lipsync-model\model.npz
cd scripts\lipsync; & ..\..\$py export_face_model.py ..\..\runtime\lipsync-model\model.npz; cd ..\..
& $py scripts\lipsync\lipsync_eval.py --split runtime\lipsync-corpus2\split.json --model runtime\lipsync-model\model.npz
node --test bridge/jali-face.test.mjs bridge/convai-jali-face.test.mjs
```
