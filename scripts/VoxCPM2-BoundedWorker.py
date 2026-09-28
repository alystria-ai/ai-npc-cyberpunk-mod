"""Experimental VoiceStudio sidecar with bounded CUDA allocation.

Same VoxCPM2 weights and speech settings. Reference/audio conversion and the
local feature encoder stay on CPU; the speech transformer/decoder use CUDA.
This process-local experiment does not modify the vendor source or game.
"""
from pathlib import Path
import importlib.util
import json
import os
import subprocess
import sys
import threading
import time

ROOT=Path(__file__).resolve().parents[1]
source=ROOT/'vendor/reference-voicestudio/backend/engines/voxcpm2_subprocess/main.py'
spec=importlib.util.spec_from_file_location('stock_voxcpm_sidecar',source)
stock=importlib.util.module_from_spec(spec)
spec.loader.exec_module(stock)
metrics={}
metrics_path=Path(os.environ['CONVAI_VOX_METRICS'])
stop_path=Path(os.environ['CONVAI_VOX_STOP'])

def save():
    metrics_path.write_text(json.dumps(metrics,indent=2)+'\n',encoding='utf-8')

def check_stop():
    if stop_path.exists():
        raise RuntimeError('Bounded VoxCPM2 cancelled between GPU operations')

def load(stdout):
    if stock._MODEL is not None:
        return stock._MODEL
    import torch
    from torch.utils._pytree import tree_map,tree_leaves
    from voxcpm import VoxCPM
    from voxcpm.model.voxcpm2 import VoxCPM2Model
    torch.set_num_threads(4)
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA is required for the speech model')
    result=subprocess.run(['nvidia-smi','--query-gpu=memory.total,memory.used','--format=csv,noheader,nounits'],
                          capture_output=True,text=True,check=True,creationflags=subprocess.CREATE_NO_WINDOW)
    total,used=map(float,result.stdout.splitlines()[0].split(','))
    budget=min(4300,total-used-1024)
    if budget<4000:
        raise RuntimeError(f'Not enough current GPU headroom for bounded test: {total-used:.0f} MiB free')
    torch.cuda.set_per_process_memory_fraction(budget/total)
    metrics.update(cudaBudgetMiB=budget,wholeGpuBeforeMiB=used,contextTokens=1024,
                   startupWarmup=False,cpuModules=['audio_vae','feat_encoder','base_lm.embed_tokens'],
                   cpuThreads=4,weightsQuantized=False,cudaDevice=torch.cuda.get_device_name())
    save()

    def keep_cpu(module,methods,copy_output):
        apply=module._apply
        def cpu_apply(fn,recurse=True):
            probe=fn(torch.empty(0,device='cpu'))
            if probe.device.type=='cuda':
                return module
            return apply(fn,recurse=recurse)
        module._apply=cpu_apply
        for name in methods:
            original=getattr(module,name)
            def forward(*args,_original=original,**kwargs):
                check_stop()
                tensors=[x for x in tree_leaves((args,kwargs)) if isinstance(x,torch.Tensor)]
                destination=tensors[0].device if tensors else torch.device('cpu')
                to_cpu=lambda x:x.to('cpu') if isinstance(x,torch.Tensor) else x
                out=_original(*tree_map(to_cpu,args),**tree_map(to_cpu,kwargs))
                if copy_output:
                    out=tree_map(lambda x:x.to(destination) if isinstance(x,torch.Tensor) else x,out)
                return out
            setattr(module,name,forward)

    original_init=VoxCPM2Model.__init__
    def init(model,*args,**kwargs):
        original_init(model,*args,**kwargs)
        keep_cpu(model.audio_vae,['encode','decode'],False)
        keep_cpu(model.feat_encoder,['forward'],True)
        keep_cpu(model.base_lm.embed_tokens,['forward'],True)
    VoxCPM2Model.__init__=init
    checkpoint=Path(os.environ['OMNIVOICE_VOXCPM_MODEL'])
    view=metrics_path.parent/'bounded-model-view'
    view.mkdir(exist_ok=True)
    for item in checkpoint.iterdir():
        if not item.is_file():
            continue
        target=view/item.name
        if item.name=='config.json':
            config=json.loads(item.read_text('utf-8'))
            config['max_length']=1024
            target.write_text(json.dumps(config,indent=2)+'\n',encoding='utf-8')
        elif not target.exists():
            os.link(item.resolve(),target)
    stopped=threading.Event()
    def heartbeat():
        while not stopped.wait(5):
            stock._send(stdout,{'op':'progress','stage':'loading_model','percent':1})
    thread=threading.Thread(target=heartbeat,daemon=True)
    thread.start()
    began=time.perf_counter()
    try:
        check_stop()
        stock._MODEL=VoxCPM.from_pretrained(str(view),load_denoiser=False,optimize=False,device='cuda')
        torch.cuda.synchronize()
        tts=stock._MODEL.tts_model
        assert next(tts.base_lm.layers.parameters()).device.type=='cuda'
        assert all(next(m.parameters()).device.type=='cpu' for m in (tts.audio_vae,tts.feat_encoder,tts.base_lm.embed_tokens))
        metrics.update(loadSeconds=time.perf_counter()-began,
                       loadedAllocatedMiB=torch.cuda.memory_allocated()/1024**2,
                       loadedReservedMiB=torch.cuda.memory_reserved()/1024**2)
        save()
    finally:
        stopped.set(); thread.join(timeout=6)
    stock._send(stdout,{'op':'progress','stage':'loading_model','percent':100})
    return stock._MODEL

original_kwargs=stock.generation_kwargs
def kwargs(text,**options):
    values=original_kwargs(text,**options)
    values.update(max_len=128,retry_badcase=False)
    return values

original_handle=stock._handle_synthesize
def handle(msg,stdout):
    import torch
    check_stop()
    torch.manual_seed(1042)
    with torch.inference_mode():
        original_handle(msg,stdout)
    torch.cuda.synchronize()
    metrics.update(peakAllocatedMiB=torch.cuda.max_memory_allocated()/1024**2,
                   peakReservedMiB=torch.cuda.max_memory_reserved()/1024**2,
                   currentAllocatedMiB=torch.cuda.memory_allocated()/1024**2)
    save()

stock._load_model=load
stock.generation_kwargs=kwargs
stock._handle_synthesize=handle
if __name__=='__main__':
    raise SystemExit(stock.main())
