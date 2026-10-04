"""Regina-only world-to-holocall authority guard for the isolated collector.

Metadata planning does not claim archive/serializer authentication. The collector
must call authenticate() while holding the existing Cast CPU lease before any
audio access, and preserve the returned authority receipt with the raw source.
"""
import hashlib,json
from pathlib import Path

PACKET_PATH='runtime/voice-data-expansion-20261004/cached-candidates/regina-expansion/holo-world-authority-proposal.json'
PACKET_SHA256='952542790130e1dd84eead03e629324fb94c98573d96636f05cd0df55bcebe60'
BRIDGE_SHA256='8a48fcdf9a830578894ba9c3df9e43539c549654d396a8358edb66ea3470ba57'
CONTRACT_SHA256='fba35101148333f4fc008deaad93483da6ca59a97c1caaeaa2cd43cd45e7fadc'
POLICY='regina_verified_primary_holocall_world_continuity_v1'

def _sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def _same_physical_source(left,right):
    # A metadata snapshot can relocate the manifest declaration, never the
    # original resource, parser output, depot, winning archive, or their hashes.
    return {k:v for k,v in left.items() if k!='manifestPath'}=={k:v for k,v in right.items() if k!='manifestPath'}

def _unique_actor(document,pointer,api):
    actor=api['pointer'](document,pointer)
    if actor.get('$type')!='scnActorDef':raise ValueError('Authority pointer is not a typed native actor')
    actor_id=api['ident'](actor['actorId']['id'])
    matches=[a for a in document['Data']['RootChunk'].get('actors',[]) if api['ident'](a['actorId']['id'])==actor_id]
    if len(matches)!=1:raise ValueError('Authority actor ID is not unique in its native source')
    return actor

def metadata(candidate,project,api):
    """Recheck the full proposed world edge without archive decompression."""
    project=Path(project).resolve()
    if candidate.get('key')!='regina-jones':raise ValueError('This authority is scoped to Regina only')
    declaration=candidate.get('canonicalHoloAuthority')
    if not isinstance(declaration,dict) or declaration.get('policy')!=POLICY or declaration.get('packetPath')!=PACKET_PATH or declaration.get('packetSha256')!=PACKET_SHA256:
        raise ValueError('Explicit frozen canonical holo authority declaration required')
    guard_path=Path(__file__).resolve()
    if declaration.get('guardPath')!=guard_path.relative_to(project).as_posix() or declaration.get('guardSha256')!=_sha(guard_path):
        raise ValueError('Canonical holo authority guard bytes changed')
    packet_path=api['project_file'](PACKET_PATH,project)
    if _sha(packet_path)!=PACKET_SHA256:raise ValueError('Frozen holo-world authority packet changed')
    packet=json.loads(packet_path.read_text(encoding='utf-8-sig'))
    for dep in packet['evidenceInputs']:
        if _sha(api['project_file'](dep['path'],project))!=dep['sha256']:raise ValueError('Authority evidence input changed: '+dep['path'])
    bridge=api['recovery_bridge']()
    if _sha(bridge.__file__)!=BRIDGE_SHA256 or _sha(bridge.contracts.__file__)!=CONTRACT_SHA256:
        raise ValueError('Authority requires the exact isolated corrected contract')
    roster={r['key']:r for r in api['read_json'](project/'characters/roster.json')}
    canonical=roster['regina-jones']
    mirror_candidate=packet['validatedMirrorSource']['candidate']
    native=api['validate_native'](mirror_candidate,canonical,project)
    mirror=native.get('sourceRecovery',{}).get('mirrorRouting')
    if not mirror or not mirror['primaryIdentity'].get('canonicalIdentityCheckedIndependentlyOfMap'):
        raise ValueError('Authority requires independently attributed primary plus native mirror routing')
    mirror_doc=api['validate_native_source'](mirror_candidate['scene'],project)
    _unique_actor(mirror_doc,mirror_candidate['actor']['pointer'],api)
    _unique_actor(mirror_doc,mirror['review']['mirrorActorPointer'],api)
    secondary=mirror['mirrorActorDefinition'];declared=packet['nativeDeclaredSecondary']
    if secondary!=declared['actor'] or secondary.get('acquisitionPlan')!='spawnSet' or secondary['spawnSetParams']!=declared['activeAcquisition'] or api['ident'](secondary['voicetagId']['id'])!=declared['nativeVoice']:
        raise ValueError('Validated native secondary differs from reviewed holo-world actor')
    expected=packet['proposedNamedAnchor'];proof=candidate['actor']['identityProof']
    if proof.get('kind')=='reviewed_native_actor_continuity':
        anchor=proof['continuity']['anchor'];anchor_scene=anchor['scene'];anchor_pointer=anchor['actorPointer']
    elif proof.get('kind')=='reviewed_actor_alias':
        # Only the exact reviewed named anchor may bootstrap itself; generic
        # target actors must use the existing two-source continuity contract.
        anchor_scene=candidate['scene'];anchor_pointer=candidate['actor']['pointer']
    else:raise ValueError('Unexpected canonical holo actor proof family')
    if not _same_physical_source(anchor_scene,expected['scene']) or anchor_pointer!=expected['actorPointer']:
        raise ValueError('Canonical holo source is not the independently reviewed named anchor')
    anchor_doc=api['validate_native_source'](anchor_scene,project);anchor_actor=_unique_actor(anchor_doc,anchor_pointer,api)
    if anchor_actor['actorName'].casefold()!='regina' or anchor_actor.get('acquisitionPlan')!='spawnSet' or anchor_actor['spawnSetParams']!=secondary['spawnSetParams'] or api['ident'](anchor_actor['voicetagId']['id'])!=api['ident'](secondary['voicetagId']['id']):
        raise ValueError('Named anchor does not match the verified secondary acquisition and voice')
    target_doc=api['validate_native_source'](candidate['scene'],project);target_actor=_unique_actor(target_doc,candidate['actor']['pointer'],api)
    identity=api['validate_identity'](target_actor,proof,canonical,target_doc,project,candidate['scene'],candidate['actor']['pointer'])
    if target_actor.get('acquisitionPlan')!='spawnSet' or target_actor['spawnSetParams']!=secondary['spawnSetParams'] or api['ident'](target_actor['voicetagId']['id'])!=api['ident'](secondary['voicetagId']['id']):
        raise ValueError('Target acquisition or voice differs from verified native holo secondary')
    return {'policy':POLICY,'packetSha256':PACKET_SHA256,'guardSha256':_sha(guard_path),'mirrorCandidate':mirror_candidate,
            'mirrorNative':native,'anchorScene':anchor_scene,'targetScene':candidate['scene'],'targetIdentity':identity,
            'nativeVoice':declared['nativeVoice'],'metadataOnly':True,'canonicalRecordEdgeClaimed':False,'canonicalRecordEdgeVerified':False,
            'mirrorEdge':{'source':mirror_candidate['scene'],'primaryActorPointer':mirror_candidate['actor']['pointer'],
                          'secondaryActorPointer':mirror['review']['mirrorActorPointer'],'eventPointer':mirror_candidate['event']['pointer'],
                          'primaryActor':mirror['primaryActorDefinition'],'secondaryActor':secondary,
                          'nativeMirrorReview':mirror['review'],'namedAnchorSource':anchor_scene,'namedAnchorPointer':anchor_pointer,
                          'targetSource':candidate['scene'],'targetPointer':candidate['actor']['pointer']}}

