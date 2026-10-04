"""Metadata-only installed path discovery; no payload exports or identity inference."""
from pathlib import Path
import hashlib,importlib.util,json,os,re,subprocess,sys
from datetime import datetime,timezone

OUT=Path(__file__).resolve().parent;ROOT=OUT.parents[3]
GAME=Path('E:/SteamLibrary/steamapps/common/Cyberpunk 2077')
sys.dont_write_bytecode=True
helper=ROOT/'scripts/Cast-SceneEvidence.py'
if hashlib.sha256(helper.read_bytes()).hexdigest()!='7ee22566b73d61cf9f8a9613ef5db9cfca3dcd2fe4c8f020bfd13de06871e36a':raise ValueError('Source helper changed')
spec=importlib.util.spec_from_file_location('oct4_registry_scene',helper);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
cli,runtime,tool=m.tools(ROOT)
archives=['archive/pc/content/audio_1_general.archive','archive/pc/ep1/audio_1_general.archive',
 'archive/pc/content/basegame_1_engine.archive','archive/pc/content/basegame_4_gamedata.archive','archive/pc/ep1/ep1_2_gamedata.archive']
pattern=r'(?i)(voicetag|voiceset|voiceover|bark|localization|voice)'
resources=[];receipts=[]
for i,relative in enumerate(archives):
    archive=GAME/relative;log=OUT/(f'paths-{i:02d}.log')
    if log.exists():raise ValueError('Preserve prior discovery listing; do not overwrite')
    with m.CpuSlots(ROOT,timeout=300):
        stat=archive.stat();index=m.read_archive_index(archive)
        with log.open('w',encoding='utf-8') as output:
            subprocess.run([str(cli),'archive',str(archive),'--list','--regex',pattern],cwd=ROOT,
                env={**os.environ,'DOTNET_ROOT':str(runtime),'DOTNET_PROCESSOR_COUNT':'1'},
                stdout=output,stderr=subprocess.STDOUT,check=True,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    listed=[]
    for line in log.read_text(encoding='utf-8-sig').splitlines():
        path=line.strip().lower().replace('/','\\')
        if not path.startswith(('base\\','ep1\\','engine\\')):continue
        key=str(m.knowledge.fnv(path,64))
        if key not in index:raise ValueError('Listed resource missing from current directory')
        if path.endswith(('.scene','.wem','.animset')):continue
        listed.append({'depotPath':path,'archivePath':relative,'pathHash64':key,**index[key]})
    receipt={'archivePath':relative,'archiveBytes':stat.st_size,'archiveMtimeNs':str(stat.st_mtime_ns),
        'listingSha256':m.digest(log),'nonSceneRegistryHints':len(listed)}
    resources+=listed;receipts.append(receipt)
    (OUT/f'catalog-{i:02d}.json').write_text(json.dumps({'scope':'Directory metadata only; no payload or speaker admission','archive':receipt,'resources':listed},indent=2)+'\n')
    print(json.dumps(receipt),flush=True)
(OUT/'catalog.json').write_text(json.dumps({'createdAt':datetime.now(timezone.utc).isoformat(),
    'scope':'Directory metadata only; no payload exports or canonical speaker admission','tool':tool,
    'archiveReceipts':receipts,'resources':resources},indent=2)+'\n')
print(json.dumps({'complete':True,'resources':len(resources)}),flush=True)
