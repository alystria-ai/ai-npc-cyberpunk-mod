"""Reuse existing authenticated language-map receipts; metadata only, no extraction."""
from pathlib import Path
import hashlib,importlib.util,json,sys
from collections import Counter,defaultdict

OUT=Path(__file__).resolve().parent;ROOT=OUT.parents[3]
GAME=Path('E:/SteamLibrary/steamapps/common/Cyberpunk 2077');sys.dont_write_bytecode=True
p=ROOT/'scripts/native_source_contracts.py'
if hashlib.sha256(p.read_bytes()).hexdigest()!='46aef2aaecd6ecd23cad9c7d214da440c3e4fd37754405cec3153aefb6e93ddb':raise ValueError('Reviewed source contracts changed')
spec=importlib.util.spec_from_file_location('oct4_non_scene_contracts',p);c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
extract=c.extract_module();archive_paths=[*extract.ARCHIVES,'archive/pc/content/audio_1_general.archive',
    'archive/pc/content/basegame_4_gamedata.archive','archive/pc/ep1/ep1_2_gamedata.archive']
indexes={relative:extract.Archive(GAME,relative) for relative in archive_paths}
bundle='runtime/voice-data-expansion-20261003/source-admission-review/bank-experiment-complete-01.json'
reader=c.NativeSourceContracts(ROOT,bundle,indexes)
counts=[]
for path,doc in reader.native_docs.items():
    root=doc['Data']['RootChunk']['root']['Data']
    counts.append({'depotPath':path,'type':root['$type'],'entries':len(root.get('entries',[])),
                   'asset':reader.assets[path]})
by_bank=defaultdict(lambda:{'bindings':0,'stringIds':set(),'resourcePaths':set()})
for (sid,variant,bank),values in reader.registrations.items():
    by_bank[bank]['bindings']+=1;by_bank[bank]['stringIds'].add(sid)
    by_bank[bank]['resourcePaths'].update(x['resourcePath'] for x in values)
summary={'scope':'Existing cached raw/JSON/hash receipts and CURRENT installed directory winners rechecked. No fresh serialization or actor attribution.',
    'sourceContractsSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'sourceBundle':bundle,'sourceBundleSha256':c.PINNED_BUNDLE,
    'banks':{k:{n:len(v) if isinstance(v,set) else v for n,v in row.items()} for k,row in by_bank.items()},
    'registryEnglishEntry':reader.registry_entry,'quarantinedRegistrationBranches':len(reader.quarantined_entries),'maps':counts,
    'newCanonicalSpeakerAssignments':0,'trainingAdmitted':False}
(OUT/'existing-map-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({'banks':summary['banks'],'quarantinedRegistrationBranches':summary['quarantinedRegistrationBranches'],
    'maps':[{k:v for k,v in r.items() if k!='asset'} for r in counts]},indent=2))
