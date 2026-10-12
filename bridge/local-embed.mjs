// Text embeddings for the local option's memory search (docs/LOCAL_OPTION_DESIGN.md, "Embeddings and vector memory").
//
// A small `llama-server` on the CPU (one thread, below-normal priority, no GPU) serving the pack's embedding model
// (granite-embedding-107m-multilingual, 384 dimensions). It exists only from the moment something needs an embedding
// until `idleMs` after the last use, like the speech worker. A query takes about 14 ms on one core.
//
//   const embedder = new LlamaEmbedder({pack});
//   embedder.available()                    -> boolean   the embedding model file is there
//   embedder.id / embedder.dim              -> e.g. 'granite-embedding-107m-multilingual-q8_0' / 384
//   await embedder.embed(['text'], {signal}) -> Float32Array[]  (each L2-normalised)
//   await embedder.close()
// Failures throw an Error whose message starts with `[local:embed]`. Another backend can replace this class as long
// as it keeps available() / id / dim / embed() / close().
import {statSync} from 'node:fs';
import {LlamaProcess} from './local-llm-server.mjs';

const fileExists = path => { try { return statSync(path).isFile(); } catch { return false; } };

export const LOCAL_EMBED_LIMITS = Object.freeze({
  idleMs: 90_000,        // the server exits this long after the last use
  startupMs: 60_000,     // loading a 120 MB model takes well under a second; this is generous
  requestMs: 30_000,
  maxChars: 1500,        // longer texts are cut
  batch: 32,             // texts per request
});

// The llama-server command line for the embedding model: CPU only. Pure; the key goes in a file.
export function buildEmbedArgs({model, port, keyFile, threads = 1, host = '127.0.0.1'}) {
  if (!model || !port || !keyFile) throw TypeError('model, port and keyFile are required');
  return ['-m', model, '--embedding', '--device', 'none', '-ngl', '0', '-t', String(threads), '-tb', String(threads),
    '-c', '2048', '-b', '2048', '-ub', '2048', '-np', '1', '--no-webui', '--host', host, '--port', String(port), '--api-key-file', keyFile];
}

function embedError(message, cause) {
  const error = new Error('[local:embed] ' + message);
  error.code = 'local-embed';
  if (cause !== undefined) error.cause = cause;
  return error;
}

// Cut at `maxChars`, not in the middle of a surrogate pair.
export function clipText(text, maxChars = LOCAL_EMBED_LIMITS.maxChars) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  const cut = value.charCodeAt(maxChars - 1);
  return value.slice(0, cut >= 0xd800 && cut <= 0xdbff ? maxChars - 1 : maxChars);
}

export function normalize(values) {
  const vector = Float32Array.from(values);
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  if (length > 0) for (let index = 0; index < vector.length; index++) vector[index] /= length;
  return vector;
}

export class LlamaEmbedder {
  #proc = null; #starting = null; #inflight = 0; #idleTimer = null; #generation = 0;

  // command/argsPrefix replace pack.server when spawning (tests); processOptions go to LlamaProcess (tests).
  constructor({pack, spawnImpl, fetchImpl = fetch, idleMs = LOCAL_EMBED_LIMITS.idleMs, threads = 1, startupMs = LOCAL_EMBED_LIMITS.startupMs,
      requestMs = LOCAL_EMBED_LIMITS.requestMs, exists = fileExists, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {},
      maxChars = LOCAL_EMBED_LIMITS.maxChars, command, argsPrefix = [], processOptions = {}} = {}) {
    Object.assign(this, {pack, spawnImpl, fetchImpl, idleMs, startupMs, requestMs, exists, setTimer, clearTimer, log, maxChars,
      argsPrefix, processOptions});
    this.threads = Math.max(1, Math.min(4, threads | 0 || 1));
    this.command = command ?? pack?.server;
  }

  get id() { return this.pack?.embed?.id ?? null; }
  get dim() { return this.pack?.embed?.dim ?? null; }

  available() {
    const file = this.pack?.embed?.file;
    if (!file || !this.exists(file) || !this.command) return false;
    // The server file is checked too, unless a test supplies its own command.
    return this.command !== this.pack?.server || this.exists(this.command);
  }

  async embed(texts, {signal} = {}) {
    const list = (Array.isArray(texts) ? texts : [texts]).map(text => clipText(text, this.maxChars));
    if (list.length === 0) return [];
    signal?.throwIfAborted();
    if (!this.available()) throw embedError('the embedding model is not installed');
    this.#inflight++;
    this.#disarm();
    try {
      const proc = await this.#ensure(signal);
      const result = [];
      for (let from = 0; from < list.length; from += LOCAL_EMBED_LIMITS.batch)
        result.push(...await this.#request(proc, list.slice(from, from + LOCAL_EMBED_LIMITS.batch), signal));
      return result;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.code === 'local-embed') throw error;
      throw embedError('embedding failed (' + (error?.code || error?.name || 'error') + ')', error);
    } finally {
      this.#inflight--;
      this.#arm();
    }
  }

