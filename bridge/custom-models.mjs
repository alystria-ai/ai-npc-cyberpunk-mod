// Chat models the player adds by hand to the Local AI model row (docs/LOCAL_AI.md, "Add your own model").
//
// There is no interface for adding: the player drops a GGUF file into the `custom/` folder of the Local AI folder and lists it in a small
// manifest beside the other manifests (bridge/local-ai-pack.mjs, bridge/mature-pack.mjs):
//   <local-ai root>/manifest.custom.json
//     {version: 1, models: [{file: 'custom/MyModel-Q4_K_M.gguf', name: 'My Model', uncensored: false,
//                            family: 'llama', contextSize: 8192, chatTemplate: 'chatml'}]}
//   file         required; relative to the Local AI folder, inside it (no drive, no `..`), ends in .gguf
//   name         optional; 1 to 60 characters, no control characters (default: the file name)
//   uncensored   optional boolean (default false): the model has no content limits of its own. Mature content's allowance reads this
//                flag (bridge/mature-content.mjs), never the file name; the default and fallback choice prefer such a model while Mature content is on
//   auto         obsolete: older manifests may still have it; it is accepted (whatever its value) and ignored. Every model takes part in the
//                default choice and the fallback like any other (by size and fit)
//   family       optional label (letters, digits, `. _ -` and spaces, at most 40) used for the Mature allowance table (e.g. 'qwen')
//   contextSize  optional whole number 2048 to 262144: the context the server starts with (else the usual ladder by free memory)
//   chatTemplate optional name of a llama.cpp built-in chat template (`--chat-template`); for a file without a usable template of its own
// An entry can instead name a server the player already runs (KoboldCpp, LM Studio, Ollama, a llama.cpp server, anything with an
// OpenAI-compatible chat API) with `endpoint` in place of `file`; our own llama-server is then not used for it (docs/LOCAL_AI.md, "Use your own server"):
//     {endpoint: 'http://127.0.0.1:5001/v1', name: 'KoboldCpp Qwen 9B', model: 'optional model id', apiKey: 'optional', remote: false,
//      uncensored: false, family: 'qwen', contextSize: 8192}
//   endpoint     required (in place of `file`); an http:// or https:// address, no user name, query or fragment. Chats go to <endpoint>/chat/completions
//                (an address with no path gets /v1). Localhost, this computer's own names and the private network (192.168.x.x, 10.x.x.x,
//                172.16 to 31, 169.254.x.x, 100.64 to 127 (Tailscale), IPv6 fc00::/7 and fe80::/10, `.local`, `.lan`, `.home.arpa`, `.internal`, a name
//                with no dot) need nothing more. Any other host needs `"remote": true` and an https:// address, so a typo cannot send chats to the internet unnoticed.
//   model        optional model id sent with each request (Ollama and LM Studio want one); without it the server's only listed model, else `local`
//   apiKey       optional, for a server that wants one. A secret: it is sent only to this endpoint's own origin and never logged, listed or put in a report
//   remote       optional boolean (default false); see `endpoint`
//   name, uncensored, family, contextSize as above (a missing contextSize: the server is asked once, else 8192; a missing name: the server's host).
//   `chatTemplate` does not apply. The checks of a file (header, size, graphics memory) do not apply either: the server is looked at when the model is chosen.
// A bad entry is skipped with one log line (never thrown). Like the Mature marker, the dev folder (CYBERPUNK_CONVAI_LOCAL_AI_DEV) is the
// fallback when the real folder has no manifest.
//
// The requirements are checked here, cheaply, never per frame: the scanner runs at most every 5 s on the bridge's settings poll, stats
// each file and reads the first 2 MiB of a file only when its size or time changed (a GGUF's header: magic, version and the key/value
// metadata up to the tokenizer). A model that fails is not listed as a choice; it is reported with a reason ("not usable"):
//   missing      the file is not there
//   bad-gguf     not a GGUF file (magic bytes), a version llama.cpp cannot read (only 2 and 3), or no `general.architecture`
//   embedding    an embedding model (an encoder architecture, or a `<arch>.pooling_type` other than none): not a chat model
//   unreadable   the file could not be read
// A model whose file plus the server's headroom is more than the graphics card's total memory is listed but marked `tooLarge`; the default and the fallback never pick it.
// Not checked: whether llama.cpp supports the architecture, and whether the model has a chat template. A model that then fails to
// start is replaced by the default model with one notice (bridge/local-llm-server.mjs).
import {closeSync, openSync, readFileSync, readSync, statSync} from 'node:fs';
import {basename, isAbsolute, resolve} from 'node:path';
import {LOCAL_AI_ENV} from './local-ai-pack.mjs';
import {modelNeedMiB, safeModelId} from './local-model-choice.mjs';

