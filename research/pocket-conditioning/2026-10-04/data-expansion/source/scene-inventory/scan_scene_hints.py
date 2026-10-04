"""Discovery-only binary ID scan. --prepare probes cached bytes; --scan reads all exact scenes.

Matches never establish actor ownership, field type, line attribution or training
admission. This is a shortlist for subsequent authenticated native serialization.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse,hashlib,importlib.util,json,struct,sys,time

ROOT=Path(__file__).resolve().parents[3];OUT=Path(__file__).resolve().parent
GAME=Path('E:/SteamLibrary/steamapps/common/Cyberpunk 2077')
PINS={'Cast-VoiceReferenceCandidates.py':'91c8c1ea1d7d5bfe1d2d3f54f6716040f9e43a108c3ec61ecc44e04f5c0a078a',
      'Extract-VoiceReferences.py':'565077b46ff96bfaf2a44dfd3addf792c1d2bf6b7eb9e14a68acf74a06f3144f'}
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def module(name):
    path=ROOT/'scripts'/name
    if sha(path)!=PINS[name]:raise ValueError('Pinned discovery dependency changed: '+name)
    spec=importlib.util.spec_from_file_location(name.replace('.','_'),path)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
sys.dont_write_bytecode=True
CAST=module('Cast-VoiceReferenceCandidates.py');EXTRACT=module('Extract-VoiceReferences.py')
def prepare():
    dest=OUT/'binary-discovery';dest.mkdir(exist_ok=True)
    if (dest/'needles.json').exists():raise ValueError('Preserve frozen needle set; use its current preparation')
    authority=ROOT/'runtime/voice-data-expansion-20261004/roster-reservations/native-authority/authority-index.json'
    roster=ROOT/'characters/roster.json';sources=[];items={}
    # Freeze exact bytes before deriving patterns, since another research worker
    # may update the latest authority index while discovery runs.
    frozen={p:p.read_bytes() for p in [authority,roster,OUT/'inventory.json']}
    auth=json.loads(frozen[authority].decode('utf-8-sig'));charlist=json.loads(frozen[roster].decode('utf-8-sig'))
    def add(kind,key,value,record=None):
        value=int(value)
        if not 0<value<2**64:return
        ident=kind+':'+str(value)
        row=items.setdefault(ident,{'id':ident,'kind':kind,'uint64':str(value),'hexLittleEndian':struct.pack('<Q',value).hex(),'keys':[],'records':[]})
        if key not in row['keys']:row['keys'].append(key)
        if record and record not in row['records']:row['records'].append(record)
    authorities=auth['strong_authorities']+auth['scoped_hints']
    for a in authorities:
        if a.get('native_voicetag'):add('native-voicetag',a['key'],a['native_voicetag'])
        if a.get('canonical_record'):add('canonical-record',a['key'],CAST.tweakdbid(a['canonical_record']),a['canonical_record'])
    for c in charlist:
        for record in c.get('records',[]):add('canonical-record',c['key'],CAST.tweakdbid(record),record)
    for p in [authority,roster,OUT/'inventory.json']:
        copied=dest/('input-'+p.name)
        copied.write_bytes(frozen[p])
        sources.append({'path':p.relative_to(ROOT).as_posix(),'sha256':hashlib.sha256(frozen[p]).hexdigest(),'snapshot':copied.relative_to(ROOT).as_posix(),'snapshotSha256':sha(copied)})
        if sources[-1]['sha256']!=sources[-1]['snapshotSha256']:raise ValueError('Input changed while preparing')
    probes=[]
    for key in ['pepe-najarro','padre-ibarra','wakako-okada','regina-jones']:
        a=next(x for x in authorities if x['key']==key and x.get('native_voicetag'))
        scene=a['scene'];raw=ROOT/scene['rawPath'];data=raw.read_bytes()
        if hashlib.sha256(data).hexdigest()!=scene['rawSha256']:raise ValueError('Probe source changed')
        needle=struct.pack('<Q',int(a['native_voicetag']))
        probes.append({'key':key,'rawPath':scene['rawPath'],'rawSha256':scene['rawSha256'],'nativeVoicetag':a['native_voicetag'],
                       'firstOffset':data.find(needle),'occurrences':data.count(needle),'decodedBytes':len(data)})
    document={'schemaVersion':1,'scope':'DISCOVERY ONLY: untyped byte matches; not speaker or training admission.',
              'sourceHelpers':PINS,'inputs':sources,'needles':list(items.values()),'cachedByteProbes':probes}
    (dest/'needles.json').write_text(json.dumps(document,indent=2)+'\n')
    print(json.dumps({'stage':'prepared','needles':len(items),'probes':probes}),flush=True)
def scan():
    dest=OUT/'binary-discovery';needles_path=dest/'needles.json';document=read(needles_path)
    for source in document['inputs']:
        if sha(ROOT/source['snapshot'])!=source['snapshotSha256']:raise ValueError('Frozen discovery input changed')
    inventory=read(dest/'input-inventory.json')
    output=dest/'matches.jsonl'
    if output.exists():raise ValueError('Scan output already exists; preserve it')
    started=time.monotonic();patterns=[(n,bytes.fromhex(n['hexLittleEndian'])) for n in document['needles']]
    completed=matched=total_bytes=0
    with CAST.LaneLock(ROOT,'oct4-scene-inventory',timeout=300),CAST.CpuSlots(ROOT,timeout=300):
        archives={a['path']:EXTRACT.Archive(GAME,a['path']) for a in inventory['archives']}
        for a in inventory['archives']:
            stat=(GAME/a['path']).stat()
            if (stat.st_size,str(stat.st_mtime_ns))!=(a['bytes'],a['mtimeNs']):raise ValueError('Installed archive changed')
        oodle=EXTRACT.Oodle(GAME/'tools/redmod/bin/oo2ext_7_win64.dll')
        with output.open('w',encoding='utf-8') as stream:
            for entry in inventory['scenes']:
                if (dest/'STOP').exists():raise RuntimeError('Owned stop requested; preserve partial scan')
                result=archives[entry['archivePath']].read(entry['depotPath'],oodle)
                if result is None:raise ValueError('Planned native resource missing')
                data,receipt=result
                if receipt['archiveEntrySha1']!=entry['archiveEntrySha1'] or len(data)!=entry['decodedBytes']:
                    raise ValueError('Planned native payload identity mismatch')
                matches=[]
                for needle,pattern in patterns:
                    first=data.find(pattern)
                    if first>=0:matches.append({'needleId':needle['id'],'firstOffset':first,'occurrences':data.count(pattern)})
                row={'scene':entry['depotPath'],'archiveSource':receipt,'matched':bool(matches),'matches':matches}
                stream.write(json.dumps(row,separators=(',',':'))+'\n');stream.flush()
                completed+=1;matched+=bool(matches);total_bytes+=len(data)
                if completed%100==0:print(json.dumps({'stage':'discovery-scan','completed':completed,'total':len(inventory['scenes']),
                    'matchedScenes':matched,'decodedBytes':total_bytes,'elapsedSeconds':round(time.monotonic()-started,2)}),flush=True)
    summary={'complete':True,'scope':document['scope'],'scenes':completed,'matchedScenes':matched,'decodedBytes':total_bytes,
        'elapsedSeconds':round(time.monotonic()-started,3),'needlesSha256':sha(needles_path),'matchesSha256':sha(output),
        'scriptSha256':sha(Path(__file__)),'sourceHelpers':PINS,'createdAt':datetime.now(timezone.utc).isoformat()}
    (dest/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary),flush=True)
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);g=p.add_mutually_exclusive_group(required=True);g.add_argument('--prepare',action='store_true');g.add_argument('--scan',action='store_true')
    a=p.parse_args();prepare() if a.prepare else scan()
