// The character editor's local web server (docs/CHARACTER_EDITOR.md). It does not exist until the player opens the editor from the
// settings, and it is closed again by the Close button, after a quiet half hour, or when the service stops: while it is closed it costs
// nothing (no listener, no timer).
//
// Safety, in the order a request meets it:
//   - it listens on 127.0.0.1 only, on a port the system picks;
//   - the Host header must be exactly that address and port (a page on another site cannot reach it through DNS tricks);
//   - the page needs a random per-session code in its address; the page script then sends the same code in a header on every call
//     (a header the browser never sends on its own, so another site cannot forge a call), compared in constant time;
//   - a call that carries an Origin must come from this server's own origin;
//   - JSON bodies only, at most 128 KiB; only the character keys of the roster (and the keys the service made for the player's own
//     characters, custom-<name>-<letters>) are accepted; the prompting routes take only the ids of the prompt profile store's own list (a Custom profile's id
//     is made from the endpoint's host and the model, never from the request), and no file name is ever built from input. The one exception to JSON is a
//     character's voice clip (/api/voice/<key>): an audio file (WAV, MP3, OGG or FLAC; the page sends a 24 kHz WAV when its browser can
//     decode the file), at most 16 MiB, checked as a recording before anything is kept (bridge/custom-voice-clip.mjs), with the words said
//     in it in a header (base64url of UTF-8). Only story characters and the player's own characters may have a clip, never everyday people;
//   - the saved clip is played back through /api/voice/<key>/audio, which is an /api/ route like the others: it needs the token header,
//     so the page fetches it and plays a blob: address. The clip is never on a URL that works without the token;
//   - the page runs under a policy that allows this one script and style, connects to nothing but this server, and may play audio from
//     blob: addresses it made itself (media-src blob:), nothing else.
import {createServer} from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {renderEditorPage} from './character-editor-page.mjs';
import {EditorError} from './character-editor.mjs';
import {CLIP} from './custom-voice-clip.mjs';

const BODY_LIMIT = 128 * 1024;
// The content types a voice clip may arrive as. The bytes are sniffed anyway (the type is never trusted), but a browser or a script that sends
// something else is not talking about a recording.
const CLIP_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/flac', 'audio/x-flac', 'application/octet-stream']);
const WORDS_HEADER_MAX = 4096;   // header characters: base64url of the 600 characters a clip's words may have is at most about 3200
const WORDS_HEADER = /^[A-Za-z0-9_-]*$/;
/** A reply that is not JSON: the saved clip, for the page's player. */
class ClipReply { constructor(bytes) { this.bytes = bytes; } }
const STRING_LIMITS = {entries: 400, key: 400, value: 1200};
const equal = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};
/** The translations the game sent: {English source: translated}, plain strings only and bounded. */
export function cleanStrings(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  let count = 0;
  for (const [source, text] of Object.entries(value)) {
    if (!source || source === '__proto__' || typeof text !== 'string' || source.length > STRING_LIMITS.key || text.length > STRING_LIMITS.value || !text.trim()) continue;
    if (++count > STRING_LIMITS.entries) break;
    out[source] = text;
  }
  return out;
}

const FACING_GENDERS = new Set(['female', 'male']);
/**
 * The character V faced when the editor was opened ({record, name, gender}), as the game described it: short plain text only. Null when
 * the game named nobody. It only fills the "New character" form; nothing is stored until the player saves.
 */
export function cleanFacing(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = (item, limit) => typeof item === 'string' ? item.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
  const record = /^[A-Za-z0-9_][A-Za-z0-9_.-]{2,119}$/.test(String(value.record ?? '').trim()) ? String(value.record).trim() : '';
  const name = text(value.name, 60), gender = FACING_GENDERS.has(String(value.gender ?? '').toLowerCase()) ? String(value.gender).toLowerCase() : '';
  return record || name ? {record, name, gender} : null;
}