export const CUSTOM_MARKER = 'manifest.custom.json';
export const CUSTOM_LIMITS = Object.freeze({
  maxModels: 16, nameMax: 60, familyMax: 40, minContext: 2048, maxContext: 262144, headerBytes: 2 * 1024 * 1024, minFileBytes: 1024 * 1024,
  maxProblems: 8, endpointMax: 300, modelMax: 120, apiKeyMax: 512,
});

/** The reasons a model is not usable, as the settings page gets them. */
export const CUSTOM_REASONS = Object.freeze(['missing', 'bad-gguf', 'embedding', 'unreadable']);

// Encoder (embedding) architectures of llama.cpp, and the vision projector: none of them chats.
const NOT_CHAT_ARCHITECTURES = new Set(['bert', 'nomic-bert', 'nomic-bert-moe', 'jina-bert-v2', 'jina-bert-v3', 'modern-bert', 'neo-bert',
  'eurobert', 't5encoder', 'wavtokenizer-dec', 'clip', 'mmproj']);
const GGUF_VERSIONS = new Set([2, 3]);
const TEMPLATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const FAMILY_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,39}$/;

const fileExists = path => { try { return statSync(path).isFile(); } catch { return false; } };
// A leading byte-order mark (Notepad and PowerShell can write one) is not part of the JSON.
const readUtf8 = path => readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
const statFile = path => { try { const stat = statSync(path); return stat.isFile() ? {size: stat.size, mtimeMs: stat.mtimeMs} : null; } catch { return null; } };

// Reads at most `length` bytes from the start of a file.
function readHead(path, length) {
  const handle = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(handle, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally { closeSync(handle); }
}

// ---- The GGUF header ---------------------------------------------------------------------------------------------------------
// GGUF: "GGUF", u32 version, u64 tensor count, u64 key/value count (version 2 and 3), then the pairs: string key, u32 type, value.
// Types: 0 u8, 1 i8, 2 u16, 3 i16, 4 u32, 5 i32, 6 f32, 7 bool, 8 string, 9 array (u32 element type, u64 count, elements), 10 u64, 11 i64, 12 f64.
const FIXED_SIZE = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8};

class Cursor {
  constructor(buffer, offset) { this.buffer = buffer; this.offset = offset; }
  need(count) { if (this.offset + count > this.buffer.length) throw new RangeError('end of the buffer'); }
  u32() { this.need(4); const value = this.buffer.readUInt32LE(this.offset); this.offset += 4; return value; }
  u64() {
    this.need(8);
    const value = this.buffer.readBigUInt64LE(this.offset); this.offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('a length that cannot be right');
    return Number(value);
  }
  string(keep = false) {
    const length = this.u64();
    this.need(length);
    const text = keep ? this.buffer.toString('utf8', this.offset, this.offset + length) : null;
    this.offset += length;
    return text;
  }
  skip(count) { this.need(count); this.offset += count; }
}

