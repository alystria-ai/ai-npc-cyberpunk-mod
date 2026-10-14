// YouTube on V's TV (docs/YOUTUBE_TV.md): the pure parts (bridge/youtube-tv.mjs), the session with a fake browser and window helper
// (bridge/youtube-tv-host.mjs), the game side (mod/youtube-tv.lua under fengari), and the wiring in the bridge, settings and redscript.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fengari from 'fengari';
import {parseVideoInput, parseClock, formatClock, parseChapters, chapterAt, descriptionExcerpt, parseTvCommand, watchingContext,
  parseOembed, parseIsoDuration, parseDataApiVideo, validDataApiKey, lookupVideo, HOME_PLACES, MAX_CONTEXT_CHARS, cleanStrings} from './youtube-tv.mjs';
import {YouTubeTv, spawnWindowHelper} from './youtube-tv-host.mjs';
import {tvPage, PAGE_STRINGS} from './youtube-tv-page.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const ID = 'M7lc1UVf-VE';

test('video links and ids', () => {
  assert.deepEqual(parseVideoInput(ID), {videoId: ID, start: 0});
  assert.deepEqual(parseVideoInput(`https://www.youtube.com/watch?v=${ID}&list=PL123&index=2`), {videoId: ID, start: 0});
  assert.deepEqual(parseVideoInput(`youtube.com/watch?v=${ID}&t=1m30s`), {videoId: ID, start: 90});
  assert.deepEqual(parseVideoInput(`https://youtu.be/${ID}?t=42`), {videoId: ID, start: 42});
  assert.deepEqual(parseVideoInput(`https://m.youtube.com/shorts/${ID}`), {videoId: ID, start: 0});
  assert.deepEqual(parseVideoInput(`https://music.youtube.com/watch?v=${ID}`), {videoId: ID, start: 0});
  assert.deepEqual(parseVideoInput(`https://www.youtube-nocookie.com/embed/${ID}?start=7`), {videoId: ID, start: 7});
  assert.deepEqual(parseVideoInput(`  https://www.youtube.com/live/${ID}  `), {videoId: ID, start: 0});
  for (const bad of ['', 'hello', 'M7lc1UVf-V', `https://evil.example/watch?v=${ID}`, `javascript:alert(1)//youtube.com/watch?v=${ID}`,
    'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/results?search_query=cats', `ftp://youtube.com/watch?v=${ID}`, null, 42])
    assert.equal(parseVideoInput(bad), null, String(bad));
});

test('clock and chapters', () => {
  assert.equal(parseClock('0:05'), 5); assert.equal(parseClock('12:34'), 754); assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock('1:61'), null); assert.equal(parseClock('x'), null);
  assert.equal(formatClock(5), '0:05'); assert.equal(formatClock(754), '12:34'); assert.equal(formatClock(3723), '1:02:03');
  const chapters = parseChapters('Great video!\n0:00 Intro\n1:30 - The build\n(12:05) Results\nThanks for watching https://x.y\nOutro - 15:00');
  assert.deepEqual(chapters, [{start: 0, title: 'Intro'}, {start: 90, title: 'The build'}, {start: 725, title: 'Results'}, {start: 900, title: 'Outro'}]);
  assert.deepEqual(parseChapters('1:00 a\n2:00 b\n3:00 c'), [], 'the first chapter must start at 0:00');
  assert.deepEqual(parseChapters('0:00 a\n2:00 b'), [], 'at least three');
  assert.deepEqual(parseChapters('0:00 a\n3:00 b\n2:00 c'), [], 'ascending');
  assert.equal(chapterAt(chapters, 100).title, 'The build');
  assert.equal(chapterAt(chapters, 0).title, 'Intro');
  assert.equal(chapterAt([], 5), null);
});

test('description excerpt drops links, timestamps and hashtags and stays bounded', () => {
  const text = descriptionExcerpt('We build a cyberdeck. See https://example.com/x\n0:00 Intro\n#cyberpunk #diy\nSecond line here.');
  assert.equal(text, 'We build a cyberdeck. See Second line here.');
  const long = descriptionExcerpt('Word '.repeat(300));
  assert(long.length <= 361 && long.endsWith('…'));
});

