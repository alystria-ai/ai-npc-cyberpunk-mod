// Clip pool access for the reference picker: per-voice clips, starting sets, the reroll and manual-set rules.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, statSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {joinedSeconds} from './audio.mjs';
import {SETS} from './picks.mjs';

export const LIVE_PREFIX = 'live:';
export const FALLBACK_TEXT = 'Alright V, give me a second and I will see what I can dig up on that.';
const MIN_WORDS = 3;
export const LOUDNESS_WINDOW_DB = 3;

export async function loadIndex(path) { return JSON.parse(await readFile(path, 'utf8')); }

// pool-index.json is built from the training manifests, the research agent's evaluation lines and embeddings (about
// ten seconds); it lives in the picker's work folder and is rebuilt only on request.
export function ensureIndex({project, work, rebuild = false, log = () => {}}) {
  const path = resolve(work, 'pool-index.json');
  if (!rebuild && existsSync(path)) return path;
  mkdirSync(work, {recursive: true});
  log('Building the clip pool index (about 10 seconds)...');
  const python = resolve(project, 'vendor/reference-voicestudio/.venv/Scripts/python.exe');
  const built = spawnSync(python, ['-B', resolve(project, 'scripts/reference-picker/build-index.py'), '--out', path],
    {cwd: project, encoding: 'utf8', env: {...process.env, PYTHONUTF8: '1'}});
  if (built.status !== 0) throw Error(`The pool index could not be built:
${built.stderr || built.stdout}`);
  return path;
}

// Phone/holocall flags (runtime/voice-data-phone-flags.json, schema voice-data-phone-flags/v1) are produced outside the
// picker and joined at serve time: the file is re-read whenever its mtime or size changes, and a missing or invalid file
// simply means "no flags" (every clip then falls back to the dataset's own delivery kind).
export const PHONE_FLAGS_FILE = 'runtime/voice-data-phone-flags.json';
export class PhoneFlags {
  constructor(path) { this.path = path; this.stamp = null; this.data = {clips: {}, live: {}, lines: {}}; }
  load() {
    let stamp = null;
    try { const stat = statSync(this.path); stamp = `${stat.mtimeMs}:${stat.size}`; } catch { /* no file */ }
    if (stamp === this.stamp) return this.data;
    this.stamp = stamp;
    this.data = {clips: {}, live: {}, lines: {}};
    if (!stamp) return this.data;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8').replace(/^\uFEFF/, ''));
      const plain = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      this.data = {clips: plain(raw.clips), live: plain(raw.live_references), lines: plain(raw.evaluation_lines)};
    } catch { /* invalid file: no flags until it changes */ }
    return this.data;
  }
  // true / false when the file has an entry with a boolean "phone", else null.
  clip(id) { return flagOf(this.load().clips[id]); }
  live(engine, voice) { return flagOf(this.load().live[engine]?.[voice]); }
  line(id) { return flagOf(this.load().lines[id]); }
}
const flagOf = entry => typeof entry?.phone === 'boolean' ? entry.phone : null;

