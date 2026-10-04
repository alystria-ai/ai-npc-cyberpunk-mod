from pathlib import Path
import json, hashlib, re
from collections import Counter

OUT=Path(__file__).resolve().parent
source=OUT/'inventory.json'
data=json.loads(source.read_text())
remaining={r['depotPath']:r for r in data['scenes'] if not r['cachedSerializationFound']}
patterns={
 'jackie':r'jackie|\\prologue\\q00[0135]\\',
 'mr-hands':r'mr_hands|call_hands|hands_briefing',
 'regina':r'regina|reggie|\\fixers\\regina_jones\\',
 'pepe':r'pepe|sq018_04b_valentinos_el_coyote',
 'songbird':r'songbird|\\q30[146]\\',
 'wakako':r'wakako|\\q112\\',
 'padre':r'padre|\\sq018\\',
}
def rank(p):
    return ('\\versions\\' in p, 'test' in p,
            not any(w in p for w in ['jackie','hands','reggie','regina','pepe','songbird','wakako','padre']),
            any(w in p for w in ['holocall','voiceset','vset_','combat','blackwall']),p)
queues={k:sorted([p for p in remaining if re.search(v,p)],key=rank) for k,v in patterns.items()}
ordered=[]
# Interleave discovery hints; they establish priority, never speaker identity.
while any(queues.values()):
    for key,queue in queues.items():
        while queue and queue[0] not in remaining:queue.pop(0)
        if queue:
            p=queue.pop(0)
            ordered.append({**remaining.pop(p),'discoveryHint':key})
ordered += [{**remaining[p],'discoveryHint':'remaining-native-scenes'} for p in sorted(remaining,key=rank)]
batches=[]
for i in range(0,len(ordered),32):
    rows=ordered[i:i+32]
    batches.append({'batch':f'priority-{i//32+1:03d}','scenePaths':[r['depotPath'] for r in rows],
        'decodedBytes':sum(r['decodedBytes'] for r in rows),'storedBytes':sum(r['storedBytes'] for r in rows),
        'hints':dict(Counter(r['discoveryHint'] for r in rows)),
        'sources':[{k:r[k] for k in ['depotPath','archivePath','archiveEntrySha1','decodedBytes','discoveryHint']} for r in rows]})
plan={'schemaVersion':1,'inventorySha256':hashlib.sha256(source.read_bytes()).hexdigest(),
 'scope':'Exact path discovery ordering only; names and filenames never establish actor attribution.',
 'batches':batches}
(OUT/'batch-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
print(json.dumps({'batches':len(batches),'scenes':len(ordered),'first':batches[0]},indent=2))
