// The clip search's winners as an "Auto-best" option for the picker (read-only; the data file is runtime/autobest-sets.json,
// written by scripts/clip-search/collect.py). Each engine has up to three winners that map onto the picker's own sets:
//   pocket / omni (<= 3 clips, <= 18 s: "best"), pocket-short / omni-short (<= 2 clips, <= 10 s), pocket-single / omni-single.
// The picker loads one into a set with its existing "set" action, so nothing about the action log changes.
import {existsSync, statSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export const AUTOBEST_FILE = 'runtime/autobest-sets.json';
const VARIANTS = {best: '', short: '-short', single: '-single'};

export class Autobest {
  constructor({project, file = resolve(project, AUTOBEST_FILE)}) { Object.assign(this, {project, file}); this.cache = null; }
  async data() {
    if (!existsSync(this.file)) return null;
    const stamp = statSync(this.file).mtimeMs;
    if (this.cache?.stamp !== stamp) {
      try { this.cache = {stamp, json: JSON.parse(await readFile(this.file, 'utf8'))}; } catch { return this.cache?.json ?? null; }
    }
    return this.cache.json;
  }
  // {set: {ids, seconds, ecapa, ecapaSe, pls, today, engine}} for one voice; only sets the pool can load (valid length, known clips).
  async forVoice(key, pool) {
    const json = await this.data(), row = json?.voices?.[key];
    const out = {};
    if (!row) return out;
    for (const engine of ['pocket', 'omni']) {
      for (const [variant, suffix] of Object.entries(VARIANTS)) {
        const set = engine + suffix;
        // "best3" is the best set of at most three clips; it stands in for a "best" the picker cannot hold (more than 3 clips)
        let found = row[engine]?.[variant];
        const loadable = candidate => {
          if (!candidate?.ids?.length || candidate.ids.some(id => id.startsWith('live:'))) return false;
          try { pool.validateSet(key, set, candidate.ids); return true; } catch { return false; }
        };
        if (!loadable(found) && variant === 'best' && loadable(row[engine]?.best3)) found = {...row[engine].best3, fallback: 'best3'};
        if (!loadable(found)) continue;
        out[set] = {ids: found.ids, seconds: found.seconds, ecapa: found.ecapa, ecapaSe: found.ecapa_se ?? null, pls: found.pls ?? null,
          today: row[engine]?.today?.ecapa ?? null, fallback: found.fallback ?? null, engine: json.engines?.[engine]?.tag ?? engine, generated: json.generated ?? null};
      }
    }
    return out;
  }
}