function readValue(cursor, type, keep) {
  if (type === 8) return cursor.string(keep);
  if (type === 9) {
    const elementType = cursor.u32(), count = cursor.u64();
    if (elementType === 9) throw new RangeError('nested array');
    if (FIXED_SIZE[elementType]) cursor.skip(FIXED_SIZE[elementType] * count);
    else if (elementType === 8) for (let index = 0; index < count; index++) cursor.string(false);
    else throw new RangeError('unknown array type');
    return null;
  }
  const size = FIXED_SIZE[type];
  if (!size) throw new RangeError('unknown value type');
  cursor.need(size);
  const at = cursor.offset;
  cursor.offset += size;
  if (!keep) return null;
  if (type === 4) return cursor.buffer.readUInt32LE(at);
  if (type === 5) return cursor.buffer.readInt32LE(at);
  if (type === 10) { const value = cursor.buffer.readBigUInt64LE(at); return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value); }
  if (type === 11) { const value = cursor.buffer.readBigInt64LE(at); return Math.abs(value) > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value); }
  if (type === 0) return cursor.buffer.readUInt8(at);
  if (type === 2) return cursor.buffer.readUInt16LE(at);
  return null;
}

/**
 * The first bytes of a file as a GGUF header: {ok: true, version, architecture, poolingType, contextLength} or {ok: false, reason}
 * (reason 'bad-gguf'). Reads the key/value pairs only until the tokenizer's (a large array); `architecture` is null when none was found.
 * Pure of any I/O.
 */
export function parseGgufHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return {ok: false, reason: 'bad-gguf', detail: 'too short'};
  if (buffer.toString('latin1', 0, 4) !== 'GGUF') return {ok: false, reason: 'bad-gguf', detail: 'no GGUF magic bytes'};
  const version = buffer.readUInt32LE(4);
  if (!GGUF_VERSIONS.has(version)) return {ok: false, reason: 'bad-gguf', detail: 'GGUF version ' + version + ' is not supported'};
  const result = {ok: true, version, architecture: null, poolingType: null, contextLength: null};
  const cursor = new Cursor(buffer, 8);
  try {
    cursor.u64();   // tensor count
    const pairs = cursor.u64();
    for (let index = 0; index < pairs; index++) {
      const key = cursor.string(true);
      if (key.startsWith('tokenizer.')) break;   // the rest is the vocabulary
      const type = cursor.u32();
      const wanted = key === 'general.architecture' || key.endsWith('.pooling_type') || key.endsWith('.context_length');
      const value = readValue(cursor, type, wanted);
      if (key === 'general.architecture' && typeof value === 'string') result.architecture = value;
      else if (key.endsWith('.pooling_type') && Number.isFinite(value)) result.poolingType = value;
      else if (key.endsWith('.context_length') && Number.isFinite(value) && value > 0) result.contextLength = value;
    }
  } catch { /* the header ran past what was read, or is damaged: use what was found */ }
  return result;
}

/** Why a parsed header is not a chat model: 'bad-gguf', 'embedding' or null (usable). */
export function headerProblem(header) {
  if (!header?.ok) return header?.reason ?? 'bad-gguf';
  if (!header.architecture) return 'bad-gguf';
  const architecture = header.architecture.toLowerCase();
  if (NOT_CHAT_ARCHITECTURES.has(architecture) || /embedding/.test(architecture)) return 'embedding';
  if (Number.isFinite(header.poolingType) && header.poolingType !== 0) return 'embedding';
  return null;
}

// ---- The manifest ------------------------------------------------------------------------------------------------------------

// A path in the manifest stays inside the Local AI folder: relative, no drive, no `..` segment, ends in .gguf.
function insidePath(root, value) {
  if (typeof value !== 'string' || !value.trim()) return {error: 'needs a "file"'};
  if (isAbsolute(value) || /^[a-z]:|^[\\/]/i.test(value)) return {error: 'the file path must be relative to the Local AI folder'};
  if (value.split(/[\\/]+/).includes('..')) return {error: 'the file path must not contain ".."'};
  if (!/\.gguf$/i.test(value)) return {error: 'only .gguf files are accepted'};
  return {path: resolve(root, value)};
}

// A log line names a file entry by its file and any other entry by its number: an endpoint's address can carry a secret in its path.
const label = (entry, index) => (typeof entry?.file === 'string' ? '"' + entry.file.slice(0, 80) + '"' : 'entry ' + (index + 1));

