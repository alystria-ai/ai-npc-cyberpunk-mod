// The player-facing words for companion vision (owner, 2026-10-30): the feature and a model's ability to use it are called "vision", never
// "picture". The setting is "Companion vision". The holocall "Live picture" is another feature and keeps its word.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DevTranscript} from './dev-transcript.mjs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// The sentences the game shows (mod/init.lua, ui.t) and docs/NOTIFICATIONS.md lists. The bridge sends only the codes, the sentences are built in Lua.
const NOTICES = {
  'vision-border': 'The yellow border is Windows showing a capture. Turn off Companion vision to stop it.',
  'vision-local-no-model': 'This Local AI model has no vision, so replies use only your words.',
  'vision-local-no-file': 'This model has vision with its vision file, from {folder}/vision on Hugging Face.',
  'vision-custom-no-images': 'Your Custom endpoint does not accept vision, so replies use only your words.',
};
const OLD_NOTICES = [
  'Turn off Companions can see to stop it.',
  'This Local AI model cannot see pictures, so replies use only your words.',
  'This model can see pictures with its vision file, from {folder}/vision on Hugging Face.',
  'Your Custom endpoint does not accept pictures, so replies use only your words.',
];

test('the four vision notices say vision and never picture, in the game scripts and in the notification catalogue', () => {
  const init = read('mod/init.lua');
  const catalogue = read('docs/NOTIFICATIONS.md');
  for (const [code, sentence] of Object.entries(NOTICES)) {
    assert.doesNotMatch(sentence, /pictures?/i, sentence);
    assert.match(sentence, /vision/i, sentence);
    assert.ok(init.includes(`ui.t('${sentence}'`), `mod/init.lua does not show: ${sentence}`);
    const row = catalogue.split('\n').find(line => line.startsWith(`| \`${code}\``));
    assert.ok(row, `docs/NOTIFICATIONS.md has no row for ${code}`);
    assert.ok(row.includes(sentence), `docs/NOTIFICATIONS.md row ${code} does not hold: ${sentence}`);
  }
  for (const old of OLD_NOTICES) {
    assert.ok(!init.includes(old), `mod/init.lua still holds: ${old}`);
    assert.ok(!catalogue.includes(old), `docs/NOTIFICATIONS.md still holds: ${old}`);
  }
});

test('the yellow border notice names the setting as it is labelled', () => {
  assert.ok(NOTICES['vision-border'].includes('Companion vision'));
  assert.ok(!NOTICES['vision-border'].includes('Companions can see'));
});

test('the developer transcript says vision yes or vision no for each turn', () => {
  const transcript = new DevTranscript({path: null, now: () => new Date(2026, 9, 30, 12, 1, 2)});
  const yes = transcript.format({speaker: 'Judy Alvarez', provider: 'local', user: 'hi', reply: 'hey', picture: true});
  const no = transcript.format({speaker: 'Panam Palmer', provider: 'custom', user: 'hi', reply: 'hey', picture: false});
  assert.match(yes, /\| provider local \| vision yes\n/);
  assert.match(no, /\| provider custom \| vision no\n/);
  assert.doesNotMatch(yes + no, /picture/i);
});

// The player documents: the setting has its new name and no player sentence about the feature says picture.
const PLAYER_SENTENCES = [
  ['README.md', 'With Companion vision on (it is off by default), each line you send carries a fresh glimpse of the game window'],
  ['README.md', 'has vision (Settings > Conversations > Companion vision) only with its vision file'],
  ['README.md', 'whether vision went along and where you were'],
  ['packaging/PLAYER_README.md', 'Settings > Conversations > Companion vision. With it on, vision of what V is looking at goes along with the turn'],
  ['packaging/PLAYER_README.md', 'a Local AI model has vision (Settings > Conversations > Companion vision) only with its vision file'],
  ['docs/NEXUS_PAGE.md', 'With Companion vision on they also get a fresh glimpse of the game window (never saved), with any provider.'],
  ['docs/NEXUS_PAGE.md', 'with Companion vision on, a Local AI model sees only with its vision file'],
  ['docs/NEXUS_PAGE.md', '[b]Companion vision (off by default):[/b]'],
  ['packaging/HF_MODEL_CARD.md', 'With it the model has vision (Settings > Conversations > Companion vision)'],
  ['docs/COMPANION_VISION.md', 'The player setting is **Companion Manager > Settings > Conversations > Companion vision**'],
];

test('the player documents describe the feature as vision, under the setting name Companion vision', () => {
  for (const [file, sentence] of PLAYER_SENTENCES) {
    const text = read(file);
    assert.ok(text.includes(sentence), `${file} does not hold: ${sentence}`);
    assert.doesNotMatch(sentence, /pictures?/i, sentence);
    assert.match(sentence, /vision/i, sentence);
  }
  for (const file of ['README.md', 'packaging/PLAYER_README.md', 'docs/NEXUS_PAGE.md', 'packaging/HF_MODEL_CARD.md', 'docs/COMPANION_VISION.md']) {
    // The changelog line of the player README names the old setting once, to say it was renamed.
    const text = read(file).replace('**Companions can see** is now **Companion vision**', '');
    assert.ok(!text.includes('Companions can see'), `${file} still uses the old setting name`);
  }
});

test('docs/COMPANION_VISION.md has no picture wording left except file names, code names and log lines', () => {
  const left = read('docs/COMPANION_VISION.md').split('\n')
    .flatMap(line => [...line.matchAll(/[^\s`(]*picture[^\s`)]*/gi)].map(match => match[0]));
  const allowed = /^(TEXT_PICTURE|pictureForTurn|scripts\/Measure-VisionPicture\.mjs|pictures:|picture)$/;
  for (const word of left) assert.match(word, allowed, `docs/COMPANION_VISION.md still says: ${word}`);
});
