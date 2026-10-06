// HTTP server and job queue behind scripts/Reference-Picker.mjs. Bound to 127.0.0.1 only.
import {createServer} from 'node:http';
import {createReadStream, existsSync, statSync} from 'node:fs';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {basename, dirname, extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Engines, SLOTS} from './engines.mjs';
import {FALLBACK_TEXT, LIVE_PREFIX, Pool, rerollSet} from './pool.mjs';
import {GpuMonitor} from './gpu.mjs';
import {Research, resolveShown} from './research.mjs';
import {engineSet, ENGINES, PickStore, SETS} from './picks.mjs';
import {isNaturalSpeechPath, serveNaturalSpeech} from './natural-speech-page.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml'};
const titleCase = key => key.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
const fail = (status, message) => Object.assign(Error(message), {status});
const ACTIVE = new Set(['queued', 'running', 'waiting-gpu']);
const round = value => Math.round(value * 100) / 100;
// The research report's render of the same kind of reference, per render slot: used as the current clips' sample when the
// current clips are the research agent's own proposal (multi-clip) or today's single reference.
const RESEARCH_SLOTS = {
  multi: {pocket: 'ft6-s5000raw__multiB', pockets: 'ft6-s5000raw__multiC', omni16: 'omni__s16_g2_multiB', omni32: 'omni__s32_g2_multiB', omni16s: 'omni__s16_g2_multiC', omni32s: 'omni__s32_g2_multiC'},
  single: {pocket: 'ft6-s5000raw__cfg1', pockets: 'ft6-s5000raw__cfg1', pocket1: 'ft6-s5000raw__cfg1', omni16: 'omni__s16_g2', omni32: 'omni__s32_g2', omni16s: 'omni__s16_g2', omni32s: 'omni__s32_g2',
    omni16one: 'omni__s16_g2', omni32one: 'omni__s32_g2'},
};

