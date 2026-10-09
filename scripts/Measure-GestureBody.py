"""How a gesture clip moves the rest of the body, not the hands (docs/COMPANION_GESTURES.md).

Companion of Measure-GestureShape.py (same WolvenKit glTF exports, forward
kinematics at 15 frames/s, world Y up, the character facing -Z). The shape
script measures hands, chest yaw and head yaw; this one measures what a viewer
reads as the whole body twitching when a clip starts, runs or ends:

  * how far the first / last pose of a clip is from the FIRST pose of the
    stance loop clip of the same animset (the workspot blends the clip in and
    out over about 0.7-1 s, so any gap pops);
  * how violently the spine, neck and head move inside the clip.

Bones: Hips, Spine, Spine1, Spine2, Spine3, Neck, Head (Neck1 is not measured).
Local rotations are compared as the angle between two parent-relative
quaternions. Positions are expressed in the HIPS frame (R_hips^T (p - p_hips)),
so where the character stands and how the hips are turned does not matter for
them; the hips turn itself is in hipsDeg.

Fields (S = first frame vs loop frame 0, E = last frame vs loop frame 0):
  hipsDegS/E   deg  rotation angle between the two hips world orientations
                    (all of yaw, pitch and roll together)
  spineDegS/E  deg  largest local-rotation difference of Spine..Spine3
  headDegS/E   deg  largest local-rotation difference of Neck and Head
  headCmS/E    cm   Head position difference in the hips frame
  chestCmS/E   cm   Spine3 position difference in the hips frame
  hipsCmS/E    cm   hips HEIGHT (world Y) difference
  hipsXzCmS/E  cm   hips horizontal (world X,Z) difference (root offset pop)
  bodyJerk     deg/s  peak angular speed of Spine..Spine3, Neck, Head local rotations
  bodyPath     cm/s   path length of Spine3 plus Head in the hips frame / duration
  spineJerk    deg/s  the same peak for Spine..Spine3 only (no Neck/Head nods)
  bodySway     cm     largest 3D excursion of the Hips bone from the clip's own
                      first frame, in the export's world frame (every export
                      faces -Z, so this is the loop's heading frame)

The loop clip of each animset is the clip named like the family idle. An
animset without one (Judy's three gestures) borrows the loop of the same-rig
sibling, see LOOP_FROM. The loop clip itself gets a `__loopDrift` entry: the
same fields, {"t0": ..., "t2": ..., ...}, for its pose after 0, 2, 4, 6, 8 and
10 s against its own frame 0 (time wraps at the clip length; the E fields repeat
the S values), because the controller jumps into clips at an arbitrary loop phase.

Writes assets/gestures/clip-body.json.
Usage: python -I scripts/Measure-GestureBody.py <glb dir> [<glb dir> ...] [--out file]
"""
import glob
import importlib.util
import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('gesture_shape', os.path.join(HERE, 'Measure-GestureShape.py'))
shape = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shape)
load, accessor, qmat = shape.load, shape.accessor, shape.qmat

FPS = 15
SPINE = ('Spine', 'Spine1', 'Spine2', 'Spine3')
HEAD = ('Neck', 'Head')
BONES = ('Hips',) + SPINE + HEAD
# Parent chain needed for forward kinematics (Neck1 sits between Neck and Head).
LOOP_NAMES = {
    'stand__2h_on_sides__01', 'stand__arms_crossed_front__01', 'stand__2h_on_hip__01',
    'kerry__stand__2h_on_hip__01', 'johnny__stand__lh_pocket__01',
    'johnny__stand__arms_crossed_front__01', 'takemura__stand__2h_on_sides__01',
}
# Animsets that hold no loop clip borrow the loop of this same-rig animset.
LOOP_FROM = {
    'judy__stand_2h_arms_crossed__01__gestures__01': 'generic_female_average__stand__arms_crossed_front__01',
}
DRIFT_TIMES = (0, 2, 4, 6, 8, 10)
GAP_FIELDS = ('hipsDeg', 'spineDeg', 'headDeg', 'headCm', 'chestCm', 'hipsCm', 'hipsXzCm')
FIELDS = [f + s for s in ('S', 'E') for f in GAP_FIELDS] + ['bodyJerk', 'bodyPath', 'bodySway', 'spineJerk']


def angle(qa, qb):
    d = abs(float(np.dot(qa, qb)))
    return math.degrees(2 * math.acos(min(1.0, d)))


