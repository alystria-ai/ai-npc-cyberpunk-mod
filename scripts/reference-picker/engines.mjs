// Rendering for the reference picker: the bridge's own PocketVoice (CPU) and a persistent OmniVoice worker (GPU),
// always as separate processes with private work, lock and prompt-cache directories under the picker's work folder,
// so a running bridge is not disturbed. Live configs are only read.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync} from 'node:fs';
import {copyFile, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';
import {PocketVoice} from '../../bridge/pocket-voice.mjs';
import {concatClips, encodeWav, readWav, REFERENCE_RATE} from './audio.mjs';

// The renders the picker makes for a voice. Today's single-reference versions are not rendered here: the research
// report already has them (Pocket student FT, OmniVoice 16 / 32), made with the same settings.
export const SLOTS = Object.freeze([
  {slot: 'pocket', engine: 'pocket', set: 'pocket', label: 'Pocket'},
  {slot: 'pockets', engine: 'pocket', set: 'pocket-short', label: 'Pocket, 10 s set'},
  {slot: 'omni16', engine: 'omni', steps: 16, set: 'omni', label: 'OmniVoice 16 steps'},
  {slot: 'omni32', engine: 'omni', steps: 32, set: 'omni', label: 'OmniVoice 32 steps'},
  {slot: 'omni16s', engine: 'omni', steps: 16, set: 'omni-short', label: 'OmniVoice 16 steps, 10 s set'},
  {slot: 'omni32s', engine: 'omni', steps: 32, set: 'omni-short', label: 'OmniVoice 32 steps, 10 s set'},
  {slot: 'pocket1', engine: 'pocket', set: 'pocket-single', label: 'Pocket, single clip'},
  {slot: 'omni16one', engine: 'omni', steps: 16, set: 'omni-single', label: 'OmniVoice 16 steps, single clip'},
  {slot: 'omni32one', engine: 'omni', steps: 32, set: 'omni-single', label: 'OmniVoice 32 steps, single clip'},
]);

const sha256Of = bytes => createHash('sha256').update(bytes).digest('hex');
const short = text => createHash('sha1').update(text).digest('hex').slice(0, 10);

export class Engines {
  constructor({project, work, onLog = () => {}, idleMs = 5 * 60_000, spawnImpl = spawn}) {
    Object.assign(this, {project, work, onLog, idleMs, spawnImpl});
    this.refs = resolve(work, 'refs');
    this.omniPython = resolve(project, 'vendor/reference-voicestudio/.venv/Scripts/python.exe');
    this.omni = null;
    this.state = {pocket: 'idle', omni: 'idle'};
  }
  get omniResident() { return !!this.omni?.loaded; }

  // ---- reference audio ----
  // Concatenate whole clips (see audio.mjs) into refs/<sha256>.wav, a content-addressed file the Pocket worker's
  // reference directory and the Omni worker can both read. Returns {path, sha256, seconds}.
  async materialize(clips) {
    await mkdir(this.refs, {recursive: true});
    const decoded = [];
    for (const clip of clips) decoded.push(await readWav(clip.path));
    const joined = concatClips(decoded), bytes = encodeWav(joined.samples, REFERENCE_RATE), sha256 = sha256Of(bytes);
    const path = resolve(this.refs, `${sha256}.wav`);
    if (!existsSync(path)) { await writeFile(`${path}.part`, bytes); await rename(`${path}.part`, path); }
    return {path, sha256, seconds: joined.samples.length / REFERENCE_RATE};
  }
  // Today's single reference, byte for byte (copied to the content-addressed name).
  async materializeLive(entry) {
    await mkdir(this.refs, {recursive: true});
    const source = resolve(this.project, entry.reference), bytes = await readFile(source);
    if (sha256Of(bytes) !== entry.sha256) throw Error('The live reference file no longer matches its configured hash');
    const path = resolve(this.refs, `${entry.sha256}.wav`);
    if (!existsSync(path)) { await writeFile(`${path}.part`, bytes); await rename(`${path}.part`, path); }
    return {path, sha256: entry.sha256};
  }

  // An id for a rendered file: changes with the reference audio, its transcript, the engine settings and the text.
  async engineTag(item) {
    if (item.engine === 'pocket') {
      const config = JSON.parse(await readFile(resolve(this.project, 'runtime/pocket-voices.json'), 'utf8'));
      return `pocket:${config.model.sha256.slice(0, 12)}:${config.model.selectedStep}`;
    }
    const config = JSON.parse(await readFile(resolve(this.project, 'runtime/local-voices.json'), 'utf8'));
    return `omni:${config.revision.slice(0, 12)}:${item.steps}`;
  }
  async sampleId(item, reference, transcript, text) {
    return short([await this.engineTag(item), reference.sha256, transcript, text].join('\n'));
  }

  // ---- Pocket (CPU): the bridge's own PocketVoice, one short-lived worker per batch ----
  // items: [{reference: {path, sha256}, transcript, text, out}]
  async runPocket(items, {onItem = () => {}, jobId = 'job'} = {}) {
    if (!items.length) return;
    this.state.pocket = 'starting';
    const live = JSON.parse(await readFile(resolve(this.project, 'runtime/pocket-voices.json'), 'utf8'));
    const {voices: _voices, proposal: _proposal, ...rest} = live;
    const voices = {};
    items.forEach((item, at) => {
      voices[`p${at}`] = {reference: `runtime/voice-references/${basename(item.reference.path)}`, sha256: item.reference.sha256,
        transcript: item.transcript, status: 'ready'};
    });
    const workDirectory = resolve(this.work, 'pocket-work'), jobs = resolve(this.work, 'pocket-jobs');
    await mkdir(workDirectory, {recursive: true}); await mkdir(jobs, {recursive: true});
    const config = {...rest, runtime: {...rest.runtime, referenceDirectory: this.refs, workDirectory}, voices,
      preparation: {startupProfiles: [], maxCachedProfiles: 8}};
    const configPath = resolve(jobs, `${jobId}.json`);
    await writeFile(configPath, JSON.stringify(config, null, 1));
    const client = new PocketVoice(config, {project: this.project, configPath, pythonExecutable: config.runtime.pythonExecutable,
      onLog: text => this.onLog('pocket', text)});
    try {
      await client.start();
      for (const [at, item] of items.entries()) {
        this.state.pocket = 'rendering';
        const chunks = [], began = performance.now();
        await client.prepareProfile(`p${at}`);
        const result = await client.synthesizeStream(`p${at}`, item.text, {onPcm: packet => chunks.push(packet.pcm)});
        const samples = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
        let cursor = 0;
        for (const chunk of chunks) { samples.set(chunk, cursor); cursor += chunk.length; }
        await mkdir(dirname(item.out), {recursive: true});
        await writeFile(`${item.out}.part`, encodeWav(samples, 24000)); await rename(`${item.out}.part`, item.out);
        await onItem(item, {seconds: result.duration, tookMs: Math.round(performance.now() - began)});
      }
    } finally {
      this.state.pocket = 'idle';
      await client.close().catch(() => {});
      await rm(configPath, {force: true});
    }
  }

  // ---- OmniVoice (GPU): one persistent worker, stopped after idleMs of quiet ----
  async ensureOmni() {
    clearTimeout(this.idleTimer);
    const worker = this.omni ?? this.startOmni();
    await worker.ready;
    return worker;
  }
  startOmni() {
    this.state.omni = 'loading';
    const cache = resolve(this.work, 'omni-prompt-cache');
    mkdirSync(cache, {recursive: true});
    const child = this.spawnImpl(this.omniPython, ['-B', resolve(this.project, 'scripts/reference-picker/omni-worker.py'), '--cache', cache],
      {cwd: this.project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1'}});
    const worker = {child, pending: new Map(), sequence: 0, buffer: ''};
    worker.ready = new Promise((done, fail) => { worker.markReady = done; worker.markFailed = fail; });
    worker.ready.catch(() => {});
    this.omni = worker;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', part => {
      worker.buffer += part;
      let at;
      while ((at = worker.buffer.indexOf('\n')) >= 0) {
        const line = worker.buffer.slice(0, at); worker.buffer = worker.buffer.slice(at + 1);
        let frame; try { frame = JSON.parse(line); } catch { continue; }
        if (frame.op === 'ready') { this.state.omni = 'ready'; worker.loaded = frame; worker.markReady(worker); }
        else if (worker.pending.has(frame.id)) {
          const request = worker.pending.get(frame.id); worker.pending.delete(frame.id);
          if (frame.op === 'done') request.resolve(frame); else request.reject(Error(frame.message || 'OmniVoice failed'));
        }
      }
    });
    child.stderr.on('data', part => this.onLog('omni', part.toString('utf8').slice(-4000)));
    const finished = error => {
      if (this.omni !== worker) return;
      this.omni = null; this.state.omni = 'idle';
      worker.markFailed(error);
      for (const request of worker.pending.values()) request.reject(error);
      worker.pending.clear();
    };
    child.once('error', finished);
    child.once('close', code => finished(Error(`The OmniVoice worker exited (${code}); see the picker log`)));
    return worker;
  }
  async renderOmni(item) {
    const worker = await this.ensureOmni();
    this.state.omni = 'rendering';
    const id = ++worker.sequence;
    try {
      return await new Promise((resolveFrame, reject) => {
        worker.pending.set(id, {resolve: resolveFrame, reject});
        worker.child.stdin.write(JSON.stringify({op: 'render', id, ref: item.reference.path, transcript: item.transcript,
          text: item.text, steps: item.steps, out: item.out}) + '\n', error => { if (error) reject(error); });
      });
    } finally {
      this.state.omni = this.omni ? 'ready' : 'idle';
      this.scheduleIdle();
    }
  }
  scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopOmni(), this.idleMs);
    this.idleTimer.unref?.();
  }
  async stopOmni() {
    clearTimeout(this.idleTimer);
    const worker = this.omni;
    if (!worker) return;
    try { worker.child.stdin.write(JSON.stringify({op: 'exit'}) + '\n'); worker.child.stdin.end(); } catch { /* already gone */ }
    await new Promise(done => { const timer = setTimeout(() => { worker.child.kill(); done(); }, 8000); worker.child.once('close', () => { clearTimeout(timer); done(); }); });
  }
  async close() { await this.stopOmni(); }
}
