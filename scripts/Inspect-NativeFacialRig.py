"""Inspect native Cyberpunk facial controls with a separately supplied solver.

CPU only: no Blender, game control, provider calls, or game installation.
Requires NumPy and the WolvenKit Cyberpunk Blender add-on source checkout.
Its parser/solver are imported in place; no upstream implementation is copied.
Extracted game resources and reports should remain outside source control.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import math
import sys
import types
from pathlib import Path

import numpy as np


PROJECT = Path(__file__).resolve().parent.parent
DEFAULT_CONTROLS = (
    'jaw_mid_open', 'lips_apart_up', 'lips_apart_dn', 'lips_together_up', 'lips_together_dn',
    'lips_l_funnel', 'lips_r_funnel', 'lips_l_purse', 'lips_r_purse', 'lips_l_stretch',
    'lips_r_stretch', 'lips_l_corner_stretch', 'lips_r_corner_stretch', 'lips_l_lower_raise',
    'lips_r_lower_raise', 'lips_tighten_up', 'lips_tighten_dn', 'lips_suck_up', 'lips_suck_dn',
    'lips_l_corner_up', 'lips_r_corner_up', 'lips_l_corner_dn', 'lips_r_corner_dn',
    'tongue_mid_fwd', 'jaw_mid_shift_fwd',
)
DEFAULT_LANDMARKS = (
    'l_J_mug_lip_up_0_JNT', 'r_J_mug_lip_up_0_JNT', 'l_J_mug_lip_dn_0_JNT',
    'r_J_mug_lip_dn_0_JNT', 'l_J_mug_lip_corner_0_JNT', 'r_J_mug_lip_corner_0_JNT',
    'mid_J_jaw_JNT',
)


def finite_weight(value: float) -> float:
    value = float(value)
    if not math.isfinite(value) or not 0 <= value <= .5:
        raise ValueError('Probe weights must be finite and between zero and 0.5')
    return value


def read_json(path: Path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def import_solver(reference: Path):
    # Create only package containers. Importing the add-on's top-level module
    # would start its Blender UI registration and require bpy unnecessarily.
    alias = 'convai_native_probe'
    for suffix in ('', '.animation', '.animation.facial', '.bartmoss'):
        package = types.ModuleType(alias + suffix)
        package.__path__ = [str(reference.joinpath(*suffix.strip('.').split('.'))) if suffix else str(reference)]
        sys.modules[alias + suffix] = package
    return tuple(importlib.import_module(alias + suffix) for suffix in (
        '.animation.facial.loader', '.animation.facial.model',
        '.animation.facial.runtime', '.animation.facial.solver',
    ))


def inspect(args) -> dict:
    loader, model, compiler, solver = import_solver(args.reference)
    setup = loader.parse_facial_setup(read_json(args.setup))
    rig_root = read_json(args.rig)['Data']['RootChunk']
    names = [x['$value'] if isinstance(x, dict) else str(x) for x in rig_root['trackNames']]
    bones = [x['$value'] if isinstance(x, dict) else str(x) for x in rig_root['boneNames']]
    indices = {name: index for index, name in enumerate(names)}
    rig = types.SimpleNamespace(num_tracks=len(names), num_bones=len(bones))
    segments = model.TrackSegments.from_setup(setup, len(names))
    runtime = compiler.compile_runtime(setup, rig, segments)
    base = np.array(rig_root['referenceTracks'], dtype=np.float32)
    if base.shape != (len(names),) or not np.all(np.isfinite(base)):
        raise ValueError('Invalid native referenceTracks')
    baseline_changes = {}
    for entry in args.baseline_track:
        name, value = entry.split('=', 1)
        if name not in indices:
            raise ValueError(f'Unknown baseline track: {name}')
        amount = float(value)
        if not math.isfinite(amount) or not 0 <= amount <= 2:
            raise ValueError('Baseline tracks must be finite and between zero and two')
        baseline_changes[name] = amount
        base[indices[name]] = amount
    lip_indices = [index for index, name in enumerate(bones) if 'lip' in name.lower() or 'mouth' in name.lower()]
    if not lip_indices:
        raise ValueError('No named mouth or lip landmarks in supplied rig')
    landmarks = [name for name in args.landmark or DEFAULT_LANDMARKS if name in bones]
    controls = args.control or [name for name in DEFAULT_CONTROLS if name + 'LipsyncPoseOutput' in indices]
    if not controls or any(name not in indices or name + 'LipsyncPoseOutput' not in indices for name in controls):
        raise ValueError('Controls must have both native and LipsyncPoseOutput tracks')

    def solve(weights):
        tracks = base.copy()
        for name, amount in weights.items():
            if name not in indices or name + 'LipsyncPoseOutput' not in indices:
                raise ValueError(f'Unknown facial control: {name}')
            tracks[indices[name + 'LipsyncPoseOutput']] += finite_weight(amount)
        quaternion, translation, output = solver.solve_runtime(runtime, tracks, lod=args.lod)
        if not all(np.all(np.isfinite(value)) for value in (quaternion, translation, output)):
            raise ValueError('Native solver produced non-finite transforms')
        return quaternion.copy(), translation.copy(), output.copy()

    neutral_q, neutral_t, _ = solve({})

    def pose(weights):
        quaternion, translation, output = solve(weights)
        delta = translation - neutral_t
        order = sorted(lip_indices, key=lambda index: float(np.linalg.norm(delta[index])), reverse=True)
        rotation = max(2 * np.arccos(np.clip(abs(np.dot(quaternion[index], neutral_q[index])), 0, 1)) for index in lip_indices)
        return {
            'controls': weights,
            'effectiveMainWeights': {name: float(output[indices[name]]) for name in weights},
            'maxLipLocalDeltaMm': float(max(np.linalg.norm(delta[index]) for index in lip_indices) * 1000),
            'maxLipLocalRotationDegrees': float(rotation * 180 / np.pi),
            'landmarkLocalDeltasMm': {name: (delta[bones.index(name)] * 1000).tolist() for name in landmarks},
            'largestChangedLipBones': [{'name': bones[index], 'deltaMm': (delta[index] * 1000).tolist()} for index in order[:4]],
        }

    influences, inbetweens = {}, {}
    for name in controls:
        index, influence_rows, threshold_rows = indices[name], [], []
        for part in runtime.parts:
            for row in np.flatnonzero(part.infl_tracks == index):
                start, end = part.infl_row_ptr[row:row + 2]
                influence_rows.append({'part': part.part_name, 'type': int(part.infl_types[row]),
                                       'influencers': [names[int(value)] for value in part.infl_indices[start:end]]})
            for row in np.flatnonzero(part.main_tracks == index):
                start, end = part.ib_row_ptr[row:row + 2]
                threshold_rows.append({'part': part.part_name, 'thresholds': part.ib_thresholds[start:end].tolist()})
        influences[name], inbetweens[name] = influence_rows, threshold_rows

    combinations = [
        {'jaw_mid_open': .2, 'lips_apart_up': .07, 'lips_apart_dn': .11},
        {'jaw_mid_open': .2, 'lips_apart_up': .07, 'lips_apart_dn': .11, 'lips_l_stretch': .11, 'lips_r_stretch': .11},
        {'jaw_mid_open': .2, 'lips_apart_up': .07, 'lips_apart_dn': .11, 'lips_l_funnel': .1, 'lips_r_funnel': .1,
         'lips_l_purse': .1, 'lips_r_purse': .1},
        {'jaw_mid_open': .08, 'lips_apart_up': .03, 'lips_apart_dn': .04, 'lips_l_lower_raise': .03,
         'lips_r_lower_raise': .03, 'lips_suck_dn': .03},
        {'jaw_mid_open': .2, 'lips_together_up': .2, 'lips_together_dn': .2},
    ]
    combinations = [weights for weights in combinations if all(name + 'LipsyncPoseOutput' in indices for name in weights)]
    dependency_files = ('animation/facial/loader.py', 'animation/facial/runtime.py', 'animation/facial/solver.py')
    report = {
        'method': 'reconstructed-native-NumPy-solver; local rig deltas only; no skinning or live-game proof',
        'referenceSource': 'https://github.com/WolvenKit/Cyberpunk-Blender-add-on',
        'dependencyHashes': {path: hashlib.sha256((args.reference / path).read_bytes()).hexdigest() for path in dependency_files},
        'resourceHashes': {'rig': hashlib.sha256(args.rig.read_bytes()).hexdigest(),
                           'setup': hashlib.sha256(args.setup.read_bytes()).hexdigest()},
        'rigBones': len(bones), 'rigTracks': len(names), 'setupVersion': setup.version, 'lod': args.lod,
        'baseline': 'native referenceTracks, with only explicitly supplied baseline overrides; actual live idle unknown',
        'baselineOverrides': baseline_changes,
        'baseEnvelopeValues': {name: float(base[index]) for index, name in enumerate(names[:13])},
        'influences': influences, 'inbetweenThresholds': inbetweens,
        'isolatedControls': [pose({name: args.weight}) for name in controls],
        'combinedControls': [pose(weights) for weights in combinations],
    }
    if args.replay:
        source = read_json(args.replay)
        rows = source.get('poses')
        if not isinstance(rows, list) or not 1 <= len(rows) <= 7202:
            raise ValueError('Replay must contain 1 to 7202 poses')
        previous, result = -1.0, []
        for row in rows:
            at = row['at']
            if not isinstance(at, (float, int)) or not math.isfinite(at) or not 0 <= at <= 120 or at <= previous:
                raise ValueError('Replay timestamps must be increasing audio seconds within two minutes')
            previous = at
            result.append({'at': at, 'current': pose(row['current']), 'candidate': pose(row['candidate'])})
        report['replay'] = result
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rig', required=True, type=Path, help='Extracted .rig.json')
    parser.add_argument('--setup', required=True, type=Path, help='Matching extracted .facialsetup.json')
    parser.add_argument('--reference', type=Path, default=PROJECT / 'vendor/reference-cp77-blender/i_scene_cp77_gltf',
                        help='Upstream i_scene_cp77_gltf source directory, used in place under its own license')
    parser.add_argument('--output', type=Path, default=PROJECT / 'runtime/native-facial-inspection.json')
    parser.add_argument('--weight', type=finite_weight, default=.2)
    parser.add_argument('--lod', type=int, choices=(0, 1, 2), default=0)
    parser.add_argument('--control', action='append', help='Native control name; repeat for a restricted inspection')
    parser.add_argument('--landmark', action='append', help='Rig bone name; repeat for custom landmarks')
    parser.add_argument('--baseline-track', action='append', default=[], metavar='NAME=VALUE',
                        help='Explicit native baseline assumption, e.g. jaw_mid_close=0.5')
    parser.add_argument('--replay', type=Path, help='Optional audio-time poses with current/candidate control maps')
    args = parser.parse_args()
    report = inspect(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'rigBones': report['rigBones'], 'rigTracks': report['rigTracks'],
                      'controls': len(report['isolatedControls']), 'replayedPoses': len(report.get('replay', [])),
                      'report': str(args.output.resolve())}))


if __name__ == '__main__':
    main()
