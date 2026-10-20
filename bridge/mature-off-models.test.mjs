// Nexus report, 2026-10-20: "I've installed both mature and normal local ai packs ... the mature model is a bit too rude, but when I turn it off, it shows that I have no
// model to use anymore." The packs are built into a real folder here, exactly as packaging/build-release.mjs lays them out (manifest.standard.json,
// manifest.lite.json, manifest.mature-standard.json, manifest.mature-lite.json, models/*.gguf, llama/llama-server.exe), and the detection, the model list and the choice are
// walked through Mature content on and off, with every saved choice. Two rules: the Local AI packs are always found whatever Mature content says, and with Mature content
// off a Mature pack model never loads, whatever the saved choice.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectLocalAiPack, describePackFiles, packFileProblems} from './local-ai-pack.mjs';
import {detectMaturePack} from './mature-pack.mjs';
import {chooseLocalModel, defaultModelIds, describeLocalModels, listLocalModels, matureOffBlocks, stillSatisfies} from './local-model-choice.mjs';

const ENGINE = 'llama/llama-server.exe';
const EMBED = {file: 'models/granite-embedding-107m-multilingual-Q8_0.gguf', dim: 384, id: 'granite-embedding-107m-multilingual-q8_0'};
const FILES = {standard: 'models/gemma-4-E4B_q4_0-it.gguf', lite: 'models/Ternary-Bonsai-2-4B-Q2_0.gguf',
  good: 'models/Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf', matureLite: 'models/Qwen3.5-2B-Uncensored-Q4_K_M.gguf'};
const SIZES = {[FILES.standard]: 5280, [FILES.lite]: 1156, [FILES.good]: 4900, [FILES.matureLite]: 1500};
const sizeOf = file => SIZES['models/' + String(file).split(/[\\/]/).pop()] ?? 0;

