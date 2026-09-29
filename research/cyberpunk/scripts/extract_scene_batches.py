"""Run reviewed exact scene batches with at most two hidden archive workers."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True)
    parser.add_argument('--game', required=True)
    parser.add_argument('--requests', required=True)
    parser.add_argument('--workers', type=int, choices=(1, 2), default=1)
    args = parser.parse_args()
    batches = json.loads(Path(args.requests).read_text(encoding='utf-8'))
    if not isinstance(batches, dict) or not 1 <= len(batches) <= 16:
        raise ValueError('Expected an object of 1..16 batch names to scene path lists')
    script = Path(__file__).with_name('extract_scene_evidence.py')

    def run(name, depots):
        command = [sys.executable, str(script), '--project', args.project, '--game', args.game, '--batch', name]
        for depot in depots:
            command += ['--depot', depot]
        result = subprocess.run(command, capture_output=True, text=True,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        print(json.dumps({'batch': name, 'exitCode': result.returncode,
                          'summary': result.stdout.strip(), 'error': result.stderr.strip()}), flush=True)
        return result.returncode

    failures = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending = [pool.submit(run, name, depots) for name, depots in batches.items()]
        for future in as_completed(pending):
            failures += bool(future.result())
    return 2 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
