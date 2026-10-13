// The clip search's winners as an "Auto-best" option for the picker (read-only; the data file is runtime/autobest-sets.json, schema
// version 2, written by scripts/clip-search/collect.py). Measure: total reference DURATION, never a clip count.
//
//   {"version":2,"generated":"...","engines":{"omni":{"tag":"omni16"},"pocket":{"tag":"..."}},
//    "voices":{"<key>":{
//      "omni":{"short":{ids,seconds,ecapa,ecapa_se,pls,latency_ms:{"16":240,"32":540}}, "long":{...}, "best":{...},
//              "today":{ids,seconds,ecapa,pls}, "curve":[{seconds,ecapa,ecapa_se},...]},
//      "pocket":{"best":{ids,seconds,ecapa,ecapa_se,pls}, "today":{...}, "curve":[...]}}}}
//
// Mapping onto the picker's sets (picks.mjs SETS): pocket <- pocket.best (<= 30 s), omni-short <- omni.short (<= 10 s),
// omni <- omni.long (<= 18 s). omni.best is the unconstrained Omni winner; the picker has no set for it (Build-AutobestConfigs.mjs
// writes it to local-voices.autobest.json). The picker loads one into a set with its existing "set" action, so the action log is unchanged.
import {existsSync, statSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export const AUTOBEST_FILE = 'runtime/autobest-sets.json';
// picker set -> [engine, key in the engine's block of the data file]
export const SET_SOURCES = Object.freeze({pocket: ['pocket', 'best'], 'omni-short': ['omni', 'short'], omni: ['omni', 'long']});

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
  // {set: {ids, seconds, ecapa, ecapaSe, pls, today, latencyMs, engine, generated}} for one voice; only sets the pool can load
  // (every clip known, joined length within the set's budget, none of today's live references).
  async forVoice(key, pool) {
    const json = await this.data(), row = json?.voices?.[key];
    const out = {};
    if (!row) return out;
    for (const [set, [engine, name]] of Object.entries(SET_SOURCES)) {
      const found = row[engine]?.[name];
      if (!found?.ids?.length || found.ids.some(id => id.startsWith('live:'))) continue;
      try { pool.validateSet(key, set, found.ids); } catch { continue; }
      out[set] = {ids: found.ids, seconds: found.seconds, ecapa: found.ecapa ?? null, ...(found.note ? {note: found.note} : {}), ecapaSe: found.ecapa_se ?? null, pls: found.pls ?? null,
        today: row[engine]?.today?.ecapa ?? null, latencyMs: found.latency_ms ?? null,
        engine: json.engines?.[engine]?.tag ?? engine, generated: json.generated ?? null};
    }
    return out;
  }
}
