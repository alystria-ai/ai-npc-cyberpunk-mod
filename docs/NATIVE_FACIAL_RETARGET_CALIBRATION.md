# Native facial retarget calibration

## October 1: restore upper-lip roll

After the user found v7 "not bad" and requested further improvement, the next
isolated change is source MouthRollUpper (index 32) to native `lips_suck_up`.
The source is active above 0.01 in 427 of the retained 445 frames; v7 discarded
it. This describes inward upper-lip motion, independently of jaw opening and
upper-lip raising. It does not justify inventing F/V contact from LowerDown.

A silent High-LOD native comparison holds jaw 0.14, upper aperture 0.04 and
upper raisers 0.06 while adding roll at 0.03, then 0.06. It also combines 0.06
roll with the calibrated lip seal, then resets. The 73-frame window capture
contains all five phases. The added contour change is subtle, without obvious
distortion or broken lip contact in this view; the face returns to neutral.

The v8 candidate adds `0.06 * (5*r / (1+4*r))`, with zero source still zero.
All v7 weights and timing are preserved. The native adapter allows the new
22nd control only up to 0.06. Local Omni poses supply zero on this new track.
Real producer-to-Lua checks verify the value reaches the feature and clears.

CPU replay of 445 frames and 108 native interaction combinations per rig is
finite. Typical added local upper-lip motion is 0.111 mm on Judy and 0.064 mm
on Johnny, with peaks 0.206/0.136 mm. This is a restrained depth/contour change;
it is not a claim of a large overall quality improvement. Ordinary speech
comparison is the remaining gate.

Evidence remains ignored: `runtime/upper-roll-images-20261001-013546`,
`runtime/lip-depth-review-20261001/FINDINGS.md`, and
`runtime/lips-v8-tests-20261001.log`. The user's authorization now includes
triggering speech through the mod; a bounded local replay permits matching
audio across comparisons without adding test dialogue to provider memory.

## October 1: lip contact and independent upper lift

The user found the rendered v6 speech better but still in need of substantial
improvement. The full retained reply has 492 mapped frames, 142 native pose
applications and a completed reset. It shows stronger round/wide shapes, but
the lips often remain parted and the upper lip has little independent motion.

A separate silent native comparison holds the jaw at 0.14. Together weights
of 0.35 still leave a tooth gap; 0.85 closes Judy's lips cleanly. Paired upper
raisers at 0.06, with aggregate upper aperture reduced to 0.04, produce a gentle
visible lift at High LOD. These are rendered endpoints, not a claim that all
intermediate speech combinations are natural.

The v7 candidate keeps the accepted jaw and v6 round/wide curves and adds:

- Native together controls: `0.85 * (12*c / (1+11*c))`, from source MouthClose.
- Independent upper raisers: `0.06 * (2*u / (1+u)) * (1-c)` per side.
- Aggregate upper aperture is reduced by up to two thirds as the independent
  upper-lip lift takes over, to avoid stacking the earlier distortion-prone lift.

The Lua validator admits weights up to 0.85 only for the two together tracks.
All other limits, audio, source timing, rest, ownership and cleanup are retained.
The local Omni articulation path is unchanged.

Independent native geometry replay matches the production JS mapping exactly
for 445 real source frames. All frames and 1,152 combined/asymmetric stress
cases per rig are finite. Real contact peaks at 0.6734, upper raise at 0.0512,
and aggregate upper aperture at 0.0405. Whole-pose peak local lip translation
changes from 7.389 to 7.401 mm on Judy and 10.287 to 10.491 mm on Johnny; peak
rotation is unchanged. These measurements use reference tracks and reconstructed
local bones, so they cannot certify skinning, teeth contact or rendered symmetry.

Seventy-eight focused checks pass, including the real producer-to-Lua boundary,
track-specific admission limits and reset. V7 was installed without a game
restart and captured during a real reply: 49 window frames over 4.47 seconds,
with the first reply's native face reporting 137 applications and final reset.
The retained mapped prefix reaches 3.2 seconds and is not marked complete;
do not describe it as a complete raw provider capture. The user says "not bad,
keep improving." The images show distinct open/narrow/closed shapes and a clean
return to rest, without obvious upper-lip distortion at this view. Naturalness
remains open, and still frames cannot certify motion quality across the cast.

