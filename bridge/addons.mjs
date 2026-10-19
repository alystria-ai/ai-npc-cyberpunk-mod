// Add-on mods (docs/ADDON_API.md): separately installed mods that give the main mod new speakers without a body (a talking
// gun, a cab's voice) and the game facts those speakers talk about. The main mod never needs one: with no add-on installed
// nothing here reads, writes or changes anything, and every function below returns the "nothing" value the caller already
// handles (an empty list, the same paths, an empty string).
//
// An add-on is one folder, normally its own CET mod folder:
//   <game>/bin/x64/plugins/cyber_engine_tweaks/mods/<AddonFolder>/convai-addon.json   the manifest (read here)
//   <AddonFolder>/init.lua ...                                                         its CET side (mod/addons.lua is the API it calls)
//   <AddonFolder>/bridge.mjs                                                           optional bridge-side hooks (loaded here)
//   <AddonFolder>/voices/<speaker>.wav                                                 optional voice references
// The bridge looks for manifests once, at start, in the game's CET mods folder (one directory listing) and in the folders named by
// CYBERPUNK_CONVAI_ADDONS (';'-separated, for development and tests). A malformed or incompatible add-on is skipped and reported
// in runtime/addons-status.json, which the game reads to tell the player; it never stops the bridge.
//
// A speaker becomes a conversation profile ("addon-<addon>-<speaker>"): a roster row the text providers' persona book reads (its
// active personality mode decides the style, example lines and rules), and a voice entry in merged copies of the voice
// configurations. Its text comes only from Mistral or the local AI, never Convai (routeFor): an add-on speaker never has a Convai
// character ID and never counts toward the Convai allowance. The bridge also keeps each speaker's recent lines and its memories of
// earlier fights or rides (runtime/addon-journal.json), shows both to the speaker, and drops a remark that repeats a recent one.
import {readFile, readdir, writeFile, mkdir, copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename, dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readPcmWav} from './speech-audio.mjs';
import {LEGACY_LOCAL_VOICE_KEYS, PLAYER_REFERENCE_PREFIX, voiceKeyValid, voiceTranscriptValid} from './voice-profile-registry.mjs';
import {AddonStock} from './addon-stock.mjs';

/** The add-on API this main mod implements. A manifest asking for the same major and an equal or lower minor is compatible. */
export const ADDON_API_VERSION = '1.0';
export const ADDON_MANIFEST = 'convai-addon.json';
export const ADDON_STATUS_FILE = 'addons-status.json';
export const ADDON_STATE_FILE = 'addon-state.json';
export const ADDON_SETTINGS_FILE = 'addon-settings.json';
export const ADDON_JOURNAL_FILE = 'addon-journal.json';
/** The only text providers an add-on speaker may use (the user's decision, 2026-10-13: never Convai). */
export const ADDON_PROVIDERS = Object.freeze(['mistral', 'local']);
/**
 * Seconds between two remark starts of one add-on on the local AI while the player keeps the default "Time between remarks"
 * (10 s). Each remark is a GPU burst of about 0.3 to 0.7 s beside the game (docs/LOCAL_MODEL_CHOICE.md: 79 to 143 tokens/s,
 * warm reply 0.45 to 0.89 s) whose frame-time cost is not measured yet (docs/LOCAL_OPTION_DESIGN.md, Risks 1), so the default
 * keeps it to about one burst in 20 s in a fight. A gap the player picked is used as it is.
 */
export const LOCAL_REMARK_GAP_S = 20;
export const ADDON_ENV = 'CYBERPUNK_CONVAI_ADDONS';
/** The CET mods folder, relative to the game root: add-ons are CET mods, so they are found where CET finds them. */
export const CET_MODS = 'bin/x64/plugins/cyber_engine_tweaks/mods';
export const ADDON_LIMITS = Object.freeze({addons: 8, speakers: 4, persona: 12000, samples: 12, rules: 12, line: 600,
  blocks: 8, blockText: 1500, blocksTotal: 4000, facts: 4000, eventText: 600, companionBlocks: 4, companionText: 600,
  referenceBytes: 8 * 1024 * 1024, referenceSeconds: 20, transcript: 2000, hookMs: 5, modes: 4, recentLines: 12, recentShown: 6,
  recentChecked: 8, moduleMs: 5000, heard: 240, talkWordsMin: 8, talkWordsMax: 60, retryMs: 250, retryShare: 1.25, retryGuessMs: 900, memories: 12, memoriesShown: 6, memoryText: 300,
  // Stock (bridge/addon-stock.mjs); the game side keeps the same numbers in mod/addons.lua STOCK.
  stockKeys: 12, stockText: 600, stockSlots: 8, stockSlotName: 48, stockBlocks: 4, stockBlocksText: 3000});

const ADDON_ID = /^[a-z][a-z0-9-]{1,23}$/;
const SPEAKER_ID = /^[a-z][a-z0-9-]{0,23}$/;
const EVENT_NAME = /^[A-Za-z0-9_.:-]{1,48}$/;
const BLOCK_KEY = /^[A-Za-z0-9_.:-]{1,40}$/;
const MODE_ID = /^[a-z][a-z0-9-]{0,23}$/;
const VERSION = /^\d{1,4}\.\d{1,4}(?:\.\d{1,6})?(?:[-+][0-9A-Za-z.-]{1,32})?$/;
const API_VERSION = /^(\d{1,3})\.(\d{1,3})$/;
const TIERS = new Set(['world', 'volatile', 'notes']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const text = (value, limit) => typeof value === 'string' ? value.replace(control, ' ').trim().slice(0, limit) : '';

/** profileKey of an add-on speaker: the key the roster, memory, voices and the game all use for it. */
export const speakerProfileKey = (addonId, speakerId) => `addon-${addonId}-${speakerId}`;
export const isAddonProfile = key => typeof key === 'string' && key.startsWith('addon-');

/** {major, minor} of "1.0", or null. */
export function parseApiVersion(value) {
  const match = typeof value === 'string' ? API_VERSION.exec(value.trim()) : null;
  return match ? {major: Number(match[1]), minor: Number(match[2])} : null;
}

/** Can this main mod (API `version`) serve an add-on that requires `required`? Same major, and the main minor at least as high. */
export function apiCompatible(required, version = ADDON_API_VERSION) {
  const want = parseApiVersion(required), have = parseApiVersion(version);
  return !!want && !!have && want.major === have.major && want.minor <= have.minor;
}

// A path inside the add-on folder: relative, no drive, no '..'. Returns the absolute path or null.
function inside(root, value) {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value) || /^[a-z]:|^[\\/]/i.test(value)) return null;
  if (value.split(/[\\/]+/).some(part => part === '..' || part === '')) return null;
  const path = resolve(root, value);
  return path.startsWith(resolve(root) + sep) ? path : null;
}

const lines = (list, limit) => (Array.isArray(list) ? list : []).map(line => text(line, ADDON_LIMITS.line)).filter(Boolean).slice(0, limit);

// persona.talkWords: the longest answer, in words, the speaker gives V when V talks to it (the main mod's own limit is about 15 to 40).
function talkWords(value, where) {
  if (value === undefined) return {};
  if (!Number.isInteger(value) || value < ADDON_LIMITS.talkWordsMin || value > ADDON_LIMITS.talkWordsMax) {
    throw Error(`${where}: talkWords must be a whole number from ${ADDON_LIMITS.talkWordsMin} to ${ADDON_LIMITS.talkWordsMax}`);
  }
  return {talkWords: value};
}

function persona(value, name) {
  const source = object(value) ? value : {};
  const result = {intro: text(source.intro, 1200), identityRule: text(source.identityRule, 1200),
    backstory: text(source.backstory, ADDON_LIMITS.persona), style: text(source.style, 3000),
    samples: lines(source.samples, ADDON_LIMITS.samples), rules: lines(source.rules, ADDON_LIMITS.rules),
    ...talkWords(source.talkWords, `speaker ${name}: persona`),
    // persona.voiceContext: a voice with no body (a cab's AI): its turns get the main mod's "right now" facts as a voice, not as a person beside V.
    ...(source.voiceContext === true ? {voiceContext: true} : {})};
  if (!result.backstory) throw Error(`speaker ${name}: persona.backstory is required`);
  return result;
}

// A personality mode (Skippy's Stone Cold Killer and Puppy-Loving Pacifist): what replaces or extends the base persona while it is on.
function mode(value, id, speaker) {
  if (!MODE_ID.test(id)) throw Error(`speaker ${speaker}: mode id ${id} is invalid`);
  if (!object(value)) throw Error(`speaker ${speaker}: mode ${id} must be an object`);
  const name = text(value.name, 60);
  if (!name) throw Error(`speaker ${speaker}: mode ${id} needs a name`);
  return {id, name, intro: text(value.intro, 1200), identityRule: text(value.identityRule, 1200), backstory: text(value.backstory, 4000),
    style: text(value.style, 3000), samples: lines(value.samples, ADDON_LIMITS.samples), rules: lines(value.rules, ADDON_LIMITS.rules),
    ...talkWords(value.talkWords, `speaker ${speaker}: mode ${id}`)};
}

function providers(value, where) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.length || value.some(item => !ADDON_PROVIDERS.includes(item)) || new Set(value).size !== value.length) {
    throw Error(`${where} must list "mistral" and/or "local" (add-on speakers never use Convai)`);
  }
  return [...value];
}

