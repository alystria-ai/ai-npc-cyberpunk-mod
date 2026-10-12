import json,sys,glob,re,os
sys.stdout.reconfigure(encoding='utf-8')
os.environ['HF_HUB_OFFLINE']='1'
import torch, soundfile as sf, numpy as np
from scipy.signal import resample_poly
from transformers import pipeline
snap=glob.glob('C:/Users/akshi/Desktop/Code Palace/Cyberpunk Mod/vendor/voice-models/hub/models--openai--whisper-small.en/snapshots/*')[0]
asr=pipeline('automatic-speech-recognition',model=snap,device=-1)
man=json.load(open('E:/CyberpunkConvai-offload/work/clip-search/missing-two/extract-manifest.json',encoding='utf-8'))
def norm(t): return re.sub(r"[^a-z' ]",' ',t.lower().replace('\u2013',' ')).split()
import difflib
for r in man:
    d,sr=sf.read(r['wavPath'],dtype='float32'); 
    if d.ndim>1: d=d.mean(1)
    d=resample_poly(d,1,3).astype(np.float32)
    out=asr({'raw':d,'sampling_rate':16000})['text'].strip()
    a,b=norm(r['transcript']),norm(out)
    sm=difflib.SequenceMatcher(None,a,b).ratio()
    print(r['key'],r['stringId'][-6:],f'{sm:.2f}','\n   sub:',r['transcript'],'\n   asr:',out)
