# Game window capture for visual verification

`scripts/Capture-GameWindow.py` captures Cyberpunk's own surface through Windows
Graphics Capture. It validates the HWND's executable against this development
installation, checks ownership during capture, and has no monitor fallback,
focus operation or input injection. It is a development tool, not a runtime
dependency of the mod.

The desktop screenshot tool returned pixels from the primary display despite
selecting the verified Cyberpunk window on the second monitor. A direct HWND
capture produced the correct game surface while Codex remained on the other
display. Do not treat the earlier desktop captures as game evidence.

Install the isolated dependencies without changing the voice environments:

```powershell
python -m pip install --target vendor/window-capture --only-binary=:all: --no-deps -r scripts/requirements-window-capture.txt
$taskWindow = (Get-Process Cyberpunk2077).MainWindowHandle
python scripts/Capture-GameWindow.py --hwnd $taskWindow --output runtime/game-capture --seconds 8 --fps 12
```

The package is the maintained [Windows Capture library](https://github.com/NiiightmareXD/windows-capture/tree/main/windows-capture-python).
The pinned NumPy/OpenCV pair avoids the installed global OpenCV binary's NumPy
ABI mismatch. Vendor packages and captured files remain ignored by Git.

Use `--probe <face-probe.json>` to attach only phase/timing information from the
native pose diagnostic. Use `--speech-state <speech-state.json>` to wait for an
owned speech request and capture that reply plus one second of rest. Admission
states such as `open` and `ready` also count: restricting the trigger to
`playing` can miss the beginning. Dialogue and identity fields are excluded
from manifests. When available, the last valid mapped timeline is retained
without its ownership identifiers for a source-to-render comparison.

Each capture is bounded to 30 seconds, 15 FPS and 450 saved frames; the optional
arming window is bounded to 180 seconds. Create `stop.txt` in the output folder
to stop an owned capture. Target loss closes the session. Keep helpers hidden
when launching with `Start-Process`.

For time-sensitive native probes, launch capture and write the diagnostic
request in the same orchestration command after `ready.json` appears. Separate
model/tool turns can introduce enough delay to miss the final poses.

The original PNGs and frame timestamps are the evidence. Enlarged contact
sheets are inspection crops only; do not replace real frames or infer continuous
motion from them alone. October 1's complete native shape capture is under
`runtime/articulation-images-20261001-001511`; all four phases and neutral reset
were captured with LOD High.

## Repeatable local speech comparison

After the user's October 1 authorization to trigger speech through the mod,
`speech-fixture:<profile-key>:<nonce>` can play a paired retained WAV/timeline.
It reads `runtime/speech-fixture.json` and starts the existing native speech
adapter on one nearby owned companion. It creates no provider request and
does not write input, reply, chat history, identity or session files. The normal
speech-state telemetry and final delivery receipt are still produced.

Prepare a fixture with `version: 1`, the matching `nonce`/`profileKey`, integer
`expiresAt` in epoch seconds within the next 120 seconds, an `audio` descriptor
(`slot`, `event`, `duration`) and a mapped `face` timeline. Maximums are 15 seconds,
2 MiB, 902 frames and 22 known controls. The probe substitutes current actor
ownership, consumes each nonce once, refuses observable busy/menu/combat states,
and uses normal pause, target-loss, unload and facial-reset handling. Its report
in `runtime/speech-fixture-result.json` contains only status/duration/source/format.
Cancel with `speech-fixture:cancel:<same nonce>`; it cannot stop a newer owner.

Before triggering, freeze the source and WAV, verify the installed on-demand
audio slot has the identical bytes, and stop the reply bridge gracefully. The
Lua descriptor cannot attest the actual WAV bytes, and mailbox checks do not
expose every private conversation closure. Keep the replay bounded and restore
the bridge afterward. Capture readiness and the diagnostic request should be
in the same orchestration command. Native replay qualifies rendered retargeting;
it does not replace continuous Convai latency/transport verification.
