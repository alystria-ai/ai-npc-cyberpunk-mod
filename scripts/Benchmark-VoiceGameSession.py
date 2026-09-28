"""Cold process-to-WAV and warm generation under the verified 60 FPS cap."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import re
import hashlib
import json
import os
import subprocess
import threading
import time
import psutil

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--label', required=True)
parser.add_argument('--fixed-view-confirmed', action='store_true')
parser.add_argument('--voxcpm-bounded', action='store_true')
parser.add_argument('--engines', nargs='+', choices=('omnivoice','chatterbox-nano','chatterbox-turbo','voxcpm2'),
                    default=['omnivoice','chatterbox-nano','chatterbox-turbo'],
                    help='VoxCPM2 is omitted by default after severe live FPS loss and GPU crashes during its startup/termination')
args = parser.parse_args()
if not re.fullmatch(r'[a-z0-9-]{1,36}', args.label):
    parser.error('Use a unique lowercase label of at most 36 characters')
LABEL = args.label
OUT = ROOT/'runtime/voice-comparison'/LABEL
OUT.mkdir(exist_ok=False)
HIDDEN = subprocess.CREATE_NO_WINDOW
CANCEL = OUT/'stop-request.json'
phase = 'baseline'
stop = threading.Event()
FIELDS = ['memory.total','memory.used','utilization.gpu','temperature.gpu','power.draw',
          'clocks.current.graphics','clocks.current.memory','pstate']
games = [{'pid':p.pid,'created':p.create_time()} for p in psutil.process_iter(['name'])
         if (p.info['name'] or '').lower()=='cyberpunk2077.exe']
assert games, 'Game is not running'

def now(): return datetime.now(timezone.utc).isoformat()

def settings():
    raw = (Path(os.environ['LOCALAPPDATA'])/'CD Projekt Red/Cyberpunk 2077/UserSettings.json').read_bytes()
    data = json.loads(raw)
    result = {'sha256':hashlib.sha256(raw).hexdigest(),
              'options':{g['group_name']:{o['name']:o.get('value') for o in g.get('options',[])}
                         for g in data['data'] if any(t in g['group_name'].lower()
                         for t in ('graphics','video','display','resolution'))}}
    flat = {k:v for g in result['options'].values() for k,v in g.items()}
    assert flat['MaximumFPS_OnOff'] is True and flat['MaximumFPS_Value']==60, '60 FPS cap is not applied'
    assert flat['QuickPresets']=='Ray Tracing Ultra', 'Graphics preset changed'
    return result

def gpu():
    r = subprocess.run(['nvidia-smi','--query-gpu='+','.join(FIELDS),'--format=csv,noheader,nounits'],
                       capture_output=True,text=True,creationflags=HIDDEN,timeout=5,check=True)
    return dict(zip(FIELDS,[v.strip() for v in r.stdout.splitlines()[0].split(',')]))

context = {'startedUtc':now(),'label':LABEL,'userReportedPerformanceProfile':'Turbo',
           'performanceProfileIndependentlyVerified':False,'gameProcesses':games,
           'fixedViewConfirmedByUser':args.fixed_view_confirmed,
           'requestedEngines':args.engines,
           'excludedEngines':[] if 'voxcpm2' in args.engines else ['voxcpm2'],
           'runnerScriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
           'settingsBefore':settings(), 'engines':[],
           'benchmarkScriptSha256':hashlib.sha256((ROOT/'scripts/Benchmark-VoiceListening.py').read_bytes()).hexdigest(),
           'coldDefinition':'Fresh worker process, no resident speech model. Weights and prepared references remain on disk. Parent times process launch to first saved-WAV receipt, including imports, loading, reference preparation and generation. OS file cache is not flushed.',
           'warmDefinition':'Two additional renders from the same loaded model, after the first finished audio.',
           'telemetryNote':'Whole-GPU samples every two seconds. Fixed view is user-confirmed, not input-enforced. Game focus and actual FPS are not measured.'}

def save():
    (OUT/'run-context.json').write_text(json.dumps(context,indent=2)+'\n',encoding='utf-8')

def monitor_gpu():
    with (OUT/'gpu-telemetry.jsonl').open('x',encoding='utf-8') as f:
        while not stop.is_set():
            row = {'utc':now(),'phase':phase,'gameRunning':any(psutil.pid_exists(g['pid']) for g in games)}
            if not row['gameRunning'] and not CANCEL.exists():
                CANCEL.write_text('Game exited; cancel between GPU operations.\n',encoding='utf-8')
            try: row['gpu']=gpu()
            except Exception as error: row['error']=str(error)
            f.write(json.dumps(row)+'\n'); f.flush()
            stop.wait(2)

save()
monitor = threading.Thread(target=monitor_gpu,daemon=True)
monitor.start()
try:
    time.sleep(3)
    cases = [('omnivoice',32),('omnivoice',16),('chatterbox-nano',None),
             ('chatterbox-turbo',None),('voxcpm2',10)]
    cases = [(engine,steps) for engine,steps in cases if engine in args.engines]
    for engine,steps in cases:
        if CANCEL.exists():
            context['cancelled']=True
            break
        assert any(psutil.pid_exists(g['pid']) for g in games), 'Game exited; stop comparisons'
        settings()
        phase = f'{engine}-{steps}' if steps else engine
        child_label = LABEL + ('-16' if engine=='omnivoice' and steps==16 else '')
        python = ROOT / ('vendor/chatterbox-env/Scripts/python.exe' if engine.startswith('chatterbox')
                         else 'vendor/reference-voicestudio/.venv/Scripts/python.exe')
        cmd = [str(python),str(ROOT/'scripts/Benchmark-VoiceListening.py'),'--engine',engine,
               '--label',child_label,'--original-line','3743548582201815040','--record-first-render',
               '--stop-file',str(CANCEL)]
        if engine=='omnivoice': cmd += ['--omni-steps',str(steps)]
        if engine=='voxcpm2' and args.voxcpm_bounded: cmd += ['--voxcpm-bounded']
        row = {'engine':engine,'steps':steps,'phase':phase,'startedUtc':now(),'gpuBefore':gpu(),
               'reportPath':str(ROOT/'runtime/voice-comparison'/child_label/engine/'report.json')}
        context['engines'].append(row); save()
        print(json.dumps({'phase':phase,'status':'starting fresh worker'}),flush=True)
        with (OUT/f'{phase}.stdout.log').open('x',encoding='utf-8') as output, \
             (OUT/f'{phase}.stderr.log').open('x',encoding='utf-8') as errors:
            began = time.perf_counter()
            child = subprocess.Popen(cmd,cwd=ROOT,stdout=subprocess.PIPE,stderr=errors,text=True,
                                     encoding='utf-8',errors='replace',creationflags=HIDDEN,
                                     env=dict(os.environ,PYTHONUTF8='1'))
            row['pid']=child.pid; save()
            for line in child.stdout:
                output.write(line); output.flush()
                try: receipt=json.loads(line)
                except (ValueError,TypeError): continue
                if receipt.get('run')==0 and receipt.get('path') and 'generationSeconds' in receipt:
                    row['coldProcessToWavSeconds']=time.perf_counter()-began
                    row['coldWavReceipt']=receipt
                    row['ownedChildren']=[{'pid':p.pid,'created':p.create_time()} for p in psutil.Process(child.pid).children(recursive=True)]
                    save()
                    print(json.dumps({'phase':phase,'coldProcessToWavSeconds':row['coldProcessToWavSeconds']}),flush=True)
            code=child.wait()
            row['processLifetimeSeconds']=time.perf_counter()-began
        row.update(exitCode=code,endedUtc=now())
        phase += '-released'
        time.sleep(3)
        row['gpuAfterExit']=gpu()
        row['ownedProcessesRemaining']=[]
        for owned in row.get('ownedChildren',[])+[{'pid':child.pid,'created':None}]:
            try:
                p=psutil.Process(owned['pid'])
                if owned['created'] is None or p.create_time()==owned['created']:
                    row['ownedProcessesRemaining'].append(owned['pid'])
            except psutil.NoSuchProcess: pass
        save()
        print(json.dumps({'phase':phase,'exitCode':code,'ownedProcessesRemaining':row['ownedProcessesRemaining']}),flush=True)
        if CANCEL.exists():
            context['cancelled']=True
            break
        assert code==0 and 'coldProcessToWavSeconds' in row, f'{engine} failed'
        assert not row['ownedProcessesRemaining'], 'An owned worker did not release before the next model'
    context['completed']=len(context['engines'])==len(cases) and not context.get('cancelled',False)
finally:
    stop.set(); monitor.join(timeout=7)
    context['endedUtc']=now()
    context['settingsAfter']=settings()
    save()
