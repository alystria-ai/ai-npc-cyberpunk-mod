"""Proposal only: resolve the declared scene-local holo execution bit.

This predicate does not admit candidates or replace the production mirror gate.
The independent primary identity, exact one-recipient Full/Holocall role, actor
ID, native voice, acquisition, original registry MAIN and English checks remain.
"""

def resolve_holo_execution_tag(document, event):
    entries=document['Data']['RootChunk'].get('executionTagEntries',[])
    if not isinstance(entries,list):raise ValueError('Scene execution tag table must be explicit')
    declared=[]
    for index,row in enumerate(entries):
        if not isinstance(row,dict) or row.get('$type')!='scnExecutionTagEntry':
            raise ValueError('Malformed native execution tag declaration')
        name=row.get('name',{})
        if not isinstance(name,dict) or name.get('$type')!='CName' or name.get('$storage')!='string' or not isinstance(name.get('$value'),str):
            raise ValueError('Execution tag name is not an exact native CName')
        flags=row.get('flags')
        if type(flags) is not int or not 1<=flags<=255 or flags & (flags-1):
            raise ValueError('Execution tag must declare one nonzero uint8 bit')
        declared.append((index,name['$value'],flags))
    matching=[r for r in declared if r[1]=='holo']
    if len(matching)!=1:raise ValueError('Require exactly one native holo declaration')
    index,name,flags=matching[0]
    if any(other_flags==flags and other_index!=index for other_index,_,other_flags in declared):
        raise ValueError('Holo bit is also assigned to another scene tag')
    observed=event.get('additionalSpeakers',{}).get('executionTag')
    if type(observed) is not int or observed!=flags:
        raise ValueError('Additional speaker tag does not exactly select declared holo')
    return {'name':'holo','flags':flags,'declarationPointer':f'/Data/RootChunk/executionTagEntries/{index}',
            'additionalSpeakersExecutionTag':observed,'resolution':'exact_scene_local_named_single_bit',
            'runtimeRouteObserved':False}
