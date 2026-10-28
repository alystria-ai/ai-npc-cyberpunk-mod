// The step markers of a Runtime: which update zips were applied on top of which full Runtime, so a skipped step can be named.
//
// A Runtime update zip is only a difference between two Runtimes and carries the new release.json, so a player who applies a later zip
// without the earlier ones has a release.json that looks right and files that are not. The release tools therefore write small marker
// files into app/defaults/runtime-steps/:
//   base.json                    {"base": "0.2.8"}                 the full Runtime's own version (a full Runtime extracted again replaces it)
//   step-<from>-to-<to>.json     {"from": "0.2.7", "to": "0.2.8"}  one per update zip; every zip adds its own file and none overwrites another,
//                                                                  so the folder lists the steps applied so far
// The setup check (bridge/setup-check.mjs) walks base -> step -> step and compares where it ends with the Runtime's release.json.
// A Runtime from before the markers has neither; a chain that starts at the oldest step's `from` is then all that can be checked.
// Reading only: a handful of small files, on demand (the setup check), never per turn.
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';

export const STEPS_DIR = 'defaults/runtime-steps';
export const BASE_FILE = 'base.json';
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$/;

export const stepFileName = (from, to) => `step-${from}-to-${to}.json`;
export const baseText = version => JSON.stringify({base: version}) + '\n';
export const stepText = (from, to) => JSON.stringify({from, to}) + '\n';

/** The numbers in a version, or null when it has none ("0.2.8" -> [0, 2, 8]). */
export const versionParts = value => {
  const parts = String(value ?? '').match(/\d+/g);
  return parts ? parts.map(Number) : null;
};

/** -1, 0 or 1 when `a` is older, the same or newer than `b`, or null when either is not made of numbers. */
export function compareVersions(a, b) {
  const x = versionParts(a), y = versionParts(b);
  if (!x || !y) return null;
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    const p = x[index] ?? 0, q = y[index] ?? 0;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const jsonOf = async path => {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, '')); } catch { return null; }
};

/** {base: string|null, steps: [{from, to}]} as the folder says (steps oldest first), or null when the Runtime has no markers. Never throws. */
export async function readRuntimeSteps(project) {
  let names;
  try { names = await readdir(join(project, STEPS_DIR)); } catch { return null; }
  let base = null;
  const steps = [];
  for (const name of names.slice(0, 200)) {
    if (name === BASE_FILE) {
      const value = await jsonOf(join(project, STEPS_DIR, name));
      if (typeof value?.base === 'string' && VERSION.test(value.base)) base = value.base;
    } else if (/^step-.+\.json$/.test(name)) {
      const value = await jsonOf(join(project, STEPS_DIR, name));
      if (typeof value?.from === 'string' && typeof value?.to === 'string' && VERSION.test(value.from) && VERSION.test(value.to)) steps.push({from: value.from, to: value.to});
    }
  }
  if (base === null && !steps.length) return null;
  steps.sort((a, b) => compareVersions(a.from, b.from) ?? (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return {base, steps};
}

/**
 * Whether the update steps on disk make an unbroken chain up to the version `current` (the Runtime's release.json):
 *   {code: 'none'}                          no markers, or nothing to compare: nothing can be said
 *   {code: 'ok'}                            the chain reaches `current`
 *   {code: 'gap', from, to}                 the step that starts at `from` and ends at `to` was never applied (`to` is where the next marker starts, or `current`)
 *   {code: 'order'}                         `current` is older than a step that was applied: a newer zip went on first, then an older one (not after the full Runtime of `current`)
 */
export async function checkRuntimeSteps({project, current}) {
  try {
    const found = project ? await readRuntimeSteps(project) : null;
    if (!found || typeof current !== 'string') return {code: 'none'};
    const {steps} = found;
    const base = found.base ?? steps[0]?.from ?? null;
    if (base === null) return {code: 'none'};
    // A step that ends after the Runtime's own version: an older zip went on over a newer one. Not when the full Runtime of this very version was extracted last (the base marker
    // is its own): that replaced every file the version has, and what is left of the newer zip is a marker and a few files nothing reads (a rollback; found in a report of
    // 28 Oct 2026, where the row's own advice, to extract the full Runtime again, could never clear it).
    if (found.base !== current && steps.some(step => compareVersions(step.to, current) === 1)) return {code: 'order'};
    let at = base;
    for (let guard = 0; guard < 100; guard++) {
      const order = compareVersions(at, current);
      if (order === null) return {code: 'none'};
      if (order === 0) return {code: 'ok'};
      if (order === 1) return {code: 'none'};   // the Runtime is older than the chain's start: a full older Runtime was extracted, not a gap
      const step = steps.find(item => item.from === at);
      if (step) { at = step.to; continue; }
      const next = steps.find(item => compareVersions(item.from, at) === 1);
      return {code: 'gap', from: at, to: next ? next.from : current};
    }
    return {code: 'none'};
  } catch { return {code: 'none'}; }
}