// The part of a server model's id made from its address and model id: `custom:<this>` (letters, digits, `. _ -`, at most 60). Stable across runs.
const endpointId = entry => ('ep-' + new URL(entry.endpoint).host + (entry.model ? '-' + entry.model : '')).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 60);

// ---- Servers the player runs themselves ----------------------------------------------------------------------------------------

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PRIVATE_NAME = /\.(?:local|lan|internal|localdomain|home\.arpa)$/;

/**
 * Where a host name or address is: 'loopback' (this computer), 'lan' (the private network: RFC 1918, link-local, 100.64.0.0/10 (Tailscale),
 * IPv6 unique-local and link-local, `.local` and similar names, a name with no dot) or 'remote' (anything else). Pure, no lookups. A name
 * that only contains such a word (`127.0.0.1.example.com`, `localhost.example.com`) is remote.
 */
export function hostKind(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return 'remote';
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return 'loopback';
  const four = IPV4.exec(host);
  if (four) {
    const [a, b, c, d] = four.slice(1).map(Number);
    if ([a, b, c, d].some(part => part > 255)) return 'remote';
    if (a === 127) return 'loopback';
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return 'lan';
    return 'remote';
  }
  if (host.includes(':')) return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host) ? 'lan' : 'remote';
  if (!host.includes('.') || PRIVATE_NAME.test(host)) return 'lan';
  return 'remote';
}

/**
 * The address of a server the player runs, checked strictly: {endpoint, origin, kind} or {error: 'why'}. `endpoint` is normalised (no
 * trailing slash; no path means /v1); `origin` is its scheme, host and port (the only place the key may go); `kind` is hostKind().
 * `remote` (the entry's "remote" flag) must be true for a host outside this computer and the private network, which must then use https.
 */
export function checkEndpoint(value, {remote = false} = {}) {
  if (typeof value !== 'string' || !value.trim()) return {error: '"endpoint" must be an http:// or https:// address'};
  const text = value.trim();
  if (text.length > CUSTOM_LIMITS.endpointMax || /[\u0000-\u001f\u007f\s]/.test(text)) return {error: '"endpoint" is not a usable address'};
  let url;
  try { url = new URL(text); } catch { return {error: '"endpoint" must be an http:// or https:// address'}; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return {error: '"endpoint" must start with http:// or https://'};
  if (!url.hostname) return {error: '"endpoint" has no host'};
  if (url.username || url.password) return {error: '"endpoint" must not contain a user name or password (use "apiKey")'};
  if (url.search || url.hash) return {error: '"endpoint" must not contain a query or a #fragment'};
  const kind = hostKind(url.hostname);
  if (kind === 'remote') {
    if (remote !== true) return {error: '"endpoint" is outside this computer and your local network; if that is what you want, add "remote": true'};
    if (url.protocol !== 'https:') return {error: 'a "remote" endpoint must use https://, so your chats and key are not sent in the clear'};
  }
  const path = url.pathname.replace(/\/+$/, '');
  return {endpoint: url.origin + (path || '/v1'), origin: url.origin, kind};
}

// The fields of an entry that names a server: {target, model, apiKey} or {error}.
function checkServerFields(raw) {
  if (raw.file !== undefined) return {error: 'give either "file" or "endpoint", not both'};
  let remote = false;
  if (raw.remote !== undefined) {
    if (typeof raw.remote !== 'boolean') return {error: '"remote" must be true or false'};
    remote = raw.remote;
  }
  const target = checkEndpoint(raw.endpoint, {remote});
  if (target.error) return target;
  let model = null;
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || !raw.model.trim() || raw.model.trim().length > CUSTOM_LIMITS.modelMax || /[\u0000-\u001f\u007f]/.test(raw.model)) {
      return {error: '"model" must be a model id (text of at most ' + CUSTOM_LIMITS.modelMax + ' characters)'};
    }
    model = raw.model.trim();
  }
  let apiKey = null;
  if (raw.apiKey !== undefined) {
    if (typeof raw.apiKey !== 'string' || !raw.apiKey.trim() || raw.apiKey.trim().length > CUSTOM_LIMITS.apiKeyMax || /[\u0000-\u001f\u007f\s]/.test(raw.apiKey.trim())) {
      return {error: '"apiKey" must be text without spaces (at most ' + CUSTOM_LIMITS.apiKeyMax + ' characters)'};
    }
    apiKey = raw.apiKey.trim();
  }
  return {target, model, apiKey};
}