test('the game command: fresh, known, validated', () => {
  const now = 1_800_000_000_000;
  const raw = value => JSON.stringify({version: 1, id: 'y1-1', issuedAt: now, ...value});
  assert.deepEqual(parseTvCommand(raw({action: 'toggle'}), now), {id: 'y1-1', action: 'toggle'});
  assert.deepEqual(parseTvCommand(raw({action: 'pick', video: `https://youtu.be/${ID}`}), now), {id: 'y1-1', action: 'pick', video: {videoId: ID, start: 0}});
  assert.equal(parseTvCommand(raw({action: 'pick', video: 'nope'}), now), null);
  assert.equal(parseTvCommand(raw({action: 'format-disk'}), now), null);
  assert.equal(parseTvCommand(raw({action: 'stop', issuedAt: now - 31_000}), now), null, 'stale');
  assert.equal(parseTvCommand(raw({action: 'stop', issuedAt: now + 6_000}), now), null, 'from the future');
  assert.equal(parseTvCommand('{bad', now), null);
  assert.deepEqual(parseTvCommand(raw({action: 'stop', reason: 'left-home'}), now), {id: 'y1-1', action: 'stop', reason: 'left-home'});
  assert.equal(parseTvCommand(raw({action: 'hide', reason: 'Bad Reason!'}), now).reason, 'game');
  const open = parseTvCommand(raw({action: 'open', language: 'de', place: 'LittleChina_VApartment', strings: {Play: 'Abspielen', x: 7}}), now);
  assert.deepEqual(open, {id: 'y1-1', action: 'open', language: 'de', strings: {Play: 'Abspielen'}, place: 'LittleChina_VApartment'});
  assert.deepEqual(cleanStrings({a: 'b\u0001c'}), {a: 'bc'});
});

const video = {videoId: ID, title: 'Building a <b>cyberdeck</b>', channel: 'Deck Lab', state: 'playing', position: 100, duration: 960,
  chapters: [{start: 0, title: 'Intro'}, {start: 90, title: 'Soldering'}, {start: 600, title: 'Boot'}],
  description: 'A full cyberdeck build from scrap. https://example.com', place: 'Glen_Apartment'};

test('the watching block: who gets it and what it says', () => {
  const input = {profileKey: 'judy', text: 'what do you think?'};
  const text = watchingContext(input, video);
  assert.match(text, /^Watching together \(from the game, right now\): You and V are watching a YouTube video together on the TV in V's apartment in the Glen: "Building a cyberdeck" from the channel Deck Lab\./);
  assert.match(text, /It is playing at 1:40 of 16:00\. The part on screen now is the chapter "Soldering"\. Its description says: A full cyberdeck build from scrap\./);
  assert.match(text, /never invent what is on screen/);
  assert(text.length <= MAX_CONTEXT_CHARS);
  for (const [extra, options] of [[{reaction: {kind: 'battle'}}, {}], [{channel: 'phone'}, {}], [{holocall: {mode: 'audio'}}, {}], [{}, {ambient: true}], [{}, {voice: true}]])
    assert.equal(watchingContext({...input, ...extra}, video, options), '', JSON.stringify([extra, options]));
  assert.equal(watchingContext(input, {...video, videoId: 'bad'}), '');
  assert.match(watchingContext(input, {...video, state: 'paused'}), /It is paused at 1:40/);
  assert.match(watchingContext(input, {...video, state: 'ended'}), /The video has just ended\./);
  assert.match(watchingContext(input, {videoId: ID}), /its title is not known/);
  const huge = watchingContext(input, {...video, title: 'T'.repeat(500), description: 'D '.repeat(5000)});
  assert(huge.length <= MAX_CONTEXT_CHARS, `${huge.length}`);
});

test('metadata: oEmbed, Data API, keys', async () => {
  assert.deepEqual(parseOembed({title: 'A', author_name: 'B'}), {title: 'A', channel: 'B'});
  assert.equal(parseOembed({}), null);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723); assert.equal(parseIsoDuration('PT45S'), 45); assert.equal(parseIsoDuration('P'), null);
  const api = {items: [{id: ID, snippet: {title: 'T', channelTitle: 'C', description: '0:00 a\n1:00 b\n2:00 c'}, contentDetails: {duration: 'PT3M'}}]};
  assert.deepEqual(parseDataApiVideo(api, ID), {title: 'T', channel: 'C', description: '0:00 a\n1:00 b\n2:00 c',
    chapters: [{start: 0, title: 'a'}, {start: 60, title: 'b'}, {start: 120, title: 'c'}], duration: 180});
  assert.equal(parseDataApiVideo(api, 'AAAAAAAAAAA'), null);
  const key = 'AIza' + 'x'.repeat(35);
  assert(validDataApiKey(key)); assert(!validDataApiKey('AIza123')); assert(!validDataApiKey(undefined));
  const asked = [];
  const fetch = async url => { asked.push(url); return {ok: true, json: async () => url.includes('oembed') ? {title: 'O', author_name: 'A'} : api}; };
  assert.deepEqual(await lookupVideo(ID, {fetch}), {title: 'O', channel: 'A'});
  assert.equal(asked.length, 1, 'no Data API call without a key');
  assert.match(asked[0], /^https:\/\/www\.youtube\.com\/oembed\?format=json&url=/);
  const both = await lookupVideo(ID, {fetch, dataApiKey: key});
  assert.equal(both.title, 'T'); assert.equal(both.chapters.length, 3);
  assert.match(asked[2] ?? asked[1], /googleapis\.com\/youtube\/v3\/videos\?part=snippet,contentDetails&id=M7lc1UVf-VE&key=AIza/);
  assert.deepEqual(await lookupVideo(ID, {fetch: async () => { throw Error('offline'); }}), {});
  assert.deepEqual(await lookupVideo('bad', {fetch}), {});
});

