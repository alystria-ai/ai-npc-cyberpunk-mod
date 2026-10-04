"""Read-only installed scene metadata inventory; never extracts game payloads."""
from pathlib import Path
import importlib.util
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
GAME = Path('E:/SteamLibrary/steamapps/common/Cyberpunk 2077')
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('scene_evidence', ROOT / 'scripts/Cast-SceneEvidence.py')
scene = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scene)
cli, dotnet, tool_receipt = scene.tools(ROOT)
env = {**os.environ, 'DOTNET_ROOT': str(dotnet), 'DOTNET_PROCESSOR_COUNT': '1'}
entries, archives = [], []
previous = json.loads((OUT/'inventory.json').read_text()) if '--reuse-listings' in sys.argv else None
for priority, (label, relative) in enumerate(scene.ARCHIVES):
    archive = GAME / relative
    stat = archive.stat()
    log = OUT / ('list-' + label + '.log')
    if previous:
        receipt = next(x for x in previous['archives'] if x['archive'] == label)
        if (receipt['bytes'], receipt['mtimeNs'], receipt['listingSha256']) != (stat.st_size, str(stat.st_mtime_ns), scene.digest(log)):
            raise ValueError('Previous metadata listing no longer matches installed archive or log')
    else:
        with log.open('w', encoding='utf-8') as output:
            result = subprocess.run([str(cli), 'archive', str(archive), '--list', '--regex', r'\.scene$'],
                cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if result.returncode:
            raise RuntimeError(f'Archive metadata listing failed; see {log}')
    paths = [line.strip().replace('/', '\\').lower() for line in log.read_text(encoding='utf-8-sig').splitlines()
             if re.search(r'\.scene$', line.strip())]
    if len(paths) != len(set(paths)):
        raise ValueError('Duplicate scene path in CLI output')
    index = scene.read_archive_index(archive)
    for depot in sorted(paths):
        scene.depot_path(depot)
        key = str(scene.knowledge.fnv(depot, 64))
        if key not in index:
            raise ValueError('Resolved path absent from archive directory: ' + depot)
        row = index[key]
        entries.append({'depotPath': depot, 'pathHash64': key, 'archive': label, 'archivePath': relative,
                        'priority': priority, **row})
    archives.append({'archive': label, 'path': relative, 'bytes': stat.st_size, 'mtimeNs': str(stat.st_mtime_ns),
                     'directoryEntries': len(index), 'resolvedScenes': len(paths),
                     'listingSha256': scene.digest(log)})
    print(json.dumps(archives[-1]), flush=True)

winners = {}
for entry in entries:
    winners[entry['depotPath']] = entry
cached = set()
cache_roots = [ROOT/'research/cyberpunk/cache/game', ROOT/'runtime']
cache_json_files = 0
for cache in cache_roots:
    for path in cache.rglob('*.scene.json'):
        cache_json_files += 1
        # Path matching establishes coverage only, not evidence qualification.
        text = str(path).replace('/', '\\').lower()
        for prefix in ('\\base\\', '\\ep1\\'):
            positions = [m.start() for m in re.finditer('(?=' + re.escape(prefix) + ')', text)]
            for pos in positions:
                suffix = text[pos + 1:-5]
                if suffix in winners:
                    cached.add(suffix)
    for path in cache.rglob('native-scenes/*/provenance.json'):
        value = json.loads(path.read_text(encoding='utf-8-sig'))
        depot = value.get('scene', {}).get('depotPath')
        if depot in winners:
            cached.add(depot)
for path, entry in winners.items():
    entry['cachedSerializationFound'] = path in cached
document = {'schemaVersion': 1, 'createdAt': datetime.now(timezone.utc).isoformat(),
    'scope': 'Base and EP1 gamedata archives; no resource extraction; path coverage is not actor evidence.',
    'tool': tool_receipt, 'archives': archives, 'winnerCount': len(winners), 'sourceCount': len(entries),
    'cachedJsonFiles': cache_json_files, 'cachedWinningPaths': len(cached),
    'notCachedWinningPaths': len(winners) - len(cached),
    'totalWinningStoredBytes': sum(x['storedBytes'] for x in winners.values()),
    'totalWinningDecodedBytes': sum(x['decodedBytes'] for x in winners.values()),
    'scenes': sorted(winners.values(), key=lambda x: x['depotPath'])}
(OUT/'inventory.json').write_text(json.dumps(document, indent=2)+'\n', encoding='utf-8')
(OUT/'uncached-scenes.txt').write_text('\n'.join(sorted(set(winners)-cached))+'\n', encoding='utf-8')
print(json.dumps({k:v for k,v in document.items() if k not in {'tool','archives','scenes'}}), flush=True)
