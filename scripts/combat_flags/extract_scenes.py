"""Unbundle every installed .scene (base + EP1) with WolvenKit and serialize each to JSON in place.

Read-only on the game install. Output goes under OUT/scenes-raw/{base,ep1}/<depot path>.scene and
<depot path>.scene.json (WolvenKit writes the JSON next to the input; `-o` would flatten basenames and
collide the versions/gold, versions/patch* copies, so it is not used).  Serialization runs in at most
--workers parallel WolvenKit processes over chunks of files, and is resumable (existing .json skipped).

    set PYTHONUTF8=1
    python scripts/combat_flags/extract_scenes.py [--workers 4] [--chunk 60]
"""
import argparse
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GAME = Path(r'E:\SteamLibrary\steamapps\common\Cyberpunk 2077')
OUT = Path(r'E:\CyberpunkConvai-offload\work\combat-flags')
CLI = ROOT / 'vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe'
DOTNET = ROOT / 'vendor/dotnet-runtime-10.0.12'
ARCHIVES = {'base': 'archive/pc/content/basegame_4_gamedata.archive',
            'ep1': 'archive/pc/ep1/ep1_2_gamedata.archive'}
ENV = {**os.environ, 'DOTNET_ROOT': str(DOTNET), 'DOTNET_PROCESSOR_COUNT': '1'}


def run(args, log):
    with open(log, 'w', encoding='utf-8') as fh:
        return subprocess.run([str(CLI), *map(str, args)], env=ENV, stdout=fh, stderr=subprocess.STDOUT,
                              creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).returncode


def unbundle():
    (OUT / 'logs').mkdir(parents=True, exist_ok=True)
    for name, rel in ARCHIVES.items():
        dest = OUT / 'scenes-raw' / name
        if dest.exists() and any(dest.rglob('*.scene')):
            print('already unbundled', name)
            continue
        dest.mkdir(parents=True, exist_ok=True)
        rc = run(['extract', GAME / rel, '--outpath', dest, '--regex', r'\.scene$'], OUT / 'logs' / f'extract-{name}.log')
        print('extract', name, 'rc', rc)


def serialize(workers, chunk):
    files = [p for p in (OUT / 'scenes-raw').rglob('*.scene') if not Path(str(p) + '.json').exists()]
    files.sort(key=lambda p: -p.stat().st_size)
    chunks = [files[i::max(1, len(files) // chunk)] for i in range(max(1, len(files) // chunk))]
    print(len(files), 'to serialize in', len(chunks), 'chunks', flush=True)
    t0 = time.time()

    def work(item):
        i, c = item
        rc = run(['convert', 'serialize', *c], OUT / 'logs' / f'serialize-{i:04d}.log')
        print(f'chunk {i} rc {rc} files {len(c)} t={time.time()-t0:.0f}s', flush=True)
        return rc

    with ThreadPoolExecutor(workers) as ex:
        rcs = list(ex.map(work, enumerate(chunks)))
    missing = [p for p in (OUT / 'scenes-raw').rglob('*.scene') if not Path(str(p) + '.json').exists()]
    print('done; missing json:', len(missing))
    return missing


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--chunk', type=int, default=60)
    a = ap.parse_args()
    unbundle()
    sys.exit(1 if serialize(min(a.workers, 4), a.chunk) else 0)
