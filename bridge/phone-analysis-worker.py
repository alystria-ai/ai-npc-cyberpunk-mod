"""Owned resident acoustic analysis. It never supplies playback samples."""
import argparse
import base64
import hashlib
import json
import sys
import time
import os
import threading
from pathlib import Path

ENGINE='pocketsphinx-5.0.4-allphone-live'
FORMAT='pocketsphinx-allphone-live-v1'
WORKER_OWNER=None

def sha(value):
    return hashlib.sha256(value).hexdigest()

class AnalysisResampler:
    """24k -> 48k causal low-pass -> 16k; carry phase/filter state."""
    delay_seconds=30/48000
    def __init__(self):
        self.taps=firwin(61,1/3)*2
        self.state=np.zeros(60)
        self.expanded_frames=0
    def push(self,audio):
        expanded=np.zeros(audio.size*2)
        expanded[::2]=audio
        filtered,self.state=lfilter(self.taps,[1.],expanded,zi=self.state)
        first=(-self.expanded_frames)%3
        self.expanded_frames+=expanded.size
        return np.clip(np.rint(filtered[first::3]*32767),-32768,32767).astype('<i2').tobytes()

def identity(value):
    owner=value.get('owner')
    if not isinstance(owner,dict) or not isinstance(owner.get('requestId'),str) or not owner['requestId'] \
       or not isinstance(owner.get('entity'),str) or not owner['entity'] \
       or type(owner.get('generation')) is not int or not 0<=owner['generation']<=2147483647 \
       or any(len(owner[key])>128 or any(ord(char)<32 or ord(char)==127 for char in owner[key]) for key in ('requestId','entity')):
        raise ValueError('Missing analysis owner')
    return {key:owner[key] for key in ('requestId','entity','generation')}

def emit(value):
    sys.stdout.write(json.dumps(dict(workerOwner=WORKER_OWNER,**value),separators=(',',':'),allow_nan=False)+'\n')
    sys.stdout.flush()

def validated_config(path):
    raw=path.read_bytes()
    config=json.loads(raw)
    if config.get('version')!=1 or config.get('engine')!=ENGINE or config.get('format')!=FORMAT:
        raise ValueError('Wrong phone-analysis configuration')
    runtime=config.get('runtime',{})
    for key in ('pythonExecutable','workerPath','dependencyDirectory','acousticModelDirectory','phoneModelPath'):
        value=runtime.get(key)
        if not isinstance(value,str) or not Path(value).is_absolute():raise ValueError('Phone-analysis paths must be explicit')
    if Path(runtime['workerPath']).resolve()!=Path(__file__).resolve() \
       or Path(runtime['pythonExecutable']).resolve()!=Path(sys.executable).resolve():
        raise ValueError('Phone-analysis executable changed')
    files=config.get('files')
    if not isinstance(files,list) or not 8<=len(files)<=64:raise ValueError('Missing phone-analysis manifest')
    for item in files:
        file=Path(item['path'])
        if not file.is_absolute() or not file.is_file() or file.is_symlink():raise ValueError('Invalid phone-analysis asset')
        if item['kind'] in ('python','worker','phone-model'):
            target=runtime[{'python':'pythonExecutable','worker':'workerPath','phone-model':'phoneModelPath'}[item['kind']]]
            if file.resolve()!=Path(target).resolve():raise ValueError('Phone-analysis asset root changed')
        elif item['kind'] in ('dependency','acoustic'):
            target=Path(runtime['dependencyDirectory' if item['kind']=='dependency' else 'acousticModelDirectory']).resolve()
            if not file.resolve().is_relative_to(target):raise ValueError('Phone-analysis asset escaped its root')
        else:raise ValueError('Unknown phone-analysis asset')
        content=file.read_bytes()
        if len(content)!=item['bytes'] or sha(content)!=item['sha256']:raise ValueError('Phone-analysis asset identity changed')
    if config.get('dependency')!={'name':'pocketsphinx','version':'5.0.4'}:raise ValueError('Wrong phone-analysis dependency')
    return config,sha(raw)

def watch_parent(parent_pid,stop):
    if os.name=='nt':
        import ctypes
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.argtypes=[ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong]
        kernel.OpenProcess.restype=ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes=[ctypes.c_void_p,ctypes.c_ulong]
        kernel.CloseHandle.argtypes=[ctypes.c_void_p]
        handle=kernel.OpenProcess(0x00100000,False,parent_pid)
        if not handle:os._exit(0)
        try:
            while not stop.wait(.25):
                if kernel.WaitForSingleObject(handle,0)==0:os._exit(0)
        finally:kernel.CloseHandle(handle)
    else:
        while not stop.wait(.25):
            try:os.kill(parent_pid,0)
            except ProcessLookupError:os._exit(0)

