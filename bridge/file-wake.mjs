// Wakes a file poll the moment the game replaces its file (docs/LATENCY_2026-10-13.md, "Event-driven file polls").
//
// The bridge reads the game's mailbox files (the request, the microphone command, the phone message) on interval polls of 50 to
// 150 ms, so a turn waited half an interval on average (25 to 75 ms) before the bridge even saw it. One directory watcher
// (ReadDirectoryChangesW on Windows) runs the poll a few milliseconds after the file changes. The interval polls stay as they
// are: a watcher that fails, misses an event or is not supported changes nothing but the latency.
//
//   const wake = watchFiles(runtime, {'last-input.json': tick, 'microphone-command.json': pollMicrophone});
//   wake.active   -> boolean, the watcher runs
//   wake.close()
//
// A handler runs `delayMs` after the first event of a burst (not reset by later ones, so the wait is bounded): a file written
// in place without the native plugin raises an event when it is truncated, and the short delay lets the write finish. The
// handlers are the polls themselves, which already ignore an unchanged file and guard against running twice at once.
import {watch as fsWatch} from 'node:fs';
import {basename} from 'node:path';

export const FILE_WAKE_DELAY_MS = 4;

export function watchFiles(directory, handlers, {watch = fsWatch, delayMs = FILE_WAKE_DELAY_MS, setTimer = setTimeout,
  clearTimer = clearTimeout, log = () => {}} = {}) {
  const names = new Set(Object.keys(handlers ?? {}).filter(name => typeof handlers[name] === 'function'));
  const pending = new Map();
  let watcher = null, closed = false;
  const fire = name => {
    pending.delete(name);
    if (closed) return;
    try { const result = handlers[name](); if (result && typeof result.catch === 'function') result.catch(() => {}); }
    catch { /* the poll reports its own failures */ }
  };
  const onEvent = (_type, filename) => {
    if (closed || filename === null || filename === undefined) return;
    const name = basename(String(filename));
    if (!names.has(name) || pending.has(name)) return;
    const timer = setTimer(() => fire(name), delayMs);
    timer?.unref?.();
    pending.set(name, timer);
  };
  function close() {
    closed = true;
    for (const timer of pending.values()) clearTimer(timer);
    pending.clear();
    try { watcher?.close(); } catch { /* already closed */ }
    watcher = null;
  }
  if (names.size) {
    try {
      watcher = watch(directory, {persistent: false}, onEvent);
      watcher?.on?.('error', error => { log(`file watch stopped (${error?.code ?? error?.message ?? 'error'}); the polls continue`); close(); });
    } catch (error) {
      watcher = null;
      log(`file watch unavailable (${error?.code ?? error?.message ?? 'error'}); the polls continue`);
    }
  }
  return {close, get active() { return !!watcher && !closed; }};
}
