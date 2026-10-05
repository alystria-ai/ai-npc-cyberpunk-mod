"""Build a local research corpus of Cyberpunk dialogue audio + native lipsync curves.

Each English voice-over line has a JALI-authored lipsync animation in
lang_en_voice.archive (base\\localization\\en-us\\lipsync\\...\\<actor>.anims).
Its float tracks are the same `*LipsyncPoseOutput` face-rig tracks that the
mod's ConvaiFace feature adds to, so they are direct ground truth for the
native controls. Animation `f_<HEX>`/`m_<HEX>` matches `..._<hex>.wem`.

Development-only. Writes beneath runtime/ (git-ignored); game-derived data
must never be committed or redistributed. Uses the already present WolvenKit
CLI (vendor/) and vgmstream-cli; helper processes run hidden at low priority.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

PROJECT = Path(__file__).resolve().parents[2]
WK = PROJECT / 'vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe'
DOTNET = PROJECT / 'vendor/dotnet-runtime-10.0.12'
VGM = Path(r'C:\Users\akshi\Downloads\misc\modding\fmodel\Output\.data\vgmstream-cli.exe')
FLAGS = (subprocess.CREATE_NO_WINDOW | 0x00004000) if os.name == 'nt' else 0  # hidden, below-normal
FPS = 30
MAIN_CAST = ['judy', 'johnny', 'panam', 'jackie', 'kerry', 'river', 'evelyn', 'takemura', 'rogue',
             'regina_reggie_jones', 'mitch', 'saul', 'viktor', 'misty', 'claire', 'dexter', 't_bug',
             'hanako', 'v', 'goro', 'alt', 'brigitte', 'placide', 'wakako_okada', 'sebastian_padre_perez',
             'muamar_capitan_reyes', 'dakota_smith', 'cassidy', 'sobchak', 'nix', 'ozob', 'lizzy']


def tool(args, log):
    env = dict(os.environ, DOTNET_ROOT=str(DOTNET))
    with open(log, 'a', encoding='utf8') as out:
        code = subprocess.run(args, stdout=out, stderr=subprocess.STDOUT, env=env, creationflags=FLAGS).returncode
    if code:
        raise RuntimeError(f'{args[0]} failed ({code}); see {log}')


def listing(game: Path, cache: Path) -> list[str]:
    if not cache.exists():
        tool([str(WK), 'archive', str(game / 'archive/pc/content/lang_en_voice.archive'), '-l'], cache.with_suffix('.log'))
        lines = cache.with_suffix('.log').read_text(encoding='utf-8-sig', errors='replace').splitlines()
        cache.write_text('\n'.join(l.strip() for l in lines if l.strip().startswith('base\\')), encoding='utf8')
    return cache.read_text(encoding='utf8').splitlines()


def track_names() -> list[str]:
    rig = PROJECT / 'runtime/facial-native-audit-20260930/json/h0_001_wa_c__judy_skeleton.rig.json'
    return [x['$value'] for x in json.loads(rig.read_text(encoding='utf8'))['Data']['RootChunk']['trackNames']]


def glb_animations(path: Path):
    data = path.read_bytes()
    length = struct.unpack('<I', data[12:16])[0]
    doc = json.loads(data[20:20 + length])
    accessors = doc['accessors']
    skin = (doc.get('skins') or [{}])[0].get('extras') or {}
    for anim in doc['animations']:
        extras = anim.get('extras') or {}
        duration = 0.0
        for sampler in anim.get('samplers', []):
            duration = max(duration, float((accessors[sampler['input']].get('max') or [0])[0]))
        yield anim['name'], extras, duration, skin.get('trackNames') or [], skin.get('rigPath', '')


def dense_tracks(extras, duration, rig_tracks, canonical):
    """Dense 30 fps values in the canonical (Judy) track order, mapped BY NAME:
    rigs differ (e.g. Royce's has 416 tracks in another order)."""
    frames = int(round(duration * FPS)) + 1
    position = {name: i for i, name in enumerate(canonical)}
    target = [position.get(name, -1) for name in rig_tracks]
    out = np.zeros((frames, len(canonical)), np.float32)
    keyed = {}
    for key in extras.get('trackKeys') or []:
        keyed.setdefault(key['trackIndex'], []).append((key['time'], key['value']))
    for key in extras.get('constTrackKeys') or []:
        index = key['trackIndex']
        if index not in keyed and index < len(target) and target[index] >= 0:
            out[:, target[index]] = key['value']
    times = np.arange(frames) / FPS
    for index, keys in keyed.items():
        if index >= len(target) or target[index] < 0:
            continue
        keys.sort()
        out[:, target[index]] = np.interp(times, [k[0] for k in keys], [k[1] for k in keys])
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, default=Path(r'E:\SteamLibrary\steamapps\common\Cyberpunk 2077'))
    parser.add_argument('--out', type=Path, default=PROJECT / 'runtime/lipsync-corpus2')
    parser.add_argument('--per-cast', type=int, default=6, help='anims files per main-cast actor')
    parser.add_argument('--others', type=int, default=120, help='random other anims files')
    parser.add_argument('--batch', type=int, default=12)
    parser.add_argument('--seed', type=int, default=7)
    args = parser.parse_args()
    out = args.out
    (out / 'lines').mkdir(parents=True, exist_ok=True)
    work = out / 'work'
    names = track_names()
    canonical = set(names)
    files = listing(args.game, out / 'voice-listing.txt')
    anims = [f for f in files if f.endswith('.anims') and '\\lipsync\\' in f]
    wems = {}
    for f in files:
        if f.endswith('.wem'):
            match = re.search(r'_([0-9a-f]{16})\.wem$', f)
            if match:
                wems.setdefault(match.group(1), f)
    rng = random.Random(args.seed)
    by_actor = {}
    for f in anims:
        by_actor.setdefault(f.rsplit('\\', 1)[1][:-6], []).append(f)
    chosen = []
    for actor in MAIN_CAST:
        group = sorted(by_actor.get(actor, []))
        rng.shuffle(group)
        chosen += group[:args.per_cast if actor != 'v' else args.per_cast * 3]
    rest = sorted(set(anims) - set(chosen))
    rng.shuffle(rest)
    chosen += rest[:args.others]
    done_path = out / 'done-anims.txt'
    done = set(done_path.read_text(encoding='utf8').splitlines()) if done_path.exists() else set()
    chosen = [f for f in chosen if f not in done]
    manifest_path = out / 'manifest.jsonl'
    print(f'{len(chosen)} anims files to process', flush=True)
    for start in range(0, len(chosen), args.batch):
        batch = chosen[start:start + args.batch]
        shutil.rmtree(work, ignore_errors=True)
        (work / 'raw').mkdir(parents=True)
        (work / 'glb').mkdir()
        (work / 'wem').mkdir()
        log = work / 'tool.log'
        regex = '^(' + '|'.join(re.escape(f) for f in batch) + ')$'
        tool([str(WK), 'unbundle', str(args.game / 'archive/pc/content/lang_en_voice.archive'),
              '--outpath', str(work / 'raw'), '--regex', regex], log)
        # Many scenes reuse one actor file name; flatten to unique names first.
        (work / 'flat').mkdir()
        for number, depot in enumerate(batch):
            source = work / 'raw' / depot.replace('\\', '/')
            if source.exists():
                source.rename(work / 'flat' / f'{number:03d}.anims')
        tool([str(WK), 'export', str(work / 'flat'), '-o', str(work / 'glb'), '-gp', str(args.game)], log)
        lines = []
        for number, depot in enumerate(batch):
            matches = list((work / 'glb').rglob(f'{number:03d}.anims.glb'))
            glb = matches[0] if len(matches) == 1 else None
            if glb is None:
                print('missing glb', depot, flush=True)
                continue
            actor = depot.rsplit('\\', 1)[1][:-6]
            seen = set()
            for name, extras, duration, rig_tracks, rig in glb_animations(glb):
                if not rig_tracks or sum(t in canonical for t in rig_tracks) < 300:
                    continue
                match = re.fullmatch(r'([fm])_([0-9A-Fa-f]{16})', name)
                if not match or duration <= 0.3 or duration > 30:
                    continue
                hexid = match.group(2).lower()
                if hexid in seen or hexid not in wems:
                    continue
                seen.add(hexid)
                lines.append(dict(actor=actor, anims=depot, anim=name, hex=hexid, wem=wems[hexid], rig=rig,
                                  duration=duration, tracks=dense_tracks(extras, duration, rig_tracks, names)))
            glb.unlink()
        if lines:
            regex = '^(' + '|'.join(re.escape(l['wem']) for l in lines) + ')$'
            tool([str(WK), 'unbundle', str(args.game / 'archive/pc/content/lang_en_voice.archive'),
                  '--outpath', str(work / 'wem'), '--regex', regex], log)
        with manifest_path.open('a', encoding='utf8') as manifest:
            for line in lines:
                wem = work / 'wem' / line['wem'].replace('\\', '/')
                if not wem.exists():
                    continue
                wav = wem.with_suffix('.wav')
                if subprocess.run([str(VGM), '-o', str(wav), str(wem)], capture_output=True,
                                  creationflags=FLAGS).returncode or not wav.exists():
                    continue
                audio, rate = sf.read(wav, dtype='float32', always_2d=True)
                audio = audio.mean(axis=1)
                audio16 = resample_poly(audio, 1, rate // 16000).astype(np.float32) if rate % 16000 == 0 \
                    else resample_poly(audio, 16000, rate).astype(np.float32)
                key = f"{line['actor']}_{line['hex']}"
                np.savez_compressed(out / 'lines' / f'{key}.npz', audio16k=audio16, tracks=line['tracks'],
                                    audio_seconds=np.float32(len(audio) / rate))
                manifest.write(json.dumps(dict(key=key, actor=line['actor'], anims=line['anims'], rig=line['rig'],
                    anim=line['anim'], hex=line['hex'], wem=line['wem'], animSeconds=line['duration'],
                    audioSeconds=len(audio) / rate)) + '\n')
        with done_path.open('a', encoding='utf8') as handle:
            handle.write('\n'.join(batch) + '\n')
        print(f'batch {start // args.batch + 1}: {len(lines)} lines', flush=True)
    shutil.rmtree(work, ignore_errors=True)
    (out / 'track-names.json').write_text(json.dumps(names), encoding='utf8')


if __name__ == '__main__':
    main()
