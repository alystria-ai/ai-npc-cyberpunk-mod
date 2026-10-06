"""Per-clip visible hand motion for companion gestures (docs/COMPANION_GESTURES.md).

Reads WolvenKit glTF exports of the gesture animsets (WolvenKit.CLI export
<file.anims> -gp <game>), runs forward kinematics and measures each clip's hand
motion relative to the chest (Spine3): reach = largest hand excursion from the
first frame (cm), open = how far the hands spread beyond their start (cm).
Writes assets/gestures/clip-motion.json, read by Build-GestureAssets.mjs.
Usage: python scripts/Measure-GestureMotion.py <glb dir> [output json]
"""
import json, struct, sys, glob, os
import numpy as np
def load(path):
    f = open(path, 'rb').read()
    jl = struct.unpack('<I', f[12:16])[0]
    j = json.loads(f[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack('<I', f[off:off + 4])[0]
    binary = f[off + 8: off + 8 + bl]
    return j, binary
def accessor(j, binary, index):
    a = j['accessors'][index]; v = j['bufferViews'][a['bufferView']]
    n = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[a['type']]
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    data = np.frombuffer(binary, dtype=np.float32, count=a['count'] * n, offset=start)
    return data.reshape(a['count'], n) if n > 1 else data
def qmat(q):
    x, y, z, w = q
    return np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                     [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                     [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
def sample(times, values, t):
    i = np.searchsorted(times, t, side='right') - 1
    i = max(0, min(i, len(times) - 1))
    if i >= len(times) - 1: return values[-1]
    a = (t - times[i]) / max(1e-6, times[i+1] - times[i])
    v = values[i] * (1 - a) + values[i+1] * a
    if v.shape[0] == 4: v = v / np.linalg.norm(v)
    return v
def analyse(path):
    j, binary = load(path)
    nodes = j['nodes']; names = [n.get('name') for n in nodes]
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get('children', []): parent[c] = i
    want = {name: names.index(name) for name in ('LeftHand', 'RightHand', 'Spine3') if name in names}
    chains = {k: [] for k in want}
    for k, idx in want.items():
        i = idx
        while i is not None:
            chains[k].append(i); i = parent.get(i)
        chains[k].reverse()
    results = {}
    for anim in j['animations']:
        tracks = {}
        tmax = 0
        for ch in anim['channels']:
            s = anim['samplers'][ch['sampler']]
            times = accessor(j, binary, s['input']); values = accessor(j, binary, s['output'])
            tmax = max(tmax, float(times[-1]))
            tracks[(ch['target']['node'], ch['target']['path'])] = (times, values)
        def world(i_chain, t):
            m = np.eye(3); p = np.zeros(3)
            for i in i_chain:
                n = nodes[i]
                tr = tracks.get((i, 'translation')); ro = tracks.get((i, 'rotation'))
                T = sample(*tr, t) if tr else np.array(n.get('translation', [0, 0, 0]))
                R = sample(*ro, t) if ro else np.array(n.get('rotation', [0, 0, 0, 1]))
                p = p + m @ T; m = m @ qmat(R)
            return p, m
        steps = np.linspace(0, tmax, max(2, int(tmax * 30)))
        rel = {'LeftHand': [], 'RightHand': []}
        for t in steps:
            cp, cm = world(chains['Spine3'], t)
            for hand in rel:
                hp, _ = world(chains[hand], t)
                rel[hand].append(cm.T @ (hp - cp))
        score = {}
        for hand, pts in rel.items():
            pts = np.array(pts)
            disp = np.linalg.norm(pts - pts[0], axis=1)
            score[hand] = (float(disp.max()), float(np.abs(np.diff(pts, axis=0)).sum()))
        sep = np.linalg.norm(np.array(rel['LeftHand']) - np.array(rel['RightHand']), axis=1)
        results[anim['name']] = {
            'duration': round(tmax, 2),
            'reach': round(100 * max(score['LeftHand'][0], score['RightHand'][0]), 1),   # cm, max hand excursion
            'path': round(100 * (score['LeftHand'][1] + score['RightHand'][1]) / max(tmax, .1), 1),  # cm/s hand travel
            'open': round(100 * float(sep.max() - sep[0]), 1),  # cm hands spread beyond start
        }
    return results
glb_dir = sys.argv[1]
target = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'assets', 'gestures', 'clip-motion.json')
out = {}
for path in sorted(glob.glob(os.path.join(glb_dir, '*.glb'))):
    key = os.path.basename(path).replace('.anims.glb', '')
    try:
        out[key] = analyse(path); print(key, len(out[key]), file=sys.stderr)
    except Exception as e:
        print('fail', key, e, file=sys.stderr)
compact = {animset: {clip: [v['reach'], v['open']] for clip, v in clips.items()} for animset, clips in out.items()}
with open(target, 'w', encoding='utf-8') as handle:
    json.dump({'version': 1, 'units': 'cm', 'fields': ['reach', 'open'], 'animsets': compact}, handle, indent=0, sort_keys=True)
