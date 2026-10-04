"""Candidate role join only: a clear result is NOT source/audio/train admission."""
import json
from pathlib import Path
import re
import unicodedata

def norm(text):
    return re.sub(r'[^\w]+',' ',unicodedata.normalize('NFKC',text or '').casefold()).strip()

class Reservations:
    def __init__(self,path=None):
        self.path=Path(path or Path(__file__).with_name('role-reservations.json'))
        d=json.loads(self.path.read_text(encoding='utf-8'))
        self.ids=set(d['exact_reserved_ids'])
        self.hashes={k:set(v) for k,v in d['exact_reserved_hashes'].items()}
        self.nodes={n for c in d['components'] if c['protectedForTraining'] for n in c['nodes']}
        self.roles={}
        for r in d['roleByIdentity'].values():
            i=r['identity']; self.roles.setdefault((i['key'],i['localizationId']),[]).append(r)
        self.eval_texts={(r['speaker_id'],r['canonical_text']) for r in d['heldout_rows'] if r['canonical_text']}
        self.train_ids={r['id'].split('/')[0]+'/'+r['id'].split('/')[1] for r in d['historical_train_rows']+d['current_pilot_train_rows'] if r.get('id')}
        self.train_hashes={kind:{(r['speaker_id'],r[field]) for r in d['historical_train_rows']+d['current_pilot_train_rows'] if r.get(field)} for kind,field in [('wem','source_wem_sha256'),('wav','wav_sha256'),('pcm','pcm_sha256')]}

    def check(self,*,speaker_id,localization_id,gender_variant=None,delivery_scenes=(),wem_depot=None,wem_sha256=None,wav_sha256=None,pcm_sha256=None,text=None):
        """Supply delivery scenes only (never identity-only anchor scenes)."""
        rid=f'{speaker_id}/{localization_id}'
        retained_train=any(value and (speaker_id,value) in self.train_hashes[kind] for kind,value in [('wem',wem_sha256),('wav',wav_sha256),('pcm',pcm_sha256)])
        reasons=[]
        if rid in self.ids: reasons.append('exact_reserved_id')
        nodes={'id:'+rid}
        for kind,value in [('wem',wem_sha256),('wav',wav_sha256),('pcm',pcm_sha256)]:
            if value:
                nodes.add(kind+':'+value)
                if value in self.hashes[kind]: reasons.append('exact_reserved_'+kind)
        for scene in delivery_scenes: nodes.add('scene:'+scene.lower().replace('/','\\'))
        if wem_depot: nodes.add('wem-depot:'+wem_depot.lower().replace('/','\\'))
        matched=sorted(nodes & self.nodes)
        if matched and not retained_train: reasons.append('protected_delivery_component')
        inherited_exposure=[]
        for r in self.roles.get((speaker_id,str(localization_id)),[]):
            if gender_variant and r['identity'].get('localizationVariant') != gender_variant: continue
            if r['protectedForNextTrain']:
                row_reasons=set(r['reasons'])
                same_role_only={'original_mandatory_eval_scene_or_reused_recording_component','genuine_new_heldout_scene_or_reused_recording_component','archive_only_matches_original_accepted1744_no_added_exposure'}
                if retained_train and row_reasons <= same_role_only: inherited_exposure.extend(row_reasons)
                else: reasons.append('finalized_role_protected')
        if text and (speaker_id,norm(text)) in self.eval_texts: reasons.append('same_speaker_evaluation_caption_duplicate')
        return {'protected_for_new_train':bool(reasons),'reasons':sorted(set(reasons)),
                'protected_component_node_matches':matched,'historical_train_id':rid in self.train_ids,
                'exact_historical_train_recording':bool(retained_train),'historical_train_scene_exposure':sorted(set(inherited_exposure)),
                'training_admitted':False,'boundary':'role reservation only; independent source, wording, audio, alignment and codec gates remain required'}
