"""Typed registry-to-existing-authority discovery links; no new speaker admission."""
from pathlib import Path
import hashlib,json
from collections import defaultdict

OUT=Path(__file__).resolve().parent;ROOT=OUT.parents[3]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
receipt_path=OUT/'voice-tags/receipt.json';receipt=read(receipt_path)
joins_path=OUT/'voice-tags/id-tag-scene-joins.json'
if not receipt['complete'] or sha(joins_path)!=receipt['joinsSha256']:raise ValueError('Typed registry joins changed')
authority_path=ROOT/'runtime/voice-data-expansion-20261004/roster-reservations/native-authority/authority-index.json'
data=authority_path.read_bytes();authority=json.loads(data.decode('utf-8-sig'))
snapshot=OUT/'authority-input.json'
if snapshot.exists():raise ValueError('Preserve discovery authority snapshot')
snapshot.write_bytes(data)
by_id=defaultdict(list)
for group in ['strong_authorities','scoped_hints']:
    for i,row in enumerate(authority[group]):
        if row.get('native_voicetag'):
            by_id[row['native_voicetag']].append({'key':row['key'],'authorityClass':row['authority_class'],
                'authorityPointer':f'/{group}/{i}','actorPointer':row['actor_pointer'],'actorScene':row['scene']['depotPath'],
                'canonicalRecord':row.get('canonical_record')})
inventory=read(OUT.parent/'inventory.json');scene_index={r['depotPath']:r for r in inventory['scenes']}
linked=[];pending_named=[]
all_joins=read(joins_path)['joins']
for row in all_joins:
    refs=by_id.get(row['nativeVoiceId'],[])
    path=row['voicesetScenePath'].replace('/','\\').lower()
    if refs:
        linked.append({**row,'existingAuthorityReferences':refs,'currentSceneDirectoryEntry':scene_index.get(path),
            'canonicalSpeakerAdmitted':False,'status':'typed-registry-discovery-only'})
    elif row['voiceTag'] in {'8ug8ear','jake_estevez'}:
        pending_named.append({**row,'status':'registry-declared-tag-without-current-actor-authority',
            'canonicalSpeakerAdmitted':False,'nextStep':'Search exact registry ID in native payloads, then authenticate active actor and dialogue joins.'})
doc={'schemaVersion':1,'scope':'Typed ID/tag/path registry linked to preexisting actor evidence for discovery. No WEM-name ownership or new actor admission.',
    'registryReceiptSha256':sha(receipt_path),'authorityInputSha256':sha(snapshot),
    'linkedRegistryRows':len(linked),'linkedCharacterKeys':sorted({r['key'] for x in linked for r in x['existingAuthorityReferences']}),
    'links':linked,'pendingNamedRegistryHints':pending_named}
(OUT/'registry-authority-shortlist.json').write_text(json.dumps(doc,indent=2)+'\n')
print(json.dumps({'linkedRegistryRows':len(linked),'linkedCharacterKeys':len(doc['linkedCharacterKeys']),
    'explicitVoicesetScenes':len({x['voicesetScenePath'] for x in linked if x['voicesetScenePath']}),
    'pendingNamedRegistryHints':pending_named},indent=2))
