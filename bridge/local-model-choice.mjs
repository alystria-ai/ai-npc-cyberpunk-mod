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
//   <id>      that model, whatever the setting for Mature content says, except that with Mature content off a Mature pack model (`mature:*`) is
//             never loaded: the pin stays in the settings, is ignored (no notice) and the default rule runs, so with a standard or lite model
//             installed they load. A model that is missing, that does not fit the free graphics
//             memory (a custom one: or the card), or that failed to start, is replaced by the default (the result says why, and which
//             model was used, so the bridge can say it once). Two things are silent: a saved id that names a model no longer in any
//             pack (a Mature model of an older pack, a removed standard model; never a `custom:` one, which is the player's own file)
//             is mapped at once, `mature:*` to `mature:good` if it fits, else `mature:lite`, any other to the default rule; and with
//             Mature content on and a Mature model installed the fallbacks never leave the Mature pack (good, then lite): when even
//             the lite one does not fit the free graphics memory it is loaded anyway, with part of its layers on the CPU (`offload`).
// With no Mature model, when nothing at all fits whole (and no server of the player's is installed), the smallest installed model of any kind (standard, lite, a custom file) is
// loaded the same way (`offload`) instead of the start failing. The caller (bridge/local-llm-server.mjs) refuses it when too little of it could stay on the card (FIT_LIMITS.hopelessShare).
// A Mature-only install (the Mature packs carry their own engine, so a player may have no Local AI pack): when every installed model is a Mature
// pack model and Mature content is off, nothing is chosen and nothing is offered as the default: Local AI is unavailable ('mature-off') until
// Mature content is turned on, or a Local AI pack or a custom model is added. With a standard, lite or custom model installed Local AI always runs: with
// Mature content off the Mature pack models are skipped, pinned or not.
// A server the player runs (an `endpoint` entry of bridge/custom-models.mjs: KoboldCpp, LM Studio, Ollama, ...) is a custom model with no file:
// `external: true`. It uses no graphics memory of ours, so it always "fits" and is never "too large", and it has no size (0). It joins the
// default choice only as the last resort of its group: the default is an installed file model when there is one (an uncensored one first with
// Mature content on), and a server only when the group has none, or when it is chosen (pinned). A pinned server that is unreachable counts as
// broken (it failed to start) and falls back like a model that did not start.
// A model that stalled the turns of this session (the game took the graphics memory and the driver moved the model into shared system memory, so the prompt
// is read at a crawl) is marked `stalled` by the server (bridge/local-llm-server.mjs, stepDown) and is left out like a broken one: the choice then steps down to the
// next smaller installed model of the same family (Mature good -> Mature lite, standard -> lite; stepDownTarget), never across the Mature line, and with none left
// the same model is loaded again with part of its layers on the CPU, or Local AI is marked unavailable (it never hands the turns to a cloud provider). The saved choice (`pin`) is never changed: the mark lives in memory for the session.
// On a card of about 8 GB or less the default rule (no pin) also keeps room for the game: a model must fit the card's total memory minus
// SMALL_CARD_GAME_RESERVE_MIB, else the next smaller one that does is taken (the largest that merely fits when none does). A pinned model is the player's word.
// Pure functions: no I/O, no timers. The caller supplies the file sizes and the free memory, and runs this only when a model is about to
// be loaded and when the settings poll sees the choice change (never per frame, never per turn).
import {basename} from 'node:path';
import {LocalAiUnavailable, tierNeedMiB} from './local-llm-server.mjs';
import {FIT_LIMITS} from './local-vram-fit.mjs';
import {MATURE_TIERS} from './mature-pack.mjs';
import {defaultProjectorFinder, noProjector} from './local-projector.mjs';

export const AUTO_MODEL = 'auto';
/** A card of this size or less (MiB; the 8 GB class reports 8,000 to 8,200) leaves the game little room beside a chat model: the default rule keeps SMALL_CARD_GAME_RESERVE_MIB of it for the game. */
export const SMALL_CARD_MAX_MIB = 8704;
export const SMALL_CARD_GAME_RESERVE_MIB = 3000;
const UNCENSORED_NAME = /uncensored|abliterat|heretic|hauhau/i;   // the names mature-content.mjs allowanceFor() recognises
const BIG_MODEL_MIB = 3000;                                      // a mature model this big gets the standard tier's headroom, else the lite one's

