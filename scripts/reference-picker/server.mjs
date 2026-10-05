// HTTP server and job queue behind scripts/Reference-Picker.mjs. Bound to 127.0.0.1 only.
import {createServer} from 'node:http';
import {createReadStream, existsSync, statSync} from 'node:fs';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {basename, dirname, extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Engines, SLOTS} from './engines.mjs';
import {FALLBACK_TEXT, Pool, rerollSet} from './pool.mjs';
import {engineSet, ENGINES, PickStore, SETS} from './picks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml'};
const titleCase = key => key.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
const fail = (status, message) => Object.assign(Error(message), {status});
const round = value => Math.round(value * 100) / 100;

export class Picker {
  constructor({project, work, pool, store, engines, uiDirectory = resolve(here, 'ui'), now = () => Date.now()}) {
    Object.assign(this, {project, work, pool, store, engines, uiDirectory, now});
    this.jobs = []; this.running = false; this.sequence = 0;
    this.references = new Map();
  }

  // ---- sets ----
  candidate(key, set) {
    const state = this.store.voice(key);
    const ids = state.candidate[set] ?? this.pool.startingSet(key, set);
    if (!ids) return null;
    const history = state.history[set][0];
    const source = state.candidate[set] ? (history?.action === 'reroll' ? 'rerolled' : history?.action === 'restore' ? 'restored' : 'chosen by hand') : ids[0]?.startsWith('live:') ? "today's reference" : 'proposed';
    return {ids, source};
  }
  describeClip(key, id) {
    const clip = this.pool.clip(key, id);
    if (!clip) return {id, missing: true};
    const url = id.startsWith('live:') ? `/audio/live/${id.slice(5)}/${key}` : `/audio/clip/${key}/${encodeURIComponent(id)}`;
    return {id, seconds: round(clip.d), transcript: clip.t, typicality: clip.ty, loudness: clip.rel ?? null, delivery: clip.k, audio: url,
      label: id.startsWith('live:') ? `today's ${id.slice(5) === 'omni' ? 'OmniVoice' : 'Pocket'} reference` : null};
  }
  describeSet(key, set) {
    const candidate = this.candidate(key, set);
    if (!candidate) return null;
    const clips = candidate.ids.map(id => this.describeClip(key, id));
    return {ids: candidate.ids, clips, source: candidate.source, seconds: this.pool.seconds(key, candidate.ids),
      budget: SETS[set].budget, transcript: this.pool.transcript(key, candidate.ids)};
  }
  setKey = ids => ids.join('|');