/**
 * One manifest entry, checked strictly: {entry: {file, name, uncensored, family, contextSize, chatTemplate}} or {error: 'why'}.
 * `file` is absolute (inside `root`). An entry with `endpoint` instead of `file` is a server the player runs: {external: true, file: null,
 * endpoint, origin, hostKind, remote, model, apiKey, name, uncensored, family, contextSize, chatTemplate: null}.
 */
export function validateEntry(root, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {error: 'is not an object'};
  const server = raw.endpoint !== undefined ? checkServerFields(raw) : null;
  if (server?.error) return {error: server.error};
  const located = server ? null : insidePath(root, raw.file);
  if (located?.error) return {error: located.error.replace('needs a "file"', 'needs a "file" or an "endpoint"')};
  let name = server ? new URL(server.target.origin).host : basename(located.path).replace(/\.gguf$/i, '');
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || !raw.name.trim()) return {error: '"name" must be a non-empty text'};
    name = raw.name.trim();
    if (name.length > CUSTOM_LIMITS.nameMax) return {error: '"name" is longer than ' + CUSTOM_LIMITS.nameMax + ' characters'};
    if (/[\u0000-\u001f\u007f]/.test(name)) return {error: '"name" must not contain control characters'};
  }
  const flag = key => (raw[key] === undefined ? false : raw[key]);
  const uncensored = flag('uncensored');   // `auto` (older manifests) is obsolete: accepted whatever its value, and ignored
  if (typeof uncensored !== 'boolean') return {error: '"uncensored" must be true or false'};
  let family = null;
  if (raw.family !== undefined) {
    if (typeof raw.family !== 'string' || !FAMILY_NAME.test(raw.family.trim())) return {error: '"family" must be a short label (letters, digits, . _ - and spaces)'};
    family = raw.family.trim();
  }
  let contextSize = null;
  if (raw.contextSize !== undefined) {
    if (!Number.isInteger(raw.contextSize) || raw.contextSize < CUSTOM_LIMITS.minContext || raw.contextSize > CUSTOM_LIMITS.maxContext) {
      return {error: '"contextSize" must be a whole number from ' + CUSTOM_LIMITS.minContext + ' to ' + CUSTOM_LIMITS.maxContext};
    }
    contextSize = raw.contextSize;
  }
  if (server) {
    return {entry: {file: null, name, uncensored, family, contextSize, chatTemplate: null, external: true, endpoint: server.target.endpoint,
      origin: server.target.origin, hostKind: server.target.kind, remote: server.target.kind === 'remote', model: server.model, apiKey: server.apiKey}};
  }
  let chatTemplate = null;
  if (raw.chatTemplate !== undefined) {
    if (typeof raw.chatTemplate !== 'string' || !TEMPLATE_NAME.test(raw.chatTemplate)) return {error: '"chatTemplate" must be the name of a llama.cpp built-in template (letters, digits, . _ -)'};
    chatTemplate = raw.chatTemplate;
  }
  return {entry: {file: located.path, name, uncensored, family, contextSize, chatTemplate}};
}

// A split model: model-00001-of-00003.gguf. Only the first part is named in the manifest; the others sit beside it.
const SHARD = /^(.*-)(\d{5})-of-(\d{5})(\.gguf)$/i;
function shardPaths(file) {
  const match = SHARD.exec(basename(file));
  if (!match) return [];
  const total = Number(match[3]);
  if (!(total > 1 && total <= 64)) return [];
  const names = [];
  for (let part = 1; part <= total; part++) names.push(match[1] + String(part).padStart(5, '0') + '-of-' + match[3] + match[4]);
  return names.map(name => resolve(file, '..', name));
}