test('the page: official player only, referrer kept, nothing drawn over the player, strings translated and escaped', () => {
  const html = tvPage({title: 'Cyberpunk Convai TV x', origin: 'http://127.0.0.1:5', strings: {Play: '<Abspielen>'}});
  assert.match(html, /<script src="https:\/\/www\.youtube\.com\/iframe_api"><\/script>/);
  assert.match(html, /strict-origin-when-cross-origin/);
  assert.match(html, /&lt;Abspielen&gt;/);
  assert(!html.includes('<Abspielen>'));
  assert.match(html, /origin: config\.origin/);
  // The stage holds the player and nothing else.
  assert.match(html, /<section id="stage" hidden><div id="player"><\/div><\/section>/);
  assert(!/googlevideo|videoplayback|\.mp4|download/i.test(html), 'never a direct media URL');
  assert.deepEqual(PAGE_STRINGS, [...new Set(PAGE_STRINGS)]);
});

// A fake Playwright persistent context: one page that "loads" the TV page by calling the binding from the page's origin.
function fakeBrowser() {
  const log = {evaluated: [], gotos: [], closed: false};
  let binding = null, url = 'about:blank', closeHandlers = [], navHandlers = [];
  const frame = {url: () => url};
  const page = {
    url: () => url, isClosed: () => log.closed, mainFrame: () => frame,
    on: (name, fn) => { if (name === 'framenavigated') navHandlers.push(fn); },
    goto: async target => {
      log.gotos.push(target); url = target;
      for (const fn of navHandlers) fn(frame);
      if (target.startsWith('http://127.0.0.1')) setTimeout(() => binding?.({frame}, {type: 'loaded'}), 0);
    },
    evaluate: async (fn, command) => { log.evaluated.push(command); return true; },
    context: () => ({newCDPSession: async () => ({send: async () => ({data: Buffer.from('jpeg').toString('base64')}), detach: async () => {}})}),
  };
  const context = {
    exposeBinding: async (name, fn) => { assert.equal(name, '__convaiTv'); binding = fn; },
    pages: () => [page], newPage: async () => page,
    on: (name, fn) => { if (name === 'close') closeHandlers.push(fn); },
    close: async () => { log.closed = true; },
  };
  return {log, context, page, send: message => binding({frame}, message), sendFrom: (from, message) => binding({frame: {url: () => from}}, message),
    navigate: target => { url = target; for (const fn of navHandlers) fn(frame); }};
}
function fakeHelper() {
  const sent = [], listeners = new Set();
  return {sent, listeners, emit: event => { for (const fn of listeners) fn(event); },
    make() {
      return {send: command => { sent.push(command); if (command.op === 'attach') setTimeout(() => this.emit({event: 'attached'}), 0); },
        onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); }, stop: () => sent.push({op: 'stopped'})};
    }};
}
const tick = (ms = 5) => new Promise(done => setTimeout(done, ms));