def resample(times, values, grid):
    """Linear (quaternions: shortest-arc nlerp) sampling of one track at every time of grid."""
    idx = np.clip(np.searchsorted(times, grid, side='right') - 1, 0, len(times) - 1)
    nxt = np.minimum(idx + 1, len(times) - 1)
    span = np.maximum(times[nxt] - times[idx], 1e-9)
    a = np.where(nxt == idx, 0.0, (grid - times[idx]) / span)[:, None]
    v0, v1 = values[idx].astype(float), values[nxt].astype(float)
    if values.shape[1] == 4:
        v1 = np.where((v0 * v1).sum(axis=1, keepdims=True) < 0, -v1, v1)
    out = v0 * (1 - a) + v1 * a
    if values.shape[1] == 4:
        out = out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-12)
    return out


class Skeleton:
    def __init__(self, gltf):
        self.nodes = gltf['nodes']
        names = [n.get('name') for n in self.nodes]
        self.parent = {}
        for i, node in enumerate(self.nodes):
            for c in node.get('children', []):
                self.parent[c] = i
        missing = [b for b in BONES if b not in names]
        if missing:
            raise ValueError('skeleton lacks ' + ','.join(missing))
        self.index = {b: names.index(b) for b in BONES}
        needed = set()
        for b in BONES:
            i = self.index[b]
            while i is not None:
                needed.add(i)
                i = self.parent.get(i)

        def depth(i):
            d = 0
            while self.parent.get(i) is not None:
                d, i = d + 1, self.parent[i]
            return d
        self.order = sorted(needed, key=depth)


def clip_frames(skel, gltf, binary, anim):
    """Per frame: world pos (cm) and world rotation of Hips/Spine3/Head, local quaternions of BONES."""
    tracks, end = {}, 0.0
    for ch in anim['channels']:
        s = anim['samplers'][ch['sampler']]
        times = accessor(gltf, binary, s['input'])
        end = max(end, float(times[-1]))
        tracks[(ch['target']['node'], ch['target']['path'])] = (times, accessor(gltf, binary, s['output']))
    grid = np.linspace(0, end, max(2, int(end * FPS) + 1))
    n = len(grid)
    tr, ro = {}, {}
    absent = set()
    for i in skel.order:
        node = skel.nodes[i]
        t = tracks.get((i, 'translation'))
        r = tracks.get((i, 'rotation'))
        tr[i] = resample(*t, grid) if t else np.tile(np.array(node.get('translation', [0, 0, 0]), dtype=float), (n, 1))
        ro[i] = resample(*r, grid) if r else np.tile(np.array(node.get('rotation', [0, 0, 0, 1]), dtype=float), (n, 1))
        if r is None and i in skel.index.values():
            absent.add(i)
    local = {b: ro[skel.index[b]] for b in BONES}
    hips_pos = np.zeros((n, 3))
    chest_h = np.zeros((n, 3))
    head_h = np.zeros((n, 3))
    hips_rot = np.zeros((n, 3, 3))
    for f in range(n):
        pos, rot = {}, {}
        for i in skel.order:
            T, R = tr[i][f], qmat(ro[i][f])
            p = skel.parent.get(i)
            if p is None or p not in pos:
                pos[i], rot[i] = T.copy(), R
            else:
                pos[i] = pos[p] + rot[p] @ T
                rot[i] = rot[p] @ R
        hi = skel.index['Hips']
        hp, hr = pos[hi] * 100, rot[hi]
        hips_pos[f], hips_rot[f] = hp, hr
        chest_h[f] = hr.T @ (pos[skel.index['Spine3']] * 100 - hp)
        head_h[f] = hr.T @ (pos[skel.index['Head']] * 100 - hp)
    return {'n': n, 'end': end, 'local': local, 'hipsPos': hips_pos, 'hipsRot': hips_rot,
            'chest': chest_h, 'head': head_h, 'absent': absent}


def gap(a, fa, b, fb):
    """Pose distance between frame fa of clip a and frame fb of clip b (a, b: clip_frames results)."""
    ra, rb = a['hipsRot'][fa], b['hipsRot'][fb]
    hips_deg = math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(ra.T @ rb) - 1) / 2))))
    spine = max(angle(a['local'][s][fa], b['local'][s][fb]) for s in SPINE)
    head = max(angle(a['local'][s][fa], b['local'][s][fb]) for s in HEAD)
    dh = a['hipsPos'][fa] - b['hipsPos'][fb]
    return {
        'hipsDeg': hips_deg, 'spineDeg': spine, 'headDeg': head,
        'headCm': float(np.linalg.norm(a['head'][fa] - b['head'][fb])),
        'chestCm': float(np.linalg.norm(a['chest'][fa] - b['chest'][fb])),
        'hipsCm': abs(float(dh[1])), 'hipsXzCm': float(math.hypot(dh[0], dh[2])),
    }


