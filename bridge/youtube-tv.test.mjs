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
  parseOembed, lookupVideo, HOME_PLACES, MAX_CONTEXT_CHARS, MAX_CAPTION_CHARS, cleanStrings, captionWindow, parseTimedText, timedTextTrack,
  trackRank, parsePlayerResponse} from './youtube-tv.mjs';
import {YouTubeTv} from './youtube-tv-host.mjs';
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

// The embedded player's own answer for the video, as headless Edge captured it on 2026-10-15 (trimmed to the fields read).
const playerAnswer = (videoId = ID) => ({videoDetails: {videoId, title: 'YouTube Developers Live: Embedded Web Player Customization',
  author: 'Google for Developers', lengthSeconds: '1344', shortDescription: 'On this week\'s show, Jeff Posnick covers the player.\n0:00 Intro\n2:10 Parameters\n9:45 Questions\nhttps://developers.google.com/youtube'},
  captions: {playerCaptionsTracklistRenderer: {captionTracks: [
    {baseUrl: 'https://www.youtube.com/api/timedtext?v=' + videoId + '&lang=en', name: {simpleText: 'English'}, languageCode: 'en'},
    {baseUrl: 'https://www.youtube.com/api/timedtext?v=' + videoId + '&lang=en&kind=asr', name: {simpleText: 'English (auto-generated)'}, languageCode: 'en', kind: 'asr'}]}}});
const json3 = JSON.stringify({wireMagic: 'pb3', events: [
  {tStartMs: 10349, dDurationMs: 1000, segs: [{utf8: 'JEFF POSNICK: Hey, everybody.'}]},
  {tStartMs: 11349, dDurationMs: 2681, segs: [{utf8: 'Welcome to this week\'s show.'}]},
  {tStartMs: 14030, dDurationMs: 10, aAppend: 1, segs: [{utf8: '\n'}]},
  {tStartMs: 14040, dDurationMs: 3000, segs: [{utf8: 'Today we '}, {utf8: 'customize the '}, {utf8: '<b>player</b> &amp; more.'}]},
  {tStartMs: 60000, dDurationMs: 4000, segs: [{utf8: 'A minute in.'}]}]});

test('metadata: oEmbed only, no key; the player\'s own answer gives description, chapters and caption tracks', async () => {
  assert.deepEqual(parseOembed({title: 'A', author_name: 'B'}), {title: 'A', channel: 'B'});
  assert.equal(parseOembed({}), null);
  const asked = [];
  const fetch = async url => { asked.push(url); return {ok: true, json: async () => ({title: 'O', author_name: 'A'})}; };
  assert.deepEqual(await lookupVideo(ID, {fetch}), {title: 'O', channel: 'A'});
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^https:\/\/www\.youtube\.com\/oembed\?format=json&url=/);
  assert.deepEqual(await lookupVideo(ID, {fetch: async () => { throw Error('offline'); }}), {});
  assert.deepEqual(await lookupVideo('bad', {fetch}), {});
  const info = parsePlayerResponse(playerAnswer(), ID);
  assert.equal(info.title, 'YouTube Developers Live: Embedded Web Player Customization');
  assert.equal(info.channel, 'Google for Developers'); assert.equal(info.duration, 1344);
  assert.deepEqual(info.chapters.map(chapter => chapter.title), ['Intro', 'Parameters', 'Questions']);
  assert.deepEqual(info.tracks, [{languageCode: 'en', auto: false, name: 'English'}, {languageCode: 'en', auto: true, name: 'English (auto-generated)'}]);
  assert.equal(parsePlayerResponse(playerAnswer('AAAAAAAAAAA'), ID), null, 'another video\'s answer is ignored');
  assert.equal(parsePlayerResponse({}, ID), null);
  // No Data API, no key anywhere.
  for (const name of ['./youtube-tv.mjs', './youtube-tv-host.mjs', './youtube-tv-page.mjs'])
    assert(!/googleapis\.com\/youtube|Data API key|dataApiKey|AIza/.test(read(name)), name);
});

