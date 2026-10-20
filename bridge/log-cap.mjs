// Keeps a log file from growing for the whole game session. The conversation service's stdout and stderr go straight to files the bridge
// process holds open for appending (bridge/bridge-supervisor.mjs), so the bridge cannot rotate them itself, and the supervisor rotated them
// only when it started: a long session, or a bridge that kept restarting, grew them without bound.
//
// `capLogFile` is the supervisor's: when the file is over `maxBytes` it keeps the last `keepBytes` (from the start of a whole line) in the
// same file. The writer keeps appending to the end of the file (it opened it for appending, which on Windows writes at the end whatever
// the position), so no rename and no new handle is needed; the few lines written during the copy may be lost, which is fine for a log.
// Synchronous and small (at most `keepBytes` read and written, only when over the cap, every few minutes, in the supervisor, never in the
// bridge or the game). Never throws.
import {closeSync, fstatSync, ftruncateSync, openSync, readSync, writeSync} from 'node:fs';

/** Returns true when the file was cut back. */
export function capLogFile(path, {maxBytes, keepBytes = Math.floor(maxBytes / 2)} = {}) {
  let fd;
  try {
    fd = openSync(path, 'r+');
    const size = fstatSync(fd).size;
    if (!(size > maxBytes)) return false;
    const length = Math.min(size, Math.max(1, keepBytes));
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    let start = 0;
    // The first line of the kept part is usually cut short.
    const newline = buffer.subarray(0, read).indexOf(0x0a);
    if (newline >= 0 && newline < read - 1) start = newline + 1;
    const kept = buffer.subarray(start, read);
    writeSync(fd, kept, 0, kept.length, 0);
    ftruncateSync(fd, kept.length);
    return true;
  } catch { return false; } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing to do */ } } }
}