/** True when every installed model is a Mature pack model (a Mature-only install) and Mature content is off: no model may run then. */
export const matureOffBlocks = (models, matureOn) => !matureOn && models.length > 0 && models.every(model => model.matureTier);

/** True when Mature content is off, the pin names a Mature pack model (`mature:*`) and one is installed: the pin is not used (the default rule runs, with no notice). */
const matureOffIgnores = (pin, models) => typeof pin === 'string' && pin.startsWith('mature:') && models.some(model => model.matureTier);

/**
 * A saved choice of a server the player runs (`custom:ep-<host>-<port>[-<model>]`, bridge/custom-models.mjs) whose id is no longer listed: the id is made of the address and the
 * entry's model id, so an entry that gained or lost its "model", or was written again, names it differently. The listed server with the same address (the pin is the other id's start,
 * or the other way round) stands for it; failing that, the only server listed does. Else the pin is returned as it was. Pure.
 */
export function resolveServerPin(pin, models = []) {
  if (typeof pin !== 'string' || !pin.startsWith('custom:ep-') || models.some(model => model.id === pin)) return pin;
  const servers = models.filter(model => model.external === true && typeof model.id === 'string');
  const same = servers.filter(model => model.id.startsWith(pin + '-') || pin.startsWith(model.id + '-'));
  if (same.length === 1) return same[0].id;
  return servers.length === 1 ? servers[0].id : pin;
}

/** A pin read from the settings file: an id made of letters, digits and `. _ : -` (at most 80), else `auto` (no choice: the default rule). */
export function normalisePin(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? (value === AUTO_MODEL ? AUTO_MODEL : value) : AUTO_MODEL;
}

const safeId = file => basename(String(file)).replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 60);
/** The part of a model id made from a file name (letters, digits, `. _ -`, at most 60). */
export const safeModelId = safeId;

// A pack manifest NAMES the projector its model sees with (a separate vision file, in the `vision` folder of the pack's folder on Hugging Face). The name stays on the model even when the file
// is not installed, so the bridge can tell "this model has no projector" from "its vision file is missing" and say where to get it (`visionFolder`: local-ai or mature).
const namedProjector = (entry, visionFolder) => (typeof entry?.mmproj === 'string' && entry.mmproj ? {mmprojNamed: entry.mmproj, visionFolder} : {});

/**
 * Every installed chat model, in a stable order: standard, lite, then the Mature pack's models in the marker's order, then the custom ones.
 * `pack` is the result of detectLocalAiPack; `matureModels` the `models` of detectMaturePack (an empty list or undefined when that pack is
 * not installed); `customModels` the `models` of CustomModelScanner.scan() (already checked: usable files only, and servers). A model whose file is
 * absent is left out. Returns [{id, name, file, tier, uncensored, loadedName}] and, for a custom model, also {custom: true, family,
 * contextSize, chatTemplate, tooLarge}:
 *   tier         'standard' | 'lite' for the Local AI packs' models, null for a Mature model (its headroom follows its size)
 *   loadedName   the name the loaded server reports (what the Mature allowance reads): an uncensored model's name always says so
 * Every file model also carries `mmproj`: the absolute path of its vision projector, or null (bridge/local-projector.mjs: the one its manifest entry names, else the one beside it. A Mature
 * model has one only when its marker names it; a model whose manifest names a projector also carries `mmprojNamed` (that path, installed or not) and `visionFolder`). `findProjector(file, declared, {auto})` is that lookup (the default remembers its answers for a few seconds), `noProjector` skips the disk.
 */