  // ---- samples ----
  line(key, index) {
    const voice = this.pool.voice(key), lines = voice.lines.filter(line => line.exists);
    const chosen = lines[Math.min(Math.max(0, index | 0), Math.max(0, lines.length - 1))];
    return {lines, chosen, index: chosen ? lines.indexOf(chosen) : 0, text: chosen?.t ?? FALLBACK_TEXT};
  }
  async reference(key, ids) {
    const memo = this.setKey(ids);
    const cacheKey = `${key}#${memo}`;
    if (!this.references.has(cacheKey)) {
      const clips = ids.map(id => this.pool.clip(key, id));
      const pending = (ids.length === 1 && ids[0].startsWith('live:')
        ? this.engines.materializeLive(this.pool.voice(key).live[ids[0].slice(5)])
        : this.engines.materialize(clips)).catch(error => { this.references.delete(cacheKey); throw error; });
      this.references.set(cacheKey, pending);
    }
    return this.references.get(cacheKey);
  }
  // Every slot that could be on the card, with the file it would produce.
  async slotsFor(key, lineIndex) {
    const voice = this.pool.voice(key), {text, index} = this.line(key, lineIndex), out = [];
    for (const definition of SLOTS) {
      let ids, transcript;
      if (definition.live) {
        const live = voice.live[definition.engine];
        if (!live?.exists) continue;
        ids = ['live:' + definition.engine]; transcript = live.transcript;
      } else {
        const candidate = this.candidate(key, definition.set);
        if (!candidate) continue;
        ids = candidate.ids; transcript = this.pool.transcript(key, ids);
      }
      const reference = await this.reference(key, ids);
      const id = await this.engines.sampleId(definition, reference, transcript, text);
      const file = `${definition.slot}-${id}.wav`, path = resolve(this.work, 'samples', key, `line${index}`, file);
      out.push({...definition, ids, transcript, reference, text, line: index, path,
        url: `/audio/sample/${key}/${index}/${file}`, exists: existsSync(path)});
    }
    return out;
  }
  jobFor(key) { return [...this.jobs].reverse().find(job => job.voice === key) ?? null; }
  async card(key, lineIndex = 0) {
    const voice = this.pool.voice(key), state = this.store.voice(key);
    const {lines, index, text} = this.line(key, lineIndex);
    const slots = await this.slotsFor(key, index), job = this.jobFor(key);
    const full = this.describeSet(key, 'full'), shortSet = this.describeSet(key, 'short');
    const sets = {full, short: shortSet};
    const kept = {};
    for (const engine of ENGINES) {
      const entry = state.kept[engine];
      if (!entry) continue;
      const current = sets[engineSet(engine)]?.ids;
      kept[engine] = {...entry, clips: entry.clips.map(id => this.describeClip(key, id)), isCurrent: !!current && current.join('|') === entry.clips.join('|')};
    }
    const rejectedNow = {};
    for (const set of Object.keys(SETS)) {
      const ids = sets[set]?.ids.join('|');
      rejectedNow[set] = !!ids && state.rejected.some(item => item.set === set && item.clips.join('|') === ids);
    }
    const active = job && ['queued', 'running'].includes(job.status) ? job : null;
    return {key, name: titleCase(key), poolSize: voice.clips.length, lines: lines.map((line, at) => ({index: at, text: line.t, seconds: round(line.d), split: line.split,
        audio: `/audio/line/${key}/${at}`})), line: index, text, hasLine: lines.length > 0,
      live: Object.fromEntries(Object.entries(voice.live).filter(([, live]) => live.exists).map(([engine, live]) => [engine,
        {seconds: round(live.d), transcript: live.transcript, audio: `/audio/live/${engine}/${key}`}])),
      sets, history: Object.fromEntries(Object.keys(SETS).map(set => [set, this.historyOf(key, set, sets[set])])),
      kept, rejected: state.rejected, rejectedNow, note: state.note,
      samples: Object.fromEntries(slots.map(slot => [slot.slot, {label: slot.label, engine: slot.engine, steps: slot.steps, set: slot.set ?? null,
        live: !!slot.live, clips: slot.live ? null : slot.ids.length, exists: slot.exists, url: slot.exists ? slot.url : null,
        state: slot.exists ? 'ready' : active?.slots.find(item => item.slot === slot.slot)?.state ?? 'missing',
        error: active?.slots.find(item => item.slot === slot.slot)?.error ?? null}])),
      job: job ? this.publicJob(job) : null};
  }
  // Earlier sets, newest first, ending with the starting set (the research agent's proposal) if it was ever replaced.
  historyOf(key, set, current) {
    const list = this.store.voice(key).history[set].map(item => ({...item}));
    const start = this.pool.startingSet(key, set);
    if (start && list.length && !list.some(item => item.clips.join('|') === start.join('|'))) {
      list.push({clips: start, seconds: this.pool.seconds(key, start), ts: null, action: start[0].startsWith('live:') ? "today's reference" : 'proposed'});
    }
    return list.map(item => ({...item, current: item.clips.join('|') === current?.ids.join('|')}));
  }
  publicJob(job) {
    return {id: job.id, voice: job.voice, line: job.line, status: job.status, done: job.done, total: job.total, current: job.current,
      error: job.error, queuedAt: job.queuedAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
      slots: job.slots.map(({slot, state, error, tookMs}) => ({slot, state, error, tookMs}))};
  }
  summary() {
    return {work: this.work, log: this.store.logPath, picks: this.store.jsonPath, engines: this.engines.state,
      voices: this.pool.keys.map(key => {
        const voice = this.pool.voice(key), state = this.store.voice(key);
        const kept = Object.keys(state.kept), job = this.jobFor(key);
        return {key, name: titleCase(key), poolSize: voice.clips.length, hasLine: voice.lines.some(line => line.exists),
          proposed: Object.keys(voice.proposed).length > 0, kept, rejected: state.rejected.length, changed: !!(state.candidate.full || state.candidate.short),
          note: !!state.note, job: job && ['queued', 'running'].includes(job.status) ? job.status : null};
      })};
  }
  queue() {
    return {running: this.running, engines: this.engines.state, jobs: this.jobs.slice(-40).map(job => this.publicJob(job)),
      waiting: this.jobs.filter(job => job.status === 'queued').length};
  }

