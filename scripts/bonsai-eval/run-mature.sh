#!/bin/bash
B=/e/CyberpunkConvai-offload/work/bonsai-eval; L=E:/CyberpunkConvai-offload/work/local-llm; BB=E:/CyberpunkConvai-offload/work/bonsai-eval
cd "/c/Users/akshi/Desktop/Code Palace/cpm-bonsai"
export LLAMA_SERVER="$L/llama-vulkan/llama-server.exe"
: > $B/results/mature-progress.txt
m() { timeout 1500 node scripts/Eval-MatureSamples.mjs --model "$1" --label "$2" --set brief --n 3 --speed --port 18601 ${3:+--server-args "$3"} > $B/results/mature-$2.console.log 2>&1; echo "$2 exit $?" >> $B/results/mature-progress.txt; }
m $BB/dl-4b/Ternary-Bonsai-2-4B-Q2_0.gguf bonsai2-4b
m $BB/dl-9b/Ternary-Bonsai-2-9B-Q2_0.gguf bonsai2-9b
m $BB/dl-4b/Ternary-Bonsai-2-4B-Q2_0.gguf bonsai2-4b-lora "--lora-scaled $BB/dl-lora-4b/Ternary-Bonsai-2-4B-Uncensored-LoRA.gguf:1"
m $L/mature/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf hauhau-4b-lite
m $L/mature/Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf gemma-minifantasy-standard
echo done >> $B/results/mature-progress.txt
