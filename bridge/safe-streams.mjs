// A full disk, a closed pipe or a bad handle on the process's own output never ends a Node process of the mod.
//
// The conversation service's stdout and stderr are files (bridge.stdout.log, bridge.stderr.log, opened by the supervisor, bridge/bridge-supervisor.mjs).
// Node writes a file stream synchronously and, when the write fails (ENOSPC on a full disk, EIO, EBADF), destroys the stream and emits 'error' on the
// next tick. Nobody listens for it on process.stderr, so a log line on a full disk became an uncaught exception and ended the whole service
// (error report 1cbe337a5144ebbd: ENOSPC at a log line, a player whose C: drive had 0.8 GiB free). A log line is never worth a crash.
//
// `guardStream` puts an 'error' listener on a stream and a write that cannot throw. A stream that was destroyed by a failed write is written to
// again through its file handle (when it has one), so the log comes back when space is freed; with no handle the line is dropped. The write
// callback is still called, so nothing waits for a line that never arrived. Nothing here runs per frame: it is a wrapper on a log write.
import {writeSync} from 'node:fs';

/** The errors of a log write that are never fatal: a full disk or quota, a closed or broken pipe, a bad or lost handle, a stream already ended. */
export const LOG_WRITE_ERRORS = Object.freeze(['ENOSPC', 'EDQUOT', 'EPIPE', 'EIO', 'EBADF', 'EAGAIN', 'ENOBUFS', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);
const IGNORED = new Set(LOG_WRITE_ERRORS);

/** True for the error of a write that failed because of the disk or the other end of the output (never a programming error). */
export const isLogWriteError = error => IGNORED.has(error?.code);

/** True for a full disk (ENOSPC) or an exceeded quota (EDQUOT). */
export const isDiskFullError = error => error?.code === 'ENOSPC' || error?.code === 'EDQUOT';

const GUARDED = Symbol.for('ai-npc.safe-stream');

/**
 * Makes `stream.write` and the stream's 'error' event harmless. Returns true when the guard was put on, false when the stream was
 * missing or already guarded. `writeFd(fd, chunk)` is the fallback write of a destroyed stream (a test seam).
 */
export function guardStream(stream, {writeFd = writeSync, onError = () => {}} = {}) {
  if (!stream || typeof stream.write !== 'function' || stream[GUARDED]) return false;
  try { Object.defineProperty(stream, GUARDED, {value: true}); } catch { return false; }
  // Every error of the stream is swallowed: stdout and stderr are logs, and a listener that rethrows would only bring the crash back.
  stream.on('error', error => { try { onError(error); } catch { /* a listener never throws */ } });
  // A file stream forgets its handle when it is destroyed (SyncWriteStream sets fd to null), so the handle is kept from now.
  const fd = Number.isInteger(stream.fd) && stream.fd >= 0 ? stream.fd : null;
  const original = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    const done = typeof encoding === 'function' ? encoding : callback;
    const finish = () => { if (typeof done === 'function') process.nextTick(done); };
    try {
      if (!stream.destroyed) return original(chunk, encoding, callback);
    } catch (error) { try { onError(error); } catch { /* ignored */ } }
    // The stream is gone (a failed write destroyed it) or threw: one more try straight through the handle, when there is one.
    try {
      if (fd !== null && chunk !== undefined && chunk !== null) {
        writeFd(fd, typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk);
      }
    } catch (error) { try { onError(error); } catch { /* ignored */ } }
    finish();
    return true;
  };
  return true;
}

/** Guards process.stdout and process.stderr (each one is looked up inside a try: a process with no usable output has none to guard). */
export function installSafeStreams({processRef = process, ...options} = {}) {
  let guarded = 0;
  for (const name of ['stdout', 'stderr']) {
    try { if (guardStream(processRef[name], options)) guarded += 1; } catch { /* no such stream */ }
  }
  return guarded;
}
