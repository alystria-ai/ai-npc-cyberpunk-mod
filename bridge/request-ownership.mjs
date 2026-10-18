import {readFile, stat} from 'node:fs/promises';

// Lua rewrites last-input.json in place (one open, write, close over the file that ships empty), so a
// replacement keeps its file index and creation time and shows as a new size and modification time.
// Rereading the whole request (often 0.5+ MB of journal history) on every ownership check
// cost about 4-10 ms per call, several times per playback poll and per PCM
// packet. An unchanged identity cannot hold different bytes; any change still
// gets the exact byte comparison against the admitted request. The game withdraws a request by writing the file
// empty, which is a change like any other: the bytes no longer match, so the owner is retired.
export function fileIdentity(info) {
  if (!info) return null;
  return [info.ino, info.size, info.mtimeMs, info.ctimeMs, info.birthtimeMs].join(':');
}

// An empty (or blank) read of the request file means no request, exactly as a missing file did.
export const requestFileEmpty = raw => typeof raw === 'string' && raw.trim() === '';

const defaultFiles = {stat, readFile};

export class RequestFileOwner {
  // files may override stat/readFile (test seam, like guarded-file.mjs).
  constructor(path, raw, info, files = defaultFiles) {
    if (typeof path !== 'string' || typeof raw !== 'string') throw Error('Invalid request ownership');
    this.path = path; this.raw = raw; this.identity = fileIdentity(info); this.files = {...defaultFiles, ...files};
  }

  static async admit(path, raw, info, files = defaultFiles) {
    const io = {...defaultFiles, ...files};
    return new RequestFileOwner(path, raw, info === undefined ? await io.stat(path).catch(() => null) : info, io);
  }

  async current() {
    const info = await this.files.stat(this.path).catch(() => null);
    if (!info) return false;
    const identity = fileIdentity(info);
    if (identity === this.identity) return true;
    const submitted = await this.files.readFile(this.path, 'utf8').catch(() => null);
    if (submitted === null || submitted !== this.raw) return false;
    // Identical bytes were written again. Later checks can use the new file.
    this.identity = identity;
    return true;
  }
}
