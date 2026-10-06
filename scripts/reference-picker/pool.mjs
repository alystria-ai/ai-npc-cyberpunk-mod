// Clip pool access for the reference picker: per-voice clips, starting sets, the reroll and manual-set rules.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
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

// Clips the effect detector flagged (comb filter, tone, reverb, band limit; clip.fx lists the reasons) stay in the index, so a
// starting set that already uses one still resolves, but they are never drawn or listed.
const isUsable = clip => !clip.fx?.length && !clip.cb;
// Clips flagged as combat or shouted delivery (scripts/combat_flags/, clip.cb = {s: score, w: [reasons]}) are never drawn by Reroll or
// the clip search, but they stay browsable on the character page (with a "combat" badge) in case a hand pick wants one.
const isBrowsable = clip => !clip.fx?.length;

export class Pool {
  // index: pool-index.json; project: repository root (for the live references).
  constructor(index, {project}) {
    this.index = index; this.project = project;
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
  voice(key) { if (!this.has(key)) throw Object.assign(Error(`Unknown voice ${key}`), {status: 404}); return this.index.voices[key]; }
  // A clip id of this voice -> {id, d (s), t, path (absolute), ...}. "live:pocket" / "live:omni" are today's
  // single references (so a kept voice with no multi-clip set still has something to show and to reuse).
  clip(key, id) {
    if (typeof id === 'string' && id.startsWith(LIVE_PREFIX)) {
      const live = this.voice(key).live[id.slice(LIVE_PREFIX.length)];
      if (!live?.exists) return null;
      return {id, d: live.d, t: live.transcript, path: resolve(this.project, live.reference), ty: null, g: null, k: null, s: 'live', rel: live.rel, sha256: live.sha256};
    }
    const clip = this.byId.get(key)?.get(id);
    return clip ? {...clip, path: resolve(this.index.dataRoot, clip.p)} : null;
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
    if (set === 'omni-short') return null;                 // no short reference exists today
    const live = voice.live[set];
    return live?.exists ? [LIVE_PREFIX + set] : null;
  }
  validateSet(key, set, ids) {
    const budget = Object.hasOwn(SETS, set) ? SETS[set].budget : 0;
    if (!budget) throw Object.assign(Error(`Unknown set ${set}`), {status: 400});
    // Only the total duration matters: any number of different whole clips is fine while they fit the budget.
    if (!Array.isArray(ids) || ids.length < 1 || new Set(ids).size !== ids.length) {
      throw Object.assign(Error('Choose at least one clip, each only once'), {status: 400});
    }
    const clips = this.clips(key, ids), seconds = joinedSeconds(clips.map(clip => clip.d));
    if (seconds > budget + 1e-6) {
      throw Object.assign(Error(`These clips add up to ${seconds.toFixed(1)} s with the gaps; the ${SETS[set].label} allows ${budget} s`), {status: 400});
    }
    return {clips, seconds: Math.round(seconds * 100) / 100};
  }
  // The clip list for browsing: every clip of the voice except effect-heavy ones, combat-flagged clips included and marked (held-out lines were removed by the index builder).
  browse(key) {
    const voice = this.voice(key), list = [];
    for (const engine of ['omni', 'pocket']) {
      const live = this.clip(key, LIVE_PREFIX + engine);
      if (live && !list.some(item => item.sha256 === live.sha256)) {
        list.push({id: live.id, d: live.d, t: live.t, ty: null, g: null, k: null, s: 'live', rel: live.rel, label: `Today's ${engine === 'omni' ? 'OmniVoice' : 'Pocket'} reference`, sha256: live.sha256});
      }
    }
    for (const clip of voice.clips.filter(isBrowsable)) list.push({id: clip.id, d: clip.d, t: clip.t, ty: clip.ty, g: clip.g, k: clip.k, s: clip.s, rel: clip.rel, src: clip.src, ...(clip.cb ? {cb: clip.cb} : {})});
    return list;
  }
  // The voice's usable clips (what reroll draws from): everything except effect-heavy and combat or shouted lines.
  rerollClips(key) { return this.voice(key).clips.filter(isUsable); }
  usableCount(key) { return this.rerollClips(key).length; }
}

// ---- reroll -------------------------------------------------------------------------------------------------------

const words = text => text.trim().split(/\s+/).filter(Boolean).length;

// Pick a different set of whole clips for a voice: as many as fill the budget (drawn until nothing more fits, at least 60% of
// the budget when the pool allows), joined length within the budget, not the current
// set and not a set the user already rejected, and (when the pool allows) sharing no clip with the current set.
// Clips are drawn at random, favouring typical ones (the research agent's own criterion), from the clips the
// agent considered (now 3-10 s) unless the voice has too few of those. Research finding: a reference whose loudness is
// far from the character's typical lines makes OmniVoice worse and typicality predicts speaker-ID gain, so only
// clips within LOUDNESS_WINDOW_DB of the voice's median loudness are drawn when there are enough of them.
// Phone-processed clips count like any other; media-processed clips (clip.k === 'media') are avoided unless the voice
// has nothing else.
export function rerollSet(clips, {budget, current = [], recent = [], rejected = [], rng = Math.random} = {}) {
  const lengthOk = clip => clip.d >= 3 && clip.d <= 10 && words(clip.t) >= MIN_WORDS;
  const loud = clip => clip.rel == null || Math.abs(clip.rel) <= LOUDNESS_WINDOW_DB;
  let pool = clips.filter(clip => lengthOk(clip) && clip.d <= budget && clip.k !== 'media' && loud(clip));
  if (pool.length < 6) pool = clips.filter(clip => clip.d >= 1 && clip.d <= budget && words(clip.t) >= 2 && clip.k !== 'media' && loud(clip));
  if (pool.length < 6) pool = clips.filter(clip => clip.d >= 1 && clip.d <= budget && words(clip.t) >= 2 && clip.k !== 'media');
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
  const minimum = budget * 0.6;
  let best = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const strict = attempt < 250;                       // first insist on a set with no clip from the current one
    const available = strict ? pool.filter(clip => !currentIds.has(clip.id)) : pool;
    if (!available.length) continue;
    const chosen = [draw(available)];
    for (;;) {
      const used = joinedSeconds(chosen.map(clip => clip.d)) + 0.4;
      const fits = available.filter(clip => !chosen.includes(clip) && used + clip.d <= budget);
      if (!fits.length) break;
      chosen.push(draw(fits));
    }
    const seconds = joinedSeconds(chosen.map(clip => clip.d)), ids = chosen.map(clip => clip.id);
    if (seen.has(key(ids))) continue;
    if (seconds < minimum && attempt < 380) continue;
    best = {ids, seconds: Math.round(seconds * 100) / 100};
    break;
  }
  return best;
}
