"""Where a gesture clip puts the hands, torso and head (docs/COMPANION_GESTURES.md).

Reads the same WolvenKit glTF exports as Measure-GestureMotion.py (in place,
world Y up, the character facing -Z, its right at +X), runs forward kinematics
at 15 frames/s and measures, relative to the clip's first frame:

  side    cm  furthest one raised hand gets outside its own shoulder while the
              other hand is not (indicating off to a side, "over there")
  cross   cm  furthest a raised hand reaches past the opposite shoulder
  point   s   longest stretch of a raised hand with the index finger out and
              the other fingers curled (pointing)
  stretch s   longest stretch of one raised, nearly straight arm while the
              other is not (reaching or indicating)
  back    cm  furthest a raised hand gets behind the chest (over-the-shoulder)
  high    cm  highest hand above the head (overhead sweeps)
  yaw     deg largest chest turn away from the start (turning the torso away)
  head    deg largest head turn (looking away)
  centre  0-1 share of the active frames (a hand moved > 8 cm) in which every
              moving hand stays in front of the body, between hips and chest,
              within 26 cm of the midline: the calm "hands centred" zone
  reach   cm  largest hand excursion (same as clip-motion.json)

Writes assets/gestures/clip-shape.json, read by Build-GestureAssets.mjs.
Usage: python -I scripts/Measure-GestureShape.py <glb dir> [<glb dir> ...] [--out file]
"""
import glob
import json
import math
import os
import struct
import sys

import numpy as np

