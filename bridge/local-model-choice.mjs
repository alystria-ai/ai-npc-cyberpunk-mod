// Which installed chat model Local AI loads (docs/LOCAL_AI.md, "Choosing the model").
//
// The installed models are the standard and lite models of the Local AI packs (bridge/local-ai-pack.mjs) and, when the optional Mature pack
// is installed, its uncensored models (bridge/mature-pack.mjs), and the models the player added by hand (bridge/custom-models.mjs, ids
// `custom:<name>`). The settings page lists them by file size, smallest first, and has no "Auto" entry. The setting `localModel` is the id
// of one model, or `auto` (no choice saved yet, or a value saved by an older version: it means "the default" below, and the settings page
// replaces it with the id the player applies):
//   default   the best installed model that fits the free graphics memory: the largest file that fits. With Mature content on and at least
//             one uncensored model installed, only the uncensored models are considered first (the largest that fits), and the others are
//             the fallback when none of them fits; otherwise an uncensored model is never picked. A custom model counts like any other
//             (its manifest `auto` flag is obsolete and ignored), except that it is never picked when it is too large for the graphics
//             card or failed to start before.
//   <id>      that model, whatever the setting for Mature content says. A model that is missing, that does not fit the free graphics
//             memory (a custom one: or the card), or that failed to start, is replaced by the default (the result says why, and which
//             model was used, so the bridge can say it once).
// Pure functions: no I/O, no timers. The caller supplies the file sizes and the free memory, and runs this only when a model is about to
// be loaded and when the settings poll sees the choice change (never per frame, never per turn).
import {basename} from 'node:path';
import {LocalAiUnavailable, tierNeedMiB} from './local-llm-server.mjs';

export const AUTO_MODEL = 'auto';
const UNCENSORED_NAME = /uncensored|abliterat|heretic|hauhau/i;   // the names mature-content.mjs allowanceFor() recognises
const BIG_MODEL_MIB = 3000;                                      // a mature model this big gets the standard tier's headroom, else the lite one's

/** A pin read from the settings file: an id made of letters, digits and `. _ : -` (at most 80), else `auto` (no choice: the default rule). */
export function normalisePin(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? (value === AUTO_MODEL ? AUTO_MODEL : value) : AUTO_MODEL;
}

const safeId = file => basename(String(file)).replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 60);
/** The part of a model id made from a file name (letters, digits, `. _ -`, at most 60). */
export const safeModelId = safeId;

/**
 * Every installed chat model, in a stable order: standard, lite, then the Mature pack's models in the marker's order, then the custom ones.
 * `pack` is the result of detectLocalAiPack; `matureModels` the `models` of detectMaturePack (an empty list or undefined when that pack is
 * not installed); `customModels` the `models` of CustomModelScanner.scan() (already checked: usable files only). A model whose file is
 * absent is left out. Returns [{id, name, file, tier, uncensored, loadedName}] and, for a custom model, also {custom: true, family,
 * contextSize, chatTemplate, tooLarge}:
 *   tier         'standard' | 'lite' for the Local AI packs' models, null for a Mature model (its headroom follows its size)
 *   loadedName   the name the loaded server reports (what the Mature allowance reads): an uncensored model's name always says so
 */
export function listLocalModels({pack, matureModels = [], customModels = []} = {}) {
  const models = [];
  for (const tier of ['standard', 'lite']) {
    const entry = pack?.tiers?.[tier];
    if (entry?.file) models.push({id: tier, name: entry.name, file: entry.file, tier, uncensored: false, loadedName: entry.name});
  }
  const taken = new Set(models.map(model => model.id));
  for (const entry of Array.isArray(matureModels) ? matureModels : []) {
    if (!entry?.file || entry.present === false) continue;
    let id = 'mature:' + safeId(entry.file), suffix = 2;
    while (taken.has(id)) id = 'mature:' + safeId(entry.file) + '-' + suffix++;
    taken.add(id);
    const name = entry.name || basename(entry.file).replace(/\.gguf$/i, '');
    models.push({id, name, file: entry.file, tier: null, uncensored: true, loadedName: UNCENSORED_NAME.test(name) ? name : name + ' (uncensored)'});
  }
  for (const entry of Array.isArray(customModels) ? customModels : []) {
    if (!entry?.file || typeof entry.id !== 'string' || taken.has(entry.id)) continue;
    taken.add(entry.id);
    models.push({id: entry.id, name: entry.name, file: entry.file, tier: null, uncensored: entry.uncensored === true, loadedName: entry.name, custom: true,
      family: entry.family ?? null, contextSize: entry.contextSize ?? null, chatTemplate: entry.chatTemplate ?? null,
      tooLarge: entry.tooLarge === true});
  }
  return models;
}

/** The headroom profile ('standard' or 'lite') of a model: its tier, or by size for a Mature model. */
export const profileOf = (model, sizeMiB) => model.tier ?? (sizeMiB >= BIG_MODEL_MIB ? 'standard' : 'lite');

/** Free graphics memory a model needs: its file plus the profile's headroom (the fixed fallback when the size is unknown). */
export const modelNeedMiB = (model, sizeMiB) => tierNeedMiB(profileOf(model, sizeMiB), sizeMiB);

const known = value => Number.isFinite(value);
const byName = (a, b) => { const x = String(a.name).toLowerCase(), y = String(b.name).toLowerCase(); return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0; };

/** The models in the order of the settings page: file size, smallest first; an equal size by name. A new array. */
export const sortLocalModels = (models, sizeOf = () => 0) => models.map(model => ({model, size: Number(sizeOf(model.file)) || 0}))
  .sort((a, b) => a.size - b.size || byName(a.model, b.model)).map(entry => entry.model);