export function listLocalModels({pack, matureModels = [], customModels = [], findProjector = defaultProjectorFinder} = {}) {
  const models = [];
  for (const tier of ['standard', 'lite']) {
    const entry = pack?.tiers?.[tier];
    if (entry?.file) models.push({id: tier, name: entry.name, file: entry.file, tier, uncensored: false, loadedName: entry.name, mmproj: findProjector(entry.file, entry.mmproj ?? null), ...namedProjector(entry, 'local-ai')});
  }
  const taken = new Set(models.map(model => model.id));
  // The Mature pack has exactly two models, `lite` and `good` (bridge/mature-pack.mjs); their ids are stable (`mature:lite`, `mature:good`), so a
  // saved choice survives a new file name. An entry with another tier, or a second one of the same tier, is ignored.
  for (const matureTier of MATURE_TIERS) {
    const entry = (Array.isArray(matureModels) ? matureModels : []).find(item => item?.tier === matureTier);
    if (!entry?.file || entry.present === false) continue;
    const id = 'mature:' + matureTier;
    if (taken.has(id)) continue;
    taken.add(id);
    const name = entry.name || basename(entry.file).replace(/\.gguf$/i, '');
    models.push({id, name, file: entry.file, tier: null, matureTier, uncensored: true, loadedName: UNCENSORED_NAME.test(name) ? name : name + ' (uncensored)',
      mmproj: findProjector(entry.file, entry.mmproj ?? null, {auto: false}), ...namedProjector(entry, 'mature')});
  }
  for (const entry of Array.isArray(customModels) ? customModels : []) {
    if (!(entry?.file || (entry?.external === true && entry.endpoint)) || typeof entry.id !== 'string' || taken.has(entry.id)) continue;
    taken.add(entry.id);
    const model = {id: entry.id, name: entry.name, file: entry.file ?? null, tier: null, uncensored: entry.uncensored === true, loadedName: entry.name, custom: true,
      family: entry.family ?? null, contextSize: entry.contextSize ?? null, chatTemplate: entry.chatTemplate ?? null,
      tooLarge: entry.tooLarge === true, mmproj: entry.file ? findProjector(entry.file, entry.mmproj ?? null) : null};
    // A server the player runs: where it is, which model to ask for and its key (the supervisor reads these; nothing publishes them). It never gets a projector from us.
    if (entry.external === true) Object.assign(model, {file: null, external: true, tooLarge: false, endpoint: entry.endpoint, origin: entry.origin, remote: entry.remote === true,
      requestModel: entry.model ?? null, apiKey: entry.apiKey ?? null, mmproj: null});
    models.push(model);
  }
  return models;
}

/** The models that are servers the player runs. */
export const externalModels = models => (Array.isArray(models) ? models : []).filter(model => model?.external === true);

/**
 * The models Local AI may start now. With an installed pack (a Local AI pack with a chat model, or a Mature pack alone) every listed model. Without one, only what needs no pack: a server the
 * player runs, and a GGUF file of the player's own (`custom:<name>`) when the Runtime's engine (`pack.server`, app/llama-cpp) is there to run it. 2026-10-29: a player with no pack and a model
 * of their own got 'not-installed' (error report: localModel custom:gemma-4-12b-it-qat-ud-q4_k_xl, localAi not-installed) because `installed` means "an engine AND a pack chat model".
 */
export function usableModels(models, pack) {
  const list = Array.isArray(models) ? models : [];
  if (pack?.installed) return list;
  return list.filter(model => model?.external === true || (model?.custom === true && Boolean(model.file) && Boolean(pack?.server)));
}

/** The player's own GGUF files in a list of models (not servers): the models that need the Runtime's engine and no pack. */
export const ownFileModels = models => (Array.isArray(models) ? models : []).filter(model => model?.custom === true && model.external !== true && Boolean(model.file));

/**
 * Can Local AI answer at all? An installed pack, a server the player runs, or a file of the player's own with the Runtime's engine to run it. `customModels` are the `models` of the custom
 * scan (bridge/custom-models.mjs). One answer for every gate: the settings status, the setup check, the start, the retry after an install.
 */
export const localAiAvailable = ({pack, customModels = []} = {}) => Boolean(pack?.installed) || usableModels(listLocalModels({pack, customModels, findProjector: noProjector}), pack).length > 0;

/** True when the player has a model file of their own but the Runtime has no engine to run it (no `pack.server`): the log and the failure detail say the engine is missing. */
export const engineMissingForOwnModel = ({pack, customModels = []} = {}) => !pack?.installed && !pack?.server && ownFileModels(listLocalModels({pack, customModels, findProjector: noProjector})).length > 0;

/** The headroom profile ('standard' or 'lite') of a model: its tier; a Mature model's `good` is standard and its `lite` is lite; a custom model by size. */
export const profileOf = (model, sizeMiB) => model.tier ?? (model.matureTier === 'good' ? 'standard' : model.matureTier === 'lite' ? 'lite' : sizeMiB >= BIG_MODEL_MIB ? 'standard' : 'lite');