export class Pool {
  // index: pool-index.json; project: repository root (for the live references and the phone flags).
  constructor(index, {project, flagsPath = resolve(project, PHONE_FLAGS_FILE)}) {
    this.index = index; this.project = project; this.flags = new PhoneFlags(flagsPath);
    // Only characters the mod actually has a voice for: the live configs decide.
    this.keys = Object.keys(index.voices).filter(key => Object.keys(index.voices[key].live).length).sort();
    this.byId = new Map();
    for (const key of this.keys) {
      const voice = index.voices[key];
      // Loudness relative to the voice's median clip (dB); null when it could not be measured.
      for (const clip of voice.clips) clip.rel = clip.lv == null || voice.loudMedian == null ? null : Math.round((clip.lv - voice.loudMedian) * 10) / 10;
      for (const live of Object.values(voice.live)) live.rel = live.lv == null || voice.loudMedian == null ? null : Math.round((live.lv - voice.loudMedian) * 10) / 10;
      this.byId.set(key, new Map(voice.clips.map(clip => [clip.id, clip])));
    }
  }
  has(key) { return this.byId.has(key); }
  // Phone-processed according to the flags file, else according to the dataset's delivery kind.
  phone(clip) { return this.flags.clip(clip.id) ?? clip.k === 'phone'; }
  livePhone(key, engine) { return this.flags.live(engine, key) ?? false; }
  linePhone(line) { return this.flags.line(line.id) ?? false; }
  voice(key) { if (!this.has(key)) throw Object.assign(Error(`Unknown voice ${key}`), {status: 404}); return this.index.voices[key]; }
  // A clip id of this voice -> {id, d (s), t, path (absolute), ...}. "live:pocket" / "live:omni" are today's
  // single references (so a kept voice with no multi-clip set still has something to show and to reuse).
  clip(key, id) {
    if (typeof id === 'string' && id.startsWith(LIVE_PREFIX)) {
      const live = this.voice(key).live[id.slice(LIVE_PREFIX.length)];
      if (!live?.exists) return null;
      return {id, d: live.d, t: live.transcript, path: resolve(this.project, live.reference), ty: null, g: null, k: null, s: 'live', rel: live.rel, sha256: live.sha256,
        ph: this.livePhone(key, id.slice(LIVE_PREFIX.length))};
    }
    const clip = this.byId.get(key)?.get(id);
    return clip ? {...clip, path: resolve(this.index.dataRoot, clip.p), ph: this.phone(clip)} : null;
  }
  clips(key, ids) {
    const found = ids.map(id => this.clip(key, id));
    const missing = ids.filter((id, at) => !found[at]);
    if (missing.length) throw Object.assign(Error(`Unknown clip(s) for ${key}: ${missing.join(', ')}`), {status: 400});
    return found;
  }
  seconds(key, ids) { return Math.round(joinedSeconds(this.clips(key, ids).map(clip => clip.d)) * 100) / 100; }
  transcript(key, ids) { return this.clips(key, ids).map(clip => clip.t.trim()).join(' '); }
  // Starting candidate sets: the research agent's proposed configs, else today's single reference.
  startingSet(key, set) {
    const voice = this.voice(key), proposed = voice.proposed;
    if (proposed[set]?.clips) return [...proposed[set].clips];
    // The single-clip sets start from today's single reference of the engine.
    if (set.endsWith('-single')) { const engine = set.replace('-single', ''); return voice.live[engine]?.exists ? [LIVE_PREFIX + engine] : null; }
    // The research agent rendered Pocket's 10 s two-clip samples from the same 10 s sets as OmniVoice's.
    if (set === 'pocket-short') return proposed['omni-short']?.clips ? [...proposed['omni-short'].clips] : null;
    if (set === 'omni-short') return null;
    const live = voice.live[set];
    return live?.exists ? [LIVE_PREFIX + set] : null;
  }
  validateSet(key, set, ids) {
    const budget = SETS[set]?.budget;
    if (!budget) throw Object.assign(Error(`Unknown set ${set}`), {status: 400});
    const most = SETS[set].count ?? 3;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > most || new Set(ids).size !== ids.length) {
      throw Object.assign(Error(most === 1 ? 'Choose one clip' : `Choose between one and ${most === 2 ? 'two' : 'three'} different clips`), {status: 400});
    }
    const clips = this.clips(key, ids), seconds = joinedSeconds(clips.map(clip => clip.d));
    if (seconds > budget + 1e-6) {
      throw Object.assign(Error(`These clips add up to ${seconds.toFixed(1)} s with the gaps; the ${SETS[set].label} allows ${budget} s`), {status: 400});
    }
    return {clips, seconds: Math.round(seconds * 100) / 100};
  }
  // The clip list for browsing: every usable clip of the voice (held-out lines were removed by the index builder).
  browse(key) {
    const voice = this.voice(key), list = [];
    for (const engine of ['omni', 'pocket']) {
      const live = this.clip(key, LIVE_PREFIX + engine);
      if (live && !list.some(item => item.sha256 === live.sha256)) {
        list.push({id: live.id, d: live.d, t: live.t, ty: null, g: null, k: null, s: 'live', rel: live.rel, label: `Today's ${engine === 'omni' ? 'OmniVoice' : 'Pocket'} reference`, sha256: live.sha256, ph: live.ph});
      }
    }
    for (const clip of voice.clips) list.push({id: clip.id, d: clip.d, t: clip.t, ty: clip.ty, g: clip.g, k: clip.k, s: clip.s, rel: clip.rel, ph: this.phone(clip)});
    return list;
  }
  // The voice's clips with the phone flag joined in (what reroll draws from).
  rerollClips(key) { return this.voice(key).clips.map(clip => ({...clip, ph: this.phone(clip)})); }
}

