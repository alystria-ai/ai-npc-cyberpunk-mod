"""Two authorized exact voice-tag registries; isolated typed metadata, no source gate changes."""
from pathlib import Path
import hashlib,importlib.util,json,os,subprocess,sys
from datetime import datetime,timezone

OUT=Path(__file__).resolve().parent;ROOT=OUT.parents[3];GAME=Path('E:/SteamLibrary/steamapps/common/Cyberpunk 2077')
sys.dont_write_bytecode=True
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(name,pin):
    p=ROOT/'scripts'/name
    if sha(p)!=pin:raise ValueError('Pinned source changed')
    spec=importlib.util.spec_from_file_location(name.replace('.','_'),p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
CAST=load('Cast-VoiceReferenceCandidates.py','91c8c1ea1d7d5bfe1d2d3f54f6716040f9e43a108c3ec61ecc44e04f5c0a078a')
EXTRACT=load('Extract-VoiceReferences.py','565077b46ff96bfaf2a44dfd3addf792c1d2bf6b7eb9e14a68acf74a06f3144f')
catalog=json.loads((OUT/'catalog.json').read_text());catalog_sha=sha(OUT/'catalog.json')
targets=['base\\sound\\localization\\voicetaglist.voicetags','ep1\\sound\\localization\\voicetaglist.voicetags']
dest=OUT/'voice-tags';dest.mkdir(exist_ok=True)
if (dest/'receipt.json').exists():raise ValueError('Registry receipt already exists; preserve it')
assets=[]
with CAST.LaneLock(ROOT,'oct4-non-scene-registry',timeout=300),CAST.CpuSlots(ROOT,timeout=300):
    archives={}
    oodle=EXTRACT.Oodle(GAME/'tools/redmod/bin/oo2ext_7_win64.dll')
    for depot in targets:
        options=[r for r in catalog['resources'] if r['depotPath']==depot]
        if not options:raise ValueError('Exact catalog target absent')
        copies=[];data=None
        for row in options:
            relative=row['archivePath'];st=(GAME/relative).stat()
            archive_meta=next(a for a in catalog['archiveReceipts'] if a['archivePath']==relative)
            if (st.st_size,str(st.st_mtime_ns))!=(archive_meta['archiveBytes'],archive_meta['archiveMtimeNs']):raise ValueError('Catalog archive changed')
            if relative not in archives:archives[relative]=EXTRACT.Archive(GAME,relative)
            payload,receipt=archives[relative].read(depot,oodle)
            if receipt['archiveEntrySha1']!=row['archiveEntrySha1'] or len(payload)!=row['decodedBytes']:raise ValueError('Registry catalog identity mismatch')
            if data is not None and payload!=data:raise ValueError('Duplicate registry sources conflict; no winner inferred')
            data=payload;copies.append(receipt)
        raw=dest/depot.split(chr(92))[0]/'voicetaglist.voicetags';raw.parent.mkdir(exist_ok=True)
        if raw.exists():raise ValueError('Preserve existing unpublished raw registry')
        raw.write_bytes(data)
        assets.append({'depotPath':depot,'allInstalledCopies':copies,'identicalInstalledCopies':True,
            'rawPath':raw.relative_to(ROOT).as_posix(),'rawSha256':sha(raw),'rawSha1':hashlib.sha1(data).hexdigest()})
    cli=ROOT/'vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe'
    CAST.checked_hash(cli,CAST.WOLVENKIT_SHA256,'Pinned serializer')
    with (dest/'serialize.log').open('w',encoding='utf-8') as log:
        subprocess.run([str(cli),'convert','serialize',*[str(ROOT/a['rawPath']) for a in assets]],cwd=ROOT,
            env={**os.environ,'DOTNET_ROOT':str(ROOT/'vendor/dotnet-runtime-10.0.12'),'DOTNET_PROCESSOR_COUNT':'1'},
            stdout=log,stderr=subprocess.STDOUT,check=True,timeout=600,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    joins=[]
    for a in assets:
        raw=ROOT/a['rawPath'];p=raw.with_name(raw.name+'.json');doc=CAST.read_json(p)
        if Path(doc['Header']['ArchiveFileName']).resolve()!=raw.resolve():raise ValueError('Registry Header source mismatch')
        if sha(raw)!=a['rawSha256']:raise ValueError('Registry raw changed while serializing')
        root=doc['Data']['RootChunk']
        if root.get('$type')!='locVoiceTagListResource':raise ValueError('Expected typed voice-tag registry')
        for i,row in enumerate(root['voiceTags']):
            if row.get('$type')!='locVoiceTag':raise ValueError('Expected typed voice-tag row')
            ident=CAST.ident(row['id']);tag=row['voiceTag']
            if tag.get('$type')!='CName' or tag.get('$storage')!='string' or not isinstance(row['voicesetScenePath'],str):
                raise ValueError('Registry needs explicit tag and scene string')
            joins.append({'registryDepot':a['depotPath'],'pointer':f'/Data/RootChunk/voiceTags/{i}',
                'nativeVoiceId':ident,'voiceTag':tag['$value'],'voicesetScenePath':row['voicesetScenePath'],'isApuc':row['isApuc']})
        a.update(jsonPath=p.relative_to(ROOT).as_posix(),jsonSha256=sha(p),
            dataSha256=hashlib.sha256(json.dumps(doc['Data'],ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
            registryType=root['$type'],entries=len(root['voiceTags']),serializationVerified=True)
    receipt={'createdAt':datetime.now(timezone.utc).isoformat(),'complete':True,'catalogSha256':catalog_sha,
        'scope':'Typed registry metadata only; no canonical actor attribution, line qualification or training admission.',
        'toolSha256':CAST.WOLVENKIT_SHA256,'assets':assets}
    (dest/'id-tag-scene-joins.json').write_text(json.dumps({'sourceReceipt':str((dest/'receipt.json').relative_to(ROOT)),'joins':joins},indent=2)+'\n')
    receipt['joinsSha256']=sha(dest/'id-tag-scene-joins.json')
    (dest/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'complete':True,'registries':len(assets),'entries':len(joins),'receiptSha256':sha(dest/'receipt.json')}),flush=True)
