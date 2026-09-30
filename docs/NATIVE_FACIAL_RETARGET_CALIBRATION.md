# Native facial retarget calibration

September 30, 2026. This is a source and CPU rig inspection. The v4 change has
not yet been accepted visually in the game.

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