/** Which packs are extracted into the folder, as the release builds them (every pack carries the engine and the embedding model). */
function install(t, packs) {
  const directory = mkdtempSync(join(tmpdir(), 'mature-off-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const put = (relative, text = 'x') => { const path = join(directory, relative); mkdirSync(join(path, '..'), {recursive: true}); writeFileSync(path, text); };
  for (const pack of packs) {
    put(ENGINE); put(EMBED.file);
    if (pack === 'standard') { put(FILES.standard); put('manifest.standard.json', JSON.stringify({version: 1, server: ENGINE, standard: {file: FILES.standard, name: 'Gemma 4 E4B'}, embed: EMBED})); }
    if (pack === 'lite') { put(FILES.lite); put('manifest.lite.json', JSON.stringify({version: 1, server: ENGINE, lite: {file: FILES.lite, name: 'Bonsai 2 4B'}, embed: EMBED})); }
    if (pack === 'mature-standard') {
      put(FILES.good);
      put('manifest.mature-standard.json', JSON.stringify({version: 1, pack: 'mature', server: ENGINE, good: {file: FILES.good, name: 'Gemma 4 E4B · uncensored', family: 'gemma-4'}, embed: EMBED}));
    }
    if (pack === 'mature-lite') {
      put(FILES.matureLite);
      put('manifest.mature-lite.json', JSON.stringify({version: 1, pack: 'mature', server: ENGINE, lite: {file: FILES.matureLite, name: 'Qwen3.5 2B uncensored', family: 'qwen'}, embed: EMBED}));
    }
  }
  const environment = {CYBERPUNK_CONVAI_LOCAL_AI: directory};
  const pack = detectLocalAiPack({project: directory, environment}), mature = detectMaturePack({project: directory, environment});
  return {directory, environment, pack, mature, models: listLocalModels({pack, matureModels: mature.models}), files: describePackFiles({project: directory, environment})};
}

const PINS = ['auto', 'standard', 'lite', 'mature:good', 'mature:lite', 'mature:old-model-of-an-earlier-pack', 'gemma-4-removed'];
const choose = (models, options) => chooseLocalModel({models, sizeOf, freeMiB: 12000, totalMiB: 12288, ...options});

test('both packs in the release layout: Local AI is installed, both models are listed with Mature content on or off, and the settings poll sees no change when it toggles', t => {
  const {pack, mature, models, files} = install(t, ['standard', 'mature-standard']);
  assert.equal(pack.installed, true);
  assert.deepEqual(pack.missing, []);
  assert.deepEqual([Boolean(pack.tiers.standard), Boolean(pack.tiers.lite)], [true, false]);
  assert.deepEqual(mature.models.map(model => [model.tier, model.present]), [['good', true]]);
  assert.deepEqual(describeLocalModels(models, sizeOf).map(model => model.name), ['Gemma 4 E4B · uncensored', 'Gemma 4 E4B']);
  assert.deepEqual(packFileProblems(files), []);
  // Nothing of this is read from the Mature content setting: the list and the pack do not depend on it, so the row has the same models on and off.
  for (const matureOn of [false, true]) assert.equal(matureOffBlocks(models, matureOn), false);
});

test('Mature content off with both packs installed: a model is always chosen and it is never an uncensored one, whatever the saved choice', t => {
  for (const packs of [['standard', 'mature-standard'], ['standard', 'lite', 'mature-standard', 'mature-lite'], ['lite', 'mature-standard'], ['lite', 'mature-lite'], ['standard', 'mature-lite']]) {
    const {models} = install(t, packs);
    for (const pin of PINS) for (const freeMiB of [12000, 7000, 3000]) {
      let choice;
      try { choice = choose(models, {pin, matureOn: false, freeMiB}); } catch (error) { choice = error; }
      const label = `${packs} pin ${pin} free ${freeMiB}`;
      if (choice instanceof Error) {
        // The only way to be left without a model with Mature content off is memory the ordinary models do not fit in; never "not installed", never "only Mature models".
        assert.equal(choice.reason, 'low-memory', label);
        assert.equal(freeMiB, 3000, label + ': ' + choice.reason);
        continue;
      }
      assert.equal(Boolean(choice.model.matureTier), false, label + ': ' + choice.model.id);
      assert.equal(choice.model.uncensored, false, label);
      // Nothing fits whole at 3,000 MiB for some of the pack combinations: the smallest ordinary model is chosen to go on the card as far as it fits (the caller's gate decides).
      if (choice.offload) assert.equal(freeMiB, 3000, label);
      else assert.equal(choice.offload, false, label);
    }
  }
});

test('the player\'s sequence: Mature on selects the uncensored model, the pin is saved, Mature off loads the standard model, Mature on again loads the uncensored one', t => {
  const {models} = install(t, ['standard', 'mature-standard']);
  const ids = options => defaultModelIds({models, sizeOf, freeMiB: 12000, totalMiB: 12288, ...options});
  // Mature content off, nothing chosen: the standard model is the default and turning Mature on would select the uncensored one.
  assert.deepEqual(ids({matureOn: false}), {default: 'standard', mature: 'mature:good'});
  assert.equal(choose(models, {matureOn: false}).model.id, 'standard');
  // Turned on: the settings page selects mature:good and saves it as the pin.
  assert.deepEqual(ids({matureOn: true}), {default: 'mature:good', mature: 'mature:good'});
  const on = choose(models, {pin: 'mature:good', matureOn: true});
  assert.deepEqual([on.model.id, on.pinned, on.fellBack], ['mature:good', true, null]);
  // Turned off again with the pin still saved (the page could not put the earlier choice back): the standard model loads, with no notice and no "no model".
  const off = choose(models, {pin: 'mature:good', matureOn: false});
  assert.deepEqual([off.model.id, off.pinned, off.fellBack, off.offload], ['standard', false, null, false]);
  assert.equal(stillSatisfies({loadedId: 'mature:good', models, pin: 'mature:good', matureOn: false}), false, 'the loaded uncensored model is replaced');
  assert.equal(stillSatisfies({loadedId: 'standard', models, pin: 'mature:good', matureOn: false}), true, 'the replacement is stable');
  assert.equal(choose(models, {pin: 'mature:good', matureOn: true}).model.id, 'mature:good', 'and the pin is used again when Mature content is back on');
  // With Mature on the player may pin the normal model: it is kept.
  assert.equal(choose(models, {pin: 'standard', matureOn: true}).model.id, 'standard');
  assert.equal(stillSatisfies({loadedId: 'standard', models, pin: 'standard', matureOn: true}), true);
});

test('Mature content on lists and loads both models: the default and a pin of either', t => {
  const {models} = install(t, ['standard', 'lite', 'mature-standard', 'mature-lite']);
  assert.deepEqual(describeLocalModels(models, sizeOf).map(model => model.id), ['lite', 'mature:lite', 'mature:good', 'standard'], 'by file size, smallest first');
  assert.equal(choose(models, {matureOn: true}).model.id, 'mature:good');
  for (const id of ['standard', 'lite', 'mature:good', 'mature:lite']) assert.equal(choose(models, {pin: id, matureOn: true}).model.id, id, id);
});

test('a Mature pack alone: installed, Mature off says only Mature models (mature-off), never not-installed; adding the standard pack lifts it', t => {
  const alone = install(t, ['mature-standard']);
  assert.equal(alone.pack.installed, true, 'the Mature pack carries its own engine: Local AI is installed');
  assert.deepEqual(describeLocalModels(alone.models, sizeOf).map(model => model.id), ['mature:good']);
  assert.throws(() => choose(alone.models, {matureOn: false}), error => error.reason === 'mature-off');
  assert.equal(choose(alone.models, {matureOn: true}).model.id, 'mature:good');
  const both = install(t, ['mature-standard', 'standard']);
  assert.equal(choose(both.models, {matureOn: false, pin: 'mature:good'}).model.id, 'standard');
});

test('the Local AI pack alone, and both Local AI packs: nothing about Mature content changes the list', t => {
  const {models} = install(t, ['standard', 'lite']);
  for (const matureOn of [false, true]) for (const pin of PINS) {
    const choice = choose(models, {pin, matureOn});
    assert.ok(['standard', 'lite'].includes(choice.model.id), `${pin} ${matureOn}`);
  }
  assert.deepEqual(describeLocalModels(models, sizeOf).map(model => model.id), ['lite', 'standard']);
});
