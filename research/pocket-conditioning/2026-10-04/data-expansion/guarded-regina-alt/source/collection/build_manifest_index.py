"""Freeze exact collection manifest/receipt locations for the qualification lane."""
from pathlib import Path
import hashlib,json

ROOT=Path(__file__).resolve().parents[3]
BASE=ROOT/'runtime/voice-data-expansion-20261004'
OUT=Path(__file__).resolve().parent

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))

def main():
    plans=[BASE/'cached-candidates/sparse-continuation-plan.json',
           BASE/'cached-candidates/allcast-continuation-plan.json',
           BASE/'cached-candidates/fresh-scenes/final-priority-001-008/plan.json']
    first=BASE/'cached-candidates/batch-001.json'
    requested=[{'path':first.relative_to(ROOT).as_posix(),'sha256':sha(first)}]
    for p in plans:requested.extend(read(p)['batches'])
    entries=[];seen=set()
    for item in requested:
        p=ROOT/item['path']
        if sha(p)!=item['sha256']:raise ValueError('Frozen collection manifest changed')
        d=read(p);batch=d['batch']
        if batch in seen:raise ValueError('Duplicate batch label')
        seen.add(batch)
        counts={}
        for c in d['candidates']:counts[c['key']]=counts.get(c['key'],0)+1
        entries.append({'batch':batch,'manifestPath':p.relative_to(ROOT).as_posix(),'manifestSha256':sha(p),
            'receiptPath':(OUT/'receipts'/(batch+'.json')).relative_to(ROOT).as_posix(),
            'requestedCandidates':len(d['candidates']),'byCharacter':counts,
            'selectionReceipt':d['selectionReceipt']})
    collectors=[]
    for name in ['decode_batch.py','decode_batch_bulk.py','decode_batch_next.py']:
        p=OUT/name;collectors.append({'path':p.relative_to(ROOT).as_posix(),'sha256':sha(p)})
    result={'schema':'cast_collection_manifest_index_v1','entries':entries,
        'sourcePlans':[{'path':p.relative_to(ROOT).as_posix(),'sha256':sha(p)} for p in plans],
        'collectorVersions':collectors,
        'firstBatchLaunchPin':{'batch':'cached-sparse-001','collectorPath':collectors[0]['path'],
            'collectorSha256':collectors[0]['sha256'],'receiptLacksWorkerHash':True,
            'evidence':'Recorded before completion in Oct4 STATUS and coordinator message; original worker bytes remained unchanged while bulk/next versions were created separately.'},
        'readProtocol':'Use only an existing sealed receipt whose manifestSha256 matches this index and completed+errors accounts for requestedCandidates. Verify every source/receipt/audio hash independently. Later receipts bind workerSha256 to one listed collector. Receipt absence means pending, not failed or qualified.',
        'boundary':'Source collection lookup only; not qualification or training admission.'}
    output=OUT/'manifest-index-v1.json'
    encoded=json.dumps(result,indent=2)+'\n'
    if output.exists() and output.read_text(encoding='utf-8')!=encoded:raise ValueError('Preserve existing index; use a new version')
    if not output.exists():output.write_text(encoded,encoding='utf-8')
    print(json.dumps({'path':output.relative_to(ROOT).as_posix(),'sha256':sha(output),'batches':len(entries)}))

if __name__=='__main__':main()
