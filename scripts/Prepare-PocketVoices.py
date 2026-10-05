"""Stage an explicitly selected Pocket student config without loading a model.

This is development/runtime configuration, not a dependency bundle builder.
The operator must supply the verified model SHA and training identity. The
source export/config/receipt/reference recordings are never changed.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import os
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))
from pocket_voice_runtime import ASSETS, digest_file, read_json, validate_config


def prepare(args):
    export = args.export.resolve()
    receipt = read_json(export / 'receipt.json')
    if receipt.get('model_sha256') != args.model_sha256 or receipt.get('input_identity') != args.input_identity:
        raise ValueError('Pocket export differs from the explicit approved model identity')
    original = read_json(args.references)
    if not isinstance(original.get('voices'), dict):
        raise ValueError('A source-qualified local voice registry is required')
    executable = args.python.resolve()
    if not executable.is_file():
        raise ValueError('The explicit Pocket Python executable is missing')
    model = {field:digest_file(export / name) for name,field in ASSETS.items()}
    if model['sha256'] != args.model_sha256:
        raise ValueError('Pocket weights failed their approved identity')
    model.update(inputIdentity=args.input_identity,selectedStep=receipt.get('selected_step'))
    raw = {'version':1,'provider':'pocket','engine':'pocket-tts',
           'referenceRegistry':{'path':str(args.references.resolve()),'sha256':digest_file(args.references)},
           'runtime':{'sourceDirectory':str(args.source.resolve()),'exportDirectory':str(export),
                      'referenceDirectory':str(args.reference_directory.resolve()),
                      'workDirectory':str(args.work.resolve()),'pythonExecutable':str(executable)},
           'model':model,'cpu':{'threads':args.threads},'sampling':{'temperature':.3,'decodeSteps':1},
           'voices':original['voices'],'preparation':{'startupProfiles':[],'maxCachedProfiles':8}}
    validated = validate_config(raw)
    destination = args.output.resolve()
    destination.parent.mkdir(parents=True,exist_ok=True)
    temporary = destination.with_name(destination.name + f'.{os.getpid()}.tmp')
    try:
        temporary.write_text(json.dumps(raw,indent=2,ensure_ascii=False,allow_nan=False)+'\n',encoding='utf-8')
        os.replace(temporary,destination)
    finally:
        temporary.unlink(missing_ok=True)
    return {'version':1,'status':'prepared','modelExecution':False,'output':str(destination),
            'modelSha256':model['sha256'],'selectedStep':model['selectedStep'],
            'availableProfiles':sorted(validated['refs']),'unavailableProfiles':validated['unavailable'],
            'device':'cpu','threads':args.threads,'gpuVramBytes':0}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--export',type=Path,required=True)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--python',type=Path,required=True)
    parser.add_argument('--references',type=Path,required=True,
                        help='Explicit approved reference registry; use the Pocket registry to preserve its selected montage')
    parser.add_argument('--reference-directory',type=Path,required=True)
    parser.add_argument('--work',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--model-sha256',required=True)
    parser.add_argument('--input-identity',required=True)
    parser.add_argument('--threads',type=int,default=4)
    print(json.dumps(prepare(parser.parse_args()),indent=2,ensure_ascii=False,allow_nan=False))


if __name__=='__main__':
    main()
