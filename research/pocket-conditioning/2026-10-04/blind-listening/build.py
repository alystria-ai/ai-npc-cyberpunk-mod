"""Create an offline listening set with byte-exact audio and concealed arm labels."""
import argparse
import hashlib
import itertools
import json
from pathlib import Path
import secrets
import shutil


def build(source, output):
    source = source.resolve()
    output = output.resolve()
    if output.exists():
        raise SystemExit('Output already exists; preserve its randomization and saved responses.')
    raw = json.loads(source.read_text(encoding='utf-8-sig'))
    output.mkdir(parents=True)
    (output / 'audio').mkdir()
    session = secrets.token_hex(12)
    first = ['johnny-silverhand', 'judy-alvarez', 'jackie-welles', 'panam-palmer', 'evelyn-parker', 'solomon-reed']
    permutations = list(itertools.permutations('ABC')) * 4
    secrets.SystemRandom().shuffle(permutations)
    manifest = {'session': session, 'first_round': first, 'characters': []}
    scoring = {'session': session, 'kind': 'teacher EMA500', 'characters': {}, 'audio_integrity': []}

    def audio(relative, expected):
        original = source.parent / relative
        digest = hashlib.sha256(original.read_bytes()).hexdigest()
        if digest != expected:
            raise ValueError(f'Audio source mismatch: {relative}')
        opaque = 'audio/' + secrets.token_hex(16) + '.wav'
        shutil.copyfile(original, output / opaque)
        if hashlib.sha256((output / opaque).read_bytes()).hexdigest() != digest:
            raise ValueError('Copy verification failed')
        scoring['audio_integrity'].append({'file': opaque, 'source': relative, 'sha256': digest})
        return opaque

    for char, order in zip(raw['characters'], permutations):
        item = {'id': char['id'], 'name': char['display_name'], 'reference': audio(char['reference']['file'], char['reference']['sha256']), 'candidates': {}}
        scoring['characters'][char['id']] = dict(zip('XYZ', order))
        texts = {}
        for label, arm in zip('XYZ', order):
            item['candidates'][label] = {}
            for row in char[arm]:
                length = 'short' if row['text_index'] == 0 else 'long'
                if length in texts and texts[length] != row['text']:
                    raise ValueError('Candidate texts differ')
                texts[length] = row['text']
                item['candidates'][label][length] = audio(row['file'], row['audio_sha256'])
        item['texts'] = texts
        manifest['characters'].append(item)
    (output / 'listening-data.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    (output / 'reveal-scoring.json').write_text(json.dumps(scoring, indent=2), encoding='utf-8')
    for name in ['index.html', 'app.js']:
        shutil.copyfile(Path(__file__).parent / name, output / name)
    (output / 'README.md').write_text('# Blind voice comparison\n\nOpen index.html through a local HTTP server. Six suggested characters, all 24 available. Audio copies are unprocessed and hash verified. Labels are randomized per character, shared across short/long clips. Responses are stored in this browser and can be exported. Finish then explicitly reveal to load the separate scoring map. These are teacher EMA500 samples, not the installed student.\n', encoding='utf-8')
    print(json.dumps({'output': str(output), 'characters': len(manifest['characters']), 'audio_files': len(scoring['audio_integrity']), 'session': session}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    build(args.source, args.output)