// ---- The scanner -------------------------------------------------------------------------------------------------------------

/**
 * Looks at the custom manifest and the files it names. Cheap by design: `scan()` is a few stats and one small JSON read, plus a header
 * read for a file whose size or time changed since the last look. Every problem is logged once (a repeat of the same line is not logged
 * again), never thrown.
 *   const scanner = new CustomModelScanner({project, log});
 *   scanner.scan({totalVramMiB})  -> {present, root, models: [...], problems: [{name, reason, detail}]}
 * A model: {id: 'custom:<id>', name, file, sizeMiB, needMiB, tooLarge, uncensored, family, contextSize, chatTemplate, architecture}; a server
 * the player runs (an `endpoint` entry) has {external: true, file: null, endpoint, origin, hostKind, remote, model, apiKey} and no size (0), never
 * `tooLarge`. `apiKey` is a secret: only the supervisor reads it; no log line, status or list carries it.
 */
export class CustomModelScanner {
  #cache = new Map(); #logged = new Set();

  constructor({project, environment = process.env, exists = fileExists, readText = readUtf8, stat = statFile, head = readHead, log = () => {}} = {}) {
    Object.assign(this, {project, environment, exists, readText, stat, head, log});
  }

  #say(message) {
    if (this.#logged.has(message)) return;
    if (this.#logged.size > 200) this.#logged.clear();
    this.#logged.add(message);
    this.log('[custom models] ' + message);
  }

  // The real folder; in a development checkout without it, the developer Local AI folder when only that has the manifest.
  #root() {
    const environment = this.environment;
    const primary = environment[LOCAL_AI_ENV.root] ? resolve(environment[LOCAL_AI_ENV.root]) : resolve(this.project ?? '.', 'local-ai');
    const dev = !environment[LOCAL_AI_ENV.root] && environment[LOCAL_AI_ENV.dev] ? resolve(environment[LOCAL_AI_ENV.dev]) : null;
    return !this.exists(resolve(primary, CUSTOM_MARKER)) && dev && this.exists(resolve(dev, CUSTOM_MARKER)) ? dev : primary;
  }