/** Sizes, memory fit and the two ways of picking, shared by the choice and by the defaults the settings page shows. */
function prepare({models, freeMiB, totalMiB, sizeOf}) {
  const sized = models.map(model => { const sizeMiB = Number(sizeOf(model.file)) || 0; return {model, sizeMiB, profile: profileOf(model, sizeMiB)}; });
  const tooLarge = item => item.model.custom === true && (item.model.tooLarge === true || (known(totalMiB) && totalMiB > 0 && modelNeedMiB(item.model, item.sizeMiB) > totalMiB));
  const fits = item => !tooLarge(item) && (!known(freeMiB) || freeMiB >= modelNeedMiB(item.model, item.sizeMiB));
  // Largest file first; an equal size keeps the order of the list (standard before lite before the Mature models).
  const bySize = list => list.map((item, index) => ({item, index})).sort((a, b) => b.item.sizeMiB - a.item.sizeMiB || a.index - b.index).map(entry => entry.item);
  const pick = list => {
    if (!list.length) return null;
    if (!known(freeMiB)) return bySize(list).at(-1);   // free memory unknown: the smallest, like the old rule that took the lite model
    return bySize(list).find(fits) ?? null;
  };
  const candidates = sized.filter(item => item.model.broken !== true && !tooLarge(item));
  return {sized, fits, pick, uncensored: candidates.filter(item => item.model.uncensored), ordinary: candidates.filter(item => !item.model.uncensored)};
}

/**
 * Chooses the model to load.
 *   models     listLocalModels(...)
 *   pin        the saved choice: a model id, or 'auto' (none: the default rule, normalisePin)
 *   matureOn   the Mature content setting is on
 *   freeMiB    free graphics memory, or null/NaN when unknown (the smallest model of the candidates is taken then)
 *   sizeOf     file => size in MiB (0 when unknown)
 *   totalMiB   the graphics card's total memory when known: a custom model that needs more is never chosen (by the default or a pin)
 * Returns {model, profile, sizeMiB, pinned, fellBack}: `fellBack` is null, or 'missing' / 'low-memory' / 'start-failed' when the pin could
 * not be used and the default rule chose instead (`model.broken`, set by the server, marks a custom model that failed to start). Throws
 * LocalAiUnavailable('not-installed') with no model, ('low-memory') when nothing fits.
 */
export function chooseLocalModel({models = [], pin = AUTO_MODEL, matureOn = false, freeMiB = null, totalMiB = null, sizeOf = () => 0} = {}) {
  if (!models.length) throw new LocalAiUnavailable('not-installed', 'no model');
  const {sized, fits, pick, uncensored, ordinary} = prepare({models, freeMiB, totalMiB, sizeOf});
  let fellBack = null;
  if (pin !== AUTO_MODEL) {
    const item = sized.find(candidate => candidate.model.id === pin);
    if (!item) fellBack = 'missing';
    else if (item.model.broken === true) fellBack = 'start-failed';
    else if (!fits(item)) fellBack = 'low-memory';
    else return {...item, pinned: true, fellBack: null};
  }
  let chosen = matureOn && uncensored.length ? pick(uncensored) : null;
  chosen ??= pick(ordinary);
  if (!chosen) throw new LocalAiUnavailable('low-memory');
  return {...chosen, pinned: false, fellBack};
}

/**
 * The models the settings page shows as selected, as ids (null when there is none):
 *   default   the model the default rule would load now (what a setting of `auto`, or of a model that is gone, gets)
 *   mature    the largest uncensored model that fits, which turning Mature content on selects; null when no uncensored model is installed
 *             or none fits
 * Same inputs as chooseLocalModel (without a pin). Never throws.
 */
export function defaultModelIds({models = [], matureOn = false, freeMiB = null, totalMiB = null, sizeOf = () => 0} = {}) {
  if (!models.length) return {default: null, mature: null};
  const {pick, uncensored, ordinary} = prepare({models, freeMiB, totalMiB, sizeOf});
  const mature = uncensored.length ? pick(uncensored) : null;
  const chosen = (matureOn ? mature : null) ?? pick(ordinary) ?? mature;
  return {default: chosen?.model.id ?? null, mature: mature?.model.id ?? null};
}

/**
 * Does the model already loaded satisfy a changed choice, so no reload is needed? A pinned model that is installed is satisfied by that
 * model alone; otherwise (`auto`, or a model that is gone) by any model of the group the default rule chooses from (the uncensored ones
 * with Mature content on and one installed, else the others).
 */
export function stillSatisfies({loadedId, models = [], pin = AUTO_MODEL, matureOn = false} = {}) {
  if (!loadedId) return false;
  if (pin !== AUTO_MODEL && models.some(model => model.id === pin)) return loadedId === pin;
  const wantUncensored = matureOn && models.some(model => model.uncensored);
  return models.some(model => model.id === loadedId && model.uncensored === wantUncensored);
}

/**
 * The list the settings page shows, for the bridge to publish: [{id, name, sizeMiB}] by file size, smallest first (sortLocalModels; names
 * are cut to 80 characters). A custom model also has {custom: true, needMiB} (file plus headroom: the graphics memory it needs) and, when
 * the card is too small for it, {tooLarge: true}.
 */
export const describeLocalModels = (models, sizeOf = () => 0) => sortLocalModels(models, sizeOf).slice(0, 24).map(model => {
  const sizeMiB = Math.round(Number(sizeOf(model.file)) || 0);
  const entry = {id: model.id, name: String(model.name).slice(0, 80), sizeMiB};
  if (model.custom) {
    entry.custom = true;
    entry.needMiB = sizeMiB > 0 ? modelNeedMiB(model, sizeMiB) : 0;
    if (model.tooLarge) entry.tooLarge = true;
  }
  return entry;
});