  // ---- actions ----
  async reroll(key, set) {
    if (!SETS[set]) throw fail(400, 'Unknown set');
    const voice = this.pool.voice(key), state = this.store.voice(key);
    const current = this.candidate(key, set)?.ids ?? [];
    const pick = rerollSet(voice.clips, {budget: SETS[set].budget, current, recent: state.history[set].slice(0, 15).map(item => item.clips),
      rejected: state.rejected.filter(item => item.set === set).map(item => item.clips)});
    if (!pick) throw fail(409, `${titleCase(key)} has no other usable clips to draw from (${voice.clips.length} in the pool)`);
    await this.store.append({voice: key, engine: set === 'short' ? 'omni-short' : 'pocket+omni', set, action: 'reroll', clips: pick.ids,
      seconds: pick.seconds, previous: current});
  }
  async setManual(key, set, ids, action = 'manual-set') {
    const {seconds} = this.pool.validateSet(key, set, ids);
    await this.store.append({voice: key, engine: set === 'short' ? 'omni-short' : 'pocket+omni', set, action, clips: ids, seconds,
      previous: this.candidate(key, set)?.ids ?? []});
  }
  async keep(key, engine, note, line) {
    if (!ENGINES.includes(engine)) throw fail(400, 'Unknown engine');
    const set = engineSet(engine), candidate = this.candidate(key, set);
    if (!candidate) throw fail(409, 'There is no set to keep');
    const {seconds} = this.pool.validateSet(key, set, candidate.ids);
    await this.store.append({voice: key, engine, set, action: 'keep', clips: candidate.ids, seconds, line, note: note ?? this.store.voice(key).note});
  }
  async unkeep(key, engine) {
    if (!ENGINES.includes(engine)) throw fail(400, 'Unknown engine');
    const kept = this.store.voice(key).kept[engine];
    if (!kept) return;
    await this.store.append({voice: key, engine, set: engineSet(engine), action: 'unkeep', clips: kept.clips});
  }
  async reject(key, set, note) {
    if (!SETS[set]) throw fail(400, 'Unknown set');
    const candidate = this.candidate(key, set);
    if (!candidate) throw fail(409, 'There is no set to reject');
    await this.store.append({voice: key, engine: set === 'short' ? 'omni-short' : 'pocket+omni', set, action: 'reject', clips: candidate.ids,
      seconds: this.pool.seconds(key, candidate.ids), note: note ?? this.store.voice(key).note});
  }
  async note(key, note) {
    if (typeof note !== 'string' || note.length > 2000) throw fail(400, 'Notes are text up to 2000 characters');
    const set = this.candidate(key, 'full');
    await this.store.append({voice: key, engine: 'all', action: 'note', note, clips: set?.ids ?? []});
  }
  async play(key, body) {
    const what = ['original', 'clip', 'sample', 'live'].includes(body.what) ? body.what : null;
    if (!what || !this.pool.has(key)) throw fail(400, 'Unknown play target');
    const entry = {voice: key, action: 'play', what, target: String(body.target ?? '').slice(0, 200)};
    if (what === 'sample') {
      const slot = SLOTS.find(item => item.slot === body.target);
      if (slot) { entry.engine = slot.live ? slot.engine : slot.set === 'short' ? 'omni-short' : slot.engine; entry.clips = slot.live ? ['live:' + slot.engine] : this.candidate(key, slot.set)?.ids ?? []; }
    }
    await this.store.append(entry);
  }

