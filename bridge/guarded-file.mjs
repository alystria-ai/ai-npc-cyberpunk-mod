import {open, readFile, rename as renameAsync, rm, writeFile} from 'node:fs/promises';
import {renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const defaultFiles = {open, rename: renameSync, rm, readFile};
const retryable = new Set(['EPERM', 'EACCES', 'EBUSY']);
// Windows refuses to rename over a file another process (the game's Lua reader, an
// indexer, antivirus) has open at that instant. Six tries with this backoff wait
// about 300 ms in total, which outlasts those short-lived handles.
const RENAME_ATTEMPTS = 6;
const RENAME_BACKOFF_MS = [10, 20, 40, 80, 150];
// A PC where something (antivirus, an indexer, a sync client) keeps refusing the rename gets the same refusals at every write, each one a retry
// loop that ends in an error for the caller. After this many refused renames in one session the writes go in place instead (the way the
// Mod Organizer 2 case below already does): every reader of these files treats a half-written file as empty and reads it again. It is logged once.
export const IN_PLACE_AFTER_REFUSALS = 6;
const defaultSession = {refused: 0, inPlace: false};
/** For tests: the process-wide count of refused renames and whether writes have switched to in place. */
export const atomicFileSession = defaultSession;
export function resetAtomicFileSession() { defaultSession.refused = 0; defaultSession.inPlace = false; }
function switchToInPlace(session, log) {
  if (session.inPlace) return;
  session.inPlace = true;
  try { (log ?? console.warn)(`[atomicFile] Windows refused ${session.refused} renames this session, so files are now written in place (a reader that finds one half written reads it again)`); } catch { /* the log is not worth a failed write */ }
}

// files may override individual fs methods; retryDelay may be milliseconds (fixed) or an
// async delay hook called with the failed attempt index; the default is a short backoff.
// A rename that keeps failing throws after the previous file is left intact and the
// temporary file is removed; callers on a poll loop must catch that.
// isCurrentSync must return true to authorize the final commit.
// The default rename commits in the same JS turn as that synchronous guard.
export async function atomicFile(path, data, {signal, isCurrent, isCurrentSync, files, retryDelay, session, log} = {}) {
  const io = {...defaultFiles, ...files};
  // Only the real rename counts toward the process-wide switch (a test that injects its own rename passes its own `session`, or none).
  const count = session ?? (files?.rename ? null : defaultSession);
  const current = async () => {
    if (signal?.aborted) return false;
    const valid = !isCurrent || await isCurrent();
    return Boolean(valid) && !signal?.aborted;
  };
  if (!await current() || signal?.aborted) return false;

  const temp = path + '.' + randomUUID() + '.tmp';
  let handle, owned = false, committed = false;
  // In place, the file is emptied first, so a write that fails (a full disk) would leave it empty. The old bytes are read first and put back
  // when the write fails; the error is still thrown. The temporary file written above is complete, so a full disk is already known by now
  // and this rarely runs, but a file that is lost is a player's settings or memories.
  const writeInPlace = async () => {
    let previous = null;
    try { previous = await io.readFile(path); } catch { /* no old file, or one that cannot be read: nothing to put back */ }
    const target = await io.open(path, 'w');
    try { await target.writeFile(data); }
    catch (error) {
      await target.close().catch(() => {});
      if (previous) {
        try { const again = await io.open(path, 'w'); try { await again.writeFile(previous); } finally { await again.close().catch(() => {}); } } catch { /* the disk is still full */ }
      }
      throw error;
    }
    await target.close().catch(() => {});
  };
  try {
    handle = await io.open(temp, 'wx');
    owned = true;
    if (!await current() || signal?.aborted) return false;
    await handle.writeFile(data);
    if (!await current() || signal?.aborted) return false;
    await handle.close();
    handle = undefined;

    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
      // This is also the check after close or a retry delay.
      if (!await current() || signal?.aborted) return false;
      if (isCurrentSync && isCurrentSync() !== true) return false;
      if (signal?.aborted) return false;
      if (count?.inPlace) { await writeInPlace(); return true; }
      try {
        const renamed = io.rename(temp, path);
        // Async rename overrides are a test seam. Once dispatched, they cannot
        // guarantee that a cancellation prevents their eventual file commit.
        if (renamed && typeof renamed.then === 'function') await renamed;
        committed = true;
        return true;
      } catch (error) {
        // Mod Organizer 2: a new file under the game folder goes to MO2's Overwrite folder, so the temporary file can be on another drive
        // than the placeholder it replaces (the game on D:, MO2 on C:), and Windows will not rename across drives. The placeholder is
        // written in place instead, as the game's own Lua does; every reader of these files copes with a half-written read. The
        // temporary file is removed below (committed stays false).
        if (error.code === 'EXDEV') {
          if (!await current() || signal?.aborted) return false;
          if (isCurrentSync && isCurrentSync() !== true) return false;
          await writeInPlace();
          return true;
        }
        if (count && retryable.has(error.code)) {
          count.refused += 1;
          // The write in hand goes in place at once (no more retries of a rename that keeps being refused); so do the writes after it.
          if (count.refused >= IN_PLACE_AFTER_REFUSALS) {
            switchToInPlace(count, log);
            if (!await current() || signal?.aborted) return false;
            if (isCurrentSync && isCurrentSync() !== true) return false;
            await writeInPlace();
            return true;
          }
        }
        if (attempt === RENAME_ATTEMPTS - 1 || !retryable.has(error.code)) throw error;
        if (!await current() || signal?.aborted) return false;
        if (typeof retryDelay === 'function') await retryDelay(attempt);
        else await new Promise(done => setTimeout(done, retryDelay ?? RENAME_BACKOFF_MS[attempt]));
      }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (owned && !committed) await io.rm(temp, {force: true, maxRetries: 3, retryDelay: 25}).catch(() => {});
  }
}

/**
 * Writes `data` to `path` without ever leaving a half-written file: a temporary file next to it, then a rename. A write that fails (a full
 * disk: ENOSPC) removes the temporary file and throws, and the old file is as it was. For the files `atomicFile` is too much for (no
 * cancellation, no retries on a refused rename); `files` is a test seam.
 */
export async function safeWriteFile(path, data, {files} = {}) {
  const io = {writeFile, rename: renameAsync, rm, ...files};
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await io.writeFile(temp, data);
    await io.rename(temp, path);
  } catch (error) {
    await io.rm(temp, {force: true}).catch(() => {});
    throw error;
  }
}
