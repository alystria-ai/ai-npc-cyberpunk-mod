// The OmniVoice server (docs/REMOTE_OMNIVOICE.md): the same resident worker the game's own route runs, behind a small HTTP endpoint, for a PC
// other than the one the game is on (or another graphics card of the same PC). This file is the endpoint; bridge/omni-server-main.mjs starts it
// with the pack's Python, model and voice clips. The voice logic is NOT here: every request goes to a bridge/resident-voice.mjs ResidentVoice,
// so a phrase is rendered, prepared, queued and cancelled exactly as it is on the game's PC.
//
// Safe by default, with nothing for the player to set up:
//   - it listens on 127.0.0.1 unless the player names another address (0.0.0.0 for the whole network, or one card's IP);
//   - every size is limited (omni-remote.mjs LIMITS), a request names voices and clips only by logical keys, never by path, and a clip is only stored
//     under the key it passed with the hash it came with (a clip is checked against its hash and again by the worker);
//   - a browser page cannot drive it: a request with an Origin header is refused, and POST needs JSON.
// There is no key (owner decision 2026-10-27): the server is meant for the player's own home network.
//
// Reliable: the worker is started when the server starts (so the first reply is warm), watched, and started again after a failure with the last
// voice table put back; the client never has to know.
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir, readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {OMNI_PROTOCOL, OMNI_SERVICE, DEFAULT_LISTEN, DEFAULT_PORT, LIMITS, TIMING_HEADER, KEY_PATTERN, SHA_PATTERN} from './omni-remote.mjs';
import {noCudaFailed, pathAttestationFailed} from './resident-voice.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const RESTART_DELAYS_MS = Object.freeze([2000, 5000, 15000, 30000]);

class HttpError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}

export class OmniServer {
  /**
   *   createVoice   () => a ResidentVoice (or the same surface); called again after the worker failed
   *   playerDirectory   the folder the worker reads uploaded clips from (<key>.wav), made when needed
   *   gpu           {index, name}: what the start options said, for the health answer (plain facts, no path)
   *   quality       16 or 32: the steps a request without `steps` is rendered with
   */
  constructor({createVoice, playerDirectory, version = '0', listen = DEFAULT_LISTEN, port = DEFAULT_PORT, gpu = null, quality = 16, log = () => {},
    setTimer = setTimeout, clearTimer = clearTimeout, restartDelays = RESTART_DELAYS_MS, now = Date.now} = {}) {
    if (typeof createVoice !== 'function' || typeof playerDirectory !== 'string') throw Error('Invalid OmniVoice server configuration');
    Object.assign(this, {createVoice, playerDirectory, version, listenAddress: listen, port, gpu, quality: quality === 32 ? 32 : 16, log, setTimer, clearTimer,
      restartDelays, now});
    this.startedAt = now(); this.instance = createHash('sha256').update(String(Math.random()) + startedKey()).digest('hex').slice(0, 12);
    this.waiting = 0; this.chain = Promise.resolve(); this.sentFiles = new Map(); this.lastTable = null; this.restarts = 0; this.closing = false;
    this.workerState = 'loading'; this.workerDetail = null; this.voice = null; this.server = null; this.restartTimer = null;
  }

  // ---- the worker ----
  startVoice() {
    if (this.closing) return;
    const voice = this.voice = this.createVoice({onState: value => this.workerChanged(voice, value)});
    this.workerState = 'loading';
    voice.start().then(() => { if (this.voice === voice) this.restored(voice); }, error => this.workerFailed(voice, error));
  }
  workerChanged(voice, value) {
    if (this.voice !== voice) return;
    if (value?.state === 'error') this.workerFailed(voice, voice.failure);
  }
  // Loaded: the last voice table the game sent is put back (a restart is not the game's concern).
  async restored(voice) {
    this.workerState = 'ready'; this.workerDetail = null;
    this.log(`voice ready (${voice.details?.device ?? 'cuda'})`);
    if (this.lastTable) {
      try { await voice.setVoices(await this.forWorker(this.lastTable), {playerVoiceDirectory: this.playerDirectory}); this.log('voices put back after a restart'); }
      catch (error) { this.log(`voices could not be put back: ${briefly(error)}`); }
    }
  }
  workerFailed(voice, error) {
    if (this.voice !== voice || this.closing || ['restarting', 'failed'].includes(this.workerState)) return;
    this.workerState = 'restarting'; this.workerDetail = briefly(error);
    // A failure that is the same on every start is not tried again: this PC has no graphics card the voice can use, or the files do not agree.
    if (noCudaFailed(this.workerDetail) || pathAttestationFailed(this.workerDetail)) {
      this.workerState = 'failed';
      this.log(noCudaFailed(this.workerDetail) ? 'The voice needs an NVIDIA graphics card that works (or the ROCm route of docs/OMNIVOICE_AMD.md) and found none. Check GPU= in the start file and the NVIDIA driver, then start the server again.'
        : `The voice cannot start (${this.workerDetail}). Start the server again after fixing the files.`);
      return;
    }
    const delay = this.restartDelays[Math.min(this.restarts, this.restartDelays.length - 1)];
    this.restarts++;
    this.log(`the voice stopped (${this.workerDetail}); starting it again in ${Math.round(delay / 1000)} s`);
    this.restartTimer = this.setTimer(async () => {
      this.restartTimer = null;
      try { await voice.close(); } catch { try { await voice.recoverExit?.(); } catch { /* the next start tries anyway */ } }
      this.startVoice();
    }, delay);
    this.restartTimer?.unref?.();
  }
  get loaded() { return this.workerState === 'ready' && this.voice?.loaded === true && !this.voice.failure && !this.voice.closing; }

