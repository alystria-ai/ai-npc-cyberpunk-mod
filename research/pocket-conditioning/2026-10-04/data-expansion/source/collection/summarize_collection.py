"""Summarize sealed raw collection only; never imply independent qualification."""
from collections import defaultdict
from pathlib import Path
import hashlib,json

OUT=Path(__file__).resolve().parent
ROOT=OUT.parents[2]

def main():
    seen={}; receipts=[]; failures=[]
    for p in sorted((OUT/'receipts').glob('*.json')):
        d=json.loads(p.read_text(encoding='utf-8'))
        receipts.append({'path':p.relative_to(ROOT).as_posix(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),
            'batch':d['batch'],'completed':len(d['completed']),'failed':len(d['errors']),'seconds':d['elapsedSeconds']})
        failures.extend(d['errors'])
        for r in d['completed']:
            token=(r['key'],r['wemSha256'])
            seen.setdefault(token,r)
    chars=defaultdict(lambda:{'uniqueOriginals':0,'recordingSeconds':0.0,'pcm':set(),'sourceRoleProtected':0})
    for (key,_),row in seen.items():
        c=chars[key];c['uniqueOriginals']+=1;c['recordingSeconds']+=row['durationSeconds'];c['pcm'].add(row['pcmSha256'])
        c['sourceRoleProtected']+=int(row['roleReservation']['protected_for_new_train'])
    for c in chars.values():c['uniquePcm']=len(c.pop('pcm'));c['recordingSeconds']=round(c['recordingSeconds'],3)
    result={'schema':'oct4_collected_raw_progress_v1','boundary':'New raw source originals only; includes silence, not independent wording/alignment/codec qualification or usable training duration.',
        'completedBatches':len(receipts),'uniqueOriginals':len(seen),'recordingSeconds':round(sum(c['recordingSeconds'] for c in chars.values()),3),
        'byCharacter':dict(sorted(chars.items())),'receipts':receipts,'failures':failures,'trainingAdmitted':False}
    pending=OUT/'progress.pending.json';pending.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8');pending.replace(OUT/'progress.json')
    print(json.dumps({k:v for k,v in result.items() if k not in ('receipts','failures')},indent=2))

if __name__=='__main__':main()