test('captions: json3, XML and WebVTT tracks parse to sorted cues; the track and its rank come from the request', () => {
  const cues = parseTimedText(json3);
  assert.deepEqual(cues.map(cue => cue.text), ['JEFF POSNICK: Hey, everybody.', 'Welcome to this week\'s show.', 'Today we customize the player & more.', 'A minute in.']);
  assert.deepEqual([cues[0].start, cues[0].end], [10.349, 11.349]);
  assert.deepEqual(parseTimedText('<?xml version="1.0"?><timedtext format="3"><body><p t="2000" d="1500">Hi &amp; <s>there</s></p><p t="500" d="400">first</p></body></timedtext>')
    .map(cue => [cue.start, cue.text]), [[0.5, 'first'], [2, 'Hi & there']]);
  assert.deepEqual(parseTimedText('<transcript><text start="1.5" dur="2">It&#39;s on</text></transcript>').map(cue => [cue.start, cue.end, cue.text]), [[1.5, 3.5, "It's on"]]);
  assert.deepEqual(parseTimedText('WEBVTT\n\n00:00:01.000 --> 00:00:03.500 align:start\n<c>Hello</c> there\n\n1:02.250 --> 1:04.000\nLater').map(cue => [cue.start, cue.end, cue.text]),
    [[1, 3.5, 'Hello there'], [62.25, 64, 'Later']]);
  for (const bad of ['', '{bad', 'plain text', null, '{"events": 5}']) assert.deepEqual(parseTimedText(bad), [], String(bad));
  assert.deepEqual(timedTextTrack(`https://www.youtube.com/api/timedtext?v=${ID}&ei=x&caps=asr&lang=en&fmt=json3`), {videoId: ID, languageCode: 'en', auto: false, translated: false});
  assert.deepEqual(timedTextTrack(`https://www.youtube.com/api/timedtext?v=${ID}&lang=de&kind=asr&tlang=fr`), {videoId: ID, languageCode: 'de', auto: true, translated: true});
  assert.equal(timedTextTrack(`https://evil.example/api/timedtext?v=${ID}`), null);
  assert.equal(timedTextTrack('https://www.youtube.com/api/timedtext?v=nope'), null);
  // Written over automatic, own over translated, the game's language, then English.
  const rank = track => trackRank(track, 'de');
  assert(rank({languageCode: 'en', auto: false}) > rank({languageCode: 'de', auto: true}));
  assert(rank({languageCode: 'de', auto: false}) > rank({languageCode: 'en', auto: false}));
  assert(rank({languageCode: 'en', auto: false}) > rank({languageCode: 'fr', auto: false}));
  assert(rank({languageCode: 'fr', auto: false}) > rank({languageCode: 'de', auto: false, translated: true}));
});

test('captions: the window is the last half minute up to the position, deduplicated, newest words kept', () => {
  const cues = parseTimedText(json3);
  assert.equal(captionWindow(cues, 18), 'JEFF POSNICK: Hey, everybody. Welcome to this week\'s show. Today we customize the player & more.');
  assert.equal(captionWindow(cues, 12), 'JEFF POSNICK: Hey, everybody. Welcome to this week\'s show.', 'nothing from the future');
  assert.equal(captionWindow(cues, 61), 'A minute in.', 'older than 30 s is gone');
  assert.equal(captionWindow(cues, 5), '');
  assert.equal(captionWindow([], 5), ''); assert.equal(captionWindow(cues, NaN), '');
  const rolling = [{start: 0, end: 2, text: 'same line'}, {start: 1, end: 3, text: 'same line'}, {start: 2, end: 4, text: 'next'}];
  assert.equal(captionWindow(rolling, 4), 'same line next');
  const long = Array.from({length: 300}, (_, i) => ({start: i * 0.1, end: i * 0.1 + 0.5, text: `word${i}`}));
  const text = captionWindow(long, 30);
  assert(text.length <= MAX_CAPTION_CHARS + 1 && text.startsWith('…') && text.endsWith('word299'), text.slice(0, 40));
});

test('the watching block carries what was just said, and falls back to title, channel, chapter and description without captions', () => {
  const input = {profileKey: 'judy'};
  const captions = {cues: parseTimedText(json3), auto: false};
  const withCaptions = watchingContext(input, {...video, position: 18, captions});
  assert.match(withCaptions, /Just before this moment the video said \(from its captions\): "JEFF POSNICK: Hey, everybody\. .*customize the player & more\."/);
  assert.match(withCaptions, /"Building a cyberdeck" from the channel Deck Lab/);
  assert(withCaptions.length <= MAX_CONTEXT_CHARS);
  assert.match(watchingContext(input, {...video, position: 18, captions: {...captions, auto: true}}), /from its automatic captions, which can mishear words/);
  const without = watchingContext(input, {...video, position: 18});
  assert(!/video said/.test(without));
  assert.match(without, /chapter "Intro"/); assert.match(without, /Its description says: A full cyberdeck build from scrap\./);
  assert(!/video said/.test(watchingContext(input, {...video, position: 5, captions})), 'nothing said yet, no caption sentence');
  // Over budget the description goes first, then the captions; the first sentence always stays.
  const crowded = watchingContext(input, {...video, title: 'T'.repeat(150), position: 30, description: 'Words here. '.repeat(400),
    captions: {cues: Array.from({length: 300}, (_, i) => ({start: i * 0.1, end: i * 0.1 + 0.5, text: `word${i}`})), auto: false}});
  assert(crowded.length <= MAX_CONTEXT_CHARS, `${crowded.length}`);
  assert.match(crowded, /video said/);
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
  // The key box is gone; captions go through the player's own module.
  assert(!/id="key"|forget-key|Data API|<details/.test(html));
  assert.equal(PAGE_STRINGS.length, 11);
  assert.match(html, /player\?\.loadModule\?\.\('captions'\)/);
  assert.match(html, /case 'captions-off': hideCaptions\(\); return true;/);
});

