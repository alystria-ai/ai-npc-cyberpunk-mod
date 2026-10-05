"""Dry-run a proposed voice config through the bridge's own Python configuration loaders (no model, no writes).

  python validate-config.py omni   <local-voices.picked.json>    # bridge/resident-voice-worker.py validate_config
  python validate-config.py pocket <pocket-voices.picked.json>   # bridge/pocket_voice_runtime.py validate_config

Prints one JSON object: {"ok": bool, "ready": [voice keys the worker would use], "unavailable": {key: status}, ...}.
Run the omni check with vendor/reference-voicestudio/.venv/Scripts/python.exe and the pocket check with
vendor/pocket-tts-env/Scripts/python.exe (it needs PyYAML).
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    kind, path = sys.argv[1], Path(sys.argv[2])
    sys.path.insert(0, str(ROOT / "bridge"))
    try:
        if kind == "omni":
            spec = importlib.util.spec_from_file_location("resident_voice_worker", ROOT / "bridge/resident-voice-worker.py")
            worker = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(worker)
            registry = worker.validate_config(worker.read_config(path), ROOT)
            ready, unavailable = sorted(registry["refs"]), registry["unavailableProfiles"]
            seconds = {}
            import wave
            for key, (reference, _transcript) in registry["refs"].items():
                with wave.open(reference, "rb") as handle:
                    seconds[key] = round(handle.getnframes() / handle.getframerate(), 2)
            result = {"ok": True, "ready": ready, "unavailable": unavailable, "referenceSeconds": seconds}
        else:
            import pocket_voice_runtime as runtime
            registry = runtime.validate_config(runtime.read_json(path))
            result = {"ok": True, "ready": sorted(registry["refs"]), "unavailable": registry["unavailable"]}
    except Exception as error:
        result = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