// ---- reroll -------------------------------------------------------------------------------------------------------

const words = text => text.trim().split(/\s+/).filter(Boolean).length;

// Pick a different set of whole clips for a voice: at most three, joined length within the budget, not the current
// set and not a set the user already rejected, and (when the pool allows) sharing no clip with the current set.
// Clips are drawn at random, favouring typical ones (the research agent's own criterion), from the clips the
// agent considered (2-9 s) unless the voice has too few of those. Research finding: a reference whose loudness is
// far from the character's typical lines makes OmniVoice worse and typicality predicts speaker-ID gain, so only
// clips within LOUDNESS_WINDOW_DB of the voice's median loudness are drawn when there are enough of them.
// Phone-flagged clips (clip.ph) are never drawn unless allowPhone is set; other media-processed clips are avoided
// unless the voice has nothing else, and with allowPhone the non-phone clips are still preferred.
export function rerollSet(allClips, {budget, current = [], recent = [], rejected = [], rng = Math.random, count = 3, allowPhone = false} = {}) {
  const clips = allowPhone ? allClips : allClips.filter(clip => !clip.ph);
  const lengthOk = clip => clip.d >= 2 && clip.d <= 9 && words(clip.t) >= MIN_WORDS;
  const loud = clip => clip.rel == null || Math.abs(clip.rel) <= LOUDNESS_WINDOW_DB;
  let pool = clips.filter(clip => lengthOk(clip) && clip.d <= budget && !clip.k && !clip.ph && loud(clip));
  if (pool.length < 6) pool = clips.filter(clip => clip.d >= 1 && clip.d <= budget && words(clip.t) >= 2 && !clip.k && !clip.ph && loud(clip));
  if (pool.length < 6) pool = clips.filter(clip => clip.d >= 1 && clip.d <= budget && words(clip.t) >= 2 && !clip.k && !clip.ph);
  if (pool.length < 4) pool = clips.filter(clip => clip.d >= 1 && clip.d <= budget && words(clip.t) >= 2);
  if (!pool.length) return null;
  const weight = clip => (0.2 + (clip.ty ?? 50) / 100) * (clip.rel == null ? 1 : 1 - Math.min(Math.abs(clip.rel), LOUDNESS_WINDOW_DB) / (2 * LOUDNESS_WINDOW_DB));
  const draw = candidates => {
    let total = 0;
    for (const clip of candidates) total += weight(clip);
    let at = rng() * total;
    for (const clip of candidates) { at -= weight(clip); if (at <= 0) return clip; }
    return candidates.at(-1);
  };
  const key = ids => [...ids].sort().join('|');
  const seen = new Set([...recent, ...rejected, current].filter(ids => ids?.length).map(key));
  const currentIds = new Set(current);
  const minimum = count === 1 ? 0 : budget * 0.6;
  let best = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const strict = attempt < 250;                       // first insist on a set with no clip from the current one
    const available = strict ? pool.filter(clip => !currentIds.has(clip.id)) : pool;
    if (!available.length) continue;
    const chosen = [draw(available)];
    while (chosen.length < count) {
      const used = joinedSeconds(chosen.map(clip => clip.d)) + 0.4;
      const fits = available.filter(clip => !chosen.includes(clip) && used + clip.d <= budget);
      if (!fits.length) break;
      chosen.push(draw(fits));
    }
    const seconds = joinedSeconds(chosen.map(clip => clip.d)), ids = chosen.map(clip => clip.id);
    if (seen.has(key(ids))) continue;
    if (seconds < minimum && attempt < 380) continue;
    if (chosen.length < Math.min(count, 2) && attempt < 380) continue;
    best = {ids, seconds: Math.round(seconds * 100) / 100};
    break;
  }
  return best;
}