FPS = 15
BONES = ('Hips', 'Spine3', 'Head', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand')
FINGERS = ('Index3', 'Middle3', 'Ring3', 'Pinky3')
ALL = BONES + tuple(side + 'Hand' + f for side in ('Left', 'Right') for f in FINGERS)


def load(path):
    data = open(path, 'rb').read()
    length = struct.unpack('<I', data[12:16])[0]
    gltf = json.loads(data[20:20 + length])
    offset = 20 + length
    size = struct.unpack('<I', data[offset:offset + 4])[0]
    return gltf, data[offset + 8: offset + 8 + size]


def accessor(gltf, binary, index):
    a = gltf['accessors'][index]
    view = gltf['bufferViews'][a['bufferView']]
    width = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[a['type']]
    start = view.get('byteOffset', 0) + a.get('byteOffset', 0)
    values = np.frombuffer(binary, dtype=np.float32, count=a['count'] * width, offset=start)
    return values.reshape(a['count'], width) if width > 1 else values


def qmat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def sample(times, values, t):
    i = int(np.searchsorted(times, t, side='right')) - 1
    i = max(0, min(i, len(times) - 1))
    if i >= len(times) - 1:
        v = values[-1]
    else:
        a = (t - times[i]) / max(1e-6, times[i + 1] - times[i])
        v = values[i] * (1 - a) + values[i + 1] * a
    if v.shape[0] == 4:
        v = v / np.linalg.norm(v)
    return v


def yaw(vector):
    # Heading in the horizontal plane; 0 = facing -Z (the clip's front).
    return math.degrees(math.atan2(vector[0], -vector[2]))


def turn(a, b):
    return abs((a - b + 180) % 360 - 180)


def analyse(path):
    gltf, binary = load(path)
    nodes = gltf['nodes']
    names = [node.get('name') for node in nodes]
    parent = {}
    for index, node in enumerate(nodes):
        for child in node.get('children', []):
            parent[child] = index
    if any(bone not in names for bone in ALL):
        raise ValueError('skeleton lacks a measured bone')
    needed = set()
    for bone in ALL:
        i = names.index(bone)
        while i is not None:
            needed.add(i)
            i = parent.get(i)
    # Topological order: parents before children.
    depth = {}
    for i in needed:
        d, j = 0, i
        while parent.get(j) is not None:
            d, j = d + 1, parent[j]
        depth[i] = d
    order = sorted(needed, key=lambda i: depth[i])
    index = {bone: names.index(bone) for bone in ALL}
    results = {}
    for anim in gltf['animations']:
        tracks, end = {}, 0.0
        for channel in anim['channels']:
            s = anim['samplers'][channel['sampler']]
            times = accessor(gltf, binary, s['input'])
            end = max(end, float(times[-1]))
            tracks[(channel['target']['node'], channel['target']['path'])] = (times, accessor(gltf, binary, s['output']))
        frames = []
        for t in np.linspace(0, end, max(2, int(end * FPS) + 1)):
            pos, rot = {}, {}
            for i in order:
                node = nodes[i]
                tr = tracks.get((i, 'translation'))
                ro = tracks.get((i, 'rotation'))
                T = sample(*tr, t) if tr else np.array(node.get('translation', [0, 0, 0]), dtype=float)
                R = sample(*ro, t) if ro else np.array(node.get('rotation', [0, 0, 0, 1]), dtype=float)
                p = parent.get(i)
                if p is None or p not in pos:
                    pos[i], rot[i] = T.astype(float), qmat(R)
                else:
                    pos[i] = pos[p] + rot[p] @ T
                    rot[i] = rot[p] @ qmat(R)
            frames.append({bone: (pos[index[bone]] * 100, rot[index[bone]]) for bone in ALL})
        first = frames[0]
        # Chest and head facing: the bone axis that points most forward at the start.
        def facing_axis(bone):
            m = first[bone][1]
            scores = [(-m[2, k], k, 1) for k in range(3)] + [(m[2, k], k, -1) for k in range(3)]
            _, k, sign = max(scores)
            return k, sign
        chest_axis, head_axis = facing_axis('Spine3'), facing_axis('Head')
        def heading(frame, bone, axis):
            v = frame[bone][1][:, axis[0]] * axis[1]
            return yaw(v)
        chest0, head0 = heading(first, 'Spine3', chest_axis), heading(first, 'Head', head_axis)
        hips_y = first['Hips'][0][1]
        chest = first['Spine3'][0]
        head_y = first['Head'][0][1]
        arm = {}
        for side in ('Left', 'Right'):
            upper = np.linalg.norm(first[side + 'ForeArm'][0] - first[side + 'Arm'][0])
            lower = np.linalg.norm(first[side + 'Hand'][0] - first[side + 'ForeArm'][0])
            arm[side] = upper + lower
        side_out = cross = back = high = 0.0
        yaw_max = head_max = reach = 0.0
        point_run = point_best = stretch_run = stretch_best = 0
        active = centred = 0
        for frame in frames:
            yaw_max = max(yaw_max, turn(heading(frame, 'Spine3', chest_axis), chest0))
            head_max = max(head_max, turn(heading(frame, 'Head', head_axis), head0))
            pointing = False
            straight = {}
            moving_hands = []
            out = {}
            for side, outward in (('Left', -1), ('Right', 1)):
                hand = frame[side + 'Hand'][0]
                shoulder = frame[side + 'Arm'][0]
                other = frame[('Right' if side == 'Left' else 'Left') + 'Arm'][0]
                moved = float(np.linalg.norm(hand - first[side + 'Hand'][0]))
                reach = max(reach, moved)
                raised = hand[1] - hips_y
                # Outside its own shoulder (only while raised: a hanging arm is not a gesture).
                out[side] = float((hand[0] - shoulder[0]) * outward) if raised > 10 and moved > 10 else 0.0
                if raised > 10 and moved > 10:
                    back = max(back, float(hand[2] - chest[2]))  # +Z is behind the chest
                    # Across the body, past the opposite shoulder.
                    cross = max(cross, float((other[0] - hand[0]) * outward))
                high = max(high, float(hand[1] - head_y))
                stretch = np.linalg.norm(hand - shoulder) / max(arm[side], 1e-6)
                straight[side] = stretch > .86 and raised > 22 and moved > 15
                if raised > 15 and moved > 12:
                    tip = {f: float(np.linalg.norm(frame[side + 'Hand' + f][0] - hand)) for f in FINGERS}
                    curled = max(tip['Middle3'], tip['Ring3'], tip['Pinky3'])
                    if tip['Index3'] - curled > 2.5:
                        pointing = True
                if moved > 8:
                    moving_hands.append(hand)
            # One hand out to its side while the other is not: indicating a direction.
            side_out = max(side_out, out['Left'] - max(0.0, out['Right']), out['Right'] - max(0.0, out['Left']))
            point_run = point_run + 1 if pointing else 0
            point_best = max(point_best, point_run)
            stretch_run = stretch_run + 1 if straight['Left'] != straight['Right'] else 0
            stretch_best = max(stretch_best, stretch_run)
            if moving_hands:
                active += 1
                if all(abs(h[0] - chest[0]) < 26 and h[2] - chest[2] < 2 and hips_y - 8 < h[1] < chest[1] + 12
                       for h in moving_hands):
                    centred += 1
        results[anim['name']] = {
            'duration': round(end, 2),
            'reach': round(reach, 1),
            'side': round(side_out, 1),
            'cross': round(cross, 1),
            'point': round(point_best / FPS, 2),
            'stretch': round(stretch_best / FPS, 2),
            'back': round(back, 1),
            'high': round(high, 1),
            'yaw': round(yaw_max, 1),
            'head': round(head_max, 1),
            'centre': round(centred / active, 2) if active else 1.0,
        }
    return results


def main(argv):
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'gestures', 'clip-shape.json')
    dirs = []
    i = 0
    while i < len(argv):
        if argv[i] == '--out':
            out = argv[i + 1]
            i += 2
        else:
            dirs.append(argv[i])
            i += 1
    fields = ['reach', 'side', 'cross', 'point', 'stretch', 'back', 'high', 'yaw', 'head', 'centre']
    result = {}
    for folder in dirs:
        for path in sorted(glob.glob(os.path.join(folder, '*.glb'))):
            key = os.path.basename(path).replace('.anims.glb', '')
            if key in result:
                continue
            try:
                clips = analyse(path)
            except Exception as error:  # an export without the arm/hand bones
                print('skip', key, error, file=sys.stderr)
                continue
            result[key] = {name: [row[f] for f in fields] for name, row in sorted(clips.items())}
            print(key, len(clips), file=sys.stderr)
    with open(out, 'w', encoding='utf-8') as handle:
        json.dump({'version': 1, 'units': 'cm, seconds share, degrees', 'fields': fields, 'animsets': result},
                  handle, indent=0, sort_keys=True)


if __name__ == '__main__':
    main(sys.argv[1:])