  async #ensure(signal) {
    if (this.#proc?.running) return this.#proc;
    if (!this.#starting) {
      const generation = this.#generation;
      const proc = new LlamaProcess({command: this.command, argsPrefix: this.argsPrefix, spawnImpl: this.spawnImpl,
        fetchImpl: this.fetchImpl, startupMs: this.startupMs, log: this.log, label: 'embedding llama-server',
        buildArgs: ({port, keyFile}) => buildEmbedArgs({model: this.pack.embed.file, port, keyFile, threads: this.threads}),
        env: {OMP_NUM_THREADS: String(this.threads)}, ...this.processOptions});
      const starting = proc.start().then(() => {
        if (generation !== this.#generation) { proc.stop().catch(() => {}); throw embedError('the embedder was closed'); }
        this.#proc = proc;
        proc.once('exit', () => { if (this.#proc === proc) { this.#proc = null; this.#disarm(); } });
        return proc;
      }, async error => {
        await proc.stop();
        this.log('[local] embedding server did not start: ' + (error?.code || error?.message));
        throw embedError('the embedding server did not start (' + (error?.code || 'error') + ')');
      }).finally(() => { if (this.#starting === starting) this.#starting = null; });
      this.#starting = starting;
      starting.catch(() => {});
    }
    return signal ? raceAbort(this.#starting, signal) : this.#starting;
  }

  async #request(proc, texts, signal) {
    const timeout = AbortSignal.timeout(this.requestMs);
    let response;
    try {
      response = await this.fetchImpl(proc.baseUrl + '/v1/embeddings', {method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {'content-type': 'application/json', authorization: 'Bearer ' + proc.apiKey},
        body: JSON.stringify({input: texts, model: 'e'})});
    } catch (error) {
      if (signal?.aborted) throw error;
      throw embedError('the embedding server did not answer (' + (error?.name === 'TimeoutError' ? 'timeout' : error?.cause?.code || 'error') + ')', error);
    }
    if (!response.ok) { await response.arrayBuffer?.().catch(() => {}); throw embedError('the embedding server answered HTTP ' + response.status); }
    let json;
    try { json = await response.json(); } catch (error) { throw embedError('the embedding server sent an unreadable answer', error); }
    const rows = Array.isArray(json?.data) ? [...json.data] : [];
    if (rows.length !== texts.length) throw embedError('the embedding server returned ' + rows.length + ' vectors for ' + texts.length + ' texts');
    if (rows.every(row => Number.isInteger(row?.index))) rows.sort((a, b) => a.index - b.index);
    return rows.map(row => {
      if (!Array.isArray(row?.embedding) || row.embedding.length === 0) throw embedError('the embedding server returned an empty vector');
      if (this.dim && row.embedding.length !== this.dim) throw embedError('unexpected embedding size ' + row.embedding.length + ' (expected ' + this.dim + ')');
      return normalize(row.embedding);
    });
  }

  #arm() {
    this.#disarm();
    if (!this.#proc || this.#inflight > 0 || !(this.idleMs > 0)) return;
    this.#idleTimer = this.setTimer(() => {
      this.#idleTimer = null;
      if (this.#inflight > 0) return;
      const proc = this.#proc; this.#proc = null;
      proc?.stop().catch(() => {});
    }, this.idleMs);
    this.#idleTimer?.unref?.();
  }
  #disarm() { if (this.#idleTimer) this.clearTimer(this.#idleTimer); this.#idleTimer = null; }

  // Ends the server. A later embed() starts a new one.
  async close() {
    this.#generation++;
    this.#disarm();
    const proc = this.#proc; this.#proc = null;
    const starting = this.#starting; this.#starting = null;
    await proc?.stop();
    await starting?.catch(() => {});
  }

  // For process exit handlers.
  killSync() {
    this.#generation++;
    this.#disarm();
    const proc = this.#proc; this.#proc = null;
    proc?.killSync();
  }
}

function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolveRace, rejectRace) => {
    const onAbort = () => rejectRace(signal.reason);
    signal.addEventListener('abort', onAbort, {once: true});
    promise.then(value => { signal.removeEventListener('abort', onAbort); resolveRace(value); },
      error => { signal.removeEventListener('abort', onAbort); rejectRace(error); });
  });
}
