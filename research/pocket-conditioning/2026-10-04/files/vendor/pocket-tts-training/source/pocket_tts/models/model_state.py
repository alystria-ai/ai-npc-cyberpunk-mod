"""Reading and writing the voice-conditioning state as safetensors.

A voice prompt is expensive to encode, so `pocket-tts export-voice` saves the
resulting per-module streaming state and generation reloads it.
"""

from pathlib import Path
import json
from urllib.parse import urlsplit

import safetensors
import safetensors.torch
import torch


def export_model_state(model_state: dict[str, dict[str, torch.Tensor]], dest: str | Path,
                       *, voice_identity_cache_key=None):
    dict_to_store = {}
    for module_name, module_state in model_state.items():
        for key, tensor_value in module_state.items():
            dict_to_store[f"{module_name}/{key}"] = tensor_value
    metadata = {} if voice_identity_cache_key is None else {
        "voice_identity_cache_key": json.dumps(list(voice_identity_cache_key), separators=(",", ":"))}
    safetensors.torch.save_file(dict_to_store, dest, metadata=metadata)


def _is_safetensors_source(source: str | Path) -> bool:
    source_text = str(source)
    if source_text.startswith(("http://", "https://")):
        source_text = urlsplit(source_text).path
    elif source_text.startswith("hf://"):
        source_text = source_text.rsplit("@", 1)[0]
    return source_text.endswith(".safetensors")


def _import_model_state(
    source: str | Path, device: torch.device
    , *, voice_identity_cache_key=None
) -> dict[str, dict[str, torch.Tensor]]:
    result = {}
    with safetensors.safe_open(source, framework="pt") as f:
        encoded_key = (f.metadata() or {}).get("voice_identity_cache_key")
        if voice_identity_cache_key is not None:
            if encoded_key is None or json.loads(encoded_key) != list(voice_identity_cache_key):
                raise ValueError("Hybrid voice state is unbound to current model/mapping/ID/reference")
        elif encoded_key is not None:
            raise ValueError("Hybrid voice state cannot be imported as legacy reference-only state")
        for key in f.keys():
            module_name, tensor_key = key.split("/")
            result.setdefault(module_name, {})
            if tensor_key == "current_end":
                # we used the shape[0] as step index before for torch.compile() compatibility,
                # but it's not needed anymore
                tensor = f.get_tensor(key)
                result[module_name]["offset"] = torch.full(
                    (1,), fill_value=tensor.shape[0], dtype=torch.long, device=device
                )
            else:
                result[module_name][tensor_key] = f.get_tensor(key).to(device)
    return result
