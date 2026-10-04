"""Run the immutable, explicit Oct4 source batches sequentially with flushed logs."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[3]
OUT=Path(__file__).resolve().parent

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def emit(v): print(json.dumps(v),flush=True)

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--plan',type=Path,required=True)
    ap.add_argument('--first',type=int,default=0)
    ap.add_argument('--count',type=int)
    args=ap.parse_args()
    plan=args.plan.resolve()
    if not plan.is_relative_to(OUT.parent): raise ValueError('Plan must belong to Oct4 outputs')
    document=json.loads(plan.read_text(encoding='utf-8-sig'))
    batches=document['batches'][args.first:None if args.count is None else args.first+args.count]
    worker=OUT/'decode_batch_bulk.py'
    worker_sha=sha(worker)
    emit({'phase':'start-plan','planSha256':sha(plan),'workerSha256':worker_sha,'count':len(batches)})
    for index,b in enumerate(batches):
        if (OUT/'STOP').exists():
            emit({'phase':'stopped-before-batch','index':index});return
        if sha(worker)!=worker_sha: raise ValueError('Running plan worker source changed')
        manifest=(ROOT/b['path']).resolve()
        if not manifest.is_relative_to(OUT.parent) or sha(manifest)!=b['sha256']:
            raise ValueError('Explicit batch manifest changed')
        batch=json.loads(manifest.read_text(encoding='utf-8'))['batch']
        receipt=OUT/'receipts'/(batch+'.json')
        if receipt.exists():
            saved=json.loads(receipt.read_text(encoding='utf-8'))
            if saved['manifestSha256']!=b['sha256']:
                raise ValueError('Prior result belongs to a different manifest')
            emit({'phase':'preserved-existing-batch','batch':batch,'completed':len(saved['completed']),'errors':len(saved['errors'])})
            continue
        log=OUT/(batch+'.log')
        if log.exists(): raise ValueError('Prior unsealed attempt exists; review its state before retry')
        emit({'phase':'start-batch','batch':batch,'index':index+1,'of':len(batches)})
        began=time.monotonic()
        with log.open('x',encoding='utf-8') as stream:
            child=subprocess.Popen([sys.executable,'-u',str(worker),'--manifest',str(manifest),'--decode'],cwd=ROOT,
                stdout=stream,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            emit({'phase':'batch-worker','batch':batch,'pid':child.pid,'log':str(log.relative_to(ROOT))})
            code=child.wait()
        if code or not receipt.is_file():
            emit({'phase':'batch-failed','batch':batch,'exitCode':code,'receiptExists':receipt.is_file()})
            raise SystemExit(code or 1)
        result=json.loads(receipt.read_text(encoding='utf-8'))
        emit({'phase':'batch-complete','batch':batch,'collected':len(result['completed']),'errors':len(result['errors']),
            'seconds':time.monotonic()-began,'receiptSha256':sha(receipt)})
    emit({'phase':'plan-complete','batches':len(batches)})

if __name__=='__main__':main()