/** Free graphics memory a model needs: its file plus the profile's headroom (the fixed fallback when the size is unknown). */
export const modelNeedMiB = (model, sizeMiB) => tierNeedMiB(profileOf(model, sizeMiB), sizeMiB);

const known = value => Number.isFinite(value);
const byName = (a, b) => { const x = String(a.name).toLowerCase(), y = String(b.name).toLowerCase(); return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0; };

/** The models in the order of the settings page: file size, smallest first; an equal size by name. A new array. */
export const sortLocalModels = (models, sizeOf = () => 0) => models.map(model => ({model, size: model.external ? 0 : Number(sizeOf(model.file)) || 0}))
  .sort((a, b) => a.size - b.size || byName(a.model, b.model)).map(entry => entry.model);

/**
 * The next smaller installed model of the same family to step down to from `from` (a model of listLocalModels): a Local AI pack model steps from
 * standard to lite, a Mature pack model (or any uncensored one) from good to lite, and the family never changes (an uncensored model never gives way to a
 * censored one). It is the largest model of the family that is smaller than `from` and neither stalled nor broken. A model the player added, and a server the
 * player runs, never step down (their choice is theirs). Null when there is none: the cloud text provider is the next step.
 */
export function stepDownTarget({models = [], from, sizeOf = () => 0} = {}) {
  if (!from || from.custom === true || from.external === true) return null;
  const size = model => Number(sizeOf(model.file)) || 0;
  const fromSize = size(from);
  const smaller = models.filter(model => model.id !== from.id && model.custom !== true && model.external !== true && model.stalled !== true && model.broken !== true
    && (model.uncensored === true) === (from.uncensored === true) && size(model) < fromSize);
  return smaller.sort((a, b) => size(b) - size(a))[0] ?? null;
}

