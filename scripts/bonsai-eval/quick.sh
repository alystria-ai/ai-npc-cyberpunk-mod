#!/bin/bash
# quick.sh <server-dir> <model> [extra args]  -> load time, coherent text sample, decode tok/s (3 runs)
sd=$1; m=$2; shift 2
"$sd/llama-server.exe" -m "$m" -ngl 99 -fa on -c 4096 --port 18701 --device Vulkan1 --reasoning off "$@" > /e/CyberpunkConvai-offload/work/bonsai-eval/results/quick.log 2>&1 &
pid=$!; t0=$(date +%s%N)
until curl -sf localhost:18701/health >/dev/null; do sleep 0.3; kill -0 $pid 2>/dev/null || { echo died; tail -5 /e/CyberpunkConvai-offload/work/bonsai-eval/results/quick.log; exit 1; }; done
echo "load_ms=$(( ($(date +%s%N)-t0)/1000000 ))"
for i in 1 2 3; do curl -s -m 120 localhost:18701/v1/chat/completions -d '{"messages":[{"role":"user","content":"Describe a rainy night in a neon city in about 80 words."}],"max_tokens":120,"temperature":0.65,"chat_template_kwargs":{"enable_thinking":false}}' | python -I -c "
import sys,json
d=json.load(sys.stdin); t=d['timings']; print('prompt %.0f tok/s, gen %.1f tok/s (%d tok)'%(t['prompt_per_second'],t['predicted_per_second'],t['predicted_n'])); 
if True: print(d['choices'][0]['message']['content'][:300].replace('\n',' '))"; done
nvidia-smi --query-gpu=memory.used --format=csv,noheader
kill $pid; sleep 2; kill -0 $pid 2>/dev/null && echo STILL_RUNNING
