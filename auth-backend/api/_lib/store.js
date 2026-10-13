import { createHash } from 'node:crypto';

// Upstash Redis over REST. Every failure (network, timeout, an error reply) throws StoreError: the endpoint treats
// that as "no token" (fail closed). No dependency, no connection to keep open between invocations.
export class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreError';
  }
}

const sha1 = text => createHash('sha1').update(text).digest('hex');

export function createUpstashStore({ url, token, fetchImpl = fetch, timeoutMs = 3000 }) {
  const base = String(url).replace(/\/+$/, '');
  const loaded = new Set(); // scripts this instance has already sent with EVAL, so later calls can use EVALSHA

  async function post(path, body) {
    let response;
    try {
      response = await fetchImpl(base + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new StoreError('store unreachable');
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new StoreError(`store answered ${response.status} without JSON`);
    }
    if (!response.ok) {
      throw new StoreError(data && typeof data.error === 'string' ? data.error.slice(0, 200) : `store answered ${response.status}`);
    }
    return data;
  }

  const unwrap = entry => {
    if (entry && typeof entry === 'object' && 'error' in entry && entry.error) throw new StoreError(String(entry.error).slice(0, 200));
    return entry?.result;
  };

  return {
    /** One command: command(['GET', key]). */
    async command(args) {
      return unwrap(await post('', args));
    },
    /** Several commands in one HTTP request (each is still its own command for billing). */
    async pipeline(commands) {
      const data = await post('/pipeline', commands);
      if (!Array.isArray(data) || data.length !== commands.length) throw new StoreError('bad pipeline answer');
      return data.map(unwrap);
    },
    /** Runs a script as one command: EVALSHA when this instance has loaded it, else EVAL (which also caches it). */
    async evalScript(script, keys, args) {
      const hash = sha1(script);
      const tail = [String(keys.length), ...keys, ...args.map(String)];
      if (loaded.has(hash)) {
        try {
          return await this.command(['EVALSHA', hash, ...tail]);
        } catch (error) {
          if (!/NOSCRIPT/i.test(error.message)) throw error;
          loaded.delete(hash);
        }
      }
      const result = await this.command(['EVAL', script, ...tail]);
      loaded.add(hash);
      return result;
    },
  };
}