/**
 * The validated manifest, or a thrown Error naming what is wrong. `dir` is the add-on folder (paths in the manifest stay inside it).
 * Pure apart from nothing: the voice files are checked later, by prepareVoices.
 */
export function validateManifest(raw, dir) {
  if (!object(raw)) throw Error('manifest must be a JSON object');
  if (raw.schema !== 1) throw Error('schema must be 1');
  if (typeof raw.id !== 'string' || !ADDON_ID.test(raw.id)) throw Error('id must be 2-24 lowercase letters, digits or dashes, starting with a letter');
  const name = text(raw.name, 60);
  if (!name) throw Error('name is required');
  if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) throw Error('version must look like 1.0 or 1.0.0');
  const required = object(raw.requires) ? raw.requires.api : undefined;
  if (!parseApiVersion(required)) throw Error('requires.api must look like "1.0"');
  let bridge = null;
  if (raw.bridge !== undefined) {
    bridge = inside(dir, raw.bridge);
    if (!bridge || !/\.m?js$/.test(bridge)) throw Error('bridge must be a .mjs file inside the add-on folder');
  }
  const addonProviders = providers(raw.providers, 'providers') ?? [...ADDON_PROVIDERS];
  if (!Array.isArray(raw.speakers) || raw.speakers.length > ADDON_LIMITS.speakers) throw Error(`speakers must be a list of at most ${ADDON_LIMITS.speakers}`);
  const seen = new Set();
  const speakers = raw.speakers.map((speaker, index) => {
    if (!object(speaker) || typeof speaker.id !== 'string' || !SPEAKER_ID.test(speaker.id)) throw Error(`speakers[${index}].id is invalid`);
    if (seen.has(speaker.id)) throw Error(`speaker ${speaker.id} is listed twice`);
    seen.add(speaker.id);
    const speakerName = text(speaker.name, 60);
    if (!speakerName) throw Error(`speaker ${speaker.id}: name is required`);
    let voice = null;
    if (speaker.voice !== undefined) {
      if (!object(speaker.voice)) throw Error(`speaker ${speaker.id}: voice must be an object`);
      const reference = inside(dir, speaker.voice.reference);
      if (!reference || !reference.toLowerCase().endsWith('.wav')) throw Error(`speaker ${speaker.id}: voice.reference must be a .wav inside the add-on folder`);
      const transcript = text(speaker.voice.transcript, ADDON_LIMITS.transcript);
      if (!transcript) throw Error(`speaker ${speaker.id}: voice.transcript is required`);
      const sha256 = speaker.voice.sha256;
      if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))) throw Error(`speaker ${speaker.id}: voice.sha256 must be 64 lowercase hex digits`);
      voice = {reference, transcript, ...(sha256 ? {sha256} : {})};
    }
    if (speaker.convai !== undefined) throw Error(`speaker ${speaker.id}: convai is not supported; add-on speakers use Mistral or the local AI only`);
    const modes = {};
    if (speaker.modes !== undefined) {
      if (!object(speaker.modes) || Object.keys(speaker.modes).length > ADDON_LIMITS.modes) throw Error(`speaker ${speaker.id}: modes must be an object of at most ${ADDON_LIMITS.modes}`);
      for (const [id, value] of Object.entries(speaker.modes)) modes[id] = mode(value, id, speaker.id);
    }
    const modeIds = Object.keys(modes);
    const defaultMode = speaker.defaultMode === undefined ? (modeIds[0] ?? null) : speaker.defaultMode;
    if (defaultMode !== null && !Object.hasOwn(modes, defaultMode)) throw Error(`speaker ${speaker.id}: defaultMode must name one of its modes`);
    return {id: speaker.id, name: speakerName, profileKey: speakerProfileKey(raw.id, speaker.id),
      persona: persona(speaker.persona, speaker.id), voice, modes, defaultMode,
      providers: providers(speaker.providers, `speaker ${speaker.id}: providers`) ?? addonProviders};
  });
  return {schema: 1, id: raw.id, name, version: raw.version, requires: {api: required.trim()}, bridge, speakers, dir, providers: addonProviders};
}

/** The folders searched for add-ons: the game's CET mods folder, then the CYBERPUNK_CONVAI_ADDONS list. */
export function addonRoots({game, environment = process.env} = {}) {
  const roots = [];
  if (typeof game === 'string' && game) roots.push({path: resolve(game, CET_MODS), children: true});
  const listed = typeof environment?.[ADDON_ENV] === 'string' ? environment[ADDON_ENV].split(';') : [];
  for (const entry of listed) if (entry.trim()) roots.push({path: resolve(entry.trim()), children: false});
  return roots;
}

/**
 * Finds and validates add-on manifests. A root with `children: true` is a folder of mod folders (one listing, one level deep); a
 * root with `children: false` is an add-on folder itself. Returns {addons: [manifest], problems: [{dir, id?, name?, status, reason}]}.
 */
export async function discoverAddons({roots = [], version = ADDON_API_VERSION, files = {readdir, readFile}} = {}) {
  const folders = [];
  for (const root of roots) {
    if (!root.children) { folders.push(root.path); continue; }
    let entries = [];
    try { entries = await files.readdir(root.path, {withFileTypes: true}); } catch { continue; }
    for (const entry of entries) if (entry.isDirectory()) folders.push(resolve(root.path, entry.name));
  }
  const addons = [], problems = [], ids = new Set(), profileKeys = new Set();
  for (const dir of [...new Set(folders)].sort()) {
    let raw;
    try { raw = await files.readFile(resolve(dir, ADDON_MANIFEST), 'utf8'); }
    catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') problems.push({dir, status: 'invalid', reason: 'manifest unreadable'}); continue; }
    let manifest;
    try { manifest = validateManifest(JSON.parse(raw.replace(/^﻿/, '')), dir); }
    catch (error) {
      let id, name;
      try { const value = JSON.parse(raw.replace(/^﻿/, '')); id = typeof value?.id === 'string' ? value.id.slice(0, 24) : undefined; name = text(value?.name, 60) || undefined; } catch {}
      problems.push({dir, ...(id ? {id} : {}), ...(name ? {name} : {}), status: 'invalid', reason: error.message}); continue;
    }
    if (!apiCompatible(manifest.requires.api, version)) {
      problems.push({dir, id: manifest.id, name: manifest.name, version: manifest.version, requires: manifest.requires.api,
        status: 'incompatible', reason: `needs add-on API ${manifest.requires.api}; this AI NPC Cyberpunk Mod has ${version}`});
      continue;
    }
    if (ids.has(manifest.id)) { problems.push({dir, id: manifest.id, name: manifest.name, status: 'duplicate', reason: 'another add-on uses this id'}); continue; }
    // "addon-<id>-<speaker>" joins two names with a dash, so add-on "ab" with speaker "c-d" and add-on "ab-c" with speaker "d" share
    // one key: the later add-on would silently take the earlier one's profile over.
    if (manifest.speakers.some(speaker => profileKeys.has(speaker.profileKey))) {
      problems.push({dir, id: manifest.id, name: manifest.name, status: 'duplicate', reason: 'a speaker of this add-on has the same profile key as one of another add-on'}); continue;
    }
    if (addons.length >= ADDON_LIMITS.addons) { problems.push({dir, id: manifest.id, name: manifest.name, status: 'skipped', reason: 'too many add-ons'}); continue; }
    ids.add(manifest.id); addons.push(manifest);
    for (const speaker of manifest.speakers) profileKeys.add(speaker.profileKey);
  }
  return {addons, problems};
}

// ---- Turn data sent by the game ------------------------------------------------------------------------------------------

function facts(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return text(value, 240);
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 24).map(item => facts(item, depth + 1));
  if (!object(value)) return null;
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) if (BLOCK_KEY.test(key)) out[key] = facts(item, depth + 1);
  return out;
}

/** The `addon` field of a game request (docs/ADDON_API.md, "Request data"), or undefined when absent or malformed. */
export function parseAddonInput(value) {
  if (!object(value) || typeof value.id !== 'string' || !ADDON_ID.test(value.id)
      || typeof value.speaker !== 'string' || !SPEAKER_ID.test(value.speaker)) return undefined;
  const result = {id: value.id, speaker: value.speaker};
  if (typeof value.event === 'string' && EVENT_NAME.test(value.event)) result.event = value.event;
  const eventText = text(value.text, ADDON_LIMITS.eventText);
  if (eventText) result.text = eventText;
  if (Number.isInteger(value.maxWords) && value.maxWords >= 3 && value.maxWords <= 60) result.maxWords = value.maxWords;
  if (typeof value.mode === 'string' && MODE_ID.test(value.mode)) result.mode = value.mode;
  if (object(value.facts)) {
    const cleaned = facts(value.facts);
    if (JSON.stringify(cleaned).length <= ADDON_LIMITS.facts) result.facts = cleaned;
  }
  const blocks = cleanBlocks(value.blocks, ADDON_LIMITS.blocks, ADDON_LIMITS.blocksTotal);
  if (blocks.length) result.blocks = blocks;
  if (value.stock === true) result.stock = true;
  if (value.repeatOk === true) result.repeatOk = true;
  return result;
}

