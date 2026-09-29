"""Recheck all explicitly exported winning scenes against installed English text."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from types import SimpleNamespace

from index_game_knowledge import Job
from index_native_localization import audit_scenes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', default=str(Path(__file__).resolve().parents[3]))
    parser.add_argument('--game', default=r'E:\SteamLibrary\steamapps\common\Cyberpunk 2077')
    args = parser.parse_args()
    cache = Path(args.project).resolve() / 'research/cyberpunk/cache/game'
    paths = []
    for manifest_path in sorted((cache / 'scene-evidence').glob('*/inventory.json')):
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        for asset in manifest['assets']:
            if asset['winner'] and asset['depotPath'].endswith('.scene'):
                paths.append(str(manifest_path.parent / asset['jsonPath']))
    if not paths or len(paths) > 512:
        raise ValueError('Expected between 1 and 512 already exported review scenes')
    job = Job(SimpleNamespace(project=args.project, game=args.game,
                              output=cache / 'localization', max_cache_gib=3))
    audit_scenes(job, paths)


if __name__ == '__main__':
    main()