// A fake Playwright persistent context: one page that "loads" the TV page by calling the binding from the page's origin.
function fakeBrowser() {
  const log = {evaluated: [], gotos: [], closed: false};
  let binding = null, url = 'about:blank', closeHandlers = [], navHandlers = [], responseHandlers = [];
  const frame = {url: () => url};
  const page = {
    url: () => url, isClosed: () => log.closed, mainFrame: () => frame,
    on: (name, fn) => { if (name === 'framenavigated') navHandlers.push(fn); if (name === 'response') responseHandlers.push(fn); },
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
    navigate: target => { url = target; for (const fn of navHandlers) fn(frame); },
    // A response the player in the page received: {url(), status(), headers(), body()} like Playwright's.
    respond: (from, body, {status = 200, headers = {}} = {}) => {
      const response = {url: () => from, status: () => status, headers: () => headers, body: async () => { log.bodies = (log.bodies ?? 0) + 1; return Buffer.from(body); }};
      for (const fn of responseHandlers) fn(response);
    }};
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

async function session({audible = () => false, now, captionWaitMs = 60_000} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-tv-'));
  const browser = fakeBrowser(), helper = fakeHelper();
  let clock = now ?? 1_800_000_000_000;
  const asked = [];
  const tv = new YouTubeTv({runtime: dir, stateDirectory: dir, launch: async () => browser.context, spawnHelper: () => helper.make(),
    audible, now: () => clock, log: () => {}, captionWaitMs, fetch: async url => { asked.push(url); return {ok: true, json: async () => ({title: 'Deck build', author_name: 'Deck Lab'})}; }});
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
    await writeFile(join(s.dir, 'youtube-data-api.json'), JSON.stringify({version: 1, key: 'AIza' + 'k'.repeat(35)}));
    await s.tv.start(); s.tv.setEnabled(true);
    await assert.rejects(readFile(join(s.dir, 'youtube-data-api.json')), 'a key saved by the first version is deleted');
    await s.command('open'); await tick();
    // The old key messages do nothing now.
    const before = s.browser.log.evaluated.length;
    s.browser.send({type: 'key', key: 'AIza' + 'k'.repeat(35)}); s.browser.send({type: 'forget-key'}); await tick(); await s.tv.queue;
    assert.equal(s.browser.log.evaluated.length, before);
    s.browser.send({type: 'pick', text: ID}); await tick(); await s.tv.queue; await tick();
    assert(s.asked.every(url => url.startsWith('https://www.youtube.com/oembed')), 'only oEmbed is asked');
    const now = s.tv.now();
    const rows = Array.from({length: 12}, (_, i) => ({videoId: `abcdefghij${String.fromCharCode(65 + i)}`, title: `v${i}`, at: now - i * 1000}));
    rows.push({videoId: 'zzzzzzzzzzz', title: 'old', at: now - 31 * 24 * 3600 * 1000});
    await writeFile(join(s.dir, 'youtube-tv-history.json'), JSON.stringify([rows.at(-1), ...rows.slice(0, 12)]));
    const history = await s.tv.history();
    assert.equal(history.length, 8); assert(!history.some(row => row.title === 'old'));
  } finally { await s.tv.close(); await s.cleanup(); }
});