// Prompt blocks from the game: at most `most` of them, `total` characters in all (a block that would pass the total is skipped).
function cleanBlocks(list, most, total) {
  const blocks = [];
  let used = 0;
  for (const block of (Array.isArray(list) ? list : []).slice(0, most)) {
    if (!object(block) || typeof block.key !== 'string' || !BLOCK_KEY.test(block.key)) continue;
    const body = text(block.text, ADDON_LIMITS.blockText);
    if (!body || used + body.length > total) continue;
    used += body.length;
    blocks.push({key: block.key, text: body, tier: TIERS.has(block.tier) ? block.tier : 'world'});
  }
  return blocks;
}

const SLOT_NAME = /^[A-Za-z0-9_.]{1,48}$/;
const clampInt = (value, low, high, fallback) => Number.isFinite(value) ? Math.max(low, Math.min(high, Math.floor(value))) : fallback;

/**
 * The `stock` rows of one add-on in the state file (handle:stock in mod/addons.lua): the lines to write ahead of time. A row with
 * a bad speaker, key, text, facts, slot or rev is dropped; numbers are clamped; at most 12 keys per speaker.
 */
export function parseAddonStock(list) {
  const rows = [], seen = new Set(), perSpeaker = new Map();
  for (const row of (Array.isArray(list) ? list : []).slice(0, ADDON_LIMITS.stockKeys * ADDON_LIMITS.speakers)) {
    if (!object(row) || typeof row.speaker !== 'string' || !SPEAKER_ID.test(row.speaker)
        || typeof row.key !== 'string' || !EVENT_NAME.test(row.key)) continue;
    const body = text(row.text, ADDON_LIMITS.stockText);
    if (!body || !Number.isSafeInteger(row.rev) || row.rev < 0) continue;
    const id = `${row.speaker}\u0000${row.key}`;
    if (seen.has(id) || (perSpeaker.get(row.speaker) ?? 0) >= ADDON_LIMITS.stockKeys) continue;
    let rowFacts;
    if (row.facts !== undefined && row.facts !== null) {
      if (!object(row.facts)) continue;
      rowFacts = facts(row.facts);
      if (JSON.stringify(rowFacts).length > ADDON_LIMITS.facts) continue;
    }
    // An object (an empty Lua table encoded as {}) is an empty list; anything else that is not a list of valid names drops the row.
    const wanted = Array.isArray(row.slots) ? row.slots : object(row.slots) && !Object.keys(row.slots).length ? [] : null;
    if (!wanted || wanted.length > ADDON_LIMITS.stockSlots || wanted.some(name => typeof name !== 'string' || !SLOT_NAME.test(name))) continue;
    seen.add(id);
    perSpeaker.set(row.speaker, (perSpeaker.get(row.speaker) ?? 0) + 1);
    rows.push({speaker: row.speaker, key: row.key, text: body, ...(rowFacts ? {facts: rowFacts} : {}),
      maxWords: clampInt(row.maxWords, 3, 60, 10), want: clampInt(row.want, 1, 4, 2), ttl: clampInt(row.ttl, 10, 300, 90),
      slots: [...new Set(wanted)], rev: row.rev,
      blocks: cleanBlocks(row.blocks, ADDON_LIMITS.stockBlocks, ADDON_LIMITS.stockBlocksText)});
  }
  return rows;
}

/**
 * The reaction of an automatic add-on remark: {kind: 'addon', addon, speaker, event, expiresAt}, or null when malformed. With the
 * request's `profileKey` it must be the profile of the very speaker the remark names (only mod/addons.lua writes these requests, with
 * exactly that key): an add-on remark can never be asked of a main character or of another add-on's speaker.
 */
export function parseAddonReaction(value, addon, profileKey) {
  if (!object(value) || value.kind !== 'addon' || typeof value.addon !== 'string' || !ADDON_ID.test(value.addon)
      || typeof value.speaker !== 'string' || !SPEAKER_ID.test(value.speaker)
      || typeof value.event !== 'string' || !EVENT_NAME.test(value.event)
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) return null;
  // The remark's event data must name the same speaker.
  if (!addon || addon.id !== value.addon || addon.speaker !== value.speaker) return null;
  if (profileKey !== undefined && profileKey !== speakerProfileKey(value.addon, value.speaker)) return null;
  return {kind: 'addon', addon: value.addon, speaker: value.speaker, event: value.event, expiresAt: value.expiresAt,
    ...(Number.isInteger(value.priority) && value.priority >= 1 && value.priority <= 5 ? {priority: value.priority} : {}),
    // The word limit of the remark, so the text host can stop, cap and size the request to it (bridge/text-provider-host.mjs).
    ...(Number.isInteger(addon.maxWords) ? {maxWords: addon.maxWords} : {})};
}

/** The state file the game writes (companion context and per-add-on state), or an empty state. */
export function parseAddonState(raw, {notBefore = 0} = {}) {
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return {addons: {}}; }
  if (!object(value) || value.version !== 1 || !object(value.addons)) return {addons: {}};
  // A file left by an earlier game session (a crash, a closed game) is not this session's state.
  if (!Number.isFinite(value.updated) || value.updated < notBefore) return {addons: {}};
  const addons = {};
  for (const [id, entry] of Object.entries(value.addons).slice(0, ADDON_LIMITS.addons)) {
    if (!ADDON_ID.test(id) || !object(entry)) continue;
    const companion = [];
    for (const block of (Array.isArray(entry.companionContext) ? entry.companionContext : []).slice(0, ADDON_LIMITS.companionBlocks)) {
      const body = object(block) && typeof block.key === 'string' && BLOCK_KEY.test(block.key) ? text(block.text, ADDON_LIMITS.companionText) : '';
      if (body) companion.push({key: block.key, text: body});
    }
    const modes = {};
    if (object(entry.modes)) for (const [speaker, value] of Object.entries(entry.modes).slice(0, ADDON_LIMITS.speakers)) {
      if (SPEAKER_ID.test(speaker) && typeof value === 'string' && MODE_ID.test(value)) modes[speaker] = value;
    }
    const memories = [];
    for (const item of (Array.isArray(entry.memories) ? entry.memories : []).slice(-ADDON_LIMITS.memories * ADDON_LIMITS.speakers)) {
      const body = object(item) && typeof item.speaker === 'string' && SPEAKER_ID.test(item.speaker) ? text(item.text, ADDON_LIMITS.memoryText) : '';
      if (body && Number.isFinite(item.at)) memories.push({speaker: item.speaker, text: body, at: item.at});
    }
    const warm = object(entry.warm) && typeof entry.warm.speaker === 'string' && SPEAKER_ID.test(entry.warm.speaker) && Number.isFinite(entry.warm.at)
      ? {speaker: entry.warm.speaker, at: entry.warm.at} : null;
    addons[id] = {companionContext: companion, ...(object(entry.state) ? {state: facts(entry.state)} : {}), modes, memories, ...(warm ? {warm} : {}),
      stock: parseAddonStock(entry.stock)};
  }
  return {addons};
}

/** The settings file the game writes: {addonId: {settingId: value}} with plain booleans, numbers and short strings only. */
export function parseAddonSettings(raw) {
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return {}; }
  if (!object(value) || value.version !== 1 || !object(value.addons)) return {};
  const result = {};
  for (const [id, entry] of Object.entries(value.addons).slice(0, ADDON_LIMITS.addons)) {
    if (!ADDON_ID.test(id) || !object(entry)) continue;
    const values = {};
    for (const [key, item] of Object.entries(entry).slice(0, 32)) {
      if (!BLOCK_KEY.test(key)) continue;
      if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) values[key] = item;
      else if (typeof item === 'string') values[key] = item.slice(0, 80);
    }
    result[id] = values;
  }
  return result;
}

// ---- Repetition ----------------------------------------------------------------------------------------------------------

// Curly apostrophes and quotation marks are the same characters as the straight ones for this purpose: "you\u2019re" and "you're" are
// one word (a model writes either), never "you" and "re".
const words = line => String(line ?? '').replace(/[\u2018\u2019\u201b\u02bc\u0060\u00b4]/g, "'").toLowerCase()
  .replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).map(word => word.replace(/^'+|'+$/g, '')).filter(Boolean);

// Words that carry no joke on their own: function words, auxiliaries, number words and units (a fare or a distance is a fact value).
// A run of four words made of these and at most one other word is a stock phrase ("I shall continue to", "hundred metres to the",
// "three hundred and fifty eddies"), not a reused line. Greeting and farewell words are on the list too: "Good evening, V. The ..." and
// "Welcome back, V. The ..." are how a welcome opens, not a joke (live 2026-10-16: the cab's welcome was dropped twice as a repeat
// of such an opener, and V heard no welcome at all).
const COMMON = new Set(`a an the and or but nor so yet if then than that this these those there here it its i me my mine we us our ours you your
  yours he she him her his they them their theirs is am are was were be been being do does did done have has had will would shall should can could may
  might must not no to of in on at by for from with as into onto over under up out off about just very quite rather also too still now only more most
  much many some any all each every one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty sixty hundred thousand
  eddies eddy metres metre meters meter kilometres kilometre kilometers kilometer km minutes minute seconds second hours hour let who whom which what
  when where why how i'm i've i'll i'd you're you've you'll you'd we're we've we'll we'd he's she's it's that's there's what's let's they're they've
  don't doesn't didn't isn't aren't wasn't weren't won't wouldn't can't couldn't shouldn't haven't hasn't v
  welcome back again hello hi hey good evening morning afternoon night day goodbye farewell thank thanks please pleasure`.split(/\s+/));
const common = word => COMMON.has(word) || /^\d/.test(word);

