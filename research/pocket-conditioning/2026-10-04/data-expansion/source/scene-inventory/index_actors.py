"""Discovery index of exact authenticated scene actor/line joins; no identity admission."""
from pathlib import Path
import hashlib,json,time
from collections import Counter

ROOT=Path(__file__).resolve().parents[3]; OUT=Path(__file__).resolve().parent
def walk(value,pointer='/Data/RootChunk'):
    if isinstance(value,dict):
        yield pointer,value
        for k,v in value.items():yield from walk(v,pointer+'/'+str(k).replace('~','~0').replace('/','~1'))
    elif isinstance(value,list):
        for i,v in enumerate(value):yield from walk(v,pointer+'/'+str(i))
rows=[]
for receipt_path in sorted((OUT/'exports').glob('*/receipts/*.json')):
    scene=json.loads(receipt_path.read_text())
    raw=ROOT/scene['rawPath']; source=ROOT/scene['jsonPath']
    if hashlib.sha256(raw.read_bytes()).hexdigest()!=scene['rawSha256']:raise ValueError('Raw changed')
    if hashlib.sha256(source.read_bytes()).hexdigest()!=scene['jsonSha256']:raise ValueError('JSON changed')
    doc=json.loads(source.read_text(encoding='utf-8-sig'))
    if Path(doc['Header']['ArchiveFileName']).resolve()!=raw.resolve():raise ValueError('Source header differs')
    root=doc['Data']['RootChunk']
    actors=root.get('actors',[]); lines=root.get('screenplayStore',{}).get('lines',[])
    event_lines=Counter(str(v.get('screenplayLineId',{}).get('id')) for p,v in walk(root) if v.get('$type')=='scnDialogLineEvent')
    for n,actor in enumerate(actors):
        if actor.get('$type')!='scnActorDef':continue
        actor_id=str(actor.get('actorId',{}).get('id'))
        spoken=[(i,l) for i,l in enumerate(lines) if l.get('$type')=='scnscreenplayDialogLine' and str(l.get('speaker',{}).get('id'))==actor_id]
        if not spoken:continue
        active_field={'spawnDespawn':'spawnDespawnParams','findInContext':'findActorInContextParams'}.get(actor.get('acquisitionPlan'))
        active_record=actor.get(active_field,{}).get('specRecordId') if active_field else None
        rows.append({'scene':scene,'actorPointer':f'/Data/RootChunk/actors/{n}',
            'actorId':actor_id,'actorName':actor.get('actorName'),'voicetagId':str(actor.get('voicetagId',{}).get('id')),
            'acquisitionPlan':actor.get('acquisitionPlan'),'lineCount':len(spoken),
            'activeRecordPointer':f'/Data/RootChunk/actors/{n}/{active_field}/specRecordId' if active_field else None,
            'activeRecord':active_record,
            'eventJoinedLineCount':sum(bool(event_lines[str(l.get('itemId',{}).get('id'))]) for i,l in spoken),
            'lines':[{'pointer':f'/Data/RootChunk/screenplayStore/lines/{i}','itemId':str(l.get('itemId',{}).get('id')),
                      'locstringId':str(l.get('locstringId',{}).get('ruid'))} for i,l in spoken]})
document={'scope':'Discovery only. Native actor names/voicetags are exact; no canonical character mapping inferred.',
    'indexerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'sourceSceneCount':len(set(r['scene']['depotPath'] for r in rows)),
    'actorRows':len(rows),'totalSceneLines':sum(r['lineCount'] for r in rows),
    'uniqueVoicetagLocstringPairs':len({(r['voicetagId'],l['locstringId']) for r in rows for l in r['lines']}),
    'actors':rows}
pending=OUT/'actor-discovery.pending.json';latest=OUT/'actor-discovery.json'
pending.write_text(json.dumps(document,indent=2)+'\n')
for attempt in range(20):
    try:pending.replace(latest);break
    except PermissionError:
        if attempt==19:raise
        time.sleep(.1)
print(json.dumps({k:v for k,v in document.items() if k!='actors'}))