/** Sizes, memory fit and the two ways of picking, shared by the choice and by the defaults the settings page shows. */
function prepare({models, freeMiB, totalMiB, sizeOf, realFit = {}}) {
  const sized = models.map(model => { const sizeMiB = model.external ? 0 : Number(sizeOf(model.file)) || 0; return {model, sizeMiB, profile: profileOf(model, sizeMiB)}; });
  // A server the player runs takes none of our graphics memory: it is never too large and always fits.
  const tooLarge = item => item.model.external !== true && item.model.custom === true
    && (item.model.tooLarge === true || (known(totalMiB) && totalMiB > 0 && modelNeedMiB(item.model, item.sizeMiB) > totalMiB));
  // `realFit[id].pick` (bridge/local-vram-fit.mjs) says the model goes whole onto the card in the free memory though the file-size rule says it does not: it fits.
  // For a model the player added (a file of unknown architecture: the rule's 1,200 MiB of headroom is a guess for it, too little for a 12B with a large cache) a projection that was looked at
  // decides in both directions: the rule passing does not make it fit when no rung of the ladder does (2026-10-29).
  const projected = fit => Array.isArray(fit?.projections) && fit.projections.some(rung => Number.isFinite(rung?.projectedMiB));
  const ownFile = item => item.model.custom === true && item.model.external !== true;
  const fits = item => item.model.external === true || (!tooLarge(item) && (!known(freeMiB)
    || (ownFile(item) && projected(realFit[item.model.id]) ? Boolean(realFit[item.model.id].pick) : freeMiB >= modelNeedMiB(item.model, item.sizeMiB) || Boolean(realFit[item.model.id]?.pick))));
  // The graphics memory a model needs, in MiB, for the player: the smallest placement the projection knows (its smallest rung plus the margin the fit keeps) when it was looked at, else the file-size rule.
  const needOf = item => {
    const fit = realFit[item.model.id], rule = modelNeedMiB(item.model, item.sizeMiB);
    const rungs = Array.isArray(fit?.projections) ? fit.projections.map(rung => rung?.projectedMiB).filter(Number.isFinite) : [];
    if (!rungs.length) return rule;
    const real = Math.min(...rungs) + (Number.isFinite(fit.marginMiB) ? fit.marginMiB : FIT_LIMITS.marginMiB);
    return ownFile(item) ? real : Math.min(rule, real);
  };
  // The default rule on a small card keeps room for the game (SMALL_CARD_GAME_RESERVE_MIB); `reserved.applied` says that it changed the pick.
  const smallCard = known(totalMiB) && totalMiB > 0 && totalMiB <= SMALL_CARD_MAX_MIB;
  const roomForGame = item => item.model.external === true || !smallCard || modelNeedMiB(item.model, item.sizeMiB) <= totalMiB - SMALL_CARD_GAME_RESERVE_MIB;
  const reserved = {applied: false};
  // Largest file first; an equal size keeps the order of the list (standard before lite before the Mature models).
  const bySize = list => list.map((item, index) => ({item, index})).sort((a, b) => b.item.sizeMiB - a.item.sizeMiB || a.index - b.index).map(entry => entry.item);
  const pick = list => {
    if (!list.length) return null;
    if (!known(freeMiB)) return bySize(list).at(-1);   // free memory unknown: the smallest, like the old rule that took the lite model
    const ordered = bySize(list), roomy = ordered.find(item => fits(item) && roomForGame(item)), plain = ordered.find(fits) ?? null;
    if (roomy && roomy !== plain) reserved.applied = true;
    return roomy ?? plain;
  };
  // The Mature pack never gives way to a censored model: the largest uncensored model that fits, else the smallest model of the Mature pack
  // anyway (the caller offloads layers). A custom uncensored model is never forced: with none of them fitting and no pack model, null.
  const pickMature = list => pick(list) ?? bySize(list.filter(item => item.model.matureTier)).at(-1) ?? null;
  const candidates = sized.filter(item => item.model.broken !== true && item.model.stalled !== true && !tooLarge(item));
  // A group's candidates are its file models; the servers the player runs only when the group has no file model (the last resort).
  const group = wanted => { const own = candidates.filter(item => item.model.external !== true && wanted(item)); return own.length ? own : candidates.filter(item => item.model.external === true && wanted(item)); };
  // The last resort when no file model fits: a server the player runs (an uncensored one only with Mature content on, like any uncensored model).
  const externals = candidates.filter(item => item.model.external === true);
  // Nothing fits whole and no server of the player's is there: the smallest installed file model of any kind (standard, lite, Mature, a custom file), to be loaded with part of its layers on the CPU.
  // A model too large for the card (`tooLarge`) is still in it: the caller's gate (bridge/local-vram-fit.mjs offloadPlan) says whether enough of it can stay on the card. An uncensored model only
  // with Mature content on (`allowUncensored`), like everywhere else.
  const offloadable = allowUncensored => bySize(sized.filter(item => item.model.external !== true && item.model.broken !== true && item.model.stalled !== true
    && (allowUncensored || !item.model.uncensored))).at(-1) ?? null;
  return {sized, fits, needOf, pick, pickMature, externals, offloadable, reserved, uncensored: group(item => item.model.uncensored), ordinary: group(item => !item.model.uncensored)};
}

/**
 * Chooses the model to load.
 *   models     listLocalModels(...)
 *   pin        the saved choice: a model id, or 'auto' (none: the default rule, normalisePin)
 *   matureOn   the Mature content setting is on
 *   freeMiB    free graphics memory, or null/NaN when unknown (the smallest model of the candidates is taken then)
 *   sizeOf     file => size in MiB (0 when unknown)
 *   totalMiB   the graphics card's total memory when known: a custom model that needs more is never chosen (by the default or a pin)
 *   realFit    {modelId: {pick}} from bridge/local-vram-fit.mjs for the models whose file-size need exceeds the free memory but whose projected memory (the real
 *              figure: a Gemma 4 E4B keeps about 1.7 GB of its file in system memory) fits whole: such a model counts as fitting, so a chosen one is kept and
 *              a Mature one is loaded whole instead of with layers on the CPU. The caller probes only the chosen model and the uncensored ones.
 * Returns {model, profile, sizeMiB, pinned, fellBack, offload}, and {needMiB, availableMiB} when `fellBack` is 'low-memory' (what the chosen model needs, the projection's smallest placement
 * when one was looked at, else the file-size rule; and the memory given to the choice): `offload` is true when the model is loaded though it does not fit the free graphics memory (some of its layers
 * then run on the CPU): a Mature model (it never gives way to a censored one), or, when nothing at all fits whole, the smallest installed model of any kind; `fellBack` is null, or 'missing' / 'low-memory' / 'start-failed' / 'too-slow' when the pin could
 * not be used and another model was chosen instead (`model.broken`, set by the server, marks a custom model that failed to start; `model.stalled` a model that
 * stalled this session's turns); `gameReserve` is true when the room kept for the game on a small card changed the default pick. Throws
 * LocalAiUnavailable('not-installed') with no model, ('mature-off') when only Mature pack models are installed and Mature content is off,
 * ('low-memory') when no model is left to try (every one is broken or stepped down).
 */