async function session({audible = () => false, now} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-tv-'));
  const browser = fakeBrowser(), helper = fakeHelper();
  let clock = now ?? 1_800_000_000_000;
  const asked = [];
  const tv = new YouTubeTv({runtime: dir, stateDirectory: dir, launch: async () => browser.context, spawnHelper: () => helper.make(),
    audible, now: () => clock, log: () => {}, fetch: async url => { asked.push(url); return {ok: true, json: async () => ({title: 'Deck build', author_name: 'Deck Lab'})}; }});
  const command = async (action, extra = {}) => {
    await writeFile(join(dir, 'youtube-tv-command.json'), JSON.stringify({version: 1, id: `${action}-${Math.random()}`, action, issuedAt: clock, ...extra}));
    await tv.poll();
  };
  const state = async () => JSON.parse(await readFile(join(dir, 'youtube-tv-state.json'), 'utf8'));
  return {dir, tv, browser, helper, command, state, asked, advance: ms => { clock += ms; }, cleanup: () => rm(dir, {recursive: true, force: true})};
}

test('a session: open, pick, pause, stop; nothing exists before the first command', async () => {
  const s = await session();
  try {
    await writeFile(join(s.dir, 'youtube-tv-command.json'), JSON.stringify({version: 1, id: 'old', action: 'open', issuedAt: Date.now()}));
    await s.tv.start(); s.tv.setEnabled(true);
    await s.tv.poll();
    assert.equal(s.tv.session, null, 'a command left from an earlier session is never replayed');
    assert.equal((await s.state()).state, 'closed');
    await s.command('open', {strings: {'That is not a YouTube link or video id.': 'Kein Link.'}, place: 'LittleChina_VApartment'});
    assert.equal((await s.state()).state, 'picking');
    assert.deepEqual(s.helper.sent.map(c => c.op + (c.mode ? ':' + c.mode : '')), ['attach', 'layout:picker']);
    assert.match(s.helper.sent[0].title, /^Cyberpunk Convai TV [A-Za-z0-9_-]{12}$/);
    await tick();
    // Only the TV page may use the binding.
    assert.equal(await s.browser.sendFrom('https://www.youtube.com/results', {type: 'close'}), false);
    assert(s.tv.session);
    s.browser.send({type: 'pick', text: 'not a link'}); await tick(); await s.tv.queue;
    assert.deepEqual(s.browser.log.evaluated.at(-1), {op: 'message', text: 'Kein Link.'});
    s.browser.send({type: 'pick', text: `https://youtu.be/${ID}?t=30`}); await tick(); await s.tv.queue;
    assert.deepEqual(s.browser.log.evaluated.find(c => c.op === 'play'), {op: 'play', video: {videoId: ID, start: 30}});
    assert.equal(s.helper.sent.at(-1).mode, 'player');
    assert.equal((await s.state()).state, 'playing');
    await tick(); await s.tv.queue;
    assert.equal(s.tv.snapshot().title, 'Deck build', 'oEmbed title');
    s.browser.send({type: 'state', state: 'playing'}); s.browser.send({type: 'time', position: 40, duration: 600}); await tick(); await s.tv.queue;
    s.advance(10_000);
    assert.match(s.tv.contextFor({profileKey: 'judy'}), /playing at 0:50 of 10:00/, 'the position runs on between reports');
    await s.command('toggle'); assert.equal(s.browser.log.evaluated.at(-1).op, 'pause');
    s.browser.send({type: 'state', state: 'paused'}); s.browser.send({type: 'time', position: 50, duration: 600}); await tick(); await s.tv.queue;  // the page reports the time with every state change
    assert.equal((await s.state()).state, 'paused');
    s.advance(10_000);
    assert.match(s.tv.contextFor({profileKey: 'judy'}), /paused at 0:50/, 'a paused video does not run on');
    await s.command('toggle'); assert.equal(s.browser.log.evaluated.at(-1).op, 'resume');
    await s.command('hide', {reason: 'game-menu'}); assert.equal(s.helper.sent.at(-1).op, 'hide');
    await s.command('show'); assert.equal(s.helper.sent.at(-1).op, 'show');
    await s.command('stop', {reason: 'player'});
    assert.equal(s.tv.session, null); assert(s.browser.log.closed);
    assert.deepEqual(await s.state(), {version: 1, state: 'closed', updated: s.tv.now(), reason: 'player'});
    assert.equal(s.tv.contextFor({profileKey: 'judy'}), '');
    assert.equal(s.helper.sent.at(-1).op, 'stopped');
    const history = JSON.parse(await readFile(join(s.dir, 'youtube-tv-history.json'), 'utf8'));
    assert.deepEqual(history.map(row => [row.videoId, row.title]), [[ID, 'Deck build']]);
  } finally { await s.tv.close(); await s.cleanup(); }
});