export class EditorServer {
  /**
   *   editor     CharacterEditor
   *   idleMs     quiet time after which the server closes itself
   *   log        (message) => void
   */
  constructor({editor, idleMs = 30 * 60 * 1000, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
    Object.assign(this, {editor, idleMs, log, setTimer, clearTimer});
    this.server = null; this.starting = null; this.token = ''; this.port = 0; this.idle = null;
    this.strings = {}; this.language = 'en'; this.facing = null;
  }
  get running() { return !!this.server; }
  /** The address of the page, or null when the server is closed. */
  get url() { return this.server ? `http://127.0.0.1:${this.port}/editor?t=${this.token}` : null; }

  /** Starts the server (or, when it already runs, only refreshes the translations) and resolves to the page address. */
  async start({strings = {}, language = 'en', facing = null} = {}) {
    this.strings = cleanStrings(strings);
    this.facing = cleanFacing(facing);
    this.language = typeof language === 'string' && /^[A-Za-z0-9-]{2,12}$/.test(language) ? language : 'en';
    if (this.server) { this.#touch(); return this.url; }
    if (this.starting) { await this.starting; return this.url; }
    this.starting = (async () => {
      const server = createServer((request, response) => { void this.#handle(request, response).catch(() => this.#fail(response, 500, 'internal')); });
      server.keepAliveTimeout = 5000;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      server.on('error', error => this.log('editor server error: ' + (error?.code ?? error?.message)));
      this.token = randomBytes(24).toString('base64url');
      this.port = server.address().port; this.server = server;
      this.#touch();
    })();
    try { await this.starting; } finally { this.starting = null; }
    return this.url;
  }
  async stop() {
    if (this.idle) this.clearTimer(this.idle);
    this.idle = null;
    const server = this.server;
    this.server = null; this.token = ''; this.port = 0;
    if (!server) return;
    await new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); });
  }
  #touch() {
    if (this.idle) this.clearTimer(this.idle);
    this.idle = this.setTimer(() => { this.idle = null; void this.stop(); }, this.idleMs);
    this.idle?.unref?.();
  }
  #fail(response, status, code, errors) {
    if (response.headersSent) { response.destroy(); return; }
    this.#send(response, status, {error: code, ...(errors?.length ? {errors} : {})});
  }
  #send(response, status, body) {
    const text = JSON.stringify(body);
    response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...this.#headers()});
    response.end(text);
  }
  #headers() {
    return {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Cross-Origin-Resource-Policy': 'same-origin', 'Cross-Origin-Opener-Policy': 'same-origin'};
  }
  async #body(request) {
    if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) throw new EditorError(415, 'bad-request');
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > BODY_LIMIT) throw new EditorError(413, 'too-large');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { throw new EditorError(400, 'bad-request'); }
  }

  // A voice clip: the raw bytes of an audio file. Too long a body is read to its end and thrown away, so the answer can still reach the page.
  async #bytes(request) {
    const type = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!CLIP_TYPES.has(type)) throw new EditorError(415, 'bad-request');
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size <= CLIP.maxUploadBytes) chunks.push(chunk);
    }
    if (size > CLIP.maxUploadBytes) throw new EditorError(413, 'invalid', [{field: 'voice', code: 'clip-big'}]);
    return Buffer.concat(chunks);
  }
  // The words said in a clip, from the X-Voice-Text header: base64url of their UTF-8 (at most 4096 characters). Absent is null (the store keeps
  // the words it has); anything that is not base64url of valid UTF-8 is a bad request.
  #words(request) {
    const value = request.headers['x-voice-text'];
    if (value === undefined) return null;
    const text = typeof value === 'string' ? value.trim().replace(/={1,2}$/, '') : null;
    if (text === null || text.length > WORDS_HEADER_MAX || !WORDS_HEADER.test(text) || text.length % 4 === 1) throw new EditorError(400, 'bad-request');
    try { return new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(text, 'base64url')); } catch { throw new EditorError(400, 'bad-request'); }
  }

  async #handle(request, response) {
    const origin = `http://127.0.0.1:${this.port}`;
    if (!this.server || request.headers.host !== `127.0.0.1:${this.port}`) { response.writeHead(403).end(); return; }
    let url;
    try { url = new URL(request.url, origin); } catch { this.#fail(response, 400, 'bad-request'); return; }
    if (request.method === 'GET' && url.pathname === '/editor') {
      if (!equal(url.searchParams.get('t'), this.token)) { response.writeHead(404, this.#headers()).end(); return; }
      this.#touch();
      const nonce = randomBytes(16).toString('base64url');
      const html = renderEditorPage({nonce, token: this.token, language: this.language});
      response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', ...this.#headers(),
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; media-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`});
      response.end(html);
      return;
    }
    if (!url.pathname.startsWith('/api/')) { response.writeHead(404, this.#headers()).end(); return; }
    if (!equal(request.headers['x-editor-token'], this.token)) { this.#fail(response, 401, 'unauthorized'); return; }
    if (request.headers.origin && request.headers.origin !== origin) { this.#fail(response, 403, 'forbidden'); return; }
    this.#touch();
    try {
      const reply = await this.#route(request, url);
      if (reply instanceof ClipReply) {
        // The clip itself: a WAV, never sniffed into anything else by the browser (nosniff), never cached.
        response.writeHead(200, {'Content-Type': 'audio/wav', 'Content-Length': reply.bytes.length, ...this.#headers()});
        response.end(reply.bytes);
      } else this.#send(response, 200, reply);
    } catch (error) {
      if (error instanceof EditorError) this.#fail(response, error.status, error.code, error.errors);
      else { this.log('editor request failed: ' + (error?.message ?? 'error')); this.#fail(response, 500, 'internal'); }
    }
  }

  async #route(request, url) {
    const method = request.method, parts = url.pathname.split('/').slice(2).map(part => { try { return decodeURIComponent(part); } catch { throw new EditorError(400, 'bad-request'); } });
    if (method === 'GET' && parts[0] === 'state' && parts.length === 1) return {...this.editor.state(), strings: this.strings, language: this.language};
    if (method === 'POST' && parts[0] === 'close' && parts.length === 1) { this.setTimer(() => { void this.stop(); }, 250).unref?.(); return {ok: true}; }
    if (method === 'GET' && parts[0] === 'facing' && parts.length === 1) return {facing: this.facing};
    if (parts[0] === 'world-rules' && parts.length === 1) {
      if (method === 'GET') return this.editor.worldRulesForPage ?? (() => { throw new EditorError(404, 'not-found'); })();
      if (method === 'PUT') return this.editor.saveWorldRules((await this.#body(request))?.text);
      if (method === 'DELETE') return this.editor.clearWorldRules();
    }
    if (parts[0] === 'custom') return this.#customRoute(request, method, parts.slice(1));
    if (parts[0] === 'prompting') return this.#promptingRoute(request, method, parts.slice(1));
    if (parts[0] === 'voice') return this.#voiceRoute(request, method, parts.slice(1));
    if (parts[0] !== 'character' || !parts[1]) throw new EditorError(404, 'not-found');
    const key = parts[1], rest = parts.slice(2);
    if (!rest.length) {
      if (method === 'GET') return this.editor.details(key);
      if (method === 'PUT') return this.editor.save(key, await this.#body(request));
    } else if (rest[0] === 'reset' && rest.length === 1 && method === 'POST') {
      const body = await this.#body(request);
      return this.editor.reset(key, body?.fields);
    } else if (rest[0] === 'summary' && rest.length === 1 && method === 'PUT') {
      return this.editor.setSummary(key, (await this.#body(request))?.text);
    } else if (rest[0] === 'memory' && rest.length === 2) {
      if (method === 'PUT') return this.editor.editRecord(key, rest[1], (await this.#body(request))?.text);
      if (method === 'DELETE') return this.editor.deleteRecord(key, rest[1]);
    }
    throw new EditorError(404, 'not-found');
  }

  // The prompting of each conversation option (bridge/prompting-editor.mjs): /api/prompting (the list), /api/prompting/<id> (GET the profile, PUT a change), .../validate (POST a change, nothing is
  // stored), .../reset (POST {field} for one field, nothing for all of it) and .../preview (POST {name, talkWords, mature, patch}). The id is looked up in the store's own list before a body is read, so
  // nothing is ever built from it; an unknown one is 404.
  async #promptingRoute(request, method, parts) {
    const prompting = this.editor.prompting;
    if (!prompting) throw new EditorError(404, 'not-found');
    if (!parts.length) {
      if (method === 'GET') return {profiles: prompting.list()};
    } else if (parts.length === 1) {
      if (method === 'GET') return prompting.details(parts[0]);
      if (method === 'PUT') { prompting.details(parts[0]); return prompting.set(parts[0], await this.#body(request)); }
    } else if (parts.length === 2 && method === 'POST') {
      prompting.details(parts[0]);
      const body = await this.#body(request);
      if (parts[1] === 'validate') return prompting.validate(parts[0], body);
      if (parts[1] === 'reset') { if (body !== null && !(typeof body === 'object' && !Array.isArray(body))) throw new EditorError(400, 'bad-request'); return prompting.reset(parts[0], body?.field); }
      if (parts[1] === 'preview') {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EditorError(400, 'bad-request');
        return prompting.preview(parts[0], {name: body.name, talkWords: body.talkWords, mature: body.mature}, body.patch);
      }
    }
    throw new EditorError(404, 'not-found');
  }

  // The characters the player makes: /api/custom (create), /api/custom/<key> (save, delete).
  async #customRoute(request, method, parts) {
    if (!parts.length) {
      if (method === 'POST') return this.editor.createCustom(await this.#body(request));
    } else if (parts.length === 1) {
      if (method === 'PUT') return this.editor.saveCustom(parts[0], await this.#body(request));
      if (method === 'DELETE') return this.editor.deleteCustom(parts[0]);
    }
    throw new EditorError(404, 'not-found');
  }

  // Voice clips, for a story character, one of the player's own or one of V's two voice keys (v-male, v-female): /api/voice/<key> (PUT the file with its words in X-Voice-Text, DELETE the clip),
  // /api/voice/<key>/text (PUT {text}: only the words), /api/voice/<key>/audio (GET the saved clip as a WAV). The key is checked before a body is read.
  async #voiceRoute(request, method, parts) {
    const [key, ...rest] = parts;
    if (!key || rest.length > 1) throw new EditorError(404, 'not-found');
    if (!rest.length) {
      if (method === 'PUT') { this.editor.checkVoiceKey(key); const words = this.#words(request); return this.editor.setVoice(key, await this.#bytes(request), words); }
      if (method === 'DELETE') return this.editor.clearVoice(key);
    } else if (rest[0] === 'text' && method === 'PUT') {
      this.editor.checkVoiceKey(key);
      return this.editor.setVoiceText(key, (await this.#body(request))?.text);
    } else if (rest[0] === 'audio' && method === 'GET') {
      return new ClipReply(await this.editor.voiceAudio(key));
    }
    throw new EditorError(404, 'not-found');
  }
}