export function chooseLocalModel({models = [], pin = AUTO_MODEL, matureOn = false, freeMiB = null, totalMiB = null, sizeOf = () => 0, realFit = {}} = {}) {
  if (!models.length) throw new LocalAiUnavailable('not-installed', 'no model');
  if (matureOffBlocks(models, matureOn)) throw new LocalAiUnavailable('mature-off', 'only Mature models are installed and Mature content is off');
  // Mature content off: a Mature pack model never loads, pinned or not (a pin of it stays in the settings, and is used again when Mature content is on).
  if (!matureOn) { if (matureOffIgnores(pin, models)) pin = AUTO_MODEL; models = models.filter(model => !model.matureTier); }
  pin = resolveServerPin(pin, models);
  const {sized, fits, needOf, pick, pickMature, externals, offloadable, reserved, uncensored, ordinary} = prepare({models, freeMiB, totalMiB, sizeOf, realFit});
  let fellBack = null, silent = false, want = pin, lowMemory = null;
  if (want !== AUTO_MODEL) {
    let item = sized.find(candidate => candidate.model.id === want);
    if (!item && !want.startsWith('custom:')) {
      // A saved id of a model that is gone for good (an older pack): no notice, the replacement is found here. A Mature id with no
      // Mature model installed at all is the plain "chosen model is missing" case: it keeps its notice.
      if (want.startsWith('mature:')) {
        item = migratedPinItem(sized, fits);
        silent = item !== null;
        if (item) want = item.model.id;
      } else { silent = true; want = AUTO_MODEL; }
    }
    if (want !== AUTO_MODEL) {
      if (!item) fellBack = 'missing';
      else if (item.model.broken === true) fellBack = 'start-failed';
      else if (item.model.stalled === true) {
        // It stalled the turns of this session: the next smaller model of its family (a Mature one stays in the Mature pack, loaded with layers on the CPU
        // when it does not fit; another one only when it fits), else the default rule below.
        const next = stepDownTarget({models, from: item.model, sizeOf});
        const target = next ? sized.find(candidate => candidate.model.id === next.id) : null;
        if (target && (target.model.uncensored || fits(target))) return {...target, pinned: false, fellBack: 'too-slow', offload: target.model.uncensored === true && !fits(target)};
        fellBack = 'too-slow';
      } else if (!fits(item)) { fellBack = 'low-memory'; lowMemory = {needMiB: Math.ceil(needOf(item)), ...(known(freeMiB) ? {availableMiB: Math.max(0, Math.floor(freeMiB))} : {})}; }
      else return {...item, pinned: true, fellBack: null, offload: false};
    }
  }
  // Mature content on with a Mature model installed: the fallback stays in the Mature pack (it never reaches a censored model).
  const mature = matureOn && uncensored.length > 0;
  const whole = (mature ? pickMature(uncensored) : null) ?? pick(ordinary) ?? externals.find(item => matureOn || !item.model.uncensored) ?? null;
  // Nothing fits whole: the smallest installed model of any kind goes onto the card as far as it fits and runs the rest on the CPU (`offload`) instead of the start failing. Whether enough of it
  // can stay on the card is the caller's gate (the projection is not pure data), so a model that is far too large is still returned here.
  const chosen = whole ?? offloadable(matureOn);
  if (!chosen) throw new LocalAiUnavailable('low-memory');
  // A silent migration, or the pinned model itself loaded anyway (it did not fit): nothing was replaced, so nothing is announced.
  if (silent || chosen.model.id === pin) fellBack = null;
  return {...chosen, pinned: false, fellBack, offload: whole === null || (chosen.model.uncensored && !fits(chosen)), ...(reserved.applied ? {gameReserve: true} : {}),
    // Why the chosen model was not used, in numbers the player is told: what it needs and what is available for it (after the game's room), both in MiB.
    ...(fellBack === 'low-memory' && lowMemory ? lowMemory : {})};
}