/** 0..1: how much two lines share (word sets, Jaccard). Cheap: a few dozen words, no model. */
export function lineSimilarity(a, b) {
  const left = new Set(words(a)), right = new Set(words(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * A near repeat: the same words, mostly the same words (similarity >= 0.6), or the same run of four words (a reused joke) that holds
 * at least two words that are not common (function words, number words and units do not make a joke).
 */
export function isNearDuplicate(a, b) {
  const left = words(a), right = words(b);
  if (!left.length || !right.length) return false;
  if (left.join(' ') === right.join(' ') || lineSimilarity(a, b) >= 0.6) return true;
  if (left.length < 4 || right.length < 4) return false;
  const runs = new Set();
  const distinct = run => run.filter(word => !common(word)).length >= 2;
  for (let index = 0; index + 4 <= left.length; index++) { const run = left.slice(index, index + 4); if (distinct(run)) runs.add(run.join(' ')); }
  for (let index = 0; index + 4 <= right.length; index++) if (runs.has(right.slice(index, index + 4).join(' '))) return true;
  return false;
}

/** The line a speaker says in an example ("Game event: ...\nSkippy: One down." -> "One down."); '' for an example that has none. */
export function sampleLine(sample, name = '') {
  const rows = String(sample ?? '').split(/\n+/).map(row => row.trim()).filter(Boolean);
  const last = rows.at(-1) ?? '';
  const match = /^([^:]{1,40}):\s*(.+)$/.exec(last);
  if (!match) return rows.length > 1 ? '' : last;
  return !name || match[1].trim().toLowerCase() === name.toLowerCase() ? match[2].trim() : '';
}

// ---- Voice references ----------------------------------------------------------------------------------------------------

/** {sha256, duration} of a reference clip the voice workers accept, or a thrown Error. */
export function inspectReference(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > ADDON_LIMITS.referenceBytes) throw Error('reference is larger than 8 MB');
  const wav = readPcmWav(bytes);
  if (wav.duration < 0.1 || wav.duration > ADDON_LIMITS.referenceSeconds) throw Error(`reference must hold 0.1 to ${ADDON_LIMITS.referenceSeconds} seconds`);
  return {sha256: createHash('sha256').update(bytes).digest('hex'), duration: wav.duration};
}

const REFERENCE_PREFIX = 'runtime/voice-references/';

/**
 * The voices a merged configuration prepares at start, without `skip` (the player keys), or undefined when it prepares none and none
 * were named (Pocket prepares only the voices a list names). A list the configuration does not carry is what its worker would choose
 * itself: OmniVoice prepares every ready voice when it has at most three, else the three original cast members that are ready.
 */
function startupWithout(config, pocket, skip) {
  let startup = config.preparation?.startupProfiles;
  if (!Array.isArray(startup)) {
    if (pocket) return undefined;
    const ready = Object.keys(config.voices).filter(key => (config.voices[key]?.status ?? 'ready') === 'ready').sort();
    const eager = (config.preparation?.mode ?? (Object.keys(config.voices).length <= 3 ? 'eager' : 'lazy')) === 'eager';
    startup = eager ? ready : LEGACY_LOCAL_VOICE_KEYS.filter(key => ready.includes(key));
  }
  return startup.filter(key => !skip.has(key));
}

// ---- Text providers -------------------------------------------------------------------------------------------------------

/**
 * The provider state an add-on speaker's text host (bridge/text-provider-host.mjs) sees: always active, its route fixed to the one
 * routeFor chose ('mistral' or 'local'), the player's saved Mistral key.
 */
export function fixedProvider(provider, route) {
  if (!ADDON_PROVIDERS.includes(route)) throw Error(`add-on speakers cannot use ${route}`);
  return {get route() { return route; }, get applied() { return route; }, get active() { return true; },
    get apiKey() { return provider?.apiKey ?? null; }};
}

const MEMORY_METHODS = ['recall', 'record', 'retrieve', 'interrupt', 'forget', 'beginSummary', 'applySummary', 'failSummary', 'pendingSummary'];
/**
 * The shared memory store as an add-on text host uses it: the same conversations, without the fact-extraction hook (a second host
 * constructed on the store itself would take that hook over from the main host).
 */
export function sharedMemory(memory) {
  const view = {};
  for (const name of MEMORY_METHODS) if (typeof memory?.[name] === 'function') view[name] = (...args) => memory[name](...args);
  return view;
}

/**
 * A lookup over the main mod's roster rows ({key, name, aliases, gender}) for AddonHost.characterInfo: by profile key, name or alias,
 * ignoring case. Built on first use, and again after `reset()` (the bridge calls it when the characters the player made change, so a character
 * made or renamed in the editor is found without a restart). Add-on speakers and unnamed archetypes are not in it.
 */
export function rosterLookup(rows) {
  let index = null;
  const lookup = value => {
    if (!index) {
      index = new Map();
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!object(row) || typeof row.key !== 'string' || isAddonProfile(row.key) || row.kind === 'ambient' || row.kind === 'archetype') continue;
        for (const name of [row.key, row.name, ...(Array.isArray(row.aliases) ? row.aliases : [])]) {
          if (typeof name === 'string' && name.trim() && !index.has(name.trim().toLowerCase())) index.set(name.trim().toLowerCase(), row);
        }
      }
    }
    return index.get(String(value ?? '').trim().toLowerCase()) ?? null;
  };
  lookup.reset = () => { index = null; };
  return lookup;
}

// ---- The host --------------------------------------------------------------------------------------------------------------

const noop = () => {};

export class AddonHost {
  /**
   * addons     validated manifests (discoverAddons)
   * problems   the ones that were skipped, for the status file
   * modules    {addonId: module namespace} (loadModules fills it)
   */
  constructor({addons = [], problems = [], log = noop, now = Date.now, startedAt = Date.now()} = {}) {
    this.addons = addons;
    this.problems = [...problems];
    this.log = log;
    this.now = now;
    this.startedAt = startedAt;
    this.modules = new Map();
    this.moduleErrors = new Map();
    this.hookFailures = new Map();
    this.voiceStatus = new Map();
    this.state = {addons: {}};
    this.settings = {};
    this.speakers = new Map();
    for (const addon of addons) for (const speaker of addon.speakers) this.speakers.set(speaker.profileKey, {addon, speaker});
    this.modes = new Map();          // profileKey -> active mode id (the game's choice; the manifest's defaultMode until then)
    this.rows = null;                // roster rows, built once (their persona fields follow the active mode)
    this.journal = {version: 1, speakers: {}};
    this.journalPath = null;
    this.journalTimer = null;
    this.warmed = new Map();         // addonId -> the last warm stamp seen in the state file
    this.onWarm = null;              // profileKey => void: the bridge warms the speaker's text route
    this.characterLookup = null;     // keyOrName => {key, name, gender} | null: the bridge's roster, for bridge modules (characterInfo)
    // Lines written ahead of time (bridge/addon-stock.mjs). Holds nothing, and starts nothing, until an add-on asks for stock.
    this.stock = this.active ? new AddonStock({now: () => this.now(), recent: key => this.recentLines(key)}) : null;
    this.onStock = null;             // () => void: the stock changed or may need lines; the bridge starts or stops its pump
    this.localRemarkAt = new Map();  // addonId -> when its last remark started on the local AI
  }

  /** True when at least one add-on is installed and valid. Every caller can skip its add-on work when false. */
  get active() { return this.addons.length > 0; }

  /** Finds, validates and loads the installed add-ons. Never throws: a failure is an add-on that is not there. */
  static async load({game, environment = process.env, log = noop, version = ADDON_API_VERSION, files} = {}) {
    try {
      const {addons, problems} = await discoverAddons({roots: addonRoots({game, environment}), version, ...(files ? {files} : {})});
      for (const problem of problems) log(`Add-on ${problem.id ?? basename(problem.dir)} not loaded (${problem.status}): ${problem.reason}`);
      const host = new AddonHost({addons, problems, log});
      if (addons.length) await host.loadModules();
      for (const addon of addons) log(`Add-on ${addon.id} ${addon.version} loaded: ${addon.speakers.map(speaker => speaker.profileKey).join(', ') || 'no speakers'}`);
      return host;
    } catch (error) {
      log(`Add-ons unavailable: ${error.message}`);
      return new AddonHost({log});
    }
  }

