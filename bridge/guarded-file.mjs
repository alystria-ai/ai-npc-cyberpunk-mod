import {open, rm} from 'node:fs/promises';
import {renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const defaultFiles = {open, rename: renameSync, rm};
const retryable = new Set(['EPERM', 'EACCES', 'EBUSY']);
// Windows refuses to rename over a file another process (the game's Lua reader, an
// indexer, antivirus) has open at that instant. Six tries with this backoff wait
// about 300 ms in total, which outlasts those short-lived handles.
const RENAME_ATTEMPTS = 6;
const RENAME_BACKOFF_MS = [10, 20, 40, 80, 150];

// files may override individual fs methods; retryDelay may be milliseconds (fixed) or an
// async delay hook called with the failed attempt index; the default is a short backoff.
// A rename that keeps failing throws after the previous file is left intact and the
// temporary file is removed; callers on a poll loop must catch that.
// isCurrentSync must return true to authorize the final commit.
// The default rename commits in the same JS turn as that synchronous guard.
export async function atomicFile(path, data, {signal, isCurrent, isCurrentSync, files, retryDelay} = {}) {
  const io = {...defaultFiles, ...files};
  const current = async () => {
    if (signal?.aborted) return false;
    const valid = !isCurrent || await isCurrent();
    return Boolean(valid) && !signal?.aborted;
  };
  if (!await current() || signal?.aborted) return false;

  const temp = path + '.' + randomUUID() + '.tmp';
  let handle, owned = false, committed = false;
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
      try {
        const renamed = io.rename(temp, path);
        // Async rename overrides are a test seam. Once dispatched, they cannot
        // guarantee that a cancellation prevents their eventual file commit.
        if (renamed && typeof renamed.then === 'function') await renamed;
        committed = true;
        return true;
      } catch (error) {
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