export class Picker {
  constructor({project, work, pool, store, engines, research = new Research({root: null}), gpu = new GpuMonitor(), uiDirectory = resolve(here, 'ui'), now = () => Date.now(), gpuRecheckMs = 5000, shownVoices}) {
    Object.assign(this, {project, work, pool, store, engines, research, gpu, uiDirectory, now, gpuRecheckMs});
    this.shown = shownVoices === undefined ? research.shown : resolveShown(shownVoices);       // voices that become rows (null: all)
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
  // target "candidate" (the clips shown as the new set) or "current" (what the engine uses now: kept, proposed or today's reference).
  async slotsFor(key, lineIndex, target = 'candidate', only = null) {
    const {text, index} = this.line(key, lineIndex), out = [];
    for (const definition of SLOTS) {
      if (only && definition.set !== only) continue;
      const ids = target === 'current' ? this.currentIds(key, definition.set) : this.candidate(key, definition.set)?.ids;
      if (!ids) continue;
      const transcript = this.pool.transcript(key, ids);
      const reference = await this.reference(key, ids);
      const id = await this.engines.sampleId(definition, reference, transcript, text);
      const file = `${definition.slot}-${id}.wav`, path = resolve(this.work, 'samples', key, `line${index}`, file);
      out.push({...definition, ids, transcript, reference, text, line: index, path,
        url: `/audio/sample/${key}/${index}/${file}`, exists: existsSync(path)});
    }
    return out;
  }
  jobFor(key) { return [...this.jobs].reverse().find(job => job.voice === key) ?? null; }
  activeJob(key, target) { return [...this.jobs].reverse().find(job => job.voice === key && (job.target ?? 'candidate') === target && ACTIVE.has(job.status)) ?? null; }

  // ---- current clips: what an engine uses now ----
  // The set the user kept, else the research agent's proposal, else today's single reference for that engine.
  currentIds(key, set) {
    const kept = this.store.voice(key).kept[set];
    if (kept) return [...kept.clips];
    const start = this.pool.startingSet(key, set);
    if (start) return start;
    const engine = set.startsWith('pocket') ? 'pocket' : 'omni';
    return this.pool.voice(key).live[engine]?.exists ? [LIVE_PREFIX + engine] : null;
  }
  currentSource(key, set) {
    if (this.store.voice(key).kept[set]) return 'kept';
    const start = this.pool.startingSet(key, set);
    return start && !start[0]?.startsWith(LIVE_PREFIX) ? 'proposed' : 'today';
  }
  // Research listening-report renders of the current clips, per slot, when the current clips are the research agent's own.
  researchFor(key, set, ids, index) {
    const start = this.pool.startingSet(key, set), out = {};
    if (!start || start.join('|') !== ids.join('|')) return out;
    const kind = ids.every(id => id.startsWith(LIVE_PREFIX)) ? 'single' : 'multi', audio = this.research.scan().audio;
    for (const [slot, cond] of Object.entries(RESEARCH_SLOTS[kind])) {
      if (SLOTS.find(item => item.slot === slot)?.set === set && audio.get(cond)?.has(`${key}|${index}`)) out[slot] = {cond, url: `/audio/research/${cond}/${key}/${index}`};
    }
    return out;
  }
  async describeCurrent(key, set, index, candidateSlots) {
    const ids = this.currentIds(key, set);
    if (!ids) return null;
    const candidate = this.candidate(key, set)?.ids, hasNew = !!candidate && candidate.join('|') !== ids.join('|');
    const sameAsCandidate = !!candidate && !hasNew;
    const rendered = sameAsCandidate ? candidateSlots.filter(slot => slot.set === set) : await this.slotsFor(key, index, 'current', set);
    const job = this.activeJob(key, sameAsCandidate ? 'candidate' : 'current'), research = this.researchFor(key, set, ids, index), samples = {};
    for (const slot of rendered) {
      const found = research[slot.slot];
      samples[slot.slot] = {label: slot.label, steps: slot.steps ?? null, ...(found ? {exists: true, url: found.url, state: 'ready', from: 'research', cond: found.cond}
        : {exists: slot.exists, url: slot.exists ? slot.url : null, state: slot.exists ? 'ready' : this.slotState(job, slot), from: 'render',
          error: job?.slots.find(item => item.slot === slot.slot)?.error ?? null})};
    }
    return {ids, source: this.currentSource(key, set), clips: ids.map(id => this.describeClip(key, id)), seconds: this.pool.seconds(key, ids), hasNew, samples};
  }
  async card(key, lineIndex = 0) {
    const voice = this.pool.voice(key), state = this.store.voice(key);
    const {lines, index, text} = this.line(key, lineIndex);
    const slots = await this.slotsFor(key, index), job = this.jobFor(key);
    const current = {};
    for (const set of Object.keys(SETS)) current[set] = await this.describeCurrent(key, set, index, slots);
    const sets = Object.fromEntries(Object.keys(SETS).map(set => [set, this.describeSet(key, set)]));
    const kept = {};
    for (const engine of ENGINES) {
      const entry = state.kept[engine];
      if (!entry) continue;
      const current = sets[engine]?.ids;
      kept[engine] = {...entry, clips: entry.clips.map(id => this.describeClip(key, id)), isCurrent: !!current && current.join('|') === entry.clips.join('|')};
    }
    const rejectedNow = {};
    for (const set of Object.keys(SETS)) {
      const ids = sets[set]?.ids.join('|');
      rejectedNow[set] = !!ids && state.rejected.some(item => item.set === set && item.clips.join('|') === ids);
    }
    const active = this.activeJob(key, 'candidate'), activeCurrent = this.activeJob(key, 'current');
    return {key, name: titleCase(key), poolSize: voice.clips.length, lines: lines.map((line, at) => ({index: at, text: line.t, seconds: round(line.d), split: line.split,
        audio: `/audio/line/${key}/${at}`})), line: index, text, hasLine: lines.length > 0,
      sets, current, history: Object.fromEntries(Object.keys(SETS).map(set => [set, this.historyOf(key, set, sets[set])])),
      kept, rejected: state.rejected, rejectedNow, note: state.note, verdict: state.verdict,
      samples: Object.fromEntries(slots.map(slot => [slot.slot, {label: slot.label, engine: slot.engine, steps: slot.steps, set: slot.set ?? null,
        clips: slot.ids.length, exists: slot.exists, url: slot.exists ? slot.url : null,
        state: slot.exists ? 'ready' : this.slotState(active, slot),
        error: active?.slots.find(item => item.slot === slot.slot)?.error ?? null}])),
      job: job ? this.publicJob(job) : null,
      jobs: {candidate: active ? this.publicJob(active) : null, current: activeCurrent ? this.publicJob(activeCurrent) : null}};
  }
  slotState(job, slot) {
    const queued = job?.slots.find(item => item.slot === slot.slot);
    if (!queued) return 'missing';
    return queued.state === 'queued' && job.status === 'waiting-gpu' && slot.engine === 'omni' ? 'gpu-busy' : queued.state;
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
    return {id: job.id, voice: job.voice, line: job.line, target: job.target ?? 'candidate', requested: job.requested ?? null, status: job.status, done: job.done, total: job.total, current: job.current,
      error: job.error, waitReason: job.waitReason ?? null, queuedAt: job.queuedAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
      slots: job.slots.map(({slot, state, error, tookMs}) => ({slot, state, error, tookMs}))};
  }
  summary() {
    const research = this.research.scan();
    const keys = [...new Set([...this.pool.keys, ...Object.keys(research.voices)])].filter(key => !this.shown || this.shown.has(key)).sort();
    return {work: this.work, log: this.store.logPath, picks: this.store.jsonPath, engines: this.engines.state, research: research.enabled,
      voices: keys.map(key => {
        const state = this.store.voice(key), job = this.jobFor(key);
        const inPool = this.pool.has(key), voice = inPool ? this.pool.voice(key) : null;
        return {key, name: titleCase(key), picker: inPool, research: key in research.voices, poolSize: voice?.clips.length ?? 0,
          hasLine: voice ? voice.lines.some(line => line.exists) : key in research.voices,
          proposed: voice ? Object.keys(voice.proposed).length > 0 : false, kept: Object.keys(state.kept), rejected: state.rejected.length,
          changed: Object.values(state.candidate).some(Boolean), note: !!state.note, verdict: state.verdict?.value ?? null,
          job: job && ACTIVE.has(job.status) ? job.status : null};
      })};
  }
  async queue() {
    const gpu = await this.gpu.status({ownResident: this.engines.omniResident});
    return {running: this.running, engines: this.engines.state, gpu, jobs: this.jobs.slice(-40).map(job => this.publicJob(job)),
      waiting: this.jobs.filter(job => ['queued', 'waiting-gpu'].includes(job.status)).length};
  }

  // ---- actions ----
  async reroll(key, set) {
    if (!SETS[set]) throw fail(400, 'Unknown set');
    const voice = this.pool.voice(key), state = this.store.voice(key);
    const current = this.candidate(key, set)?.ids ?? [];
    const clips = this.pool.rerollClips(key);
    const pick = rerollSet(clips, {budget: SETS[set].budget, current, recent: state.history[set].slice(0, 15).map(item => item.clips),
      rejected: state.rejected.filter(item => item.set === set).map(item => item.clips), count: SETS[set].count ?? 3});
    if (!pick) {
      throw fail(409, `${titleCase(key)} has no other usable clips to draw from (${voice.clips.length} in the pool)`);
    }
    await this.store.append({voice: key, engine: set, set, action: 'reroll', clips: pick.ids,
      seconds: pick.seconds, previous: current});
  }
  // "Keep current": turn the new clips down (logged as a rejection, so Reroll avoids them) and show the current clips again (logged as a restore).
  async dismiss(key, set) {
    if (!SETS[set]) throw fail(400, 'Unknown set');
    const candidate = this.candidate(key, set), current = this.currentIds(key, set);
    if (!candidate || !current || candidate.ids.join('|') === current.join('|')) return;
    await this.reject(key, set);
    await this.setManual(key, set, current, 'restore');
  }
  async setManual(key, set, ids, action = 'manual-set') {
    const {seconds} = this.pool.validateSet(key, set, ids);
    await this.store.append({voice: key, engine: set, set, action, clips: ids, seconds,
      previous: this.candidate(key, set)?.ids ?? []});
  }
  // Keep the shown set for an engine (or, to undo a keep, an explicit earlier set).
  async keep(key, engine, note, line, clips) {
    if (!ENGINES.includes(engine)) throw fail(400, 'Unknown engine');
    const set = engineSet(engine), ids = clips ?? this.candidate(key, set)?.ids;
    if (!ids) throw fail(409, 'There is no set to keep');
    const {seconds} = this.pool.validateSet(key, set, ids);
    await this.store.append({voice: key, engine, set, action: 'keep', clips: ids, seconds, line, note: note ?? this.store.voice(key).note});
  }
  async unreject(key, set) {
    if (!SETS[set]) throw fail(400, 'Unknown set');
    const candidate = this.candidate(key, set);
    if (candidate) await this.store.append({voice: key, engine: set, set, action: 'unreject', clips: candidate.ids});
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
    await this.store.append({voice: key, engine: set, set, action: 'reject', clips: candidate.ids,
      seconds: this.pool.seconds(key, candidate.ids), note: note ?? this.store.voice(key).note});
  }
  async note(key, note) {
    if (typeof note !== 'string' || note.length > 2000) throw fail(400, 'Notes are text up to 2000 characters');
    await this.store.append({voice: key, engine: 'all', action: 'note', note});
  }
  async verdict(key, value, line) {
    if (!['fine', 'bad', ''].includes(value)) throw fail(400, 'The verdict is "fine", "bad" or empty');
    await this.store.append({voice: key, engine: 'all', action: 'verdict', verdict: value, line});
  }
  async play(key, body) {
    const what = ['research', 'clip', 'sample'].includes(body.what) ? body.what : null;
    if (!what || !(this.pool.has(key) || key in this.research.scan().voices)) throw fail(400, 'Unknown play target');
    const entry = {voice: key, action: 'play', what, target: String(body.target ?? '').slice(0, 200)};
    if (what === 'sample') {
      const slot = SLOTS.find(item => item.slot === body.target);
      if (slot) {
        entry.engine = slot.set;
        if (body.current === true) { entry.current = true; entry.clips = this.currentIds(key, slot.set) ?? []; } else entry.clips = this.candidate(key, slot.set)?.ids ?? [];
      }
    }
    await this.store.append(entry);
  }

  // ---- jobs ----
  enqueue(key, {line = 0, force = false, slots, target = 'candidate'} = {}) {
    this.pool.voice(key);
    const known = new Set(SLOTS.map(item => item.slot));
    if (slots && (!Array.isArray(slots) || slots.some(slot => !known.has(slot)))) throw fail(400, 'Unknown render slot');
    const existing = this.jobs.find(job => job.voice === key && job.line === line && (job.target ?? 'candidate') === target && ['queued', 'waiting-gpu'].includes(job.status));
    if (existing) {                                  // one pending job per voice and line; widen it instead of queueing twice
      existing.requested = existing.requested && slots ? [...new Set([...existing.requested, ...slots])] : null;
      existing.force ||= force;
      return existing;
    }
    const job = {id: ++this.sequence, voice: key, line, target, force, requested: slots ?? null, status: 'queued', done: 0, total: 0, current: null,
      error: null, queuedAt: this.now(), slots: [], startedAt: null, finishedAt: null};
    this.jobs.push(job);
    this.store.append({voice: key, engine: slots?.length === 1 || slots?.every(slot => slot.startsWith('omni')) ? (slots[0] === 'pocket' ? 'pocket' : 'omni') : 'all',
      action: 'regenerate', line, force, slots: slots ?? null, ...(target === 'current' ? {target} : {}),
      sets: Object.fromEntries(Object.keys(SETS).map(set => [set, this.candidate(key, set)?.ids ?? null]))}).catch(() => {});
    queueMicrotask(() => this.drain());
    return job;
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      // Jobs held for the GPU do not block others (Pocket needs no GPU); loop until a pass starts nothing new.
      for (let progressed = true; progressed;) {
        progressed = false;
        for (const job of this.jobs.filter(item => ['queued', 'waiting-gpu'].includes(item.status))) {
          if (await this.run(job) !== 'wait') progressed = true;
        }
      }
      if (this.jobs.some(job => job.status === 'waiting-gpu')) this.recheckLater();
    } finally { this.running = false; }
  }
  recheckLater() {
    clearTimeout(this.recheck);
    this.recheck = setTimeout(() => this.drain(), this.gpuRecheckMs);
    this.recheck.unref?.();
  }
  // Plan the renders still missing, hold the job while another process has the GPU, then render.
  async run(job) {
    const store = this.store;
    try {
      const wanted = (await this.slotsFor(job.voice, job.line, job.target)).filter(slot => !job.requested || job.requested.includes(slot.slot));
      job.slots = wanted.filter(slot => job.force || !slot.exists).map(slot => ({...slot, state: 'queued', error: null}));
      job.total = job.slots.length; job.done = 0;
      // Only OmniVoice needs the GPU. When another process holds it, Pocket (CPU) still renders now and the
      // OmniVoice renders stay queued ("GPU busy, queued") until the GPU frees up.
      let gpuHeld = null;
      if (job.slots.some(slot => slot.engine === 'omni')) {
        const gpu = await this.gpu.status({ownResident: this.engines.omniResident});
        if (gpu.busy) gpuHeld = gpu;
      }
      if (gpuHeld && !job.slots.some(slot => slot.engine === 'pocket')) { job.status = 'waiting-gpu'; job.waitReason = gpuHeld.reason; return 'wait'; }
      job.status = 'running'; job.startedAt ??= this.now(); job.waitReason = null;
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
      if (gpuHeld) {
        if (!job.error) { job.current = null; job.status = 'waiting-gpu'; job.waitReason = gpuHeld.reason; return 'wait'; }
        failSlots(omni, Error(`Skipped: ${gpuHeld.reason}`));      // Pocket failed; do not keep retrying it while waiting
      }
      for (const slot of gpuHeld ? [] : omni) {
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
    return job.status;
  }

  // ---- HTTP ----
  async handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    try {
      this.guard(request);
      // Audio routes take the raw pathname: clip ids contain '/', so segments must be decoded after splitting.
      if (request.method === 'GET' && path.startsWith('/audio/')) return await this.audio(request, response, url.pathname);
      if ((request.method === 'GET' || request.method === 'HEAD') && isNaturalSpeechPath(path)) return serveNaturalSpeech(request, response, path);       // read-only listening page
      if (path.startsWith('/api/')) return await this.api(request, response, path, url);
      if (request.method === 'GET' && /^\/voice\/[a-z0-9-]+\/?$/.test(path)) return await this.staticFile(response, '/voice.html');       // the character page (reference clips)
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
      if (parts[0] === 'queue') return this.json(response, await this.queue());
      if (parts[0] === 'research') return this.json(response, this.research.scan(url.searchParams.get('rescan') === '1') && this.research.describe());
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
    const line = Number.isInteger(body.line) ? body.line : 0;
    if (parts[2] === 'verdict') {            // also for voices that only have research audio
      if (!this.pool.has(key) && !(key in this.research.scan().voices)) throw fail(404, `Unknown voice ${key}`);
      await this.verdict(key, body.value ?? '', line);
      return this.json(response, {ok: true, verdict: this.store.voice(key).verdict});
    }
    this.pool.voice(key);
    switch (parts[2]) {
      case 'reroll': await this.reroll(key, body.set); break;
      case 'set': await this.setManual(key, body.set, body.clips); break;
      case 'restore': await this.setManual(key, body.set, body.clips, 'restore'); break;
      case 'keep': await this.keep(key, body.engine, typeof body.note === 'string' ? body.note : undefined, line, Array.isArray(body.clips) ? body.clips : undefined); break;
      case 'unreject': await this.unreject(key, body.set); break;
      case 'unkeep': await this.unkeep(key, body.engine); break;
      case 'reject': await this.reject(key, body.set, typeof body.note === 'string' ? body.note : undefined); break;
      case 'note': await this.note(key, body.note); break;
      case 'regenerate': this.enqueue(key, {line, force: body.force === true, slots: Array.isArray(body.slots) ? body.slots : undefined, target: body.target === 'current' ? 'current' : 'candidate'}); break;
      case 'dismiss': await this.dismiss(key, body.set); break;
      default: throw fail(404, 'Unknown request');
    }
    return this.json(response, await this.card(key, line));
  }
  async audio(request, response, path) {
    // Clip ids contain '/', so they arrive percent-encoded; decode each segment after splitting.
    const parts = path.split('/').filter(Boolean).slice(1).map(part => {
      try { return decodeURIComponent(part); } catch { return part; }
    });
    let file;
    if (parts[0] === 'research') file = this.research.file(parts[1], parts[2], Number(parts[3]));
    else if (parts[0] === 'line' && this.pool.has(parts[1])) file = this.line(parts[1], Number(parts[2])).chosen?.path;
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

export async function startPicker({project, work, port = 8765, store, engines, pool, research, gpu, gpuRecheckMs, shownVoices}) {
  const picker = new Picker({project, work, pool, store, engines, research, gpu, gpuRecheckMs, shownVoices});
  const server = createServer((request, response) => picker.handle(request, response));
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return {picker, server, port: server.address().port, close: async () => { await new Promise(done => server.close(done)); server.closeAllConnections?.(); await engines.close(); await store.flush(); await store.writeDerived(); }};
}
