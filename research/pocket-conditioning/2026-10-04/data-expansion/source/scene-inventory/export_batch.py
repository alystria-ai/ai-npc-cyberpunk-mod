"""One exact Oct4 inventory batch, authenticated native serialization, one CPU slot."""
from pathlib import Path
from datetime import datetime, timezone
import argparse, hashlib, importlib.util, json, re, sys

ROOT=Path(__file__).resolve().parents[3]
OUT=Path(__file__).resolve().parent
GAME=Path('E:/SteamLibrary/steamapps/common/Cyberpunk 2077')
PIN='7ee22566b73d61cf9f8a9613ef5db9cfca3dcd2fe4c8f020bfd13de06871e36a'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
helper=ROOT/'scripts/Cast-SceneEvidence.py'
if sha(helper)!=PIN:raise ValueError('Native source helper changed; review before exporting')
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('scene_export_oct4',helper)
scene=importlib.util.module_from_spec(spec)
spec.loader.exec_module(scene)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--batch',required=True)
    args=parser.parse_args()
    inventory=OUT/'inventory.json'; plan_path=OUT/'batch-plan.json'
    plan=json.loads(plan_path.read_text()); source=json.loads(inventory.read_text())
    if plan['inventorySha256']!=sha(inventory):raise ValueError('Plan inventory hash mismatch')
    chosen=[b for b in plan['batches'] if b['batch']==args.batch]
    if len(chosen)!=1 or not re.fullmatch(r'priority-[0-9]{3}',args.batch):raise ValueError('Unknown exact batch')
    batch=chosen[0]; depots=scene.allowlist(batch['scenePaths'])
    out=OUT/'exports'/args.batch
    if out.resolve()!=out.absolute() or not out.resolve().is_relative_to(OUT.resolve()):raise ValueError('Redirected output')
    cli,runtime,tool=scene.tools(ROOT)
    with scene.LaneLock(ROOT,'oct4-scene-inventory',timeout=300), scene.CpuSlots(ROOT,timeout=300):
        for archive in source['archives']:
            stat=(GAME/archive['path']).stat()
            if (stat.st_size,str(stat.st_mtime_ns))!=(archive['bytes'],archive['mtimeNs']):raise ValueError('Installed archive identity changed')
        assets,missing,decoded=scene.resolve_winners(GAME,out,depots,256*1024**2)
        expected={r['depotPath']:r for r in batch['sources']}
        for a in assets:
            e=expected[a['depotPath']]
            if any(a[k]!=e[k] for k in ['archivePath','archiveEntrySha1','decodedBytes']):raise ValueError('Installed native winner changed')
        if missing:raise ValueError('Planned installed scenes are now missing')
        manifest={'version':1,'schemaVersion':1,'createdAt':datetime.now(timezone.utc).isoformat(),
            'scope':'Exact Oct4 native scene discovery; no speaker admission, audio decoding or frozen corpus writes.',
            'lane':'oct4-scene-inventory','batch':args.batch,'tool':tool,'helperSha256':PIN,
            'planSha256':sha(plan_path),'sourceInventorySha256':sha(inventory),
            'exporterSha256':sha(Path(__file__).resolve()),
            'precedence':[a[0] for a in scene.ARCHIVES],'requestedPaths':depots,'missingPaths':[],
            'winnerCount':len(assets),'assetCount':len(assets),'totals':{'decodedBytes':decoded},
            'assets':assets,'complete':False,'status':'metadata_verified'}
        out.mkdir(parents=True,exist_ok=True)
        pending=out/'inventory-pending.json'; completed=out/'inventory.json'
        prior=completed if completed.exists() else pending
        old=scene.read_json(prior) if prior.exists() else None
        if old and (scene.fingerprint(old)!=scene.fingerprint(manifest) or old.get('planSha256')!=manifest['planSha256']):
            raise ValueError('Existing batch baseline differs; preserve it and create a new plan')
        job=scene.SceneJob(ROOT,out,cli,runtime,1024*1024**2,600)
        old_by_path={a['depotPath']:a for a in old['assets']} if old else {}
        scene.knowledge.write_json(pending,manifest)
        progress=out/'progress.jsonl'
        def emit(row):
            row={'at':datetime.now(timezone.utc).isoformat(),'batch':args.batch,**row}
            with progress.open('a',encoding='utf-8') as stream:stream.write(json.dumps(row)+'\n')
            print(json.dumps(row),flush=True)
        try:
            for archive,relative in scene.ARCHIVES:
                selected=[a for a in assets if a['archive']==archive]
                absent=[a for a in selected if not (out/a['rawPath']).exists()]
                if absent:
                    root=out/'raw'/archive; root.mkdir(parents=True,exist_ok=True)
                    pattern='^('+'|'.join(re.escape(a['depotPath']) for a in absent)+')$'
                    emit({'stage':'extracting','archive':archive,'count':len(absent)})
                    job.run(['extract',GAME/relative,'--outpath',root,'--regex',pattern],'extract-'+archive)
                to_serialize=[]
                for a in selected:
                    scene.verify_raw(out,a)
                    previous=old_by_path.get(a['depotPath'],{})
                    serialized=out/a['jsonPath']
                    if serialized.exists() and not previous.get('jsonSha256'):
                        raise ValueError('Orphan serialization lacks baseline; preserve and use a new batch')
                    if not serialized.exists():to_serialize.append(out/a['rawPath'])
                if to_serialize:
                    emit({'stage':'serializing-exact-files','archive':archive,'count':len(to_serialize)})
                    job.run(['convert','serialize',*to_serialize],'serialize-'+archive+'-exact-files')
                for a in selected:
                    previous=old_by_path.get(a['depotPath'],{})
                    scene.verify_serialized(out,a,previous.get('jsonSha256'))
                    scene.knowledge.write_json(pending,manifest)
                    receipt=scene.scene_receipts(ROOT,out,{'assets':[a]})[0]
                    scene.knowledge.write_json(out/'receipts'/(a['pathHash64']+'.json'),receipt)
                    emit({'stage':'serialized_verified','scene':a['depotPath'],'completed':sum(x.get('serializationVerified',False) for x in assets),'total':len(assets)})
            manifest.update(complete=True,status='serialized_verified')
            emit({'stage':'publishing-completed-receipts','resources':len(assets),'decodedBytes':decoded})
            scene.publish_completed(ROOT,out,manifest,job)
            print(json.dumps({'at':datetime.now(timezone.utc).isoformat(),'batch':args.batch,'stage':'complete','resources':len(assets),'decodedBytes':decoded}),flush=True)
        except BaseException:
            manifest.update(complete=False,status='failed_or_interrupted')
            for a in assets:
                for k in ['assetSha256','jsonSha256','sha1Verified','serializationVerified']:
                    if k not in a and k in old_by_path.get(a['depotPath'],{}):a[k]=old_by_path[a['depotPath']][k]
            scene.knowledge.write_json(pending,manifest)
            raise
if __name__=='__main__':main()
