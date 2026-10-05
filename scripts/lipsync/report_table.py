"""Render lipsync_eval reports as one Markdown comparison table."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROWS = [
    ('Inner lip aperture r', 'geo_innerAperture', 'r'),
    ('Inner aperture error (mm)', 'geo_innerAperture', 'mae'),
    ('Mouth width r', 'geo_width', 'r'),
    ('Lip protrusion r', 'geo_protrusion', 'r'),
    ('Chin drop r', 'geo_chinDrop', 'r'),
    ('Jaw control r', 'jaw', 'r'),
    ('Lip contact control r', 'together', 'r'),
    ('Purse r', 'purse', 'r'),
    ('Corner stretch r', 'cornerStretch', 'r'),
    ('Lower roll r', 'suckDn', 'r'),
    ('Lip-contact recall', 'closure', 'recall'),
    ('Lip-contact precision', 'closure', 'precision'),
    ('F/V contact recall', 'fv', 'recall'),
    ('Rounding recall', 'rounding', 'recall'),
    ('Rounding precision', 'rounding', 'precision'),
    ('Timing (ms late vs game)', 'lagMs', None),
]


def main(paths):
    columns = {}
    for path in paths:
        report = json.loads(Path(path).read_text(encoding='utf8'))
        for name, values in report['candidates'].items():
            if name == 'jaliGraphOnly' and 'game curves (graph controls)' in columns:
                continue
            label = {'pocket': 'Pocket (before)', 'omni': 'Omni (before)', 'model': 'Game-trained model',
                     'jaliGraphOnly': 'game curves (graph controls)'}.get(name, name)
            columns[label] = values
    order = [c for c in ['Pocket (before)', 'Omni (before)', 'Game-trained model', 'game curves (graph controls)'] if c in columns]
    print('| Metric | ' + ' | '.join(order) + ' |')
    print('| --- | ' + ' | '.join('---:' for _ in order) + ' |')
    for label, key, field in ROWS:
        cells = []
        for column in order:
            value = columns[column].get(key)
            value = value if field is None else (value or {}).get(field)
            cells.append('—' if value is None else (f'{value:.0f}' if field is None else f'{value:.2f}'))
        print(f'| {label} | ' + ' | '.join(cells) + ' |')


if __name__ == '__main__':
    main(sys.argv[1:])