  scan({totalVramMiB = null} = {}) {
    const root = this.#root();
    const none = {present: false, root, models: [], problems: []};
    const path = resolve(root, CUSTOM_MARKER);
    if (!this.exists(path)) return none;
    let manifest;
    // Text copied from a web page can arrive with curly quotes; they are never valid JSON, so read them as straight quotes.
    const parseLoose = text => { try { return JSON.parse(text); } catch (error) { const fixed = text.replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2018\u2019]/g, "'"); if (fixed === text) throw error; return JSON.parse(fixed); } };
    try { manifest = parseLoose(this.readText(path)); } catch { this.#say(CUSTOM_MARKER + ' is not valid JSON; no custom models'); return {...none, present: true}; }
    if (!manifest || typeof manifest !== 'object' || manifest.version !== 1 || !Array.isArray(manifest.models)) {
      this.#say(CUSTOM_MARKER + ' must be {"version": 1, "models": [...]}; no custom models');
      return {...none, present: true};
    }
    const models = [], problems = [], files = new Set(), ids = new Set();
    manifest.models.forEach((raw, index) => {
      if (index >= CUSTOM_LIMITS.maxModels) { if (index === CUSTOM_LIMITS.maxModels) this.#say('only the first ' + CUSTOM_LIMITS.maxModels + ' custom models are used'); return; }
      const checked = validateEntry(root, raw);
      if (checked.error) { this.#say('skipped ' + label(raw, index) + ': ' + checked.error); return; }
      const entry = checked.entry;
      if (entry.external) {
        // A server the player runs: nothing to read from disk, and no network here (it is looked at when the model is chosen).
        const serverKey = (entry.endpoint + '|' + (entry.model ?? '')).toLowerCase();
        if (files.has(serverKey)) { this.#say('skipped ' + label(raw, index) + ': the same endpoint and model are listed twice'); return; }
        files.add(serverKey);
        let id = 'custom:' + endpointId(entry), suffix = 2;
        while (ids.has(id)) id = 'custom:' + endpointId(entry) + '-' + suffix++;
        ids.add(id);
        models.push({...entry, id, sizeMiB: 0, needMiB: 0, tooLarge: false, architecture: null});
        return;
      }
      const key = entry.file.toLowerCase();
      if (files.has(key)) { this.#say('skipped ' + label(raw, index) + ': the same file is listed twice'); return; }
      files.add(key);
      const verdict = this.#inspect(entry);
      if (verdict.reason) {
        this.#say('"' + entry.name + '" is not usable: ' + verdict.detail);
        if (problems.length < CUSTOM_LIMITS.maxProblems) problems.push({name: entry.name, reason: verdict.reason, detail: verdict.detail});
        return;
      }
      let id = 'custom:' + safeModelId(entry.file), suffix = 2;
      while (ids.has(id)) id = 'custom:' + safeModelId(entry.file) + '-' + suffix++;
      ids.add(id);
      let contextSize = entry.contextSize;
      if (contextSize && verdict.header.contextLength && contextSize > verdict.header.contextLength) {
        this.#say('"' + entry.name + '": contextSize ' + contextSize + ' is more than the model supports (' + verdict.header.contextLength + '); using that');
        contextSize = verdict.header.contextLength;
      }
      const model = {...entry, id, contextSize, sizeMiB: verdict.sizeMiB, architecture: verdict.header.architecture, tooLarge: false, needMiB: 0};
      model.needMiB = modelNeedMiB({tier: null}, model.sizeMiB);
      model.tooLarge = Number.isFinite(totalVramMiB) && totalVramMiB > 0 && model.needMiB > totalVramMiB;
      if (model.tooLarge) this.#say('"' + model.name + '" is too large for this graphics card (needs about ' + model.needMiB + ' MiB, the card has ' + Math.round(totalVramMiB) + ' MiB); listed but never chosen as the default or the fallback');
      models.push(model);
    });
    return {present: true, root, models, problems};
  }

  // The file checks, cached by the file's size and time: {reason, detail} for a problem, else {header, sizeMiB}.
  #inspect(entry) {
    const stat = this.stat(entry.file);
    if (!stat) return {reason: 'missing', detail: 'the file ' + basename(entry.file) + ' was not found'};
    if (stat.size < CUSTOM_LIMITS.minFileBytes) return {reason: 'bad-gguf', detail: basename(entry.file) + ' is too small to be a model'};
    const signature = entry.file + '|' + stat.size + '|' + stat.mtimeMs;
    let verdict = this.#cache.get(signature);
    if (!verdict) {
      verdict = this.#read(entry, stat);
      if (this.#cache.size > 64) this.#cache.clear();
      this.#cache.set(signature, verdict);
    }
    return verdict;
  }

  #read(entry, stat) {
    let header;
    try { header = parseGgufHeader(this.head(entry.file, Math.min(CUSTOM_LIMITS.headerBytes, stat.size))); }
    catch { return {reason: 'unreadable', detail: basename(entry.file) + ' could not be read'}; }
    const problem = headerProblem(header);
    if (problem === 'embedding') return {reason: 'embedding', detail: basename(entry.file) + ' is an embedding model (' + header.architecture + '), not a chat model'};
    if (problem) return {reason: 'bad-gguf', detail: basename(entry.file) + ' is not a usable GGUF file (' + (header.detail ?? 'no general.architecture') + ')'};
    let bytes = stat.size;
    for (const part of shardPaths(entry.file)) if (part.toLowerCase() !== entry.file.toLowerCase()) bytes += this.stat(part)?.size ?? 0;
    return {header, sizeMiB: bytes / 1048576};
  }
}
