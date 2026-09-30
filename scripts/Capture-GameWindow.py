"""Bounded, read-only Cyberpunk window capture using Windows Graphics Capture.

No desktop/monitor fallback, focus changes or input injection. The separately
installed windows-capture package lives under ignored vendor/window-capture.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import sys
import threading
import time

PROJECT = Path(__file__).resolve().parent.parent
GAME = Path(r'E:\SteamLibrary\steamapps\common\Cyberpunk 2077\bin\x64\Cyberpunk2077.exe')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hwnd', type=lambda value: int(value, 0), required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seconds', type=float, default=1)
    parser.add_argument('--fps', type=float, default=8)
    parser.add_argument('--crop', nargs=4, type=int, metavar=('LEFT', 'TOP', 'RIGHT', 'BOTTOM'),
                        help='Save an exact window-region crop; permits up to 30 FPS for motion inspection')
    parser.add_argument('--probe', type=Path)
    parser.add_argument('--speech-state', type=Path,
                        help='Wait for active speech, then capture that reply and a short ending tail')
    parser.add_argument('--arm-seconds', type=float, default=120)
    args = parser.parse_args()
    if not 0 < args.seconds <= 30 or not 0 < args.fps <= (30 if args.crop else 15):
        parser.error('Capture must be at most 30 seconds; 15 FPS full-window or 30 FPS cropped')
    if args.crop:
        left, top, right, bottom = args.crop
        if left < 0 or top < 0 or right <= left or bottom <= top or (right-left)*(bottom-top) > 400000:
            parser.error('Crop must be positive, within the window, and at most 400000 pixels')
    if not 0 < args.arm_seconds <= 180:
        parser.error('Arming must be at most 180 seconds')
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    user32.IsWindow.argtypes = [wintypes.HWND]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    if not user32.IsWindow(args.hwnd):
        raise RuntimeError('The selected game window is unavailable')
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(args.hwnd, ctypes.byref(pid))
    handle = kernel32.OpenProcess(0x1000, False, pid.value)
    if not handle:
        raise RuntimeError('Cannot verify the selected window owner')
    try:
        size, executable = wintypes.DWORD(32768), ctypes.create_unicode_buffer(32768)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, executable, ctypes.byref(size)):
            raise RuntimeError('Cannot read the selected window executable')
        if Path(executable.value).resolve() != GAME.resolve():
            raise RuntimeError('Capture target is not the installed Cyberpunk executable')
    finally:
        kernel32.CloseHandle(handle)

    sys.path.insert(0, str(PROJECT / 'vendor/window-capture'))
    from windows_capture import WindowsCapture
    import cv2

    args.output.mkdir(parents=True, exist_ok=True)
    capture = WindowsCapture(window_hwnd=args.hwnd, monitor_index=None,
                             cursor_capture=False, draw_border=None,
                             minimum_update_interval=max(1, int(500 / args.fps)))
    finished = threading.Event()
    started, previous_sample, speech_owner, ended_at = None, -1, None, None
    mapped_timeline = None
    frames, failure = [], []
    last_probe = None
    ready_written = False

    @capture.event
    def on_frame_arrived(frame, control):
        nonlocal started, previous_sample, last_probe, ready_written, speech_owner, ended_at, mapped_timeline
        try:
            current_pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(args.hwnd, ctypes.byref(current_pid))
            if current_pid.value != pid.value:
                raise RuntimeError('Capture window ownership changed')
            now = time.perf_counter()
            if args.crop and (right > frame.width or bottom > frame.height):
                raise RuntimeError('Requested crop exceeds the current game window')
            if not ready_written:
                if args.crop:
                    # Save framing context before signaling readiness, so PNG
                    # encoding cannot delay the first triggered speech frames.
                    frame.save_as_image(str(args.output / 'window-context.png'))
                (args.output / 'ready.json').write_text(json.dumps({'ready': True, 'armedForSpeech': bool(args.speech_state), 'width': frame.width, 'height': frame.height}), encoding='utf-8')
                ready_written = True
            speech = None
            if args.speech_state:
                try:
                    speech = json.loads(args.speech_state.read_text(encoding='utf-8-sig'))
                except (OSError, ValueError):
                    return
                if started is None:
                    # Continuous admission can be open/ready before playing.
                    # The owned request is the gate; waiting for a particular
                    # renderer label can miss the beginning of the reply.
                    if not speech.get('requestId') or speech.get('state') in ('idle', 'finished', 'cancelled', 'error', 'stopped'):
                        return
                    speech_owner = speech['requestId']
                elif speech.get('requestId') != speech_owner and ended_at is None:
                    ended_at = now
            if started is None:
                started = now
            elapsed = now - started
            if elapsed >= args.seconds or len(frames) >= (900 if args.crop else 450) or (ended_at is not None and now - ended_at >= 1):
                control.stop()
                finished.set()
                return
            # Fixed sample buckets avoid halving cadence when actual arrivals
            # narrowly precede a second relative-to-last-frame throttle.
            sample = int(elapsed * args.fps)
            if sample == previous_sample:
                return
            previous_sample = sample
            name = f'frame-{len(frames):04d}.png'
            if args.crop:
                pixels = frame.frame_buffer[top:bottom, left:right]
                if not cv2.imwrite(str(args.output / name), pixels, [cv2.IMWRITE_PNG_COMPRESSION, 1]):
                    raise RuntimeError('Could not write the captured game region')
            else:
                frame.save_as_image(str(args.output / name))
            if args.speech_state and speech_owner:
                try:
                    wire = json.loads(args.speech_state.with_name('continuous-speech.json').read_text(encoding='utf-8-sig'))
                    timeline = wire.get('face')
                    if wire.get('requestId') == speech_owner and isinstance(timeline, dict):
                        mapped_timeline = {key: timeline.get(key) for key in
                                           ('duration', 'complete', 'source', 'articulation', 'tracks', 'frames')}
                except (OSError, ValueError):
                    pass
            if args.probe:
                try:
                    source = json.loads(args.probe.read_text(encoding='utf-8-sig'))
                    last_probe = {key: source.get(key) for key in ('state', 'mode', 'phase', 'elapsed')}
                except (OSError, ValueError):
                    pass
            face = speech.get('face', {}) if speech else {}
            speech_observation = ({'state': speech.get('state'), 'position': speech.get('position'),
                                   'duration': speech.get('duration'), 'face': {key: face.get(key) for key in
                                   ('state', 'position', 'applied', 'articulation', 'source')}} if speech else None)
            frames.append({'file': name, 'seconds': elapsed, 'captureTimespan': frame.timespan,
                           'width': frame.width, 'height': frame.height, 'probe': last_probe,
                           **({'crop': args.crop} if args.crop else {}),
                           'speech': speech_observation})
        except Exception as error:
            failure.append(type(error).__name__ + ': ' + str(error))
            control.stop()
            finished.set()

    @capture.event
    def on_closed():
        finished.set()

    controller = capture.start_free_threaded()
    try:
        deadline = time.monotonic() + args.seconds + 8 + (args.arm_seconds if args.speech_state else 0)
        while not finished.wait(.2):
            if (args.output / 'stop.txt').exists():
                failure.append('Capture cancelled')
                break
            if time.monotonic() >= deadline:
                failure.append('Capture deadline expired without enough game frames')
                break
    finally:
        if not controller.is_finished():
            controller.stop()
        controller.wait()
        report = {'backend': 'windows-graphics-capture', 'windowOnly': True,
                  'targetFps': args.fps, 'crop': args.crop, 'frames': frames, 'errors': failure}
        (args.output / 'manifest.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        if mapped_timeline:
            (args.output / 'mapped-timeline.json').write_text(json.dumps(mapped_timeline), encoding='utf-8')
    if failure or not frames:
        raise RuntimeError('; '.join(failure) or 'No game frames captured')
    print(json.dumps({'frames': len(frames), 'directory': str(args.output.resolve())}))


if __name__ == '__main__':
    main()