test('the setting: off refuses to open and turning it off stops a session', async () => {
  const s = await session();
  try {
    await s.tv.start();
    await s.command('open');
    assert.deepEqual(await s.state(), {version: 1, state: 'error', updated: s.tv.now(), reason: 'disabled'});
    assert.equal(s.tv.session, null);
    s.tv.setEnabled(true); await s.command('open'); assert(s.tv.session);
    s.tv.setEnabled(false); await s.tv.queue;
    assert.equal(s.tv.session, null);
    assert.equal((await s.state()).reason, 'disabled');
  } finally { await s.tv.close(); await s.cleanup(); }
});

test('an unplayable video goes back to the picker with a message; a video picked on YouTube itself plays on the TV page', async () => {
  const s = await session();
  try {
    await s.tv.start(); s.tv.setEnabled(true);
    await s.command('open'); await tick();
    s.browser.send({type: 'pick', text: ID}); await tick(); await s.tv.queue;
    s.browser.send({type: 'error', code: 150}); await tick(); await s.tv.queue;
    assert.equal(s.tv.video, null);
    assert.deepEqual(s.browser.log.evaluated.find(c => c.op === 'picker'), {op: 'picker', message: 'This video cannot be played here. Choose another one.'});
    assert.equal(s.helper.sent.at(-1).mode, 'picker');
    assert.equal((await s.state()).state, 'picking');
    s.browser.send({type: 'search', query: 'cyberdeck build'}); await tick(); await s.tv.queue;
    assert.equal(s.browser.log.gotos.at(-1), 'https://www.youtube.com/results?search_query=cyberdeck%20build');
    s.browser.navigate(`https://www.youtube.com/watch?v=${ID}`); await tick(); await s.tv.queue; await tick(); await s.tv.queue;
    assert.match(s.browser.log.gotos.at(-1), /^http:\/\/127\.0\.0\.1:\d+\/tv\//);
    assert.deepEqual(s.browser.log.evaluated.filter(c => c.op === 'play').at(-1), {op: 'play', video: {videoId: ID, start: 0}});
  } finally { await s.tv.close(); await s.cleanup(); }
});

test('the video ducks while the conversation is audible and comes back after a quiet moment', async () => {
  let audible = false;
  const s = await session({audible: async () => audible});
  try {
    await s.tv.start(); s.tv.setEnabled(true);
    await s.command('open'); await tick();
    s.browser.send({type: 'pick', text: ID}); await tick(); await s.tv.queue;
    audible = true; await tick(450);
    assert.deepEqual(s.browser.log.evaluated.filter(c => c.op === 'duck').at(-1), {op: 'duck', on: true});
    audible = false; await tick(300);
    assert.equal(s.browser.log.evaluated.filter(c => c.op === 'duck').at(-1).on, true, 'held for a moment');
    s.advance(1500); await tick(300);
    assert.deepEqual(s.browser.log.evaluated.filter(c => c.op === 'duck').at(-1), {op: 'duck', on: false});
  } finally { await s.tv.close(); await s.cleanup(); }
});

test('the Data API key: validated, saved, forgotten; history keeps 8 videos for 30 days at most', async () => {
  const s = await session();
  try {
    await s.tv.start(); s.tv.setEnabled(true);
    await s.command('open'); await tick();
    s.browser.send({type: 'key', key: 'nope'}); await tick(); await s.tv.queue;
    assert.equal(s.browser.log.evaluated.at(-1).text, 'That does not look like a YouTube Data API key.');
    const key = 'AIza' + 'k'.repeat(35);
    s.browser.send({type: 'key', key}); await tick(); await s.tv.queue;
    assert.equal(await s.tv.dataApiKey(), key);
    s.browser.send({type: 'pick', text: ID}); await tick(); await s.tv.queue; await tick();
    assert(s.asked.some(url => url.includes('googleapis.com') && url.includes('key=AIza')), 'with a key the Data API is asked');
    s.browser.send({type: 'forget-key'}); await tick(); await s.tv.queue;
    assert.equal(await s.tv.dataApiKey(), '');
    const now = s.tv.now();
    const rows = Array.from({length: 12}, (_, i) => ({videoId: `abcdefghij${String.fromCharCode(65 + i)}`, title: `v${i}`, at: now - i * 1000}));
    rows.push({videoId: 'zzzzzzzzzzz', title: 'old', at: now - 31 * 24 * 3600 * 1000});
    await writeFile(join(s.dir, 'youtube-tv-history.json'), JSON.stringify([rows.at(-1), ...rows.slice(0, 12)]));
    const history = await s.tv.history();
    assert.equal(history.length, 8); assert(!history.some(row => row.title === 'old'));
  } finally { await s.tv.close(); await s.cleanup(); }
});

test('a frame is only taken on demand, of a playing video', async () => {
  const s = await session();
  try {
    await s.tv.start(); s.tv.setEnabled(true);
    assert.equal(await s.tv.captureFrame(), null);
    await s.command('open'); await tick();
    assert.equal(await s.tv.captureFrame(), null, 'no video, no frame');
    s.browser.send({type: 'pick', text: ID}); await tick(); await s.tv.queue;
    assert.deepEqual(await s.tv.captureFrame(), {mime: 'image/jpeg', data: Buffer.from('jpeg').toString('base64')});
  } finally { await s.tv.close(); await s.cleanup(); }
});

test('V\'s homes are the same five places in the redscript, the Lua and the bridge', () => {
  const reds = read('../r6/scripts/CyberpunkConvai/YouTubeTv.reds'), luaSource = read('../mod/youtube-tv.lua');
  const keys = Object.keys(HOME_PLACES).sort();
  assert.deepEqual([...reds.matchAll(/Equals\(name, "([A-Za-z_]+)"\)/g)].map(m => m[1]).sort(), keys);
  assert.deepEqual([...luaSource.match(/M\.HOMES = \{([^}]+)\}/)[1].matchAll(/([A-Za-z_]+) = true/g)].map(m => m[1]).sort(), keys);
  // The page's sentences are the ones the game translates, each keyed by its own English text.
  const pairs = [...luaSource.matchAll(/put\('([^']*)',\s*ui\.t\('([^']*)'\)\)/g)];
  assert(pairs.every(([, key, text]) => key === text), 'each page string is translated under its own key');
  assert.deepEqual(pairs.map(m => m[1]), PAGE_STRINGS);
  // Every text the game shows goes through ui.t('...'), which scripts/Extract-UiCatalog.mjs catalogues.
  assert(read('../scripts/Extract-UiCatalog.mjs').includes("'mod/youtube-tv.lua'"));
  const catalog = JSON.parse(read('../localization/en.json')).strings;
  for (const [, text] of pairs) assert(catalog[text], `${text} is not in localization/en.json`);
  for (const text of ['YouTube', 'YouTube: pause or play', 'YouTube: stop', "YouTube on the TV works in V's apartments."]) assert(catalog[text], text);
});