/** The installed model a saved `mature:*` id that is in no pack any more stands for: the Mature pack's good model if it fits, else its lite one; null when the pack has none. */
function migratedPinItem(sized, fits) {
  const good = sized.find(item => item.model.matureTier === 'good'), lite = sized.find(item => item.model.matureTier === 'lite');
  return (good && fits(good) ? good : lite ?? good) ?? null;
}

/**
 * The models the settings page shows as selected, as ids (null when there is none):
 *   default   the model the default rule would load now (what a setting of `auto`, or of a model that is gone, gets)
 *   mature    the largest uncensored model that fits (else the smallest one: it is loaded with layers on the CPU), which turning Mature
 *             content on selects; null when no uncensored model is installed
 * Same inputs as chooseLocalModel (without a pin). Never throws.
 */
export function defaultModelIds({models = [], matureOn = false, freeMiB = null, totalMiB = null, sizeOf = () => 0} = {}) {
  if (!models.length) return {default: null, mature: null};
  const {pick, pickMature, uncensored, ordinary} = prepare({models, freeMiB, totalMiB, sizeOf});
  const mature = uncensored.length ? pickMature(uncensored) : null;
  // A Mature-only install with Mature content off: no default (nothing is saved on Apply); turning Mature content on selects `mature`.
  if (matureOffBlocks(models, matureOn)) return {default: null, mature: mature?.model.id ?? null};
  const chosen = (matureOn ? mature : null) ?? pick(ordinary) ?? (matureOn ? mature : null);   // Mature content off: an uncensored model is never the default
  return {default: chosen?.model.id ?? null, mature: mature?.model.id ?? null};
}

/**
 * Does the model already loaded satisfy a changed choice, so no reload is needed? A pinned model that is installed is satisfied by that
 * model alone; otherwise (`auto`, or a model that is gone) by any model of the group the default rule chooses from (the uncensored ones
 * with Mature content on and one installed, else the others).
 */
export function stillSatisfies({loadedId, models = [], pin = AUTO_MODEL, matureOn = false} = {}) {
  if (!loadedId) return false;
  if (matureOffBlocks(models, matureOn)) return false;   // a Mature-only install with Mature content turned off: nothing may stay loaded
  if (!matureOn && models.some(model => model.id === loadedId && model.matureTier)) return false;   // a Mature pack model never stays loaded with Mature content off
  if (matureOffIgnores(pin, models)) pin = AUTO_MODEL;
  pin = resolveServerPin(pin, models);
  if (pin !== AUTO_MODEL && models.some(model => model.id === pin)) return loadedId === pin;
  // A saved Mature model that is gone stands for a model of the Mature pack (chooseLocalModel): any of the two satisfies it.
  if (pin.startsWith('mature:') && models.some(model => model.matureTier)) return models.some(model => model.id === loadedId && model.matureTier);
  const wantUncensored = matureOn && models.some(model => model.uncensored);
  return models.some(model => model.id === loadedId && model.uncensored === wantUncensored);
}

/**
 * The list the settings page shows, for the bridge to publish: [{id, name, sizeMiB}] by file size, smallest first (sortLocalModels; names
 * are cut to 80 characters). A custom model also has {custom: true, needMiB} (file plus headroom: the graphics memory it needs) and, when
 * the card is too small for it, {tooLarge: true}. An entry also says `hasVision: true` when the model has a vision projector (never its path).
 */
export const describeLocalModels = (models, sizeOf = () => 0) => sortLocalModels(models, sizeOf).slice(0, 24).map(model => {
  const sizeMiB = model.external ? 0 : Math.round(Number(sizeOf(model.file)) || 0);
  const entry = {id: model.id, name: String(model.name).slice(0, 80), sizeMiB};
  if (model.mmproj && model.external !== true) entry.hasVision = true;   // only when true: an entry without the field has no projector
  if (model.custom) {
    entry.custom = true;
    entry.needMiB = sizeMiB > 0 ? modelNeedMiB(model, sizeMiB) : 0;
    if (model.external) entry.external = true;   // only these fields leave this function: never the address or the key
    else if (model.tooLarge) entry.tooLarge = true;
  }
  return entry;
});
