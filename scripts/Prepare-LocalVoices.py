"""Configure three existing, verified references for the resident base model.

No dataset extraction, training or model download is performed.
"""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
KEYS = ('johnny-silverhand', 'judy-alvarez', 'panam-palmer')
REVISION = 'c5fdb5ccb189668d56333f77ba2629f4cd7535f4'
model = ROOT / 'vendor/voice-models/hub/models--k2-fsa--OmniVoice/snapshots' / REVISION
if not (model / 'model.safetensors').is_file():
    raise FileNotFoundError('The pinned base OmniVoice model must already be installed')
selected = json.loads((ROOT / 'runtime/voice-references/selected-benchmark.json').read_text('utf-8'))
references = {clip['key']: clip for clip in selected['clips']}
voices = {}
for key in KEYS:
    ref = references[key]
    path = Path(ref['wavPath']).resolve()
    assert ref['source']['sha1Verified'] and path.is_relative_to(ROOT)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == ref['wav']['sha256']
    text = ref['transcript']
    if 'â' in text:
        text = text.encode('cp1252').decode('utf-8')
    voices[key] = {'reference': path.relative_to(ROOT).as_posix(),
                   'sha256': ref['wav']['sha256'], 'transcript': text}
config = {'provider': 'hybrid', 'engine': 'omnivoice', 'steps': 32,
          'model': model.relative_to(ROOT).as_posix(), 'revision': REVISION,
          'voices': voices}
target = ROOT / 'runtime/local-voices.json'
temp = target.with_suffix('.json.tmp')
temp.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
temp.replace(target)
print('Configured existing base-model references for Johnny, Judy and Panam. Default: 32 steps; resident model.')
