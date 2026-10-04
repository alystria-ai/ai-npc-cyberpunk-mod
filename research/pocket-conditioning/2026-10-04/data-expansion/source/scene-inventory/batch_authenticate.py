"""Batch equivalent of Cast.authenticate_serialization; call OUTSIDE existing CPU locks.

This only authenticates serialization. Callers must still perform installed archive
winner/raw authentication and every actor/line/localization check normally. Returned
tuple-key mapping may seed Cast's verified memo; its entry point rechecks source
hashes and Header even on memo hits. No speaker identity is asserted here.
"""
from pathlib import Path
import hashlib, importlib.util, json, os, shutil, subprocess, sys, uuid

ROOT=Path(__file__).resolve().parents[3]
CAST_SHA='91c8c1ea1d7d5bfe1d2d3f54f6716040f9e43a108c3ec61ecc44e04f5c0a078a'

def batchauthenticate(project, out, scenes):
    project,out=Path(project).resolve(),Path(out).resolve()
    own_root=project/'runtime/voice-data-expansion-20261004'
    if project!=ROOT or not out.is_relative_to(own_root.resolve()):raise ValueError('Batch output must be owned Oct4 output')
    if not isinstance(scenes,(list,tuple)) or not 1<=len(scenes)<=32:raise ValueError('Require 1..32 exact native resources')
    helper=project/'scripts/Cast-VoiceReferenceCandidates.py'
    if hashlib.sha256(helper.read_bytes()).hexdigest()!=CAST_SHA:raise ValueError('Source validator changed; review before use')
    spec=importlib.util.spec_from_file_location('oct4_batch_cast',helper)
    cast=importlib.util.module_from_spec(spec)
    previous=sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode=True
        spec.loader.exec_module(cast)
    finally:sys.dont_write_bytecode=previous
    with cast.CpuSlots(project,timeout=300):
        cli=project/'vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe'
        cast.checked_hash(cli,cast.WOLVENKIT_SHA256,'Pinned native serializer')
        out.mkdir(parents=True,exist_ok=True)
        stage=out/('native-auth-'+uuid.uuid4().hex)
        if stage.resolve()!=stage.absolute() or not stage.is_relative_to(out):raise ValueError('Redirected stage')
        stage.mkdir()
        jobs=[]; total=0
        def inputs(scene):
            raw=cast.project_file(scene['rawPath'],project)
            serialized=cast.project_file(scene['jsonPath'],project)
            cast.checked_hash(raw,scene['rawSha256'],'Current native raw')
            cast.checked_hash(raw,scene['entrySha1'],'Current native entry','sha1')
            cast.checked_hash(serialized,scene['jsonSha256'],'Current native JSON')
            expected=cast.read_json(serialized)
            if Path(expected['Header']['ArchiveFileName']).resolve()!=raw:raise ValueError('Current native JSON original Header source mismatch')
            data_hash=hashlib.sha256(json.dumps(expected['Data'],ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()
            if scene.get('dataSha256') is not None and scene['dataSha256']!=data_hash:raise ValueError('Current dependency Data differs')
            return raw,expected
        for i,scene in enumerate(scenes):
            raw,expected=inputs(scene)
            total+=raw.stat().st_size
            if total>256*1024**2:raise ValueError('Native copied input exceeds256MiB')
            extension=raw.suffix.lower()
            if extension not in {'.scene','.community','.quest','.questphase','.gamedef','.json'}:raise ValueError('Unsupported native resource')
            copied=stage/(str(i)+extension)
            shutil.copyfile(raw,copied)
            cast.checked_hash(copied,scene['rawSha256'],'Copied native scene')
            jobs.append((scene,copied,expected))
        env={**os.environ,'DOTNET_ROOT':str(project/'vendor/dotnet-runtime-10.0.12'),'DOTNET_PROCESSOR_COUNT':'1'}
        with (stage/'serialize.log').open('w',encoding='utf-8') as log:
            subprocess.run([str(cli),'convert','serialize',*[str(j[1]) for j in jobs]],cwd=project,env=env,
                stdout=log,stderr=subprocess.STDOUT,check=True,timeout=600,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        verified={}
        for scene,copied,expected in jobs:
            inputs(scene) # Inputs must remain unchanged throughout serialization.
            cast.checked_hash(copied,scene['rawSha256'],'Serialized native raw')
            actual=cast.read_json(copied.with_name(copied.name+'.json'))
            if Path(actual['Header']['ArchiveFileName']).resolve()!=copied or actual['Data']!=expected['Data']:
                raise ValueError('Cached actor/line JSON differs from authenticated native serialization')
            receipt={'verified':True,'tool':'WolvenKit.CLI 9.0.1','toolSha256':cast.WOLVENKIT_SHA256,
                'rawSha256':scene['rawSha256'],'cachedJsonSha256':scene['jsonSha256'],
                'dataSha256':hashlib.sha256(json.dumps(actual['Data'],ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()}
            verified[(scene['rawSha256'],scene['jsonSha256'])]=receipt
        cast.write_json(stage/'receipts.json',{'sourceHelperSha256':CAST_SHA,'batchHelperSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'scope':'Native serialization only; no installed winner or actor identity admission',
            'resources':[{'scene':s,'serializationVerification':verified[(s['rawSha256'],s['jsonSha256'])]} for s,_,_ in jobs]})
        return verified