  /**
   * Imports each add-on's bridge module. A module that fails to load, or whose import or activate does not finish within
   * `timeoutMs`, leaves its add-on working without hooks: one add-on must never hold up the bridge start.
   */
  async loadModules({importModule = path => import(pathToFileURL(path).href), timeoutMs = ADDON_LIMITS.moduleMs} = {}) {
    const within = (work, what) => {
      let timer;
      const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${what} did not finish within ${timeoutMs / 1000} s`)), timeoutMs); timer.unref?.(); });
      return Promise.race([work, limit]).finally(() => clearTimeout(timer));
    };
    for (const addon of this.addons) {
      if (!addon.bridge) continue;
      try {
        const module = await within(importModule(addon.bridge), 'loading the bridge module');
        if (module?.apiVersion !== undefined && !apiCompatible(String(module.apiVersion))) throw Error(`bridge module needs add-on API ${module.apiVersion}`);
        this.modules.set(addon.id, module);
        if (typeof module.activate === 'function') {
          await within(module.activate(Object.freeze({version: ADDON_API_VERSION, addon: Object.freeze({id: addon.id, name: addon.name, version: addon.version,
            speakers: addon.speakers.map(speaker => Object.freeze({id: speaker.id, name: speaker.name, profileKey: speaker.profileKey}))}),
          log: message => this.log(`[${addon.id}] ${String(message).slice(0, 400)}`),
          settings: () => ({...(this.settings[addon.id] ?? {})}),
          state: () => this.state.addons[addon.id]?.state ?? null,
          character: value => this.characterInfo(value)})), 'activate');
        }
      } catch (error) {
        this.modules.delete(addon.id);
        this.moduleErrors.set(addon.id, error.message);
        this.log(`Add-on ${addon.id}: bridge module not loaded: ${error.message}`);
      }
    }
  }

  // A hook is plain synchronous code on the turn path: it must be quick and must not throw. Three failures switch it off.
  #hook(addonId, name, args) {
    const module = this.modules.get(addonId), fn = module?.[name];
    if (typeof fn !== 'function') return undefined;
    const key = `${addonId}:${name}`, failures = this.hookFailures.get(key) ?? 0;
    if (failures >= 3) return undefined;
    const started = performance.now();
    try {
      const result = fn(args);
      if (result && typeof result.then === 'function') {
        result.then(undefined, () => {});   // an async hook that rejects must not become an unhandled rejection (it ends the bridge)
        throw Error('hooks must return a value, not a promise');
      }
      const ms = performance.now() - started;
      if (ms > ADDON_LIMITS.hookMs) this.log(`Add-on ${addonId}: ${name} took ${ms.toFixed(1)} ms; keep hooks under ${ADDON_LIMITS.hookMs} ms`);
      return result;
    } catch (error) {
      this.hookFailures.set(key, failures + 1);
      this.log(`Add-on ${addonId}: ${name} failed${failures + 1 >= 3 ? ' (switched off)' : ''}: ${error.message}`);
      return undefined;
    }
  }

  /** The active personality mode of a speaker: {id, name, ...} or null for a speaker without modes. */
  modeOf(profileKey) {
    const owner = this.speakers.get(profileKey);
    if (!owner) return null;
    const id = this.modes.get(profileKey) ?? owner.speaker.defaultMode;
    return id ? owner.speaker.modes[id] ?? null : null;
  }

  /** Switches a speaker's personality mode (from the turn's data or the game's state file). Unknown modes are ignored. */
  setMode(profileKey, id) {
    const owner = this.speakers.get(profileKey);
    if (owner && typeof id === 'string' && Object.hasOwn(owner.speaker.modes, id)) this.modes.set(profileKey, id);
  }

  /**
   * Roster rows for the persona book (one per speaker), built once. The persona fields are read when the persona book builds a
   * prompt, so they follow the active mode: within a mode the persona text is the same on every turn (the stable prompt prefix the
   * text providers cache), and a mode change starts a new prefix.
   */
  rosterRows() {
    if (this.rows) return this.rows;
    const host = this;
    this.rows = [...this.speakers.values()].map(({addon, speaker}) => {
      const base = speaker.persona, key = speaker.profileKey;
      const current = () => host.modeOf(key);
      const row = {key, name: speaker.name, kind: 'addon', addon: addon.id, speaker: speaker.id, voiceOnly: true};
      Object.defineProperties(row, {
        backstory: {enumerable: true, get: () => [base.backstory, current()?.backstory].filter(Boolean).join('\n\n')},
        speakingStyleDescription: {enumerable: true, get: () => current()?.style || base.style},
        speakingStyleSampleDialogues: {enumerable: true, get: () => (current()?.samples.length ? current().samples : base.samples).join('\n\n')},
        intro: {enumerable: true, get: () => current()?.intro || base.intro || undefined},
        identityRule: {enumerable: true, get: () => current()?.identityRule || base.identityRule || undefined},
        talkWords: {enumerable: true, get: () => current()?.talkWords || base.talkWords || undefined},
        rules: {enumerable: true, get: () => { const list = [...base.rules, ...(current()?.rules ?? [])]; return list.length ? list : undefined; }},
      });
      return row;
    });
    return this.rows;
  }

  /**
   * Adds the speakers to the bridge's roster array in place (existing rows win). Add-on speakers never have a Convai character:
   * an add-on key in the ID map (a hand-edited characters.json) is removed, so no Convai route, warm-up or memory ever opens for one.
   */
  extend(roster, ids) {
    if (!this.active) return;
    const known = new Set(roster.map(row => row?.key));
    for (const row of this.rosterRows()) if (!known.has(row.key)) roster.push(row);
    for (const key of Object.keys(ids)) if (isAddonProfile(key)) { delete ids[key]; this.log(`${key} is an add-on speaker: its Convai character ID is not used`); }
  }

  isSpeaker(profileKey) { return this.speakers.has(profileKey); }

  /**
   * Who a character of the main mod is, for a bridge module: {key, name, gender: 'female' | 'male' | null} for a profile key or a name
   * ("Panam Palmer"), or null when it is unknown. The bridge sets the lookup (setCharacterLookup); without one nothing is known.
   */
  characterInfo(value) {
    const wanted = typeof value === 'string' ? value.trim().slice(0, 80) : '';
    const found = wanted && typeof this.characterLookup === 'function' ? this.characterLookup(wanted) : null;
    if (!object(found)) return null;
    const gender = String(found.gender ?? '').toUpperCase();
    return {key: text(found.key, 80), name: text(found.name, 80), gender: gender === 'FEMALE' ? 'female' : gender === 'MALE' ? 'male' : null};
  }

  /** The display name of the add-on a speaker belongs to. */
  addonName(profileKey) { return this.speakers.get(profileKey)?.addon.name ?? 'This add-on'; }

  /** The one notice the game shows when no allowed provider is set up (Lua shows it once per session and add-on). */
  providerNotice(profileKey) {
    const owner = this.speakers.get(profileKey);
    const allowed = owner?.speaker.providers ?? ADDON_PROVIDERS;
    const need = allowed.length === 2 ? 'a free Mistral key or the Local AI pack' : allowed[0] === 'mistral' ? 'a free Mistral key' : 'the Local AI pack';
    return `${this.addonName(profileKey)} needs ${need}. Set it up under Conversation provider in AI NPC Cyberpunk Mod's settings.`;
  }

  /**
   * Seconds before a remark of this speaker may start on the local AI (0: now). Only while the player keeps the default
   * "Time between remarks"; the game waits that long (errorCode addon-pace, retryAfter). Mistral and a chosen gap are never held.
   */
  localPace(profileKey, route, now = this.now(), priority = 0) {
    const owner = this.speakers.get(profileKey);
    if (!owner || route !== 'local' || this.settings[owner.addon.id]?.remarkGapChosen === true) return 0;
    // The biggest moments (priority 5: a near death, the end of a fight) are rare and never lost to the pace.
    if (priority >= 5) return 0;
    const last = this.localRemarkAt.get(owner.addon.id);
    return last === undefined ? 0 : Math.max(0, Math.ceil((last + LOCAL_REMARK_GAP_S * 1000 - now) / 1000));
  }

  /** A remark of this speaker starts on `route`. Returns a token for remarkRefunded (null when the route is not paced). */
  remarkStarted(profileKey, route, now = this.now()) {
    const owner = this.speakers.get(profileKey);
    if (!owner || route !== 'local') return null;
    const token = {id: owner.addon.id, at: now, before: this.localRemarkAt.get(owner.addon.id)};
    this.localRemarkAt.set(owner.addon.id, now);
    return token;
  }

  /**
   * The remark that started with `token` never reached the player (the game withdrew it, or it was cancelled before its line was
   * published): it does not count towards the pace, so the next moment is not refused for a remark nobody heard. Only while no later
   * remark has started since.
   */
  remarkRefunded(token) {
    if (!token || this.localRemarkAt.get(token.id) !== token.at) return false;
    if (token.before === undefined) this.localRemarkAt.delete(token.id);
    else this.localRemarkAt.set(token.id, token.before);
    return true;
  }

  /** A turn of a speaker begins: the personality mode the game sent with it takes effect before the prompt is built. */
  beginTurn(input) {
    if (input?.addon?.mode) this.setMode(input.profileKey, input.addon.mode);
  }

  /**
   * The text provider of an add-on speaker's turn: the player's own provider when the speaker allows it, else Mistral when a key is
   * saved, else the local AI when its pack is installed and working; null when none can serve it (the game then tells the player once
   * that the add-on needs a free Mistral key or the Local AI pack).
   *   applied        the conversation provider in use ('convai', 'mistral', 'local')
   *   mistralKey     a Mistral key is saved and was not refused
   *   localReady     the Local AI pack is installed and has not failed to start
   */
  routeFor(profileKey, {applied, mistralKey = false, localReady = false} = {}) {
    const owner = this.speakers.get(profileKey);
    if (!owner) return null;
    const allowed = owner.speaker.providers;
    const usable = route => allowed.includes(route) && (route === 'mistral' ? mistralKey : localReady);
    if (usable(applied)) return applied;
    for (const route of ['mistral', 'local']) if (usable(route)) return route;
    return null;
  }

  // ---- Recent lines and memories ----------------------------------------------------------------------------------------

  #entry(profileKey) {
    const speakers = this.journal.speakers;
    speakers[profileKey] ??= {lines: [], memories: []};
    return speakers[profileKey];
  }

