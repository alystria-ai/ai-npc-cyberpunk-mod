// Which named place V stands in, from V's world position (bridge/named-places-data.mjs). The game side only reads the position when a turn's context is
// built (mod/turn-context.lua, on demand, never per frame) and sends it with the snapshot; everything else happens here, in the bridge, on plain numbers.
// The position itself never goes into a prompt or a log: only the place's name does.
//
// A place whose position was measured with the developer probe ("quest capture:<id>", runtime/quest-place-capture.json) is matched from that
// measurement until the shipped list has it: `readCaptures` reads the file when it changed (at most every few seconds, off the turn's path).
import {readFile, stat} from 'node:fs/promises';
import {NAMED_PLACES} from './named-places-data.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const LIMIT = 100000;   // the world is a few kilometres wide
const coordinate = value => finite(value) && Math.abs(value) <= LIMIT;

/** A position {x, y, z} from the game, or null. Rounded to a tenth of a metre. */
export function parsePosition(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const {x, y, z} = value;
  if (!coordinate(x) || !coordinate(y) || !coordinate(z)) return null;
  const tenth = number => Math.round(number * 10) / 10;
  return {x: tenth(x), y: tenth(y), z: tenth(z)};
}

// Positions measured in the game: {id: {x, y, z}} for ids of the list only.
let captured = new Map();

/**
 * runtime/quest-place-capture.json as the developer probe writes it ({places: {id: {name, x, y, z, radius, captured, district, area}}}): the measured
 * positions of the places the list knows (`captured: false` is a guess and is not used). Anything else in the file is ignored.
 */
export function parseCaptures(text) {
  const found = new Map();
  let value;
  try { value = JSON.parse(String(text ?? '').replace(/^﻿/, '')); } catch { return found; }
  const places = value && typeof value === 'object' ? value.places : null;
  if (!places || typeof places !== 'object' || Array.isArray(places)) return found;
  for (const place of NAMED_PLACES) {
    const entry = Object.hasOwn(places, place.id) ? places[place.id] : null;
    if (!entry || typeof entry !== 'object' || entry.captured === false) continue;
    const position = parsePosition(entry);
    if (position) found.set(place.id, position);
  }
  return found;
}

/** Replaces the measured positions (tests; the bridge goes through readCaptures). */
export function setCaptures(map) { captured = map instanceof Map ? map : new Map(); }

/** The list with each place's position: the shipped one, else a measured one. A place with neither has null coordinates. */
export function placesWithPositions(list = NAMED_PLACES, measured = captured) {
  return list.map(place => {
    if (finite(place.x) && finite(place.y) && finite(place.z)) return place;
    const found = measured.get(place.id);
    return found ? {...place, ...found} : place;
  });
}

/**
 * The named place around `position` ({x, y, z}), or null: horizontal distance within the place's radius, height within its `dz`, and, when the game named
 * the root district and the place knows its own, the same district. Of several, the one V is deepest inside (distance over radius).
 */
export function namedPlaceAt(position, {district, list = NAMED_PLACES, measured = captured} = {}) {
  const at = parsePosition(position);
  if (!at) return null;
  let best = null, bestRatio = Infinity;
  for (const place of placesWithPositions(list, measured)) {
    if (!finite(place.x) || !finite(place.y) || !finite(place.z)) continue;
    if (place.root && typeof district === 'string' && district && district !== place.root) continue;
    if (Math.abs(at.z - place.z) > (place.dz ?? 6)) continue;
    const ratio = Math.hypot(at.x - place.x, at.y - place.y) / place.radius;
    if (ratio <= 1 && ratio < bestRatio) { best = place; bestRatio = ratio; }
  }
  return best;
}

/** The places that still have no position, for the owner to measure: [{id, probe}]. */
export function placesToCapture(list = NAMED_PLACES, measured = captured) {
  return placesWithPositions(list, measured).filter(place => !(finite(place.x) && finite(place.y) && finite(place.z))).map(place => ({id: place.id, probe: `quest capture:${place.id}`}));
}

/**
 * Reads the capture file when its modification time changed. `poll()` is called from the settings poll and does at most one stat every `everyMs`;
 * it never throws. A missing file means no measured positions.
 */
export function captureReader({path, everyMs = 5000, now = Date.now, log = () => {}} = {}) {
  let checkedAt = -Infinity, mtime = null, busy = false;
  return {
    async poll() {
      if (busy || !path || now() - checkedAt < everyMs) return false;
      busy = true; checkedAt = now();
      try {
        const info = await stat(path).catch(() => null);
        const stamp = info ? `${info.mtimeMs}:${info.size}` : null;
        if (stamp === mtime) return false;
        mtime = stamp;
        const next = stamp ? parseCaptures(await readFile(path, 'utf8').catch(() => '')) : new Map();
        const changed = JSON.stringify([...next]) !== JSON.stringify([...captured]);
        captured = next;
        if (changed) log(`named places: ${next.size} position(s) measured in the game (${[...next.keys()].join(', ') || 'none'})`);
        return changed;
      } catch { return false; } finally { busy = false; }
    },
  };
}
