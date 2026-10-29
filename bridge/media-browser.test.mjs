// The media page in a real headless browser (bridge/media-pcm-client.mjs through bridge/realtime-host.mjs): the page opens on its own route, takes a sound in packets, plays
// it on a real AudioContext, ducks it, reports the end of a one-shot as an event and stops a loop with a fade. Muted, no input: the decoded sound is a quiet tone. Skips itself
// where no browser can start.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {RealtimeHost, MEDIA_MODULES, PCM_MODULES} from './realtime-host.mjs';

const tone = (seconds, level = 0.05) => Float32Array.from({length: Math.round(seconds * 48000)}, (_, i) => level * Math.sin(i / 20));
const until = async (predicate, ms = 15000) => { const end = Date.now() + ms; while (!(await predicate())) { if (Date.now() > end) assert.fail('the media page did not reach the expected state'); await new Promise(done => setTimeout(done, 25)); } };

test('the media page plays, ducks, reports an end and fades a stop in a real browser', {timeout: 120000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cyberpunk-media-page-'));
  for (const name of [...PCM_MODULES, ...MEDIA_MODULES]) await writeFile(join(root, name), await readFile(new URL(name, import.meta.url)));
  await writeFile(join(root, 'realtime-client.js'), 'throw Error("Convai must not run in the media test");');
  const requests = [];
  const host = new RealtimeHost({clientAssetsDirectory: root, launchBrowser: async options => {
    const browser = await chromium.launch({...options, args: [...options.args, '--mute-audio']});
    const open = browser.newPage.bind(browser);
    browser.newPage = async (...args) => { const page = await open(...args); page.on('request', request => requests.push(request.url())); return page; };
    return browser;
  }});
  t.after(async () => { await host.close().catch(() => {}); await rm(root, {recursive: true, force: true}); });
  let media;
  try { media = await host.mediaHost(); } catch (error) { t.skip('no browser can start here: ' + error.message); return; }
  const pageState = () => media.page.evaluate(() => window.mediaPcm.state());
  // A one-shot of 0.4 s: it plays, then the page tells the host it ended.
  const shot = await media.play({pack: 'panam-sunset-coffee', id: 'shot', key: 'k/shot', samples: tone(0.4), rate: 48000, at: 'bed'});
  assert.equal(shot.played, true);
  assert.equal((await pageState()).items.length, 1);
  await until(() => media.count() === 0);
  assert.equal((await pageState()).items.length, 0, 'ended on the page, and the host was told by the page\'s own event');
  // A loop that ducks: lowered while a voice is audible, back after.
  await media.play({pack: 'panam-sunset-coffee', id: 'bed', key: 'k/bed', samples: tone(1), rate: 48000, loop: true, duck: true, volume: 0.5, fadeIn: 0.1});
  media.speech(true);
  await until(async () => (await pageState()).ducked === true);
  media.speech(false);
  await until(async () => (await pageState()).ducked === false);
  assert.equal((await pageState()).context, 'running');
  // A stop with a fade ends the loop on its own.
  assert.equal(await media.stop({pack: 'panam-sunset-coffee', fadeOut: 0.2}), 1);
  await until(async () => (await pageState()).items.length === 0);
  // The page loaded only its own route and modules.
  const origin = new Set(requests.map(url => new URL(url).pathname));
  assert.ok(origin.has('/media') && origin.has('/media-pcm-client.mjs') && origin.has('/media-engine.mjs') && origin.has('/media-mix.mjs'), [...origin].join(' '));
  assert.ok(![...origin].some(path => path === '/client.js' || path === '/local'), 'the Convai client and the speech page were never loaded for it');
  // Idle: the page closes after the quiet time and the next sound opens a new one.
  assert.equal(await media.releaseIfIdle({idleMs: 0}), true);
  assert.equal(media.page, null);
  await media.play({pack: 'panam-sunset-coffee', id: 'again', key: 'k/shot', samples: tone(0.2), rate: 48000});
  assert.ok(media.page);
});