  /** Reads runtime/addon-journal.json (recent lines and memories, kept across game sessions). Never throws. */
  async loadJournal(stateDirectory, {read = path => readFile(path, 'utf8')} = {}) {
    if (!this.active || !stateDirectory) return;
    this.journalPath = resolve(stateDirectory, ADDON_JOURNAL_FILE);
    try {
      const value = JSON.parse(await read(this.journalPath));
      if (!object(value) || value.version !== 1 || !object(value.speakers)) return;
      for (const [key, entry] of Object.entries(value.speakers)) {
        if (!this.speakers.has(key) || !object(entry)) continue;
        const target = this.#entry(key);
        target.lines = (Array.isArray(entry.lines) ? entry.lines : []).filter(line => object(line) && typeof line.text === 'string')
          .slice(-ADDON_LIMITS.recentLines).map(line => ({text: text(line.text, 600), at: Number(line.at) || 0, ...(line.event ? {event: text(line.event, 48)} : {})}));
        target.memories = (Array.isArray(entry.memories) ? entry.memories : []).filter(item => object(item) && typeof item.text === 'string')
          .slice(-ADDON_LIMITS.memories).map(item => ({text: text(item.text, ADDON_LIMITS.memoryText), at: Number(item.at) || 0}));
      }
    } catch { /* none yet */ }
  }