def run(config,config_sha):
    global np,firwin,lfilter
    runtime=config['runtime']
    sys.path.insert(0,runtime['dependencyDirectory'])
    began=time.perf_counter()
    import numpy as np
    import scipy
    from scipy.signal import firwin,lfilter
    from pocketsphinx import Decoder
    import pocketsphinx
    if np.__version__!=config['scientific']['numpy'] or scipy.__version__!=config['scientific']['scipy'] \
       or not Path(pocketsphinx.__file__).resolve().is_relative_to(Path(runtime['dependencyDirectory']).resolve()):
        raise ValueError('Phone-analysis dependency resolved outside its prepared identity')
    imports_ms=(time.perf_counter()-began)*1000
    began=time.perf_counter()
    decoder=Decoder(hmm=runtime['acousticModelDirectory'],allphone=runtime['phoneModelPath'],
        lm=None,dict=None,allphone_ci=True,lw=.8,dither=False,cmn='live',remove_noise=False,
        samprate=16000,frate=100,beam=1e-20,pbeam=1e-20,loglevel='FATAL')
    initial_cmn=decoder.get_cmn()
    init_ms=(time.perf_counter()-began)*1000
    emit(dict(version=1,type='ready',engine=ENGINE,format=FORMAT,configSha256=config_sha,
        importsMs=imports_ms,decoderInitMs=init_ms,workerPid=os.getpid(),device='cpu',gpuVramBytes=0,
        runtime=runtime,files=config['files'],scientific=config['scientific'],defaultModelsDisabled=True,
        frontend=dict(inputSampleRate=24000,analysisSampleRate=16000,frameRate=100,cmn='live',
            dither=False,removeNoise=False,resampler='causal-fir61-up2-down3',resamplerDelaySeconds=AnalysisResampler.delay_seconds)))
    active=None
    command_index=0
    def end_active():
        nonlocal active
        if active is not None:
            decoder.end_utt()
            active=None
    try:
        for raw in sys.stdin:
            if len(raw)>1_000_000:raise ValueError('Oversized analysis command')
            command=json.loads(raw)
            if command.get('version')!=1 or command.get('workerOwner')!=WORKER_OWNER:
                raise ValueError('Phone-analysis process owner changed')
            if type(command.get('id')) is not int or command['id']!=command_index+1:
                raise ValueError('Phone-analysis command sequence changed')
            command_index=command['id']
            result=dict(version=1,id=command.get('id'),engine=ENGINE)
            try:
                action=command.get('command')
                if action=='shutdown':
                    end_active();emit({**result,'type':'stopped'});return
                owner=identity(command)
                if action=='start':
                    if active is not None:raise ValueError('Another analysis owner is active')
                    decoder.set_cmn(initial_cmn)
                    decoder.start_utt()
                    active=dict(owner=owner,index=0,frames=0,resampler=AnalysisResampler())
                    emit({**result,'type':'started','owner':owner});continue
                if active is None or active['owner']!=owner:raise ValueError('Stale analysis owner')
                if action=='cancel':
                    end_active();emit({**result,'type':'cancelled','owner':owner});continue
                if action=='finish':
                    duration=active['frames']/24000
                    decoder.end_utt()
                    segments=[] if decoder.hyp() is None else [dict(phone=segment.word,startFrame=segment.start_frame,
                        endFrame=segment.end_frame) for segment in decoder.seg()]
                    active=None
                    emit({**result,'type':'finished','owner':owner,'duration':duration,'segments':segments});continue
                if action!='packet':raise ValueError('Unknown analysis command')
                index,offset,frames=command.get('index'),command.get('offsetFrames'),command.get('frames')
                if type(index) is not int or type(offset) is not int or index!=active['index']+1 \
                   or offset!=active['frames'] or type(frames) is not int \
                   or frames<1 or frames>96000 or offset+frames>24000*120:
                    raise ValueError('Invalid analysis PCM sequence')
                pcm_bytes=base64.b64decode(command['pcm'],validate=True)
                if len(pcm_bytes)!=frames*4:raise ValueError('Wrong analysis PCM length')
                audio=np.frombuffer(pcm_bytes,dtype='<f4')
                if not np.isfinite(audio).all():raise ValueError('Non-finite analysis PCM')
                began=time.perf_counter()
                analysis=active['resampler'].push(audio)
                decoder.process_raw(analysis,False,False)
                segments=[] if decoder.hyp() is None else [dict(phone=segment.word,startFrame=segment.start_frame,
                    endFrame=segment.end_frame) for segment in decoder.seg()]
                active['index']=index;active['frames']+=frames
                emit({**result,'type':'phones','owner':owner,'index':index,'receivedFrames':active['frames'],
                    'audioEndSeconds':active['frames']/24000,'decodedFrames':decoder.n_frames(),
                    'analysisMs':(time.perf_counter()-began)*1000,'pcmSha256':sha(pcm_bytes),'segments':segments})
            except Exception as error:
                emit({**result,'type':'error','error':str(error)})
    finally:
        end_active()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=Path,required=True)
    parser.add_argument('--owner',required=True)
    parser.add_argument('--parent-pid',type=int,required=True)
    args=parser.parse_args()
    if len(args.owner)!=32 or any(char not in '0123456789abcdef' for char in args.owner) or args.parent_pid<1:
        raise ValueError('Invalid phone-analysis parent owner')
    WORKER_OWNER=args.owner
    stop=threading.Event()
    watchdog=threading.Thread(target=watch_parent,args=(args.parent_pid,stop),daemon=True)
    watchdog.start()
    try:
        config,config_sha=validated_config(args.config)
        run(config,config_sha)
    except Exception:
        emit(dict(version=1,type='fatal',engine=ENGINE,error='Resident phone analysis is unavailable'))
        sys.exit(1)
    finally:
        stop.set()
        watchdog.join(timeout=1)