Watch sharp consonant closure: one retained research source sample jumps from
zero MouthClose to 0.241 in one 60 Hz frame. No new smoothing is imposed before
checking whether that closure is visibly abrupt.

Ignored evidence:

- `runtime/speech-images-v6-20261001-004508`: complete v6 game-window sequence
  and sanitized mapped timeline; the user's improvement report applies to v6.
- `runtime/lip-detail-images-20261001-010003`: upper/lower lift and 0.35 contact.
- `runtime/lip-contact-images-20261001-010515`: 0.85 contact and neutral reset.
- `runtime/lip-contact-geometry-20261001/FINDINGS.md`: scripts, two-rig replay,
  asymmetric stress cases and limits.
- `runtime/lips-v7-tests-20261001.log`: focused source check receipt.
- `runtime/speech-images-v7-20261001-012027`: actual v7 speech PNG sequence,
  timing metadata and the last observed mapped prefix. A later reply was not
  recorded by this bounded capture and must not be merged into its evidence.

## October 1: rendered shape contrast

The user accepted v5's jaw opening and the smoothness after the browser snapshot
fix, but described normal speech as mostly up/down jaw movement. They changed
LOD from Low to High; the saved `LODPreset` was independently confirmed as High.

Direct game-window capture now provides rendered evidence. With jaw held at
0.14, funnel 0.32/purse 0.28 visibly round Judy's lips, while corner stretch
0.23/inner stretch 0.14 visibly widen them. The complete seven-and-a-half-second
test returned to neutral. These channels work on the running High-LOD rig;
this does not establish what the earlier Low setting rendered.

The normal v5 speech capture shows much weaker lip contrast. The v6 comparison
keeps the accepted jaw curve and uses fixed shoulders for the existing lip
signals, bounded by the endpoints just rendered:

| Source | v6 native response |
| --- | --- |
| Funnel | `0.32 * (4*x / (1+3*x))` to each native funnel |
| Pucker | `0.28 * (4*x / (1+3*x))` to each native purse |
| Left/right stretch | `0.23 * (3*x / (1+2*x))` to the corresponding corner, plus `0.14*x` inner stretch |

Zero still means zero; one frame's calibration is independent of the rest of the
reply. Jaw, closure, aperture, lower roll, timing, local Omni articulation and
the zeroed individual upper raisers are preserved.

An independent replay of all 445 retained source frames on Judy/Johnny found
finite geometry and an exactly unchanged jaw. Median lip-shape contribution
increases from 0.74 to 2.34 mm on Judy and 0.90 to 2.88 mm on Johnny in local
bone space. Across the capture, it stays below 76.3 percent of the larger
context-matched rounded/wide probe's translation and 72.5 percent of its rotation.
Native influences do not erase these injected signals. These are bounded
geometry results, not acceptance of the new spoken animation.

Seventy-five focused source checks pass, including original producer-to-Lua
field delivery, independent constant-jaw round/wide inputs, bounds, source
immutability, 60 Hz timing, reset and native probe lifecycle. The fresh v6
speech rendering was subsequently captured; the user reports an improvement
but does not yet accept the overall quality. The next contact/lift comparison
is described above.

Ignored evidence:

- `runtime/articulation-images-20261001-001511`: complete native pose capture,
  original PNGs, phase metadata and an enlarged inspection contact sheet.
- `runtime/speech-images-high-lod-20261001-002049`: partial normal v5 speech
  capture. Its trigger missed the opening portion; do not describe it as a full
  reply recording.
- `runtime/lip-contrast-geometry-20261001/FINDINGS.md`: reproducible two-rig CPU
  comparison and limitations.
- `runtime/lip-contrast-v6-tests-20261001.log`.

See [game window capture](GAME_WINDOW_CAPTURE.md) for the direct HWND tool and
the multi-monitor capture limitation found during this check.

## Earlier calibration record

The following September 30 sections record the earlier v4/v5 source and CPU
checks. Subsequent rendered results are stated above.

## What the provider and rig actually represent

Convai Web SDK 1.7.0 supplies its custom 61-value order, not the standard
ARKit-52 order. The installed SDK identifies `JawOpen` at 17, `MouthClose` at
18, left/right `MouthStretch` at 29/30, and `MouthRollLower` at 31. The new
regression checks compare these positions with the actual SDK order table.

