import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {LOCAL_VOICE_KEYS, voiceSteps} from './resident-voice.mjs';

const plan = JSON.parse(await readFile(new URL('../packaging/release-plan.json', import.meta.url), 'utf8'));
const development = JSON.parse(await readFile(new URL('../scripts/development-files.json', import.meta.url), 'utf8'));
const scripts = plan.archives.find(a => a.id === 'scripts');
const runtime = plan.archives.find(a => a.id === 'runtime');
const relative = path => typeof path === 'string' && path.length > 0
  && !/^(?:[a-z]:|[\\/])/i.test(path) && !path.split(/[\\/]/).includes('..');

test('two proposed archives partition every active development file by Lua extension', () => {
  assert.equal(plan.archives.length, 2);
  assert.equal(scripts.onlyExtension, '.lua'); assert.equal(runtime.forbiddenExtension, '.lua');
  assert(scripts.files.every(file => file.source.endsWith('.lua') && file.target.endsWith('.lua')));
  assert(runtime.files.every(file => !file.source.endsWith('.lua') && !file.target.endsWith('.lua')));
  const compare = files => files.map(f => `${f.source}\t${f.target}`).sort();
  assert.deepEqual(compare([...scripts.files, ...runtime.files]), compare(development.files));
  const targets = [...scripts.files, ...runtime.files].map(f => f.target.toLowerCase());
  assert.equal(new Set(targets).size, targets.length);
  assert(!targets.some(path => path.endsWith('/knowledgestate.reds')));
});

test('package destinations are relative game-root paths and never include a wrapper directory', () => {
  assert.equal(plan.installRoot, 'game-root');
  for (const archive of plan.archives) for (const file of archive.files) {
    assert(relative(file.source), file.source); assert(relative(file.target), file.target);
    assert.match(file.target, /^(bin|r6|archive)\//);
  }
  for (const component of runtime.plannedComponents) {
    assert(relative(component.destination), component.id);
    assert.match(component.destination, /^(bin|r6|archive)\//);
  }
});

test('private runtime, conditioning recordings and benchmark data cannot become blanket package includes', () => {
  const sources = plan.archives.flatMap(a => a.files.map(f => f.source));
  assert.deepEqual(sources.filter(path => path.startsWith('runtime/')), [
    'runtime/facial-rig/package/convai_facial.archive',
    'runtime/ambient-driver-guard/package/cyberpunk_convai_ambient_driver_guard.archive',
  ]);
  assert(!sources.some(path => /(?:convai-key|player-memory|phone-history|phone-sessions|characters-verified|reply-\d+\.wav|benchmark|voice-references)/i.test(path)));
  assert.equal(plan.voice.references.packageExistingAudio, false);
  assert.equal(plan.voice.references.generateFromUserInstalledGame, true);
  for (const required of ['API keys and authentication tokens', 'end-user IDs and memory/session/history files',
    'developer runtime directory as a tree', 'benchmark samples and training datasets', 'CET user settings and bindings']) {
    assert(plan.exclusions.includes(required), required);
  }
});

test('voice plan preserves current precision, resident model, step options and explicit Convai unload', () => {
  assert.equal(plan.voice.providerDefault, 'hybrid');
  assert.equal(plan.voice.stepsDefault, voiceSteps(undefined));
  assert.deepEqual(plan.voice.stepsOptions, [voiceSteps(16), voiceSteps(32)]);
  assert.deepEqual(plan.voice.startupProfiles, [...LOCAL_VOICE_KEYS]);
  assert.equal(plan.voice.localProfiles.length, plan.voice.registry.preparedLocalProfiles);
  assert.equal(new Set(plan.voice.localProfiles).size, plan.voice.localProfiles.length);
  assert(plan.voice.startupProfiles.every(key => plan.voice.localProfiles.includes(key)));
  assert.equal(plan.voice.registry.subjectiveListeningRequired, false);
  assert.equal(plan.voice.precision, 'float16'); assert.equal(plan.voice.tensorRT, false);
  assert.equal(plan.voice.residentWhileSelected, true); assert.equal(plan.voice.convaiAllUnloadsLocalModel, true);
});

test('proposal explicitly records missing portability, license and hosting proof', () => {
  assert.equal(plan.status, 'proposal-not-buildable'); assert.equal(plan.publishAuthorized, false);
  assert.equal(runtime.plannedComponents.find(c => c.id === 'python').status, 'existing-venv-not-portable');
  assert.equal(runtime.plannedComponents.find(c => c.id === 'bootstrap').status, 'not-implemented');
  assert.equal(plan.licenses.find(l => l.component === 'VoiceStudio adapter').license, 'AGPL-3.0-only');
  assert.match(plan.licenses.find(l => l.component === 'OmniVoice pretrained weights').license, /^CC-BY-NC/);
  assert.equal(plan.licenses.find(l => l.component === 'OmniVoice audio tokenizer').license, 'Boson Higgs Audio 2 Community License');
  assert.equal(plan.hosting.maxAssetBytesExclusive, 2 ** 31); assert.equal(plan.hosting.measuredZipBytes, null);
  assert(runtime.plannedComponents.find(c => c.id === 'omni-model').uncompressedBytes > plan.hosting.maxAssetBytesExclusive);
  assert(plan.requiredChecks.includes('relocated-clean-machine-without-developer-paths'));
  assert(plan.requiredChecks.includes('native-game-audio-and-ui-acceptance'));
});

test('file-loaded intrinsic history is an explicit runtime data dependency, separate from raw research assets', () => {
  const history = runtime.plannedComponents.find(component => component.id === 'intrinsic-history');
  assert(history);
  assert.match(history.destination, /\/app\/research\/cyberpunk\/native-character-claims$/);
  assert.deepEqual(history.sourceFiles, [
    'research/cyberpunk/native-character-claims/jackie-welles.json',
    'research/cyberpunk/native-character-claims/johnny-silverhand.json',
  ]);
  assert.equal(history.includeRawGameExports, false);
  assert.equal(history.authorHashEncoding, 'canonical-json-v1');
  assert.equal(plan.voice.registry.schemaVersion, 2);
  assert.equal(plan.voice.registry.maxCachedProfiles, 8);
  assert.equal(plan.voice.registry.sharedModel, true);
});