def motion(frames):
    n, end = frames['n'], frames['end']
    dt = max(end / (n - 1), 1e-6)
    peak = spine_peak = 0.0
    for b in SPINE + HEAD:
        q = frames['local'][b]
        for f in range(1, n):
            speed = angle(q[f - 1], q[f]) / dt
            peak = max(peak, speed)
            if b in SPINE:
                spine_peak = max(spine_peak, speed)
    path = 0.0
    for key in ('chest', 'head'):
        path += float(np.linalg.norm(np.diff(frames[key], axis=0), axis=1).sum())
    sway = float(np.linalg.norm(frames['hipsPos'] - frames['hipsPos'][0], axis=1).max())
    return peak, path / max(end, 1e-6), sway, spine_peak


def find_loop(clip_names):
    for name in clip_names:
        if name in LOOP_NAMES:
            return name
    return None


def analyse(path, borrowed_loop=None):
    """borrowed_loop: (frames, label) for an animset that holds no loop clip of its own."""
    gltf, binary = load(path)
    skel = Skeleton(gltf)
    anims = {a['name']: a for a in gltf['animations']}
    loop_name = find_loop(anims)
    notes = []
    if loop_name:
        loop = clip_frames(skel, gltf, binary, anims[loop_name])
    elif borrowed_loop:
        loop, label = borrowed_loop
        loop_name = None
        notes.append('no own loop, using ' + label)
    else:
        raise ValueError('no loop clip and no sibling to borrow one from')
    result, skipped, absent_clips = {}, [], []
    for name, anim in sorted(anims.items()):
        try:
            fr = loop if name == loop_name else clip_frames(skel, gltf, binary, anim)
            if fr['absent']:
                absent_clips.append(name)
            s = gap(fr, 0, loop, 0)
            e = gap(fr, fr['n'] - 1, loop, 0)
            jerk, pathv, sway, spine_jerk = motion(fr)
        except Exception as error:  # a clip that lacks a bone or a track
            skipped.append((name, str(error)))
            continue
        row = {f + 'S': s[f] for f in GAP_FIELDS}
        row.update({f + 'E': e[f] for f in GAP_FIELDS})
        row.update({'bodyJerk': jerk, 'bodyPath': pathv, 'bodySway': sway, 'spineJerk': spine_jerk})
        result[name] = [round(row[f], 1) for f in FIELDS]
    drift = None
    if loop_name:
        drift = {}
        n, end = loop['n'], loop['end']
        for t in DRIFT_TIMES:
            frame = int(round((t % max(end, 1e-6)) * FPS))
            frame = min(frame, n - 1)
            g = gap(loop, frame, loop, 0)
            row = {f + s: g[f] for f in GAP_FIELDS for s in ('S', 'E')}
            drift['t%d' % t] = [round(row.get(f, 0.0), 1) for f in FIELDS]
        # the last four (motion) fields have no meaning for a drift entry
        for v in drift.values():
            v[-4:] = [0.0, 0.0, 0.0, 0.0]
    return result, drift, (loop, loop_name), skipped, absent_clips, notes


def main(argv):
    out = os.path.join(HERE, '..', 'assets', 'gestures', 'clip-body.json')
    dirs, i = [], 0
    while i < len(argv):
        if argv[i] == '--out':
            out, i = argv[i + 1], i + 2
        else:
            dirs.append(argv[i])
            i += 1
    started = time.time()
    paths = {}
    for folder in dirs:
        for path in sorted(glob.glob(os.path.join(folder, '*.glb'))):
            key = os.path.basename(path).replace('.anims.glb', '')
            paths.setdefault(key, path)
    # Animsets with their own loop first, borrowers after.
    order = sorted(paths, key=lambda k: k in LOOP_FROM)
    loops, result = {}, {}
    for key in order:
        borrowed = None
        if key in LOOP_FROM:
            src = LOOP_FROM[key]
            if src not in loops:
                print('skip', key, 'sibling loop', src, 'was not measured', file=sys.stderr)
                continue
            borrowed = (loops[src][0], src + ':' + loops[src][1])
        try:
            rows, drift, loop, skipped, absent, notes = analyse(paths[key], borrowed)
        except Exception as error:
            print('skip', key, error, file=sys.stderr)
            continue
        if loop[1]:
            loops[key] = loop
        if drift:
            rows['__loopDrift'] = drift
        result[key] = rows
        print(key, len([r for r in rows if r != '__loopDrift']), 'clips', *notes, file=sys.stderr)
        for name, why in skipped:
            print('  skipped clip', name, why, file=sys.stderr)
        if absent:
            print('  %d clips lack a rotation track on a body bone (bind pose used): %s' % (len(absent), ', '.join(absent[:5])), file=sys.stderr)
    with open(out, 'w', encoding='utf-8') as handle:
        json.dump({'version': 1, 'units': 'degrees, cm, deg/s, cm/s', 'fields': FIELDS, 'animsets': result},
                  handle, indent=0, sort_keys=True, separators=(',', ':'))
    print('done in %.1f s' % (time.time() - started), file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1:])