  // ---- jobs ----
  enqueue(key, {line = 0, force = false, slots} = {}) {
    this.pool.voice(key);
    const existing = this.jobs.find(job => job.voice === key && job.line === line && ['queued'].includes(job.status));
    if (existing) return existing;
    const job = {id: ++this.sequence, voice: key, line, force, requested: slots ?? null, status: 'queued', done: 0, total: 0, current: null,
      error: null, queuedAt: this.now(), slots: [], startedAt: null, finishedAt: null};
    this.jobs.push(job);
    this.store.append({voice: key, engine: 'all', action: 'regenerate', line, force,
      clips: this.candidate(key, 'full')?.ids ?? [], short: this.candidate(key, 'short')?.ids ?? null}).catch(() => {});
    queueMicrotask(() => this.drain());
    return job;
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.jobs.find(item => item.status === 'queued'); job; job = this.jobs.find(item => item.status === 'queued')) await this.run(job);
    } finally { this.running = false; }
  }
  async run(job) {
    job.status = 'running'; job.startedAt = this.now();
    const store = this.store;
    try {
      const wanted = (await this.slotsFor(job.voice, job.line)).filter(slot => !job.requested || job.requested.includes(slot.slot));
      job.slots = wanted.filter(slot => job.force || !slot.exists).map(slot => ({...slot, state: 'queued', error: null}));
      job.total = job.slots.length;
      const pocket = job.slots.filter(slot => slot.engine === 'pocket'), omni = job.slots.filter(slot => slot.engine === 'omni');
      const finish = (slot, result) => {
        slot.state = 'ready'; slot.tookMs = result.tookMs; job.done++;
        return writeFile(slot.path.replace(/\.wav$/, '.json'), JSON.stringify({voice: job.voice, slot: slot.slot, line: slot.line, clips: slot.ids,
          text: slot.text, seconds: result.seconds, tookMs: result.tookMs, steps: slot.steps ?? null, finished: new Date().toISOString()}, null, 1));
      };
      const failSlots = (slots, error) => { for (const slot of slots.filter(item => item.state !== 'ready')) { slot.state = 'error'; slot.error = error.message; } job.error = error.message; };
      if (pocket.length) {
        for (const slot of pocket) slot.state = 'running';
        job.current = 'Pocket';
        try {
          await this.engines.runPocket(pocket.map(slot => ({slot, reference: slot.reference, transcript: slot.transcript, text: slot.text, out: slot.path})),
            {jobId: `job${job.id}`, onItem: (item, result) => finish(item.slot, result)});
        } catch (error) { failSlots(pocket, error); }
      }
      for (const slot of omni) {
        slot.state = 'running'; job.current = slot.label;
        try {
          await mkdir(dirname(slot.path), {recursive: true});
          const result = await this.engines.renderOmni({reference: slot.reference, transcript: slot.transcript, text: slot.text, steps: slot.steps, out: slot.path});
          await finish(slot, {seconds: result.seconds, tookMs: result.tookMs});
        } catch (error) { failSlots([slot], error); }
      }
      job.status = job.error ? 'error' : 'done';
    } catch (error) { job.status = 'error'; job.error = error.message; }
    job.current = null; job.finishedAt = this.now();
    store.append({voice: job.voice, engine: 'all', action: job.status === 'done' ? 'regenerate-done' : 'regenerate-failed', line: job.line,
      slots: job.slots.map(({slot, state, tookMs, error}) => ({slot, state, tookMs, error})), error: job.error ?? undefined}).catch(() => {});
  }

  // ---- HTTP ----
  async handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    try {
      this.guard(request);
      if (request.method === 'GET' && path.startsWith('/audio/')) return await this.audio(request, response, path);
      if (path.startsWith('/api/')) return await this.api(request, response, path, url);
      if (request.method === 'GET') return await this.staticFile(response, path);
      throw fail(405, 'Method not allowed');
    } catch (error) {
      if (!error.status) console.error(error);
      response.writeHead(error.status ?? 500, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
      response.end(JSON.stringify({error: error.status ? error.message : 'Internal error; see the picker console'}));
    }
  }
  guard(request) {
    // Loopback only, and no DNS-rebinding or cross-site posts.
    const host = (request.headers.host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost'].includes(host)) throw fail(403, 'Bad host');
    if (request.method === 'POST') {
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) throw fail(403, 'Bad origin');
      if (!(request.headers['content-type'] ?? '').startsWith('application/json')) throw fail(415, 'JSON only');
    }
  }
  async body(request) {
    let size = 0; const chunks = [];
    for await (const chunk of request) { size += chunk.length; if (size > 65_536) throw fail(413, 'Request too large'); chunks.push(chunk); }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'Invalid JSON'); }
  }
  json(response, value, status = 200) {
    response.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
    response.end(JSON.stringify(value));
  }
  async api(request, response, path, url) {
    const parts = path.split('/').filter(Boolean).slice(1);
    if (request.method === 'GET') {
      if (parts[0] === 'state') return this.json(response, this.summary());
      if (parts[0] === 'queue') return this.json(response, this.queue());
      if (parts[0] === 'voice' && parts[1]) return this.json(response, await this.card(parts[1], Number(url.searchParams.get('line') ?? 0)));
      if (parts[0] === 'pool' && parts[1]) {
        const list = this.pool.browse(parts[1]);
        return this.json(response, {key: parts[1], clips: list.map(clip => ({...clip, audio: clip.id.startsWith('live:')
          ? `/audio/live/${clip.id.slice(5)}/${parts[1]}` : `/audio/clip/${parts[1]}/${encodeURIComponent(clip.id)}`}))});
      }
      throw fail(404, 'Unknown request');
    }
    if (request.method !== 'POST') throw fail(405, 'Method not allowed');
    const body = await this.body(request);
    if (parts[0] === 'play' && parts[1]) { await this.play(parts[1], body); return this.json(response, {ok: true}); }
    if (parts[0] === 'generate-missing') {
      const keys = Array.isArray(body.voices) ? body.voices.filter(key => this.pool.has(key)).slice(0, 200) : [];
      for (const key of keys) this.enqueue(key, {line: 0});
      return this.json(response, {queued: keys.length});
    }
    if (parts[0] !== 'voice' || !parts[1] || !parts[2]) throw fail(404, 'Unknown request');
    const key = parts[1];
    this.pool.voice(key);
    const line = Number.isInteger(body.line) ? body.line : 0;
    switch (parts[2]) {
      case 'reroll': await this.reroll(key, body.set ?? 'full'); break;
      case 'set': await this.setManual(key, body.set ?? 'full', body.clips); break;
      case 'restore': await this.setManual(key, body.set ?? 'full', body.clips, 'restore'); break;
      case 'keep': await this.keep(key, body.engine, typeof body.note === 'string' ? body.note : undefined, line); break;
      case 'unkeep': await this.unkeep(key, body.engine); break;
      case 'reject': await this.reject(key, body.set ?? 'full', typeof body.note === 'string' ? body.note : undefined); break;
      case 'note': await this.note(key, body.note); break;
      case 'regenerate': this.enqueue(key, {line, force: body.force === true, slots: Array.isArray(body.slots) ? body.slots : undefined}); break;
      default: throw fail(404, 'Unknown request');
    }
    return this.json(response, await this.card(key, line));
  }
  async audio(request, response, path) {
    const parts = path.split('/').filter(Boolean).slice(1);
    let file;
    if (parts[0] === 'line' && this.pool.has(parts[1])) file = this.line(parts[1], Number(parts[2])).chosen?.path;
    else if (parts[0] === 'clip' && this.pool.has(parts[1])) file = this.pool.clip(parts[1], parts[2])?.path;
    else if (parts[0] === 'live' && this.pool.has(parts[2])) file = this.pool.clip(parts[2], 'live:' + parts[1])?.path;
    else if (parts[0] === 'sample' && this.pool.has(parts[1]) && /^[a-z0-9-]+-[0-9a-f]{10}\.wav$/.test(parts[3] ?? '') && /^\d+$/.test(parts[2] ?? '')) {
      file = resolve(this.work, 'samples', parts[1], `line${parts[2]}`, parts[3]);
    }
    if (!file || !existsSync(file)) throw fail(404, 'No such audio');
    return this.sendFile(request, response, file);
  }
  async staticFile(response, path) {
    const name = path === '/' ? 'index.html' : path.slice(1);
    const file = resolve(this.uiDirectory, name);
    if (!file.startsWith(this.uiDirectory + sep) || !existsSync(file) || !statSync(file).isFile()) throw fail(404, 'Not found');
    response.writeHead(200, {'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store'});
    response.end(await readFile(file));
  }
  sendFile(request, response, file) {
    const size = statSync(file).size, range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    const headers = {'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600'};
    let start = 0, end = size - 1, status = 200;
    if (range && (range[1] || range[2])) {
      if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
      else { start = Math.max(0, size - Number(range[2])); }
      if (start > end || start >= size) { response.writeHead(416, {'content-range': `bytes */${size}`}); response.end(); return; }
      status = 206; headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = end - start + 1;
    response.writeHead(status, headers);
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(file, {start, end}).pipe(response);
  }
}

export async function startPicker({project, work, port = 8765, index, store, engines, pool, log = console.log}) {
  const picker = new Picker({project, work, pool, store, engines});
  const server = createServer((request, response) => picker.handle(request, response));
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return {picker, server, port: server.address().port, close: async () => { await new Promise(done => server.close(done)); server.closeAllConnections?.(); await engines.close(); await store.flush(); await store.writeDerived(); }};
}
