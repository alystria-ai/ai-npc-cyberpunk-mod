"""Scoped source coverage, not usable-speech qualification or global exhaustion."""
from pathlib import Path
from collections import Counter,defaultdict
import hashlib,json

ROOT=Path(__file__).resolve().parents[3]
BASE=ROOT/'runtime/voice-data-expansion-20261004'
OUT=Path(__file__).resolve().parent
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()

def main():
    roster=read(BASE/'roster-reservations/cast-roster.json')
    index=read(OUT/'manifest-index-v3.json')
    planned=Counter()
    for e in index['entries']:planned.update(e['byCharacter'])
    collected=defaultdict(dict);errors=[]
    for p in (OUT/'receipts').glob('*.json'):
        d=read(p);errors.extend(d['errors'])
        for r in d['completed']:collected[r['key']].setdefault(r['wemSha256'],r)
    hints_path=BASE/'scene-inventory/binary-discovery/key-counts.json'
    hint_document=read(hints_path)
    hints=hint_document.get('characters',[])
    if isinstance(hints,dict):hints=[{'key':k,**v} for k,v in hints.items()]
    hints={x.get('key'):x for x in hints if isinstance(x,dict)}
    special={
        'pepe-najarro':'A separate explicitly registered generic Valentino voice-family pool is NOT counted as Pepe dialogue or performer-equivalent training.',
        'mr-hands':'Base/EP1 and versioned performer lineage remains separate; character-level raw totals do not authorize a performer merge.',
        '8ug8ear':'A new native registry voice ID was found after the original scene byte-pattern scan; absence in that earlier scan is not exhaustion.',
        'jake-estevez':'A new native registry voice ID was found after the original scene byte-pattern scan; canonical utterance attribution remains unresolved.',
        'resident-male':'Generic runtime profile has no single canonical speaker or approved generic-cast collection policy.',
        'resident-female':'Generic runtime profile has no single canonical speaker or approved generic-cast collection policy.',
        'fingers':'No new independently established typed-record authority in this round; prior TRAIN retains its existing role.',
        'rosalind-myers':'No new independently established typed-record authority in this round; prior TRAIN retains its existing role.'}
    rows=[]
    for r in roster['characters']:
        key=r['key'];raw=list(collected[key].values());seconds=sum(x['durationSeconds'] for x in raw)
        baseline=r['selected_duration_seconds']
        rows.append({'key':key,'name':r['name'],'tier':r['tier'],'priorPilotClips':r['selected_pilot_rows'],
            'priorPilotRecordingSeconds':baseline,'newOriginalsCollected':len(raw),'newRecordingSeconds':round(seconds,3),
            'plannedNewRecordings':planned[key],'pendingNewRecordings':max(0,planned[key]-len(raw)),
            'priorEligibleExtraRows':r.get('unused_qualified_pool_rows',0),
            'priorAvailableOriginals':r.get('prior_available_unique_originals',0),
            'floorState':'Final corpus assembly owns actual available TRAIN/usable-span coverage, including the full retained prior pool; pilot counts are not that pool.',
            'discoveryHints':hints.get(key),
            'scopeLimitation':special.get(key,'This fixed collection round is not an exhaustive proof that the installed game has no additional dialogue.')})
    result={'schema':'fixed_scope_cast_coverage_v2','scope':'105 cached batches +14 fresh scene batches +5 Regina batches +12 approved Tier1 gap batches; no open-ended additional discovery.',
        'plannedRecordings':sum(planned.values()),'newUniqueOriginals':sum(len(v) for v in collected.values()),
        'newRecordingSeconds':round(sum(x['durationSeconds'] for v in collected.values() for x in v.values()),3),
        'characters':rows,'sourceErrors':errors,
        'notExhaustion':'The scene scan, actor joins and registries have explicit coverage limits. Uncollected/unauthenticated leads are held, not proof of no game speech.',
        'notQualification':'A 300-second recording sum is not a claim of300usable training seconds. Final role, codec, timing and transcript-policy admission is separate.'}
    text=json.dumps(result,indent=2)+'\n';tmp=OUT/'coverage-current.pending.json';tmp.write_text(text,encoding='utf-8');tmp.replace(OUT/'coverage-current.json')
    lines=['# Fixed-round source coverage','',result['scope'],'',
        f"Planned: **{result['plannedRecordings']} recordings**. Collected: **{result['newUniqueOriginals']} new originals / {result['newRecordingSeconds']/60:.2f} recording minutes**.",'',
        '**Recording duration includes silence and is not final usable training duration.** Prior pilot counts are historical context, not the full available training pool. Final corpus assembly separately measures all retained qualified TRAIN originals, including Panam’s499 recordings; this report does not infer floor gaps from the capped pilot. No character is declared globally source-exhausted.','',
        '| Character | Tier | Prior pilot seconds (historical) | New original seconds | New collected / planned | Prior eligible extra rows |',
        '|---|---:|---:|---:|---:|---:|']
    for r in rows:lines.append(f"| {r['name']} | {r['tier']} | {r['priorPilotRecordingSeconds']:.1f} | {r['newRecordingSeconds']:.1f} | {r['newOriginalsCollected']} / {r['plannedNewRecordings']} | {r['priorEligibleExtraRows']} |")
    lines+=['','## Scope limits','',result['notExhaustion'],'']
    lines += [f"- **{next(r['name'] for r in rows if r['key']==key)}:** {note}" for key,note in special.items()]
    (OUT/'COVERAGE_CURRENT.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps({'planned':result['plannedRecordings'],'collected':result['newUniqueOriginals'],
        'floorCoverageOwner':'final_corpus_assembly; use actual qualified aligned spans, not capped pilot counts'}))

if __name__=='__main__':main()