[Apple's MouthStretchLeft definition](https://developer.apple.com/documentation/arkit/arfaceanchor/blendshapelocation/mouthstretchleft)
describes lateral movement of the mouth corner. Our previous retarget used
only Cyberpunk's `lips_l_stretch`/`lips_r_stretch` and always zeroed the separate
`lips_l_corner_stretch`/`lips_r_corner_stretch` tracks. Those native controls
are different poses.

The installed Judy skeleton and facial setup were extracted into the ignored
`runtime/facial-native-audit-20260930` directory. They contain 344 bones and
414 tracks. The pure NumPy parser and reconstructed native solver from the
[Cyberpunk Blender add-on, commit 7a4ee793](https://github.com/WolvenKit/Cyberpunk-Blender-add-on/blob/7a4ee793c36d9615946fe87ec9d42cde7568021d/i_scene_cp77_gltf/animation/facial/solver.py)
were imported in place without starting Blender or controlling the game.
No upstream solver implementation or extracted game asset was copied into
tracked source.

An independent repeat extracted Johnny's matching rig/setup into the ignored
`runtime/facial-native-johnny-20260930` directory and ran the same CPU inspector.
His isolated left/right corner stretch produces about 1.73/1.99 mm maximum
local lip translation at 0.20, versus 0.97/1.13 mm for inner stretch. His lower
roll produces about 1.06 mm and 18.3 degrees at the same isolated weight.
This qualifies the target distinction on two real character rigs, rather than
assuming Judy's geometry applies to every character.

At the same isolated weight of **0.20**, with the native reference pose as
baseline:

| Native control | Maximum local lip-bone translation | Left mouth-corner translation |
| --- | ---: | ---: |
| `lips_l_stretch` | 1.01 mm | 0.10 mm |
| `lips_l_corner_stretch` | 2.13 mm | 2.13 mm |
| `lips_suck_dn` | 1.25 mm | 0.21 mm |
| `lips_apart_up` | 0.56 mm | 0.00 mm |
| `lips_apart_dn` | 0.58 mm | 0.00 mm |

These are **local skeletal deltas**, not screen-space mouth aperture or a
rendered mesh measurement. Skinning, inherited transforms, native idle poses,
LOD and other animations still affect the visible result. The corner comparison
demonstrates a target-pose mismatch; it does not prove the finished performance.

[Apple's MouthRollLower definition](https://developer.apple.com/documentation/arkit/arfaceanchor/blendshapelocation/mouthrolllower)
describes inward lower-lip movement. Judy's native `lips_suck_dn` retracts the
lower lip; at the isolated 0.20 probe it also produces about 19.8 degrees of
maximum local lip-bone rotation. This motion is available in our existing
native graph and Lua whitelist, but the provider route previously discarded it.

## The controlled v4 comparison

`arkit61-native-v4` changes only these source-specific mappings:

| Source | Previous native mapping | v4 native mapping |
| --- | --- | --- |
| Left MouthStretch | 0.20 × source to inner stretch | 0.12 × source to inner stretch; 0.08 × source to corner stretch |
| Right MouthStretch | 0.20 × source to inner stretch | 0.12 × source to inner stretch; 0.08 × source to corner stretch |
| MouthRollLower | Discarded | 0.20 × source to `lips_suck_dn` |

The stretch coefficient budget stays 0.20 per side. Inputs remain independently
clamped to their valid range. There is no generated idle offset, random movement,
per-utterance normalization, new phoneme inference, or audio processing. The
current jaw, upper/lower aperture, closure, funnel and purse mappings remain
unchanged for this comparison. Individual upper-lip raisers stay zero after
the previous Judy distortion report. Local Omni/Rhubarb articulation is unchanged.

The source remains the indexed provider timeline. Growing prefixes use the same
poses at the same audio timestamps; the final confirmed boundary still clears
the mouth. The existing 21-control graph interface is sufficient, so this
retarget does not require a new facial archive or redscript class.

A retained 445-frame Judy reply demonstrates that the omitted signal exists:
lower roll is above 0.01 in 443 frames, with a median 0.074 and peak 0.185. Its
new lower-roll weight therefore has a median about 0.015 and peak about 0.037,
well below the isolated 0.20 probe. Source left/right stretch peak at about
0.661, so the new corner component peaks about 0.053 per side.

An offline replay of 443 interior poses through the reconstructed native solver
found no non-finite transforms. Maximum local lip translation peaks at about
6.34 mm before and after; the change alters the shape distribution rather than
increasing every deformation. This is bounded geometry evidence, not a live
quality result. The replay was compared against the same native reference
baseline, whose actual in-game idle counterpart remains unmeasured.

The independent bounded stretch comparison used source 0.50: old inner weight
0.10 versus new inner 0.06 plus corner 0.04. Maximum local lip translation
changes from 0.454 to 0.592 mm on Judy and 0.515 to 0.677 mm on Johnny; maximum
local rotation decreases slightly on both. Source lower-roll 0.20 adds native
weight 0.04, giving about 0.250 mm / 3.74 degrees on Judy and 0.212 mm /
3.48 degrees on Johnny. A source at its full upper bound still gives a much
stronger roll; these local transforms remain a rendered validation question.

## Closure semantics need a separate contact calibration

[Apple defines MouthClose independently of jaw position](https://developer.apple.com/documentation/arkit/arfaceanchor/blendshapelocation/mouthclose).
Our current jaw mapping still multiplies opening by `1 - MouthClose`.
On Judy, isolated `lips_together` controls produce no lip translation or
rotation at a closed neutral jaw; their useful closing motion appears through
combined jaw-open correctives. Consequently, removing jaw motion for a fully
closed-lip source can remove the contact mechanism that should close lips over
an open jaw.

This deserves a combined-pose calibration, not another gain increase. It is
deferred from v4 so the corner/roll comparison has a clear scope. In the
retained source, MouthClose's median is zero and p95 about 0.075. Its current
jaw suppression peaks about 0.022 and has p95 about 0.0035, so it is not the main
cause of weak opening in that captured reply.

Native influences also matter: `jaw_mid_close` can suppress jaw opening;
lip-together controls influence aperture; suck/corner/purse controls can influence
funnel. The additive graph preserves the native animated face. Reference-track
probes establish how poses work but do not prove that no competing native
control is active in a live actor. A live baseline is still needed if v4 remains
weak despite smoother sampling.

## Reproducing the CPU inspection

`scripts/Inspect-NativeFacialRig.py` accepts matching extracted rig/setup JSON,
a separate upstream source directory, selected controls, explicit baseline
assumptions and an optional current/candidate replay. It requires NumPy. It
does not generate speech, use the GPU, install resources or call a provider.
The upstream checkout remains a separate dependency under its own applicable
terms; this script does not grant redistribution rights to that source or to
game assets. No root license file was identified in the pinned checkout, so it
is not included in the mod package on an assumed license.

```powershell
python scripts/Inspect-NativeFacialRig.py `
  --rig runtime/facial-native-audit-20260930/json/h0_001_wa_c__judy_skeleton.rig.json `
  --setup runtime/facial-native-audit-20260930/json/h0_001_wa_c__judy_rigsetup.facialsetup.json `
  --output runtime/facial-native-audit-20260930/native-rig-report.json
```

For a competing native baseline, repeat with a documented assumption such as
`--baseline-track jaw_mid_close=0.5`. That is a hypothesis test, not a claim
about the live NPC. Reports include resource/dependency hashes, pose weights,
influence relationships, inbetween thresholds and local bone motion.

The provider tests failed on missing corner/roll output before v4 and now pass.
They cover actual SDK ordering, independent source shapes, unchanged provider
arrays/PCM, bounds, neutral source, upper-lip safety, growing prefixes, confirmed
EOF and unchanged unrelated controls. Live acceptance must still check smooth
corner/lower-lip articulation, natural opening, consonant contact and reset.

The combined targeted verification passed **122 checks**, including the real
JavaScript publisher/builder through Lua to the native-feature adapter. That
cross-boundary test verifies the actual corner and lower-roll fields, the
zeroed upper raisers, ownership and final reset. CPU inspection also completed
25 controls and 443 replayed Judy poses; neither test set is a visual claim.

## Opening calibration after the live v4 rejection

The user still described the mouth as barely opening with v4. The completed
3.6-second capture contains 217 mapped frames. Its active native jaw has a
median **0.0381**, p95 **0.1525**, and peak **0.1898**. Upper aperture has median
0.0229 and peak 0.0592; lower aperture has median 0.0321 and peak 0.16.

This is a separate limitation from the corrected corner/roll basis. The native
solver inspection gives an explanation for the weak opening: at jaw weight
0.0381, both Judy and Johnny rotate the jaw locally by only about **0.71 degrees**.
Judy's largest lip-bone local translation from that isolated jaw pose is about
0.56 mm. Typical upper/lower aperture together add at most about **0.09 mm** of
local lip translation when isolated. Raising those aperture tracks alone would
not address most of the missing jaw motion and could reintroduce lip distortion.

The earlier accepted native jaw-probe range of approximately 0.348 produces
about **6.52 degrees** of jaw-local rotation, with maximum isolated local lip
translation of 5.13 mm on Judy and 5.07 mm on Johnny. It is a reference excursion,
not proof that every sustained pose up to that weight looks natural during speech.

### Fixed curve comparison

The source jaw was approximately recovered from the existing k3 native mapping:

```text
old native jaw = 0.40 * (3 * j / (1 + 2 * j)) * closureSeal * boundaryFade
candidate jaw  = 0.40 * (k * j / (1 + (k - 1) * j)) * closureSeal * boundaryFade
```

Here `j` is the original provider jaw coefficient. Existing closure weights and
the exact first/final 40 ms boundary fade were retained. The mapped capture is
rounded to four decimals; reconstruction therefore approximates the original
source. The k3 round trip reproduces the stored weights to floating-point error,
and propagating the rounding intervals yields a worst candidate uncertainty
width of about **0.00033**. Unrecoverable neutral endpoints remain zero. No
per-reply peak normalization or minimum mouth opening was introduced.

| Curve | Captured active jaw median | Captured p95 | Captured peak | Native jaw rotation, median → peak |
| --- | ---: | ---: | ---: | ---: |
| k3, live v4 | 0.0381 | 0.1525 | 0.1898 | 0.71° → 3.56° |
| k6 candidate | 0.0696 | 0.2208 | 0.2574 | 1.30° → 4.82° |
| k10 candidate | 0.1039 | 0.2690 | 0.3002 | 1.95° → 5.63° |
| Earlier accepted isolated probe | — | — | approximately 0.348 | approximately 6.52° |

Both actual character setups produce essentially the same jaw rotation for
these candidates. k10 changes the typical captured jaw opening by about 2.73×,
while its peak physical excursion remains below the accepted isolated probe.
All replayed transforms were finite. Other lip motions still differ between
the two character rigs, as expected.

### Prepared v5 change

`arkit61-native-v5` selects the fixed **k10** jaw shoulder. Its maximum stays
0.40, zero source stays zero, full current closure still suppresses opening,
and existing boundary easing remains unchanged. The current aperture, closure,
funnel, purse, v4 corner/roll mappings, reserved upper-lip raisers and local
Omni/Rhubarb path are unchanged. Matching source coefficients map to the same
pose at the same timestamps regardless of reply range or growing-prefix length.

This comparison changes only the provider jaw transfer function. It does not
resolve the independently observed low live feature-application cadence, change
audio timing, or claim rendered improvement. The next live assessment needs
both reliable sampling and a check for opening, consonant contact, smooth motion,
absence of distortion, and final reset. The independent MouthClose semantics
issue above remains deferred for a combined contact calibration.

Redacted numerical evidence and reproducible CPU scripts are retained under the
ignored `runtime/facial-opening-candidates-20260930` directory:

- `reconstruct.mjs` and `reconstructed-poses.json`: numerical source inversion,
  k3/k6/k10 weights, rounding uncertainty and exact original audio timestamps.
- `native-opening.py` and `native-opening-report.json`: actual Judy/Johnny solver
  trajectories, the isolated probe comparison and separate aperture contributions.

The reports contain numerical controls and resource hashes; dialogue and
actor, request, user and session identifiers are excluded. Native reference
tracks remain the assumed baseline, not a measurement of the actor's live idle.

The updated targeted tests failed on the old curve and now cover fixed monotonic
bounds, zero/rest, current closure behavior, immutable source arrays/PCM, original
ARKit-61 corner/roll ordering, matched growing-prefix timestamps and unchanged
unrelated articulation. Visual qualification is still pending.
