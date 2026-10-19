// What a support report may say about the player's voice clips (bridge/player-voices.mjs): how many, and for each its length and whose it is
// (a story character's key, or just "custom" for a character the player made, whose key carries the name they chose). Never the words, the
// audio, a hash or a path. It reads the index only and imports nothing of the clip code, so the support report
// stays small. A missing or damaged index is "none".
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

export const PLAYER_VOICES_INDEX = 'player-voices.json';
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const LIMIT = 160;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function readPlayerVoiceSummary(stateDirectory, {read = file => readFile(file, 'utf8')} = {}) {
  let value = null;
  try { const raw = await read(join(stateDirectory, PLAYER_VOICES_INDEX)); value = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch { return {count: 0, clips: []}; }
  const voices = plain(value) && plain(value.voices) ? value.voices : {};
  const clips = Object.entries(voices)
    .filter(([key, entry]) => KEY.test(key) && !['constructor', 'prototype', '__proto__'].includes(key) && plain(entry) && /^[a-f0-9]{64}$/.test(entry.sha256 ?? '')
      && Number.isFinite(entry.seconds) && entry.seconds > 0 && entry.seconds <= 30)
    .sort(([a], [b]) => a.localeCompare(b)).slice(0, LIMIT)
    .map(([key, entry]) => ({character: key.startsWith('custom-') ? 'custom' : key, seconds: Math.round(entry.seconds * 10) / 10}));
  return {count: clips.length, clips};
}