test('captions: the player\'s own answer and caption track for the playing video are read once; others are ignored', async () => {
  const s = await session();
  try {
    await s.tv.start(); s.tv.setEnabled(true);
    await s.command('open', {language: 'en'}); await tick();
    // Before a video plays nothing is read.
    s.browser.respond(`https://www.youtube.com/api/timedtext?v=${ID}&lang=en`, json3); await tick();
    assert.equal(s.browser.log.bodies ?? 0, 0);
    s.browser.send({type: 'pick', text: ID}); await tick(); await s.tv.queue;
    // Unrelated responses never have their body read.
    s.browser.respond('https://rr1---sn.googlevideo.com/videoplayback?id=1', 'x');
    s.browser.respond('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', '{}');
    s.browser.respond(`https://www.youtube.com/api/timedtext?v=AAAAAAAAAAA&lang=en`, json3);   // another video
    await tick();
    assert.equal(s.browser.log.bodies ?? 0, 0);
    s.browser.respond('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', JSON.stringify(playerAnswer())); await tick(10);
    let snap = s.tv.snapshot();
    assert.equal(snap.chapters, 3); assert.equal(snap.duration, 1344); assert.equal(snap.captions, null);
    s.browser.respond(`https://www.youtube.com/api/timedtext?v=${ID}&lang=en&kind=asr`, json3); await tick(10);
    assert.deepEqual(s.tv.snapshot().captions, {languageCode: 'en', auto: true, cues: 4});
    // A written track replaces the automatic one; a repeat of a track already read is not read again.
    s.browser.respond(`https://www.youtube.com/api/timedtext?v=${ID}&lang=en&fmt=json3`, json3); await tick(10);
    assert.deepEqual(s.tv.snapshot().captions, {languageCode: 'en', auto: false, cues: 4});
    const bodies = s.browser.log.bodies;
    s.browser.respond(`https://www.youtube.com/api/timedtext?v=${ID}&lang=en&fmt=json3`, json3); await tick(10);
    assert.equal(s.browser.log.bodies, bodies);
    s.browser.send({type: 'time', position: 16, duration: 1344}); await tick(); await s.tv.queue;
    assert.match(s.tv.contextFor({profileKey: 'judy'}), /video said \(from its captions\): "JEFF POSNICK: Hey, everybody\. Welcome to this week's show\. Today we customize the player & more\."/);
    assert.match(s.tv.contextFor({profileKey: 'judy'}), /chapter "Intro"/);
    // Too large, or not a 200, is skipped.
    s.browser.respond(`https://www.youtube.com/api/timedtext?v=${ID}&lang=de`, json3, {headers: {'content-length': String(5 * 1024 * 1024)}});
    s.browser.respond(`https://www.youtube.com/api/timedtext?v=${ID}&lang=fr`, json3, {status: 403});
    await tick(10);
    assert.equal(s.browser.log.bodies, bodies);
    // A new video starts clean.
    s.browser.send({type: 'pick', text: 'abcdefghijk'}); await tick(); await s.tv.queue;
    snap = s.tv.snapshot();
    assert.equal(snap.captions, null); assert.equal(snap.chapters, 0);
  } finally { await s.tv.close(); await s.cleanup(); }
});

test('captions: with none fetched by the player it is asked to load one, then to hide them once read; a video without any stays without', async () => {
  const s = await session({captionWaitMs: 20});
  try {
    await s.tv.start(); s.tv.setEnabled(true);
    await s.command('open', {language: 'de'}); await tick();
    s.browser.send({type: 'pick', text: ID}); await tick(); await s.tv.queue;
    const answer = playerAnswer();
    answer.captions.playerCaptionsTracklistRenderer.captionTracks.push({languageCode: 'de', name: {simpleText: 'Deutsch'}});
    s.browser.respond('https://www.youtube.com/youtubei/v1/player', JSON.stringify(answer)); await tick(60); await s.tv.queue;
    assert.deepEqual(s.browser.log.evaluated.find(c => c.op === 'captions'), {op: 'captions', languages: ['de', 'en']});
    s.browser.respond(`https://www.youtube.com/api/timedtext?v=${ID}&lang=de`, json3); await tick(10); await s.tv.queue;
    assert.equal(s.browser.log.evaluated.at(-1).op, 'captions-off');
    assert.equal(s.browser.log.evaluated.filter(c => c.op === 'captions').length, 1, 'asked once');
    // A video whose player answer lists no tracks: never asked; the block falls back to title, chapter and description.
    s.browser.send({type: 'pick', text: 'abcdefghijk'}); await tick(); await s.tv.queue;
    const none = playerAnswer('abcdefghijk'); delete none.captions;
    s.browser.respond('https://www.youtube.com/youtubei/v1/player', JSON.stringify(none)); await tick(60); await s.tv.queue;
    assert.equal(s.browser.log.evaluated.filter(c => c.op === 'captions').length, 1);
    assert.equal(s.tv.snapshot().captionsMissing, true);
    const block = s.tv.contextFor({profileKey: 'judy'});
    assert(!/video said/.test(block)); assert.match(block, /Its description says: On this week's show, Jeff Posnick covers the player\./);
    // The page answers that the player lists none: noted.
    s.browser.send({type: 'pick', text: 'bcdefghijkl'}); await tick(60); await s.tv.queue;
    s.browser.send({type: 'captions', available: false}); await tick(); await s.tv.queue;
    assert.equal(s.tv.snapshot().captionsMissing, true);
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