def authenticate(candidate,project,out,scene_archives,verified,api):
    """Authenticate the entire primary→mirror→named anchor→target chain."""
    if not api['CpuSlots'].held_by_this_process():raise RuntimeError('Canonical holo guard requires the existing CPU lease')
    project=Path(project).resolve();out=Path(out).resolve()
    if not out.is_relative_to(project/'runtime/voice-data-expansion-20261004'):
        raise ValueError('Canonical holo guard output must stay in the new collection workspace')
    plan=metadata(candidate,project,api);bridge=api['recovery_bridge']();mirror=plan['mirrorCandidate'];mirror_proof=mirror['actor']['identityProof']
    auth=bridge.authenticate(plan['mirrorNative']['sourceRecovery'],project,out,scene_archives,verified,api)
    primary_continuity=None
    if mirror_proof.get('kind')=='reviewed_native_actor_continuity':
        primary_continuity=api['authenticate_native_continuity'](mirror_proof,project,out,scene_archives,verified)
    elif mirror_proof.get('kind')!='direct_actor_record':
        raise ValueError('Authority primary must retain the reviewed two-source or direct-record proof')
    proof=candidate['actor']['identityProof'];target_continuity=None
    if proof['kind']=='reviewed_native_actor_continuity':
        target_continuity=api['authenticate_native_continuity'](proof,project,out,scene_archives,verified)
    else:
        api['verify_live_scene'](candidate['scene'],scene_archives)
        target_continuity={'namedAnchorSerialization':api['authenticate_serialization'](candidate['scene'],project,out,verified)}
    return {'policy':POLICY,'packetSha256':plan['packetSha256'],'guardSha256':plan['guardSha256'],
            'nativeVoice':plan['nativeVoice'],'nativeMirrorAuthentication':auth,'primaryContinuityAuthentication':primary_continuity,
            'targetContinuityAuthentication':target_continuity,'metadataOnly':False,'currentInstalledSourcesAuthenticated':True,
            'mirrorEdge':plan['mirrorEdge'],'canonicalRecordEdgeClaimed':False,'canonicalRecordEdgeVerified':False,'trainingAdmitted':False}
