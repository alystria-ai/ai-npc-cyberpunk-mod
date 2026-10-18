import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

// CET rewrites the heartbeat in place, so a read can land on a half-written file (or, on an old
// install, in the gap of a remove and rename). Retry that short unreadable interval, never an explicit
// world transition. An empty file is the shipped placeholder, "no session yet", and returns at once.
// No previous-world lease is extended or substituted after failure.
export async function readWorldSession(path, {read = readFile, wait = delay, now = Date.now} = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await read(path, 'utf8');
      if (typeof raw === 'string' && raw.trim() === '') return null;
      const value = JSON.parse(raw);
      const current = now();
      return value?.version === 1 && typeof value.token === 'string' && value.token.length <= 200
        && Number.isSafeInteger(value.generation) && value.generation > 0 && typeof value.ready === 'boolean'
        && Number.isFinite(value.updated) && value.updated <= current + 1000 && current - value.updated < 5000
        ? value : null;
    } catch (error) {
      if (attempt === 2 || (error?.code !== 'ENOENT' && !(error instanceof SyntaxError))) return null;
      await wait(15);
    }
  }
  return null;
}