  // ---- the endpoint ----
  listen() {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    // Idle connections of the game's client are kept open for reuse (no handshake in front of a phrase); a request that is slow to arrive is cut.
    this.server.keepAliveTimeout = 120_000; this.server.headersTimeout = 20_000; this.server.requestTimeout = 120_000;
    this.server.on('connection', socket => socket.setNoDelay(true));
    this.server.on('clientError', (error, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {} });
    this.startVoice();
    return new Promise((done, fail) => {
      this.server.once('error', fail);
      this.server.listen(this.port, this.listenAddress, () => {
        this.server.off('error', fail);
        const address = this.server.address();
        this.port = address.port;
        done({address: address.address, port: address.port});
      });
    });
  }
  async close() {
    this.closing = true;
    this.clearTimer(this.restartTimer);
    const stopped = new Promise(done => this.server ? this.server.close(() => done()) : done());
    this.server?.closeAllConnections?.();
    try { await this.voice?.close(); } catch { try { await this.voice?.recoverExit?.(); } catch { /* the process ends anyway */ } }
    await stopped;
  }

  health() {
    const voice = this.voice;
    return {ok: true, service: OMNI_SERVICE, protocol: OMNI_PROTOCOL, version: this.version, instance: this.instance,
      state: this.loaded ? 'ready' : ['restarting', 'failed'].includes(this.workerState) ? 'error' : 'loading',
      ...(this.workerDetail && ['restarting', 'failed'].includes(this.workerState) ? {detail: this.workerDetail} : {}),
      device: voice?.details?.device ?? null, gpu: this.gpu, quality: this.quality, voices: voice?.available?.size ?? 0,
      prepared: voice?.prepared?.size ?? 0, waiting: this.waiting, restarts: this.restarts, uptimeMs: this.now() - this.startedAt};
  }