test('the redscript adds choices only on a TV, on a direct interaction, where the game offers its own, in V\'s home, with the setting on', () => {
  const reds = read('../r6/scripts/CyberpunkConvai/YouTubeTv.reds');
  assert.match(reds, /@wrapMethod\(MediaDeviceControllerPS\)\npublic func GetActions\(out actions: array<ref<DeviceAction>>, context: GetActionsContext\) -> Bool \{/);
  assert.match(reds, /let result = wrappedMethod\(actions, context\);/);
  assert.match(reds, /if !result \|\| !IsDefined\(tv\) \|\| NotEquals\(context\.requestType, gamedeviceRequestType\.Direct\) \{ return result; \};/);
  assert.match(reds, /if mode == 0 \|\| !ToggleON\.IsDefaultConditionMet\(this, context\) \|\| !ConvaiYouTubeTvAtHome\(game\) \{ return result; \};/);
  // The game's own actions are never removed or replaced.
  assert(!/ArrayErase|ArrayClear\(actions|ArrayRemove|@replaceMethod/.test(reds));
  assert.match(reds, /public final func ConvaiYouTubeTvChoice\(choice: String\) -> Void \{\}/);
});

test('the bridge, settings and install wiring', () => {
  const bridge = read('./convai-bridge.mjs');
  assert.match(bridge, /import \{YouTubeTv\} from '\.\/youtube-tv-host\.mjs';/);
  assert.match(bridge, /block\('volatile', youtubeTv \? youtubeTv\.contextFor\(input, \{ambient: isAmbientProfile\(input\.profileKey\),/);
  assert.match(bridge, /'youtube-tv-command\.json': \(\) => youtubeTv\.poll\(\)/);
  assert.match(bridge, /if \(settings\) youtubeTv\?\.setEnabled\(settings\.youtubeTv === true\);/);
  assert.match(bridge, /clearInterval\(youtubeTimer\); await youtubeTv\.close\(\)/);
  const manager = read('../mod/manager.lua'), mcm = read('../mod/mcm.lua'), init = read('../mod/init.lua');
  assert.match(manager, /if type\(settings\.youtubeTv\) ~= 'boolean' then settings\.youtubeTv, settingsNeedSave = false, true end/);
  assert.match(manager, /or key == 'holocallLiveImage' or key == 'youtubeTv'/);
  assert.match(mcm, /setting\('youtubeTv', 'YouTube on V’s TV', 'bool', snapshot\.settings\.youtubeTv == true, false,/);
  assert.match(mcm, /key == 'youtubeTv'/);
  assert.match(init, /registerHotkey\('cyberpunk_convai_youtube_tv', 'Cyberpunk Convai: YouTube on the TV'/);
  assert.match(init, /pcall\(convaiInstallYouTubeTv\)/);
  assert.match(init, /if youtube\.active then pcall\(youtube\.update, player, worldReady\) end/);
  const files = JSON.parse(read('../scripts/development-files.json')).files.map(file => file.source);
  assert(files.includes('mod/youtube-tv.lua') && files.includes('r6/scripts/CyberpunkConvai/YouTubeTv.reds'));
});

// ---- mod/youtube-tv.lua under fengari, with the CET calls it makes faked ----
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function runLua(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = `
local writes, notices, observed, calls = {}, {}, {}, {}
STATE = nil
json = {encode = function(v) writes[#writes + 1] = v; return 'json' end, decode = function(text) return STATE end}
local realOpen = io.open
io.open = function(path, mode)
  if mode == 'wb' then return {write = function() return true end, close = function() end} end
  if path == 'runtime/youtube-tv-state.json' then
    if not STATE then return nil end
    return {read = function() return 'x' end, close = function() end}
  end
  return realOpen(path, mode)
end
ObserveAfter = function(class, method, fn) observed[class .. '.' .. method] = fn end
convaiNotices = {send = function(player, id, text) notices[#notices + 1] = id .. ':' .. text; return true end}
local player = {
  ConvaiYouTubeTvSetMode = function(self, mode) calls[#calls + 1] = 'mode=' .. mode end,
  ConvaiYouTubeTvSetLabels = function(self, a, b, c) calls[#calls + 1] = 'labels=' .. a .. '|' .. b .. '|' .. c end,
}
Game = {GetPlayer = function() return player end}
local NOW = 100
local ENABLED, AREA, MENU = true, 'LittleChina_VApartment', false
local M = (function()
${read('../mod/youtube-tv.lua')}
end)()
assert(M.install({log = function() end, ui = {t = function(text) return text end, current = function() return 'en' end},
  enabled = function() return ENABLED end, place = function() return {district = 'Watson', area = AREA} end,
  inMenu = function() return MENU end, clock = function() return NOW end}))
${body}
`;
  try {
    const result = lauxlib.luaL_dostring(state, to_luastring(program));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
    assert.equal(result, lua.LUA_OK, error);
  } finally { lua.lua_close(state); }
}

test('Lua: the setting reaches the TV choices, throttled, labels once per player', () => {
  runLua(`
M.sync(player)
assert(calls[1] == 'labels=YouTube|YouTube: pause or play|YouTube: stop' and calls[2] == 'mode=1', table.concat(calls, ','))
M.sync(player); assert(#calls == 2, 'throttled')
NOW = NOW + 3; M.sync(player); assert(#calls == 2, 'unchanged mode is not pushed again')
ENABLED = false; NOW = NOW + 3; M.sync(player); assert(calls[3] == 'mode=0', tostring(calls[3]))
`);
});

test('Lua: the TV choice opens only in V\'s home and writes the command with the page strings', () => {
  runLua(`
AREA = 'Kabuki_JudysApartment'
observed['PlayerPuppet.ConvaiYouTubeTvChoice'](player, 'open')
assert(#writes == 0 and not M.active)
AREA = 'Glen_Apartment'
observed['PlayerPuppet.ConvaiYouTubeTvChoice'](player, 'open')
assert(M.active and #writes == 1)
local open = writes[1]
assert(open.action == 'open' and open.place == 'Glen_Apartment' and open.language == 'en' and open.version == 1)
assert(open.strings['Play'] == 'Play' and type(open.issuedAt) == 'number' and open.id:match('^y%d+%-1$'))
assert(calls[#calls] == 'mode=2', 'the pause and stop choices appear')
observed['PlayerPuppet.ConvaiYouTubeTvChoice'](player, 'toggle')
assert(writes[2].action == 'toggle')
observed['PlayerPuppet.ConvaiYouTubeTvChoice'](player, 'stop')
assert(writes[3].action == 'stop' and writes[3].reason == 'player' and not M.active)
assert(calls[#calls] == 'mode=1')
`);
});

test('Lua: while a video is open, menus hide it, leaving home stops it, and the bridge\'s answer ends it', () => {
  runLua(`
M.open(player, 'tv')
MENU = true; NOW = NOW + 0.3; M.update(player, true)
assert(writes[#writes].action == 'hide' and writes[#writes].reason == 'game-menu')
NOW = NOW + 0.1; M.update(player, true); assert(writes[#writes].action == 'hide', 'once')
MENU = false; NOW = NOW + 0.3; M.update(player, true)
assert(writes[#writes].action == 'show')
STATE = {version = 1, state = 'error', reason = 'open-failed', updated = os.time() * 1000}
NOW = NOW + 1.1; M.update(player, true)
assert(not M.active and notices[1]:match('^youtube%-tv:YouTube could not open on the TV%. Use Windowed Borderless'), tostring(notices[1]))
STATE = nil
M.open(player, 'tv'); local before = #writes
AREA = 'Watson'; NOW = NOW + 1.1; M.update(player, true)
assert(writes[#writes].action == 'stop' and writes[#writes].reason == 'left-home' and not M.active)
AREA = 'LittleChina_VApartment'
M.open(player, 'tv')
STATE = {version = 1, state = 'closed', reason = 'closed-by-player', updated = os.time() * 1000}
NOW = NOW + 1.5; M.update(player, true)
assert(not M.active, 'the player closed the window')
`);
});

test('Lua: the key binding opens at home, toggles while open, and says where it works elsewhere; a load resets', () => {
  runLua(`
AREA = 'Watson'
M.hotkey(); assert(#writes == 0 and notices[1] == "youtube-tv:YouTube on the TV works in V's apartments.", tostring(notices[1]))
AREA = 'Northside_Apartment'
M.hotkey(); assert(M.active and writes[1].action == 'open')
M.hotkey(); assert(writes[2].action == 'toggle')
MENU = true; M.hotkey(); assert(#writes == 2, 'not from a menu')
M.reset('world'); assert(not M.active and writes[3].action == 'stop' and writes[3].reason == 'world')
ENABLED = false; MENU = false; M.hotkey(); assert(#writes == 3)
`);
});

// Found 2026-10-15 against the real helper: Windows PowerShell 5.1's [Console]::In.ReadLineAsync runs synchronously, so the helper
// sat waiting for a second line before it handled 'attach' while the bridge waited for 'attached'; and Edge titles the window
// "<title> - Profile 1 - Microsoft Edge", which an exact match never found.
test('the window helper answers a command while its input stays open, and finds the TV by the start of its title', {skip: process.platform !== 'win32'}, async () => {
  const source = read('./youtube-tv-window.ps1');
  assert.match(source, /StreamReader\(\[Console\]::OpenStandardInput\(\)/);
  assert.doesNotMatch(source, /\$reader = \[Console\]::In/);
  assert.match(source, /name\.StartsWith\(title \+ " - ", StringComparison\.Ordinal\)/);
  const helper = spawnWindowHelper();
  try {
    const answer = new Promise(done => helper.onEvent(event => { if (event.event === 'error' || event.event === 'attached') done(event); }));
    helper.send({op: 'attach', title: 'Cyberpunk Convai TV no-such-window-' + Date.now()});
    const event = await Promise.race([answer, new Promise(done => setTimeout(() => done({event: 'timeout'}), 20000))]);
    assert.deepEqual(event, {message: 'window-not-found', event: 'error'}, 'an answer arrives with stdin still open');
  } finally { helper.stop(); }
});
