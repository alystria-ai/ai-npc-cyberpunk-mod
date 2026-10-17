#!/bin/bash
B=/e/CyberpunkConvai-offload/work/bonsai-eval; L=/e/CyberpunkConvai-offload/work/local-llm
cd $B/bench; : > $B/results/step1/_progress.txt
run() { node bench24.mjs --model "$1" --label "$2" --runs stable,stable --exe "$3" > $B/results/step1/$2.console.log 2>&1; echo "$2 exit $?" >> $B/results/step1/_progress.txt; }
V=$L/llama-vulkan/llama-server.exe
run $L/dl-gemma4-e4b/gemma-4-E4B_q4_0-it.gguf gemma4-e4b $V
run $L/dl-qwen35-2b/Qwen3.5-2B-Q4_K_M.gguf q35-2b $V
run $B/dl-9b/Ternary-Bonsai-2-9B-Q2_0.gguf bonsai2-9b $V
run $B/dl-4b/Ternary-Bonsai-2-4B-Q2_0.gguf bonsai2-4b $V
run $B/dl-2b/Ternary-Bonsai-2-2B-Q2_0.gguf bonsai2-2b $V
echo done >> $B/results/step1/_progress.txt
