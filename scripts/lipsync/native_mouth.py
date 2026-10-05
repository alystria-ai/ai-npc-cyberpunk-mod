"""Native mouth geometry from Cyberpunk facial-track weights (CPU, research only).

Uses the WolvenKit Blender add-on's reconstructed Sermo solver (vendor/, imported
in place) and an extracted rig/facialsetup pair under runtime/. Weights are
added to `<control>LipsyncPoseOutput`, exactly where the mod's ConvaiFace
feature and the game's own lipsync animations write. Returns bone-origin
landmarks in model space; skinned surfaces and teeth are not modelled.
"""
from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path

import numpy as np

PROJECT = Path(__file__).resolve().parents[2]
REFERENCE = PROJECT / 'vendor/reference-cp77-blender/i_scene_cp77_gltf'
RIGS = {
    'judy': ('facial-native-audit-20260930', 'h0_001_wa_c__judy'),
    'johnny': ('facial-native-johnny-20260930', 'h0_001_ma_c__silverhand'),
}


def _solver():
    alias = 'convai_native_mouth'
    for suffix in ('', '.animation', '.animation.facial', '.bartmoss'):
        package = types.ModuleType(alias + suffix)
        package.__path__ = [str(REFERENCE.joinpath(*suffix.strip('.').split('.'))) if suffix else str(REFERENCE)]
        sys.modules[alias + suffix] = package
    return tuple(importlib.import_module(alias + suffix) for suffix in (
        '.animation.facial.loader', '.animation.facial.model', '.animation.facial.runtime', '.animation.facial.solver'))


def _matrices(q, t, s=None):
    q = np.asarray(q, dtype=np.float64)
    q = q / np.linalg.norm(q, axis=-1, keepdims=True)
    x, y, z, w = q.T
    m = np.zeros((len(q), 4, 4))
    m[:, 0, 0] = 1 - 2 * (y * y + z * z); m[:, 0, 1] = 2 * (x * y - z * w); m[:, 0, 2] = 2 * (x * z + y * w)
    m[:, 1, 0] = 2 * (x * y + z * w); m[:, 1, 1] = 1 - 2 * (x * x + z * z); m[:, 1, 2] = 2 * (y * z - x * w)
    m[:, 2, 0] = 2 * (x * z - y * w); m[:, 2, 1] = 2 * (y * z + x * w); m[:, 2, 2] = 1 - 2 * (x * x + y * y)
    if s is not None:
        m[:, :3, :3] *= np.asarray(s)[:, None, :]
    m[:, :3, 3] = t
    m[:, 3, 3] = 1
    return m


LANDMARKS = {
    'upIn': ('l_J_mug_lip_up_inside_0_JNT', 'r_J_mug_lip_up_inside_0_JNT'),
    'dnIn': ('l_J_mug_lip_dn_inside_0_JNT', 'r_J_mug_lip_dn_inside_0_JNT'),
    'up': ('l_J_mug_lip_up_0_JNT', 'r_J_mug_lip_up_0_JNT'),
    'dn': ('l_J_mug_lip_dn_0_JNT', 'r_J_mug_lip_dn_0_JNT'),
    'cornerL': ('l_J_mug_lip_corner_0_JNT',),
    'cornerR': ('r_J_mug_lip_corner_0_JNT',),
    'chin': ('mid_J_mug_chin_rowA_0_JNT',),
}


class NativeMouth:
    def __init__(self, character='judy'):
        loader, model, compiler, self.solver = _solver()
        folder, prefix = RIGS[character]
        src = PROJECT / 'runtime' / folder / 'json'
        rig = json.loads((src / f'{prefix}_skeleton.rig.json').read_text(encoding='utf-8-sig'))['Data']['RootChunk']
        setup = loader.parse_facial_setup(json.loads((src / f'{prefix}_rigsetup.facialsetup.json').read_text(encoding='utf-8-sig')))
        self.names = [x['$value'] for x in rig['trackNames']]
        self.bones = [x['$value'] for x in rig['boneNames']]
        self.index = {n: i for i, n in enumerate(self.names)}
        self.parents = np.asarray(rig['boneParentIndexes'], dtype=int)
        self.runtime = compiler.compile_runtime(setup, types.SimpleNamespace(num_bones=len(self.bones), num_tracks=len(self.names)),
                                                model.TrackSegments.from_setup(setup, len(self.names)))
        self.base = np.array(rig['referenceTracks'], dtype=np.float32)
        q, t, s = [], [], []
        for r in rig['boneTransforms']:
            q.append([r['Rotation'][k] for k in 'ijkr'])
            t.append([r['Translation'][k] for k in 'XYZ'])
            s.append([r['Scale'][k] for k in 'XYZ'])
        self.rest = _matrices(q, t, s)
        wanted = sorted({self.bones.index(b) for group in LANDMARKS.values() for b in group})
        chain = set()
        for b in wanted:
            while b >= 0 and b not in chain:
                chain.add(b)
                b = int(self.parents[b])
        self.chain = sorted(chain, key=self._depth)
        self.groups = {k: [self.bones.index(b) for b in v] for k, v in LANDMARKS.items()}
        self.neutral = self.landmarks({})
        # Model-space axes from the neutral face: forward = jaw root -> lips.
        self.forward = None

    def _depth(self, b):
        d = 0
        while self.parents[b] >= 0:
            b = int(self.parents[b]); d += 1
        return d

    def landmarks(self, weights: dict) -> dict:
        tracks = self.base.copy()
        for name, value in weights.items():
            tracks[self.index[name + 'LipsyncPoseOutput']] += float(value)
        q, t, _ = self.solver.solve_runtime(self.runtime, tracks, lod=0)
        local = self.rest[self.chain] @ _matrices(q[self.chain], t[self.chain])
        world = {}
        for row, b in enumerate(self.chain):
            p = int(self.parents[b])
            world[b] = world[p] @ local[row] if p >= 0 else local[row]
        return {k: np.mean([world[b][:3, 3] for b in v], axis=0) for k, v in self.groups.items()}

    def features(self, weights: dict) -> np.ndarray:
        """[inner aperture, outer aperture, width, protrusion, chin drop] in millimetres, relative to neutral."""
        a, n = self.landmarks(weights), self.neutral
        inner = np.linalg.norm(a['upIn'] - a['dnIn']) - np.linalg.norm(n['upIn'] - n['dnIn'])
        outer = np.linalg.norm(a['up'] - a['dn']) - np.linalg.norm(n['up'] - n['dn'])
        width = np.linalg.norm(a['cornerL'] - a['cornerR']) - np.linalg.norm(n['cornerL'] - n['cornerR'])
        fwd = self.forward_axis()
        lips = (a['up'] + a['dn']) / 2 - (n['up'] + n['dn']) / 2
        chin = np.linalg.norm(a['chin'] - n['chin'])
        return np.array([inner, outer, width, float(lips @ fwd), chin]) * 1000

    def forward_axis(self):
        if self.forward is None:
            # Purse pushes the lips forward on every human rig; use it to fix the sign/axis.
            a = self.landmarks({'lips_l_purse': .4, 'lips_r_purse': .4})
            d = (a['up'] + a['dn']) / 2 - (self.neutral['up'] + self.neutral['dn']) / 2
            axis = np.zeros(3); k = int(np.argmax(np.abs(d))); axis[k] = np.sign(d[k])
            self.forward = axis
        return self.forward


FEATURES = ['innerAperture', 'outerAperture', 'width', 'protrusion', 'chinDrop']
