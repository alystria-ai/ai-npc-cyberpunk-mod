import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, copyFile, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, basename, resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {characterPayload, characterMatches, verifyCharacter, verifyMemoryConfiguration} from '../scripts/character-payload.mjs';

const profile = {key: 'test-character', name: 'Test-Character', voice: 'convai-kokoro-test',
  voiceName: 'Test voice', model: 'reference-model', backstory: 'A fictional local resident.',
  speakingStyleDescription: 'Warm, direct speech with short sentences.',
  speakingStyleSampleDialogues: 'V: Hey.\nTest-Character: Good to see you.'};
const expected = characterPayload(profile);
const readback = {character_id: 'fixture-character-id', character_name: 'Test Character',
  voice_type: profile.voice, backstory: profile.backstory,
  speaking_style: {description: profile.speakingStyleDescription,
    sample_dialogues: profile.speakingStyleSampleDialogues}};

test('create payload puts biography, speaking style and sample dialogues in separate fields', () => {
  assert.deepEqual(expected, {charName: 'Test Character', voiceType: profile.voice,
    backstory: profile.backstory, speaking_style_description: profile.speakingStyleDescription,
    speaking_style_sample_dialogues: profile.speakingStyleSampleDialogues, model_group_name: profile.model});
  for (const field of ['speakingStyleDescription', 'speakingStyleSampleDialogues']) {
    assert.throws(() => characterPayload({...profile, [field]: ''}), /rebuild the character profiles/);
  }
});

test('matching biography alone cannot pass verification when either speaking field is absent or stale', () => {
  assert(characterMatches(readback, expected));
  verifyCharacter(readback.character_id, readback, expected, profile.key);
  for (const actual of [{...readback, speaking_style: undefined},
    {...readback, speaking_style: {...readback.speaking_style, description: ''}},
    {...readback, speaking_style: {...readback.speaking_style, sample_dialogues: 'Old example'}}]) {
    assert(!characterMatches(actual, expected));
    assert.throws(() => verifyCharacter(readback.character_id, actual, expected, profile.key), /readback mismatch/);
  }
  assert.throws(() => verifyCharacter('different-id', readback, expected, profile.key), /readback mismatch/);
});

test('memory verification rejects changed policy while ignoring fluctuating credit estimates', () => {
  const before = {memory_settings: {enabled: true, ltm_min_credit_cost_e8: 0}};
  verifyMemoryConfiguration(before, {memory_settings: {enabled: true,
    ltm_min_credit_cost_e8: 100000000, kb_min_credit_cost_e8: 100000000}}, profile.key);
  assert.throws(() => verifyMemoryConfiguration(before,
    {memory_settings: {enabled: false}}, profile.key), /Memory configuration changed/);
  assert.throws(() => verifyMemoryConfiguration(before, {}, profile.key), /Memory configuration changed/);
});

test('provisioner repairs an existing profile with empty speaking fields and preserves its ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'convai-provision-'));
  try {
    for (const dir of ['scripts', 'characters', 'runtime']) await mkdir(join(root, dir));
    for (const name of ['Provision-Characters.mjs', 'character-payload.mjs']) {
      await copyFile(new URL('../scripts/' + name, import.meta.url), join(root, 'scripts', name));
    }
    await writeFile(join(root, 'characters/roster.json'), JSON.stringify([profile]));
    await writeFile(join(root, 'runtime/characters.json'), JSON.stringify({[profile.key]: readback.character_id}));
    await writeFile(join(root, 'runtime/convai-key.txt'), 'api-key=local-fixture-only');
    const initial = {...readback, speaking_style: {description: '', sample_dialogues: ''},
      personalised_prompt_config: {MODEL: profile.model}, memory_settings: {enabled: true}};
    await writeFile(join(root, 'fake-api.mjs'), `
import {writeFile} from 'node:fs/promises';
let actual=${JSON.stringify(initial)}, mutations=[];
globalThis.fetch=async(url,options)=>{
 const body=JSON.parse(options.body),route=new URL(url).pathname;
 if(route==='/character/list')return Response.json({characters:[actual]});
 if(route==='/character/get')return Response.json(actual);
 if(route!=='/character/update')throw Error('Unexpected API route');
 mutations.push({route,body});
 actual={...actual,character_name:body.charName,voice_type:body.voiceType,backstory:body.backstory,
  speaking_style:{description:body.speaking_style_description,sample_dialogues:body.speaking_style_sample_dialogues}};
 await writeFile('mutations.json',JSON.stringify(mutations));
 return Response.json({STATUS:'SUCCESS'});
};`);
    await promisify(execFile)(process.execPath, ['--import', './fake-api.mjs', 'scripts/Provision-Characters.mjs', '--apply'],
      {cwd: root, windowsHide: true, timeout: 15000, env: {...process.env, CYBERPUNK_CONVAI_KEY_FILE: join(root, 'runtime/convai-key.txt')}});
    const changes = JSON.parse(await readFile(join(root, 'mutations.json'), 'utf8'));
    assert.deepEqual(changes, [{route: '/character/update', body: {charID: readback.character_id, ...expected}}]);
    const mapping = JSON.parse(await readFile(join(root, 'runtime/characters.json'), 'utf8'));
    assert.equal(mapping[profile.key], readback.character_id);
    const report = JSON.parse(await readFile(join(root, 'runtime/profile-enrichment-report.json'), 'utf8'));
    assert(report.completed && report.profiles[0].speakingStyleVerified && report.profiles[0].sampleDialoguesVerified);
    assert(report.profiles[0].modelVerified && report.profiles[0].memoryEnabled && report.profiles[0].memoryConfigurationPreserved && !report.profiles[0].created);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert(basename(root).startsWith('convai-provision-'));
    await rm(root, {recursive: true, force: true});
  }
});
