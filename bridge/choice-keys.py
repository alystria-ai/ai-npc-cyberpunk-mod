"""Presses the dialogue-choice keys for "Speak dialogue choices" (docs/VOICE_CHOICES.md).

The game scrolls and applies a dialogue choice from its own input actions; nothing in its scripts picks one by index. So the bridge presses the same
keys the player would: the up/down arrow keys to move the highlight (ChoiceScrollUp/Down map to UI_MoveUp/UI_MoveDown) and Enter to apply it
(ChoiceApply maps to DialogConfirm).

One process per spoken choice, started while the player is still speaking and gone a moment after the pick (or at once when nothing is picked), so
nothing stays resident. It reads one JSON object per line from stdin and answers one JSON object per line on stdout:

    {"id": 1, "keys": ["down", "down"], "gapMs": 70, "holdMs": 45}      -> {"id": 1, "ok": true, "sent": 2}
    {"id": 2, "keys": ["apply"]}                                        -> {"id": 2, "ok": true, "sent": 1}
    {"quit": true}                                                      -> the process ends

A key is sent only while the foreground window belongs to Cyberpunk2077.exe (checked before each key); anything else answers
{"ok": false, "reason": "not-foreground"} and sends nothing. Keys are sent as scan codes, like a real keyboard. Windows only.
The process also ends by itself after IDLE_S seconds without a request, or when stdin closes.
"""
import ctypes
import json
import os
import sys
import threading
import time
from ctypes import wintypes

IDLE_S = 20
KEYS = {  # name -> (virtual key, extended key)
    'up': (0x26, True),
    'down': (0x28, True),
    'apply': (0x0D, False),
}
GAME = 'cyberpunk2077.exe'

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008
INPUT_KEYBOARD = 1
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD), ('dwFlags', wintypes.DWORD),
                ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.c_size_t)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', wintypes.LONG), ('dy', wintypes.LONG), ('mouseData', wintypes.DWORD), ('dwFlags', wintypes.DWORD),
                ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.c_size_t)]


class _UNION(ctypes.Union):
    _fields_ = [('ki', KEYBDINPUT), ('mi', MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [('type', wintypes.DWORD), ('u', _UNION)]


def api():
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
    user32.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    return user32, kernel32


def foreground_is_game(user32, kernel32):
    window = user32.GetForegroundWindow()
    if not window:
        return False
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(window, ctypes.byref(pid))
    if not pid.value:
        return False
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not handle:
        return False
    try:
        size = wintypes.DWORD(1024)
        buffer = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return False
        return os.path.basename(buffer.value).lower() == GAME
    finally:
        kernel32.CloseHandle(handle)


def send_key(user32, name, up):
    vk, extended = KEYS[name]
    scan = user32.MapVirtualKeyW(vk, 0)  # MAPVK_VK_TO_VSC
    flags = KEYEVENTF_SCANCODE | (KEYEVENTF_EXTENDEDKEY if extended else 0) | (KEYEVENTF_KEYUP if up else 0)
    item = INPUT(type=INPUT_KEYBOARD)
    item.u.ki = KEYBDINPUT(0, scan, flags, 0, 0)
    return user32.SendInput(1, ctypes.byref(item), ctypes.sizeof(INPUT)) == 1


def press(user32, kernel32, keys, gap_ms, hold_ms):
    sent = 0
    for name in keys:
        if name not in KEYS:
            return {'ok': False, 'reason': 'unknown-key', 'sent': sent}
        if not foreground_is_game(user32, kernel32):
            return {'ok': False, 'reason': 'not-foreground', 'sent': sent}
        if not send_key(user32, name, False):
            return {'ok': False, 'reason': 'send-failed', 'sent': sent}
        try:
            time.sleep(hold_ms / 1000)
        finally:
            send_key(user32, name, True)   # a key that went down always comes up
        sent += 1
        if sent < len(keys):
            time.sleep(gap_ms / 1000)
    return {'ok': True, 'sent': sent}


def main():
    if os.name != 'nt':
        print(json.dumps({'ok': False, 'reason': 'not-windows'}), flush=True)
        return 1
    user32, kernel32 = api()
    last = [time.monotonic()]

    def watchdog():
        while True:
            time.sleep(1)
            if time.monotonic() - last[0] > IDLE_S:
                os._exit(0)
    threading.Thread(target=watchdog, daemon=True).start()
    print(json.dumps({'ready': True}), flush=True)
    for line in sys.stdin:
        last[0] = time.monotonic()
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if not isinstance(request, dict):
            continue
        if request.get('quit'):
            return 0
        keys = request.get('keys')
        if not isinstance(keys, list) or len(keys) > 14:
            print(json.dumps({'id': request.get('id'), 'ok': False, 'reason': 'bad-request'}), flush=True)
            continue
        gap = min(max(int(request.get('gapMs', 70)), 30), 400)
        hold = min(max(int(request.get('holdMs', 45)), 30), 200)
        answer = press(user32, kernel32, [str(name) for name in keys], gap, hold)
        answer['id'] = request.get('id')
        print(json.dumps(answer), flush=True)
        last[0] = time.monotonic()
    return 0


if __name__ == '__main__':
    sys.exit(main())