  async handle(req, res) {
    const started = performance.now();
    try {
      // A browser page (any web page the player visits) cannot reach this: browsers send Origin on every cross-site request.
      if (req.headers.origin !== undefined) throw new HttpError(403, 'browser');
      const url = new URL(req.url ?? '/', 'http://omnivoice.invalid');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/v1/health') return reply(res, 200, this.health());
      if (req.method === 'POST' && ['/v1/voices', '/v1/prepare', '/v1/synthesize'].includes(path)) {
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'json-needed');
        const limit = path === '/v1/voices' ? LIMITS.voicesBytes : LIMITS.jsonBytes;
        const body = parseJson(await readBody(req, limit));
        if (this.waiting >= LIMITS.waiting) throw new HttpError(503, 'busy');
        this.waiting++;
        try {
          if (path === '/v1/voices') return await this.voices(body, res);
          if (path === '/v1/prepare') return await this.prepare(body, req, res);
          return await this.synthesize(body, req, res, started);
        } finally { this.waiting--; }
      }
      const clip = /^\/v1\/clips\/([^/]+)$/.exec(path);
      if (req.method === 'PUT' && clip) return await this.clip(clip[1], url.searchParams.get('sha256'), req, res);
      throw new HttpError(path.startsWith('/v1/') ? 405 : 404, 'not-found');
    } catch (error) {
      if (!(error instanceof HttpError) && error?.name === 'AbortError') { try { res.destroy(); } catch {} return; }
      const status = error instanceof HttpError ? error.status : 500;
      if (!(error instanceof HttpError)) this.log(`a request failed: ${briefly(error)}`);
      if (res.headersSent) { try { res.destroy(); } catch {} return; }
      reply(res, status, {ok: false, error: error instanceof HttpError ? error.code : 'server-error',
        ...(status === 500 ? {message: briefly(error)} : {}), state: this.health().state}, status === 413 || status === 415 ? {connection: 'close'} : {});
    }
  }

  need() {
    if (!this.loaded) throw new HttpError(503, ['restarting', 'failed'].includes(this.workerState) ? 'failed' : 'loading');
    return this.voice;
  }

  // The voices the game wants. Voices whose clip the server has not got (a player's own clip, V's voice) come back as `missing`; the game sends
  // each with PUT /v1/clips/<key> and asks again with `reload` naming them, so the worker reads the file that has arrived.
  voices(body, res) {
    const voices = body?.voices, reload = body?.reload ?? [];
    if (!plain(voices) || Object.keys(voices).length > 1024 || !Array.isArray(reload) || reload.length > 64 || reload.some(key => !KEY_PATTERN.test(key))) {
      throw new HttpError(400, 'bad-voices');
    }
    const voice = this.need();
    const job = this.chain.catch(() => {}).then(async () => {
      try {
        const held = reload.filter(key => Object.hasOwn(voices, key));
        const wanted = await this.forWorker(voices);
        if (held.length) {
          const reduced = {...wanted}; for (const key of held) delete reduced[key];
          await voice.setVoices(reduced, {playerVoiceDirectory: this.playerDirectory});
        }
        await voice.setVoices(wanted, {playerVoiceDirectory: this.playerDirectory});
      } catch (error) { throw new HttpError(400, 'bad-voices', briefly(error)); }
      this.lastTable = voices;
      const missing = [];
      for (const [key, descriptor] of Object.entries(voices)) {
        if (plain(descriptor) && (descriptor.status ?? 'ready') === 'ready' && !voice.available.has(key) && SHA_PATTERN.test(descriptor.sha256 ?? '')) {
          missing.push({key, sha256: descriptor.sha256});
        }
      }
      return {ok: true, voices: voice.available.size, prepared: [...voice.prepared], missing};
    });
    this.chain = job;
    return job.then(value => reply(res, 200, value));
  }

  // The table as the worker is given it: a voice whose clip the game sent (the file <key>.wav in the player folder has the descriptor's hash) is read from
  // there, whatever folder the game's descriptor names; every other descriptor is passed on as it is. The worker checks every file against its hash again.
  async forWorker(voices) {
    const result = {};
    for (const [key, descriptor] of Object.entries(voices)) {
      result[key] = descriptor;
      if (!plain(descriptor) || (descriptor.status ?? 'ready') !== 'ready' || typeof descriptor.reference !== 'string' || descriptor.reference.startsWith('runtime/player-voices/')) continue;
      if (!KEY_PATTERN.test(key) || !SHA_PATTERN.test(descriptor.sha256 ?? '')) continue;
      if (await this.sentSha(key) === descriptor.sha256) result[key] = {...descriptor, reference: `runtime/player-voices/${key}.wav`};
    }
    return result;
  }
  // The hash of the clip the game sent for `key` (read again only when the file changed), or null.
  async sentSha(key) {
    const file = resolve(this.playerDirectory, `${key}.wav`);
    try {
      const info = await stat(file), seen = this.sentFiles.get(key);
      if (seen && seen.size === info.size && seen.mtimeMs === info.mtimeMs) return seen.sha;
      const sha = createHash('sha256').update(await readFile(file)).digest('hex');
      this.sentFiles.set(key, {size: info.size, mtimeMs: info.mtimeMs, sha});
      return sha;
    } catch { return null; }
  }

  async clip(key, sha, req, res) {
    if (!KEY_PATTERN.test(key) || !SHA_PATTERN.test(sha ?? '')) throw new HttpError(400, 'bad-clip');
    const bytes = await readBody(req, LIMITS.clipBytes);
    if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') throw new HttpError(400, 'not-wav');
    if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new HttpError(400, 'hash');
    await mkdir(this.playerDirectory, {recursive: true});
    const files = (await readdir(this.playerDirectory).catch(() => [])).filter(name => name.endsWith('.wav'));
    if (files.length >= LIMITS.clipFiles && !files.includes(`${key}.wav`)) throw new HttpError(507, 'clips-full');
    const target = resolve(this.playerDirectory, `${key}.wav`), temporary = `${target}.${process.pid}.tmp`;
    try { await writeFile(temporary, bytes); await rename(temporary, target); }
    catch (error) { await rm(temporary, {force: true}); throw error; }
    reply(res, 200, {ok: true, key, bytes: bytes.length});
  }

  // A job the game gives up on (the connection closes) is cancelled; one that has not started never starts, one that has finishes in the worker
  // (a render cannot be taken back), exactly as on the game's own PC.
  signalFor(req, res) {
    const control = new AbortController();
    res.on('close', () => { if (!res.writableEnded) control.abort(); });
    return control.signal;
  }

  async prepare(body, req, res) {
    const {profile, languageReference} = body ?? {};
    if (typeof profile !== 'string' || !KEY_PATTERN.test(profile)) throw new HttpError(400, 'bad-profile');
    const voice = this.need();
    if (!voice.hasProfile(profile)) throw new HttpError(404, 'unknown-profile');
    this.useSteps(voice, body?.steps);
    voice.setKeepPrepared(true);
    const signal = this.signalFor(req, res);
    const started = performance.now();
    try {
      const receipt = languageReference ? await voice.prepareLanguage(profile, languageReference, {signal}) : await voice.prepareProfile(profile, {signal});
      reply(res, 200, {ok: true, profile, ready: receipt.ready !== false, ...(receipt.languageReference ? {languageReference: receipt.languageReference} : {}),
        ms: receipt.ms ?? Math.round(performance.now() - started), prepared: [...voice.prepared]});
    } catch (error) { this.renderFailed(error); }
  }

  async synthesize(body, req, res, started) {
    const {profile, text, language, languageReference} = body ?? {};
    if (typeof profile !== 'string' || !KEY_PATTERN.test(profile)) throw new HttpError(400, 'bad-profile');
    if (typeof text !== 'string' || !text.trim() || text.length > LIMITS.textChars) throw new HttpError(400, 'bad-text');
    if (language !== undefined && language !== null && !/^[a-z]{2,3}$/.test(language)) throw new HttpError(400, 'bad-language');
    const voice = this.need();
    if (!voice.hasProfile(profile)) throw new HttpError(404, 'unknown-profile');
    const steps = [16, 32].includes(body?.steps) ? body.steps : this.quality;
    const signal = this.signalFor(req, res);
    let result;
    try { result = await voice.synthesize(profile, text, {signal, steps, ...(language ? {language} : {}), ...(languageReference ? {languageReference} : {})}); }
    catch (error) { this.renderFailed(error); }
    if (signal.aborted) return;
    const wav = Buffer.from(result.audio, 'base64');
    const timing = JSON.stringify({...result.timing, prepared: [...voice.prepared], serverMs: Math.round((performance.now() - started) * 10) / 10});
    res.writeHead(200, {'content-type': 'audio/wav', 'content-length': wav.length, [TIMING_HEADER]: timing, 'x-omni-instance': this.instance,
      'cache-control': 'no-store'});
    res.end(wav);
  }

  useSteps(voice, steps) { if ([16, 32].includes(steps)) voice.setSteps(steps); }

  renderFailed(error) {
    if (error?.name === 'AbortError') throw error;
    const message = String(error?.message ?? error);
    if (/Convai voice|unknown/i.test(message)) throw new HttpError(404, 'unknown-profile');
    if (/^Invalid /.test(message)) throw new HttpError(400, 'bad-request', message);
    if (this.voice?.failure || this.voice?.closing) throw new HttpError(503, 'failed', message);
    throw new HttpError(500, 'render-failed', message);
  }
}

const startedKey = () => `${process.pid}:${Date.now()}`;
const briefly = error => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 200);

function reply(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-store', ...headers});
  res.end(body);
}

function parseJson(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!plain(value)) throw Error('not an object');
    return value;
  } catch { throw new HttpError(400, 'bad-json'); }
}

// The body, up to `limit` bytes: an announced size above it is refused before anything is read, and a stream that goes past it is cut.
function readBody(req, limit) {
  return new Promise((done, fail) => {
    const announced = Number(req.headers['content-length']);
    if (Number.isFinite(announced) && announced > limit) { fail(new HttpError(413, 'too-large')); return; }
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { chunks.length = 0; fail(new HttpError(413, 'too-large')); req.pause(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks)));
    req.on('error', fail);
    req.on('aborted', () => fail(Object.assign(Error('aborted'), {name: 'AbortError'})));
  });
}