  #saveJournal() {
    if (!this.journalPath || this.journalTimer) return;
    this.journalTimer = setTimeout(() => {
      this.journalTimer = null;
      void writeFile(this.journalPath, JSON.stringify(this.journal)).catch(error => this.log(`Add-on journal not saved: ${error.message}`));
    }, 2000);
    this.journalTimer.unref?.();
  }

  /** Is this add-on speaker a voice with no body whose turns get the voice form of the main mod's context (persona.voiceContext)? */
  usesVoiceContext(profileKey) { return this.speakers.get(profileKey)?.speaker.persona.voiceContext === true; }

  /** The speaker's recent lines, oldest first. */
  recentLines(profileKey) { return (this.journal.speakers[profileKey]?.lines ?? []).map(line => line.text); }

  /** The speaker's memories of earlier fights or rides, oldest first. */
  memories(profileKey) { return (this.journal.speakers[profileKey]?.memories ?? []).map(item => item.text); }

  /** Adds a memory ("the fight in the Kabuki market: four Tyger Claws, V never fired a lethal shot"). Repeats are ignored. */
  remember(profileKey, memory, at = this.now()) {
    const body = text(memory, ADDON_LIMITS.memoryText);
    if (!body || !this.speakers.has(profileKey)) return false;
    const entry = this.#entry(profileKey);
    if (entry.memories.some(item => item.text === body)) return false;
    entry.memories.push({text: body, at});
    entry.memories = entry.memories.slice(-ADDON_LIMITS.memories);
    this.#saveJournal();
    return true;
  }

  /**
   * Checks a finished line before it is spoken: {duplicate, similar}. A remark that nearly repeats one of the speaker's recent lines
   * is dropped by the bridge (nothing is said; the next event gets a fresh chance). A conversation reply is never dropped.
   */
  review(input, line) {
    const recent = this.recentLines(input?.profileKey).slice(-ADDON_LIMITS.recentChecked);
    const similar = recent.find(previous => isNearDuplicate(previous, line)) ?? this.#echoedSample(input?.profileKey, line);
    const rule = this.#brokenRule(input, line);
    return {duplicate: (!!similar || !!rule) && input?.reaction?.kind === 'addon', similar, ...(rule ? {rule} : {})};
  }

  // The add-on module's own check of a finished line (the optional `check` hook): a short reason when the line broke a rule of its speaker
  // (Delamain addressing a companion outside a group chat), else null. A remark that breaks one is written once more, like a repeat.
  #brokenRule(input, line) {
    const owner = this.speakers.get(input?.profileKey);
    if (!owner || typeof line !== 'string') return null;
    const data = input.addon && input.addon.id === owner.addon.id ? input.addon : null;
    const reason = this.#hook(owner.addon.id, 'check', {speaker: owner.speaker.id, profileKey: owner.speaker.profileKey, line, event: data?.event ?? null,
      facts: data?.facts ?? null, group: !!input.group, reaction: input.reaction?.kind === 'addon', state: this.state.addons[owner.addon.id]?.state ?? null,
      settings: {...(this.settings[owner.addon.id] ?? {})}});
    return typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 120) : null;
  }

  // The speaker's own example lines (the active mode's and the persona's) are used up: a remark that says one again is a repeat even
  // when the journal has never seen it. Only the spoken part of a sample counts ("Game event: ...\nSkippy: line" is the line).
  #echoedSample(profileKey, line) {
    const owner = this.speakers.get(profileKey);
    if (!owner) return null;
    const mode = this.modeOf(profileKey);
    for (const sample of [...(mode?.samples ?? []), ...owner.speaker.persona.samples]) {
      const spoken = sampleLine(sample, owner.speaker.name);
      if (spoken && isNearDuplicate(spoken, line)) return spoken;
    }
    return null;
  }

  /**
   * Writes a remark and checks it against the speaker's recent lines. A remark that nearly repeats one is written once more with
   * a hint that names the lines to avoid, instead of being dropped, unless the second try could not arrive before the remark goes
   * stale (reaction.expiresAt, epoch ms): the time the first try took, plus a margin, must still fit. Never more than two tries.
   *   generate   async (input) => reply {text, ...}: one try; `input.addon.avoid` lists the lines the try must not resemble
   *   first      a reply that already exists (a line written ahead of time); the first try is then not generated
   *   firstMs    how long that first try took (a guess when `first` is given and this is not)
   * Returns {reply, duplicate, similar, retried}: `duplicate` is true when the remark is to be dropped.
   */
  async produce(input, generate, {first = null, firstMs} = {}) {
    const started = this.now();
    let reply = first ?? await generate(input);
    const tookMs = Number.isFinite(firstMs) ? firstMs : first ? ADDON_LIMITS.retryGuessMs : this.now() - started;
    let check = this.review(input, reply.text);
    if (!check.duplicate) return {reply, duplicate: false, similar: null, retried: false};
    const limit = input.reaction?.expiresAt;
    const late = Number.isFinite(limit) && limit > 0 && this.now() + tookMs * ADDON_LIMITS.retryShare + ADDON_LIMITS.retryMs > limit;
    // A remark the add-on marked repeatOk (a welcome that replaces the game's own, say) is said even when it repeats: V missing the
    // line altogether is worse than hearing familiar words. A line that broke a rule of its speaker is never said.
    const keep = () => input.addon?.repeatOk === true && !check.rule;
    if (late) return {reply, duplicate: !keep(), kept: keep(), similar: check.similar, rule: check.rule ?? null, retried: false};
    const again = {...input, addon: {...input.addon, avoid: [...new Set([check.similar, reply.text].filter(Boolean))], ...(check.rule ? {rule: check.rule} : {})}};
    reply = await generate(again);
    check = this.review(input, reply.text);
    return {reply, duplicate: check.duplicate && !keep(), kept: check.duplicate && keep(), similar: check.similar, rule: check.rule ?? null, retried: true};
  }

  /** A line was spoken: keep it for the repetition check and the prompt, and let the add-on's module turn it into a memory. */
  afterReply(input, line) {
    const owner = this.speakers.get(input?.profileKey);
    const body = text(line, 600);
    if (!owner || !body) return;
    const entry = this.#entry(owner.speaker.profileKey);
    entry.lines.push({text: body, at: this.now(), ...(input.addon?.event ? {event: input.addon.event} : {})});
    entry.lines = entry.lines.slice(-ADDON_LIMITS.recentLines);
    const memory = this.#hook(owner.addon.id, 'remember', {speaker: owner.speaker.id, profileKey: owner.speaker.profileKey,
      event: input.addon?.event ?? null, facts: input.addon?.facts ?? null, mode: this.modeOf(owner.speaker.profileKey)?.id ?? null,
      line: body, heard: text(input.text, ADDON_LIMITS.heard), group: !!input.group, reaction: input.reaction?.kind === 'addon',
      settings: {...(this.settings[owner.addon.id] ?? {})}});
    if (typeof memory === 'string') this.remember(owner.speaker.profileKey, memory);
    this.#saveJournal();
  }

  /**
   * Voice configuration paths with the add-on voices merged in. Without add-on voices (and no player clips) `paths` comes back
   * unchanged (the same object) and nothing is read or written. With them, each reference is checked and copied under every reference
   * root as runtime/voice-references/addons/<profileKey>.wav, and each configuration file that lists voices is written again beside the
   * original as addons.<name> with the extra entries. A voice that fails a check is left out; the others still load.
   *   paths   {pocket, omni: {short, long}} (bridge/voice-config-paths.mjs)
   *   roots   reference roots besides the Pocket configuration's own referenceDirectory (the OmniVoice / cloud voice folder)
   *   extra   voices that belong to no add-on, merged the same way: [{key, reference (a .wav path), sha256?, transcript}]. The main
   *           mod's V voices (bridge/v-voice.mjs) arrive here; a key that already names a voice in a configuration is left alone.
   *           An item with `player: true` is a player's own clip for a character (a story character, or one the player made), which
   *           stays where it is, in the data folder: {key, reference: <playerVoiceDirectory>/<key>.wav, sha256?, transcript, player: true}.
   *           It is checked like the others (and must be named <key>.wav inside `playerVoiceDirectory`) but NEVER copied: its descriptor
   *           is {reference: 'runtime/player-voices/<key>.wav', sha256, transcript}, which every voice engine resolves only inside the
   *           player folder. It OVERRIDES a voice of that key in every merged configuration (Pocket, OmniVoice short and long), and the
   *           key leaves `preparation.startupProfiles`, so nothing is prepared before that character speaks. A configuration that gets
   *           one is told the folder (`runtime.playerVoiceDirectory` for Pocket, `playerVoiceDirectory` for OmniVoice). Nothing persists
   *           the override: the copies are written again at every start, so a start that passes no player clip (it was removed) leaves
   *           the shipped voice in place (and with nothing at all to merge the original files are used).
   *   playerVoiceDirectory   the absolute folder those clips are in (<state>/player-voices); without it player items are skipped
   */
  async voiceConfigPaths(paths, {stateDirectory, roots = [], extra = [], playerVoiceDirectory = null, files = {readFile, writeFile, mkdir, copyFile}} = {}) {
    const voiced = [...this.speakers.values()].filter(({speaker}) => speaker.voice);
    if ((!voiced.length && !extra.length) || !stateDirectory) return paths;
    const entries = new Map();
    const players = new Map();
    const playerFolder = typeof playerVoiceDirectory === 'string' && isAbsolute(playerVoiceDirectory) ? resolve(playerVoiceDirectory) : null;
    for (const voice of extra) {
      if (voice?.player === true) {
        const label = String(voice.key).replace(/[^a-z0-9-]/gi, '?').slice(0, 80);
        try {
          if (!voiceKeyValid(voice.key) || basename(String(voice.reference ?? '')) !== `${voice.key}.wav`) throw Error('the clip must be named <key>.wav');
          if (!playerFolder) throw Error('no player voice folder was given');
          if (relative(playerFolder, resolve(String(voice.reference))) !== `${voice.key}.wav`) throw Error('the clip is not in the player voice folder');
          // One bad descriptor makes a whole configuration throw, and this text came from the player: it is checked before it gets in.
          if (!voiceTranscriptValid(voice.transcript)) throw Error('its transcript cannot be used');
          const bytes = await files.readFile(voice.reference);
          const {sha256} = inspectReference(bytes);
          if (voice.sha256 && voice.sha256 !== sha256) throw Error('reference does not match its sha256');
          players.set(voice.key, {descriptor: {reference: `${PLAYER_REFERENCE_PREFIX}${voice.key}.wav`, sha256, transcript: voice.transcript}});
        } catch (error) { this.log(`Player voice ${label} not used: ${error.message}`); }
        continue;
      }
      try {
        const bytes = await files.readFile(voice.reference);
        const {sha256} = inspectReference(bytes);
        if (voice.sha256 && voice.sha256 !== sha256) throw Error('reference does not match its sha256');
        entries.set(voice.key, {source: voice.reference, sha256, transcript: voice.transcript,
          descriptor: {reference: `${REFERENCE_PREFIX}addons/${voice.key}.wav`, sha256, transcript: voice.transcript}});
      } catch (error) { this.log(`Voice ${voice.key} not used: ${error.message}`); }
    }
    for (const {speaker} of voiced) {
      try {
        const bytes = await files.readFile(speaker.voice.reference);
        const {sha256} = inspectReference(bytes);
        if (speaker.voice.sha256 && speaker.voice.sha256 !== sha256) throw Error('reference does not match voice.sha256');
        entries.set(speaker.profileKey, {source: speaker.voice.reference, sha256, transcript: speaker.voice.transcript,
          descriptor: {reference: `${REFERENCE_PREFIX}addons/${speaker.profileKey}.wav`, sha256, transcript: speaker.voice.transcript}});
        this.voiceStatus.set(speaker.profileKey, 'ready');
      } catch (error) {
        this.voiceStatus.set(speaker.profileKey, error.message);
        this.log(`Add-on voice ${speaker.profileKey} not used: ${error.message}`);
      }
    }
    if (!entries.size && !players.size) return paths;
    const copied = new Set();
    const install = async root => {
      // Only the copied voices go to a reference root. A player's clip never does (with only those, nothing is created there).
      if (!root || !entries.size) return;
      const folder = resolve(root, 'addons');
      if (copied.has(folder.toLowerCase())) return;
      copied.add(folder.toLowerCase());
      await files.mkdir(folder, {recursive: true});
      for (const [key, entry] of entries) {
        const target = resolve(folder, `${key}.wav`);
        let same = false;
        try { same = createHash('sha256').update(await files.readFile(target)).digest('hex') === entry.sha256; } catch {}
        if (!same) await files.copyFile(entry.source, target);
      }
    };
    for (const root of roots) {
      try { await install(root); } catch (error) { this.log(`Add-on voices could not be copied to ${root}: ${error.message}`); }
    }
    const merge = async path => {
      if (!path) return path;
      let config;
      try { config = JSON.parse(await files.readFile(path, 'utf8')); } catch { return path; }
      if (!object(config) || !object(config.voices)) return path;
      const pocket = config.engine === 'pocket-tts';
      if (pocket) {
        try { await install(config.runtime?.referenceDirectory); }
        catch (error) { this.log(`Add-on voices could not be copied for Pocket: ${error.message}`); return path; }
      }
      const voices = {...config.voices};
      for (const [key, entry] of entries) if (!Object.hasOwn(voices, key)) voices[key] = entry.descriptor;
      // A player's own clip replaces whatever voice the configuration names for that key (the shipped voice is back once the clip is gone).
      for (const [key, entry] of players) voices[key] = entry.descriptor;
      const next = {...config, voices};
      // An eager configuration prepares every voice at start; add-on voices are prepared on demand instead.
      if (object(config.preparation) && config.preparation.mode === 'eager') {
        next.preparation = {...config.preparation, mode: 'lazy', startupProfiles: (config.preparation.startupProfiles ?? []).slice(0, 3)};
      }
      if (players.size) {
        // Nothing is prepared before that character speaks: the player keys leave the start-up list (explicit from here, and lazy).
        const startup = startupWithout(next, pocket, players);
        if (startup) next.preparation = {...next.preparation, ...(pocket ? {} : {mode: 'lazy'}), startupProfiles: startup};
        if (pocket) next.runtime = {...config.runtime, playerVoiceDirectory: playerFolder};
        else next.playerVoiceDirectory = playerFolder;
      }
      if (config.version === 1 && config.engine !== 'pocket-tts') next.version = 2;
      const target = resolve(stateDirectory, `addons.${basename(path)}`);
      await files.writeFile(target, JSON.stringify(next, null, 2));
      return target;
    };
    try {
      const omni = {};
      const merged = new Map();
      const once = async path => { if (!merged.has(path)) merged.set(path, await merge(path)); return merged.get(path); };
      for (const [reference, path] of Object.entries(paths.omni ?? {})) omni[reference] = await once(path);
      return {...paths, pocket: await once(paths.pocket), omni};
    } catch (error) {
      this.log(`Add-on voices not merged: ${error.message}`);
      return paths;
    }
  }

  /** Reads the game's add-on state file. Called when it changes (and at start). */
  observeState(raw) {
    if (!this.active) return;
    this.state = parseAddonState(raw, {notBefore: this.startedAt - 5000});
    for (const addon of this.addons) {
      const entry = this.state.addons[addon.id];
      if (!entry) continue;
      for (const [speaker, id] of Object.entries(entry.modes)) this.setMode(speakerProfileKey(addon.id, speaker), id);
      for (const memory of entry.memories) this.remember(speakerProfileKey(addon.id, memory.speaker), memory.text, memory.at);
      if (entry.warm && entry.warm.at !== this.warmed.get(addon.id)) {
        this.warmed.set(addon.id, entry.warm.at);
        const key = speakerProfileKey(addon.id, entry.warm.speaker);
        if (this.speakers.has(key)) try { this.onWarm?.(key); } catch { /* a warm-up is best effort */ }
      }
    }
    this.#observeStock();
  }

  // The wanted lines of every speaker (an add-on or speaker that is not in the file wants none). The bridge hears about it only
  // when there is stock, or there just was: a game without stock never calls back.
  #observeStock() {
    if (!this.stock) return;
    let changed = false;
    for (const addon of this.addons) {
      const rows = this.state.addons[addon.id]?.stock ?? [];
      for (const speaker of addon.speakers) {
        const mine = rows.filter(row => row.speaker === speaker.id);
        if (this.stock.configure(speaker.profileKey, mine, {mode: this.modeOf(speaker.profileKey)?.id ?? null})) changed = true;
      }
    }
    if (changed || this.stock.size) try { this.onStock?.(); } catch { /* the pump is best effort */ }
  }

  /** Reads the add-on settings file the game writes on Apply, and tells each module its values. */
  observeSettings(raw) {
    if (!this.active) return;
    const next = parseAddonSettings(raw);
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings);
    this.settings = next;
    if (changed) for (const addon of this.addons) this.#hook(addon.id, 'onSettings', {...(next[addon.id] ?? {})});
  }

  /**
   * The add-on context blocks of a turn, in the bridge's {tier, text, key} form (bridge/convai-bridge.mjs conversationBlocks):
   * for an add-on speaker its own blocks; for any other character the companion context the add-ons set ("you are riding in a
   * cab"). Empty with no add-ons.
   */
  blocks(input) {
    if (!this.active || !input) return [];
    const owner = this.speakers.get(input.profileKey);
    if (owner) return this.#speakerBlocks(owner, input);
    const out = [];
    for (const addon of this.addons) {
      for (const block of this.state.addons[addon.id]?.companionContext ?? []) out.push({tier: 'world', key: `addon:${addon.id}:${block.key}`, text: block.text});
      const extra = this.#hook(addon.id, 'companionBlocks', {profileKey: input.profileKey, group: !!input.group,
        state: this.state.addons[addon.id]?.state ?? null, settings: {...(this.settings[addon.id] ?? {})}});
      out.push(...this.#blockList(addon.id, extra, 'world'));
    }
    return out;
  }

  #blockList(addonId, value, tier) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, ADDON_LIMITS.blocks).flatMap((block, index) => {
      const body = text(typeof block === 'string' ? block : block?.text, ADDON_LIMITS.blockText);
      return body ? [{tier: TIERS.has(block?.tier) ? block.tier : tier, key: `addon:${addonId}:${block?.key ?? index}`, text: body}] : [];
    });
  }

  #speakerBlocks({addon, speaker}, input) {
    const data = input.addon && input.addon.id === addon.id && input.addon.speaker === speaker.id ? input.addon : null;
    const out = [{tier: 'notes', key: `addon:${addon.id}:voice`, text: `You are ${speaker.name}, a voice with no body: you cannot move, gesture, look at anything or touch anything. You only speak.`}];
    for (const block of data?.blocks ?? []) out.push({tier: block.tier, key: `addon:${addon.id}:${block.key}`, text: block.text});
    const hooked = this.#hook(addon.id, 'speakerBlocks', {speaker: speaker.id, profileKey: speaker.profileKey, event: data?.event ?? null,
      text: data?.text ?? null, facts: data?.facts ?? null, reaction: input.reaction?.kind === 'addon', group: !!input.group, mode: this.modeOf(speaker.profileKey)?.id ?? null,
      heard: input.reaction?.kind === 'addon' ? null : text(input.text, ADDON_LIMITS.heard) || null,
      state: this.state.addons[addon.id]?.state ?? null, settings: {...(this.settings[addon.id] ?? {})}});
    const own = this.#blockList(addon.id, hooked, 'volatile');
    out.push(...own);
    // Without a hook of its own the facts are shown plainly, so an add-on can start with data only.
    if (!own.length && data?.facts && Object.keys(data.facts).length) {
      out.push({tier: 'volatile', key: `addon:${addon.id}:facts`, text: `What the game reports right now (facts for you, never read them out as a list): ${factLine(data.facts)}`});
    }
    // Callbacks: what the speaker remembers of earlier fights or rides (changes rarely, so it sits with the world blocks).
    const memories = this.memories(speaker.profileKey).slice(-ADDON_LIMITS.memoriesShown);
    if (memories.length) out.push({tier: 'world', key: `addon:${addon.id}:memories`,
      text: `Earlier moments you shared with V (true; now and then refer back to one in a few words when it fits, never list them):\n${memories.map(item => `- ${item}`).join('\n')}`});
    // Anti-repetition: the speaker's own recent lines, so it never says the same thing twice. When V is talking to the speaker the same lines
    // are what it said a moment ago, which V heard and may ask about: a question about one is answered, in new words (live 2026-10-16: "that
    // must be awful" after the district remark got the remark again, word for word).
    const recent = this.recentLines(speaker.profileKey).slice(-ADDON_LIMITS.recentShown);
    const talking = input.reaction?.kind !== 'addon';
    if (recent.length) out.push({tier: 'volatile', key: `addon:${addon.id}:recent`,
      text: talking
        ? `What you recently said to V aloud, oldest first (V heard it all). If V asks about one of these lines or reacts to it, answer V's actual question in new words. Never say a line again and never reuse its opening, its phrases or its numbers, whatever V says:\n${recent.map(item => `- ${item}`).join('\n')}`
        : `Your most recent lines (never repeat one, its joke or its wording; find a new angle):\n${recent.map(item => `- ${item}`).join('\n')}`});
    // A second try after a near repeat (produce): name what was too close, so the new line shares no phrasing with it.
    const avoid = Array.isArray(data?.avoid) ? data.avoid.filter(item => typeof item === 'string' && item.trim()).slice(0, 3) : [];
    if (avoid.length) out.push({tier: 'volatile', key: `addon:${addon.id}:avoid`,
      text: `Your first attempt ${typeof data?.rule === 'string' && data.rule ? `broke a rule (${data.rule.slice(0, 120)})` : 'repeated an earlier line'} and was thrown away. Write a completely different line now: another angle, another opening, other words. Do not reuse any phrasing from these:\n${avoid.map(item => `- ${item}`).join('\n')}`});
    return out;
  }

  /** The event text of an automatic add-on remark (the Convai trigger, or the [EVENT] line of a text provider). */
  trigger(input) {
    const data = input?.addon, owner = this.speakers.get(input?.profileKey);
    if (owner && data?.mode) this.setMode(owner.speaker.profileKey, data.mode);
    if (!owner || !data) return typeof input?.text === 'string' ? input.text : '';
    const words = data.maxWords ?? 14;
    const hooked = this.#hook(owner.addon.id, 'trigger', {speaker: owner.speaker.id, profileKey: owner.speaker.profileKey, event: data.event ?? null,
      text: data.text ?? null, facts: data.facts ?? null, maxWords: words, mode: this.modeOf(owner.speaker.profileKey)?.id ?? null, settings: {...(this.settings[owner.addon.id] ?? {})}});
    const own = text(hooked, 1200);
    if (own) return own;
    return `${data.text || `Game event: ${data.event ?? 'something happened'}.`} This event was not spoken by V. `
      + `React as ${owner.speaker.name} with one short spoken line of at most ${words} words. `
      + 'Use only these facts; do not invent numbers, names, injuries, kills or outcomes. '
      + 'Do not ask a question. Return only the spoken line, without narration or actions.';
  }

  /** Files the bridge should re-read when the game replaces them (bridge/file-wake.mjs). Empty with no add-ons. */
  watchHandlers(runtime, {read = path => readFile(path, 'utf8')} = {}) {
    if (!this.active) return {};
    // A file that cannot be read, reads empty or reads cut off keeps what was last seen: the game writes addon-state.json in place
    // (it is empty for a moment between the file being opened and its text arriving, and a document with stock lines is far bigger
    // than one buffer, so a read can land halfway), and an empty or torn document would drop every mode and prepared stock line.
    // The game never saves an empty document: even "nothing" is JSON.
    const reader = (name, apply) => () => read(resolve(runtime, name)).then(raw => {
      if (typeof raw !== 'string' || raw.trim() === '') return undefined;
      let value;
      try { value = JSON.parse(raw); } catch { return undefined; }
      return apply(value);
    }, () => undefined);
    return {[ADDON_STATE_FILE]: reader(ADDON_STATE_FILE, raw => this.observeState(raw)),
      [ADDON_SETTINGS_FILE]: reader(ADDON_SETTINGS_FILE, raw => this.observeSettings(raw))};
  }

  /** What the game shows the player about installed add-ons: one entry per add-on found, loaded or not. */
  status() {
    return {version: 1, api: ADDON_API_VERSION, updated: this.now(), addons: [
      ...this.addons.map(addon => ({id: addon.id, name: addon.name, version: addon.version, status: 'ready',
        ...(this.moduleErrors.has(addon.id) ? {moduleError: this.moduleErrors.get(addon.id)} : {}),
        speakers: addon.speakers.map(speaker => ({id: speaker.id, profileKey: speaker.profileKey, providers: speaker.providers,
          modes: Object.keys(speaker.modes), voice: speaker.voice ? (this.voiceStatus.get(speaker.profileKey) ?? 'pending') : 'none'}))})),
      ...this.problems.map(problem => ({...(problem.id ? {id: problem.id} : {}), ...(problem.name ? {name: problem.name} : {}),
        ...(problem.version ? {version: problem.version} : {}), ...(problem.requires ? {requires: problem.requires} : {}),
        folder: basename(problem.dir), status: problem.status, reason: problem.reason}))]};
  }

  /**
   * Writes runtime/addons-status.json for the game. With nothing found, empties a file an earlier run left (an uninstalled add-on);
   * a missing or already empty file is left alone, so a plain install changes nothing. The file is never removed or created here:
   * under Mod Organizer 2 only a file that already exists is written in place (the install ships it empty).
   */
  async publishStatus(runtime, {write = (path, data) => writeFile(path, data), read = path => readFile(path, 'utf8')} = {}) {
    const path = resolve(runtime, ADDON_STATUS_FILE);
    if (!this.addons.length && !this.problems.length) {
      if ((await read(path).catch(() => '')) !== '') await write(path, '').catch(() => {});
      return false;
    }
    await mkdir(dirname(path), {recursive: true}).catch(() => {});
    await write(path, JSON.stringify(this.status()));
    return true;
  }
}

function factLine(value) {
  const parts = [];
  const walk = (item, prefix) => {
    if (parts.length >= 32) return;
    if (item === null || typeof item !== 'object') { parts.push(`${prefix}: ${item}`); return; }
    if (Array.isArray(item)) { parts.push(`${prefix}: ${item.map(entry => typeof entry === 'object' ? JSON.stringify(entry) : String(entry)).join(', ')}`); return; }
    for (const [key, entry] of Object.entries(item)) walk(entry, prefix ? `${prefix}.${key}` : key);
  };
  walk(value, '');
  return parts.join('; ').slice(0, 1500);
}
