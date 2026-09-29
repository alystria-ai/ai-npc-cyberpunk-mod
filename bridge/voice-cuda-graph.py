"""Bounded CUDA replay for the existing OmniVoice forward, without quantization.

One shape is retained. The denoising sampler/codec and model parameters are
unchanged. Every input is refreshed and execution is serialized by the owner.
This adapter is inference-only; unsupported calls use the original forward.
"""
from types import MethodType, SimpleNamespace
import gc
import time
import torch


class VoiceGraph:
    def __init__(self, model, max_tokens=640, budget_mib=512, free_margin_mib=1024):
        self.model = model
        self.original = model.forward
        self.max_tokens = max_tokens
        self.budget = int(budget_mib * 1024**2)
        self.free_margin = int(free_margin_mib * 1024**2)
        self.entry = None
        self.captures = self.replays = self.fallbacks = 0
        self.capture_ms = 0
        self.disabled_reason = None
        self.last_fallback = None
        self.skipped = set()
        # cuBLAS caches workspace per CUDA stream. Creating a new stream for
        # every sentence shape would retain another workspace each time even
        # after that sentence's graph was evicted.
        self.stream = torch.cuda.Stream()
        self.old_cache = model.llm.config.use_cache
        # The bidirectional denoiser never consumes past_key_values. Retaining
        # newly-created KV tensors inside every call wastes memory/work.
        model.llm.config.use_cache = False

    def clear(self):
        if self.entry is not None:
            torch.cuda.synchronize()
            self.entry = None
            gc.collect()
            torch.cuda.empty_cache()

    def close(self):
        self.clear()
        self.model.forward = self.original
        self.model.llm.config.use_cache = self.old_cache

    def begin_request(self):
        # A memory-pressure fallback lasts for this render, not all future
        # conversations. Do not retry capture at every denoising step.
        self.skipped.clear()
        self.last_fallback = None

    def snapshot(self):
        return {"mode": "cuda-graph" if self.entry else "eager", "captures": self.captures,
                "replays": self.replays, "fallbacks": self.fallbacks,
                "captureMs": self.capture_ms, "shape": self.entry["shape"] if self.entry else None,
                "graphAllocatedMiB": self.entry["bytes"] / 1024**2 if self.entry else 0,
                "graphReservedMiB": self.entry["reserved"] / 1024**2 if self.entry else 0,
                "disabledReason": self.disabled_reason, "lastFallback": self.last_fallback}

    def supported(self, ids, audio, attention, kwargs):
        return (not self.disabled_reason and not torch.is_grad_enabled() and not self.model.training
                and ids is not None and ids.is_cuda and ids.ndim == 3
                and ids.dtype == torch.long and ids.get_device() == torch.cuda.current_device()
                and ids.shape[0] == 2 and ids.shape[1] == self.model.config.num_audio_codebook
                and 1 <= ids.shape[2] <= self.max_tokens
                and audio is not None and audio.dtype == torch.bool and audio.shape == (2, ids.shape[2])
                and audio.device == ids.device
                and attention is not None and attention.dtype == torch.bool
                and attention.device == ids.device
                and attention.shape == (2, 1, ids.shape[2], ids.shape[2])
                and all(value is None for value in kwargs.values()))

    def capture(self, ids, audio, attention):
        self.clear()
        if torch.cuda.mem_get_info()[0] < self.budget + self.free_margin:
            self.last_fallback = "Insufficient free VRAM for capture and the game margin"
            return False
        started = time.perf_counter()
        try:
            self.entry = self.capture_entry(ids, audio, attention)
        except RuntimeError as error:
            # Graph support varies by the installed PyTorch/GPU stack. A
            # recoverable capture error must not discard otherwise valid TTS.
            # If CUDA itself is unhealthy, the original forward will raise and
            # the existing voice error path handles it without a retry loop.
            self.disabled_reason = f"CUDA replay disabled: {str(error)[:180]}"
        self.capture_ms += (time.perf_counter() - started) * 1000
        if self.entry is None:
            gc.collect()
            torch.cuda.empty_cache()
            return False
        self.captures += 1
        if max(self.entry['bytes'], self.entry['reserved']) > self.budget:
            self.last_fallback = "Captured graph exceeds the additional-memory budget"
        elif torch.cuda.mem_get_info()[0] < self.free_margin:
            self.last_fallback = "Capture would reduce the free VRAM margin for the game"
        else:
            return True
        self.clear()
        return False

    def capture_entry(self, ids, audio, attention):
        baseline = torch.cuda.memory_allocated()
        reserved = torch.cuda.memory_reserved()
        b_ids, b_audio, b_attention = ids.clone(), audio.clone(), attention.clone()
        stream = self.stream
        stream.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(stream):
            for _ in range(2):
                warm = self.original(input_ids=b_ids, audio_mask=b_audio, attention_mask=b_attention).logits.float()
        torch.cuda.current_stream().wait_stream(stream)
        del warm
        torch.cuda.synchronize()
        graph = torch.cuda.CUDAGraph()
        # The same unmodified PyTorch operators run in capture and replay.
        with torch.cuda.graph(graph, stream=stream):
            # The pinned sampler immediately casts logits to float32. Capture
            # that identical cast too, avoiding a separate launch each step.
            output = self.original(input_ids=b_ids, audio_mask=b_audio, attention_mask=b_attention).logits.float()
        stream.synchronize()
        used = torch.cuda.memory_allocated() - baseline
        return {"shape": tuple(ids.shape), "ids": b_ids, "audio": b_audio,
                "attention": b_attention, "graph": graph, "output": output,
                "stream": stream, "bytes": max(0, used),
                "reserved": max(0, torch.cuda.memory_reserved() - reserved)}

    def forward(self, input_ids=None, audio_mask=None, attention_mask=None, **kwargs):
        if not self.supported(input_ids, audio_mask, attention_mask, kwargs):
            self.clear()
            self.fallbacks += 1
            return self.original(input_ids=input_ids, audio_mask=audio_mask, attention_mask=attention_mask, **kwargs)
        shape = tuple(input_ids.shape)
        if self.entry is None or self.entry["shape"] != shape:
            if shape in self.skipped or not self.capture(input_ids, audio_mask, attention_mask):
                self.skipped.add(shape)
                self.fallbacks += 1
                return self.original(input_ids=input_ids, audio_mask=audio_mask, attention_mask=attention_mask, **kwargs)
        e = self.entry
        # Static masks change when the speaker/reference changes, even when
        # sequence length happens to match. Never reuse values based on shape.
        e["ids"].copy_(input_ids)
        e["audio"].copy_(audio_mask)
        e["attention"].copy_(attention_mask)
        e["graph"].replay()
        self.replays += 1
        return SimpleNamespace(logits=e["output"])

    def install(self):
        owner = self
        def forward(model, *args, **kwargs):
            return owner.forward(*args, **kwargs)
        self.model.forward = MethodType(forward, self.model)
        return self
