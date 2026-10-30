// Where the media channel is joined to the rest of the bridge (the bridge is a program, not a module: its places are checked in its source, as other suites do), and the promises
// it makes about the speech path: nothing added in front of it, no timer of its own.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bridge = read('./convai-bridge.mjs'), realtime = read('./realtime-host.mjs'), local = read('./local-pcm-host.mjs');
const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));
const code = text => text.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');

test('the bridge reads the media request file from its existing loop, gated, with no timer of its own', () => {
  assert.match(bridge, /const mediaLink = new MediaLink\(\{path: resolve\(runtime, 'media-command\.json'\), bondPacks, audio: preparedAudio/, 'its own file, not the request file');
  assert.match(bridge, /wanted: \(\) => questPoller\.armed \|\| realtime\.mediaBusy/, 'looked at only while a quest runs or a sound plays');
  assert.match(bridge, /setInterval\(\(\) => \{ mediaLink\.maybePoll\(\); return tick\(\); \}, 50\)/, 'called from the existing 50 ms loop, not awaited');
  assert.ok(!/setInterval\([^)]*media/i.test(code(bridge)), 'no media interval');
  assert.ok(!/setInterval|setTimeout/.test(code(read('./media-link.mjs'))), 'the link creates no timer');
  assert.ok(!/setInterval/.test(code(read('./media-host.mjs'))), 'the host creates no interval');
  assert.ok(!/setInterval|requestAnimationFrame/.test(code(read('./media-engine.mjs'))), 'the page engine runs nothing by itself');
  assert.match(code(read('./media-engine.mjs')), /source\.onended = /, 'an end is the source\'s own event');
});

test('a pack that stopped running and a quiet media page are handled by the existing 500 ms due-check', () => {
  const release = between(bridge, 'async function releaseUnused() {', 'const localModelSizes');
  assert.match(release, /await mediaLink\.reconcile\(\)/);
  assert.match(release, /await realtime\.releaseMediaIfIdle\(\{idleMs: MEDIA_IDLE_MS\}\)/);
  assert.ok(release.indexOf('mediaLink.reconcile') < release.indexOf('voiceBoundaryBusy()'), 'a stopped pack\'s music is not held back by a busy voice boundary');
});

test('the media page is a page of its own: the speech renderer, its lease and its packets are untouched', () => {
  assert.match(realtime, /export const MEDIA_MODULES = Object\.freeze\(\['media-engine\.mjs', 'media-mix\.mjs', 'media-pcm-client\.mjs'\]\)/);
  assert.match(realtime, /const createMediaPage = async \(\{onEvent\}\) =>/);
  assert.match(realtime, /await page\.goto\(origin \+ '\/media'\)/, 'its own route');
  assert.match(realtime, /url\.pathname === '\/media' \|\| MEDIA_MODULES\.includes\(url\.pathname\.slice\(1\)\)/, 'the page may request only its own route and modules');
  assert.match(realtime, /exposeFunction\('mediaEvent'/, 'the page posts the end of a sound as an event');
  // The speech page is built exactly as before: the same factory, the same modules, read at the same moment.
  assert.match(realtime, /const \[bundle, \.\.\.modules\] = await Promise\.all\(\[/);
  assert.ok(!/\bmedia|Media/.test(between(realtime, 'const createLocalPage = async', '// The media page: music')), 'createLocalPage knows nothing of the media page');
  assert.match(realtime, /if \(this\.media\?\.busy\) return false;/, 'a playing music bed keeps the browser');
  assert.match(realtime, /mediaDisposing = media\?\.close\(\)/, 'the media page goes with the browser');
});

test('the speech path\'s only link to the media channel is one synchronous, guarded call at the first audible packet and one at the end', () => {
  assert.match(realtime, /const onSpeech = on => this\.media\?\.speech\(on\);/);
  assert.match(realtime, /new LocalPcmHost\(\{createPage: createLocalPage, label: 'companion', levelLog: line => console\.error\(line\), onSpeech\}\)/);
  assert.match(realtime, /new LocalPcmHost\(\{createPage: createLocalPage, label: 'V', levelLog: line => console\.error\(line\), onSpeech\}\)/);
  assert.match(local, /const signalSpeech = on => \{ if \(!this\.onSpeech \|\| speaking === on\) return; speaking = on; try \{ this\.onSpeech\(on\); \} catch \{/);
  assert.match(local, /markStage\('firstPcmAccepted'\); firstAudio\?\.\(\); signalSpeech\(true\);/, 'after the renderer accepted the first packet and after the poll was woken');
  assert.equal((local.match(/signalSpeech\(/g) ?? []).length, 2, 'called twice (the first audible packet, the end): nothing else was added to the speech path');
  const speech = between(read('./media-host.mjs'), '  speech(on) {', '  get busy()');
  assert.match(speech, /if \(this\.page && this\.items\.size\) setImmediate\(\(\) => this\.syncDuck\(\)\)/, 'with nothing playing it is a counter, with something playing the page command is off the caller\'s turn');
  assert.ok(!/await/.test(speech), 'nothing awaited');
});
