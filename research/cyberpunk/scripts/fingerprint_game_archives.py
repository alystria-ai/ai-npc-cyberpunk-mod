"""Read and fingerprint the exact installed containers used by the evidence cache."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from index_game_knowledge import ARCHIVES, digest, utc, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True)
    parser.add_argument('--game', required=True)
    args = parser.parse_args()
    root = Path(args.game).resolve()
    result = {'version': 1, 'createdAt': utc(),
              'digestMeaning': 'Full installed archive file SHA-256; distinct from each extracted asset hash',
              'archives': []}
    for archive_id, relative in ARCHIVES:
        path = root / relative
        if not path.is_file():
            if archive_id == 'base':
                raise FileNotFoundError(path)
            continue
        before = path.stat()
        sha = digest(path)
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise RuntimeError('Archive changed during fingerprint; do not publish a mixed-version manifest')
        record = {'archive': archive_id, 'archivePath': relative, 'archiveSha256': sha,
                  'archiveBytes': before.st_size, 'archiveMtimeNs': str(before.st_mtime_ns)}
        result['archives'].append(record)
    output = Path(args.project).resolve() / 'research/cyberpunk/cache/game/archive-fingerprints.json'
    write_json(output, result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
