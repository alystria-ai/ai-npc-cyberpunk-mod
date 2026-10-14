// YouTube on V's TV (docs/YOUTUBE_TV.md): the session. Nothing of it exists until the player picks YouTube on a TV in one of V's homes:
// then a local page server, one visible Edge window (the IFrame Player API page, bridge/youtube-tv-page.mjs) and the window helper
// (bridge/youtube-tv-window.ps1) start, and all three stop when the video is stopped. The game side (mod/youtube-tv.lua) writes
// runtime/youtube-tv-command.json; this module answers in runtime/youtube-tv-state.json and gives a companion's turn the
// "watching together" block (bridge/youtube-tv.mjs watchingContext). Nothing runs in the game process and nothing runs per frame.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile, rm, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {atomicFile} from './guarded-file.mjs';
import {parseTvCommand, parseVideoInput, watchingContext, lookupVideo, validDataApiKey, VIDEO_ID, cleanLine} from './youtube-tv.mjs';
import {tvPage} from './youtube-tv-page.mjs';

const HELPER = fileURLToPath(new URL('./youtube-tv-window.ps1', import.meta.url));
const HISTORY_MAX = 8, HISTORY_MAX_AGE_MS = 30 * 24 * 3600 * 1000;   // YouTube API data is kept 30 days at most
const DUCK_POLL_MS = 200, DUCK_RELEASE_MS = 1200;
const UNPLAYABLE = new Set([2, 5, 100, 101, 150, 152, 153]);

/** Starts the window helper. Returns {send(command), onEvent(fn), stop()}; the helper exits with this process. */
export function spawnWindowHelper({parentId = process.pid, log = () => {}} = {}) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-ParentId', String(parentId)],
    {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  const listeners = new Set();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let event; try { event = JSON.parse(line); } catch { continue; }
      for (const listener of listeners) { try { listener(event); } catch { /* a listener never breaks the helper */ } }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => log('window helper: ' + String(text).trim().slice(0, 300)));
  child.on('error', error => log('window helper failed to start: ' + error.message));
  child.on('exit', code => { for (const listener of listeners) { try { listener({event: 'exit', code}); } catch {} } });
  return {
    send: command => { try { if (!child.killed && child.stdin.writable) child.stdin.write(JSON.stringify(command) + '\n'); } catch {} },
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    stop: () => { try { child.stdin.end(JSON.stringify({op: 'exit'}) + '\n'); } catch {} setTimeout(() => { try { child.kill(); } catch {} }, 1500).unref?.(); },
  };
}

/** Launches the TV's browser window: Edge, visible, as an app window (no tabs or address bar), with its own profile. */
export async function launchTvBrowser({userDataDir, executablePath} = {}) {
  const {chromium} = await import('playwright');
  return chromium.launchPersistentContext(userDataDir, {
    ...(executablePath ? {executablePath} : {channel: 'msedge'}), headless: false, viewport: null,
    // The window opens off screen at a small size; the window helper puts it over the game.
    args: ['--app=about:blank', '--window-position=-32000,-32000', '--window-size=960,600',
      '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--disable-features=Translate,msEdgeSidebarV2,msUndersideButton,msHubApps,EdgeShoppingAssistant',
      '--hide-crash-restore-bubble'],
    ignoreDefaultArgs: ['--enable-automation'], handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false});
}

export class YouTubeTv {
  /**
   *   runtime, stateDirectory   the game's runtime folder (command and state files) and the project's state folder (profile, history, key)
   *   launch({userDataDir})     -> Playwright BrowserContext; spawnHelper() -> helper (tests inject fakes)
   *   audible()                 -> true while a conversation is being spoken or recorded: the video's volume ducks
   *   fetch, now, log
   */
  constructor({runtime, stateDirectory, launch = launchTvBrowser, spawnHelper = spawnWindowHelper, audible = () => false,
    fetch = globalThis.fetch, now = Date.now, log = () => {}, browserExecutable} = {}) {
    Object.assign(this, {runtime, stateDirectory, launch, spawnHelper, audible, fetch, now, log, browserExecutable});
    this.commandPath = resolve(runtime, 'youtube-tv-command.json');
    this.statePath = resolve(runtime, 'youtube-tv-state.json');
    this.historyPath = resolve(stateDirectory, 'youtube-tv-history.json');
    this.keyPath = resolve(stateDirectory, 'youtube-data-api.json');
    this.profilePath = resolve(stateDirectory, 'youtube-tv-browser');
    this.enabled = false; this.observed = null; this.handled = new Set(); this.polling = false; this.closed = false;
    this.session = null; this.video = null; this.queue = Promise.resolve();
  }
  /** The first read only records a command left by an earlier session, so it is never replayed. */
  async start() {
    this.observed = await readFile(this.commandPath, 'utf8').catch(() => '');
    await this.publish('closed');
    return this;
  }
  setEnabled(on) {
    const next = on === true;
    if (next === this.enabled) return;
    this.enabled = next;
    if (!next && this.session) this.enqueue(() => this.stop('disabled'));
  }
  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(error => this.log('error: ' + (error?.message ?? error)));
    return run;
  }
  async poll() {
    if (this.polling || this.closed || this.observed === null) return;
    this.polling = true;
    try {
      const raw = await readFile(this.commandPath, 'utf8').catch(() => '');
      if (raw === this.observed) return;
      this.observed = raw;
      const command = parseTvCommand(raw, this.now());
      if (!command || this.handled.has(command.id)) return;
      this.handled.add(command.id);
      if (this.handled.size > 64) this.handled.delete(this.handled.values().next().value);
      await this.enqueue(() => this.handle(command));
    } finally { this.polling = false; }
  }
  async handle(command) {
    if (command.action === 'open') {
      if (!this.enabled) { await this.publish('error', {reason: 'disabled'}); return; }
      this.strings = command.strings; this.place = command.place;
      if (this.session) { await this.showPicker(); return; }
      await this.open();
      return;
    }
    if (!this.session) { if (command.action !== 'hide' && command.action !== 'show') await this.publish('closed'); return; }
    switch (command.action) {
      case 'pick': await this.play(command.video); break;
      case 'toggle': await this.control(this.video?.state === 'playing' || this.video?.state === 'buffering' ? 'pause' : 'resume'); break;
      case 'pause': await this.control('pause'); break;
      case 'resume': await this.control('resume'); break;
      case 'stop': await this.stop(command.reason); break;
      case 'hide': this.session.helper.send({op: 'hide'}); this.session.hidden = true; break;
      case 'show': this.session.helper.send({op: 'show'}); this.session.hidden = false; break;
    }
  }
  async open() {
    const nonce = randomBytes(9).toString('base64url');
    const title = `Cyberpunk Convai TV ${nonce}`;
    const session = this.session = {nonce, title, page: null, context: null, server: null, helper: null, origin: '', hidden: false,
      pendingVideo: null, duckTimer: null, ducked: false, quietSince: 0, closing: false};
    await this.publish('opening');
    try {
      const hasKey = !!await this.dataApiKey();
      session.server = createServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        // The embedded player needs the page's origin as referrer (YouTube error 153 without it).
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        if (req.headers.host !== `127.0.0.1:${session.server.address()?.port}`) { res.writeHead(403).end(); return; }
        if (req.method === 'GET' && req.url === `/tv/${nonce}`) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(tvPage({title, origin: session.origin, strings: this.strings, hasKey}));
        } else res.writeHead(404).end();
      });
      await new Promise((done, fail) => { session.server.once('error', fail); session.server.listen(0, '127.0.0.1', done); });
      session.origin = `http://127.0.0.1:${session.server.address().port}`;
      session.url = `${session.origin}/tv/${nonce}`;
      // The helper compiles its Windows calls (about 1.2 s) while the browser starts.
      session.helper = this.spawnHelper({log: this.log});
      const attached = new Promise(done => {
        const off = session.helper.onEvent(event => {
          if (event.event === 'attached' || event.event === 'error' || event.event === 'exit') { off(); done(event.event === 'attached'); }
        });
      });
      session.helper.onEvent(event => this.fromHelper(session, event));
      await mkdir(this.profilePath, {recursive: true}).catch(() => {});
      session.context = await this.launch({userDataDir: this.profilePath, executablePath: this.browserExecutable});
      if (session.closing) throw Error('closed while opening');
      // Only this page may talk to the bridge: a YouTube page the player browses in the same window is ignored.
      await session.context.exposeBinding('__convaiTv', (source, message) => {
        let origin = '';
        try { origin = new URL(source?.frame?.url?.() ?? '').origin; } catch {}
        if (origin !== session.origin || this.session !== session) return false;
        void this.enqueue(() => this.fromPage(session, message));
        return true;
      });
      session.page = session.context.pages()[0] ?? await session.context.newPage();
      session.context.on('close', () => { if (this.session === session && !session.closing) void this.enqueue(() => this.stop('window-closed')); });
      // A video chosen on YouTube's own search page plays in the TV's player instead.
      session.page.on('framenavigated', frame => {
        if (frame !== session.page.mainFrame()) return;
        const url = frame.url();
        if (url.startsWith(session.origin)) return;
        const video = parseVideoInput(url);
        if (video) void this.enqueue(async () => { session.pendingVideo = video; await session.page.goto(session.url).catch(() => {}); });
      });
      await session.page.goto(session.url);
      session.helper.send({op: 'attach', title});
      if (!await attached) throw Error('the TV window could not be placed');
      session.helper.send({op: 'layout', mode: 'picker'});
      await this.publish('picking');
      this.log('opened');
    } catch (error) {
      this.log('open failed: ' + (error?.message ?? error));
      await this.teardown(session);
      await this.publish('error', {reason: 'open-failed'});
    }
  }
  async fromPage(session, message) {
    if (this.session !== session || !message || typeof message !== 'object') return;
    switch (message.type) {
      case 'loaded': {
        await this.evaluate({op: 'recent', rows: await this.history()});
        if (session.pendingVideo) { const video = session.pendingVideo; session.pendingVideo = null; await this.play(video); }
        break;
      }
      case 'pick': {
        const video = parseVideoInput(typeof message.text === 'string' ? message.text : '');
        if (!video) { await this.evaluate({op: 'message', text: this.t('That is not a YouTube link or video id.')}); break; }
        await this.play(video);
        break;
      }
      case 'search': {
        const query = typeof message.query === 'string' ? message.query.trim().slice(0, 200) : '';
        if (query) await session.page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`).catch(() => {});
        break;
      }
      case 'key': {
        const key = typeof message.key === 'string' ? message.key.trim() : '';
        if (!validDataApiKey(key)) { await this.evaluate({op: 'message', text: this.t('That does not look like a YouTube Data API key.')}); break; }
        await atomicFile(this.keyPath, JSON.stringify({version: 1, key})).catch(() => false);
        await this.evaluate({op: 'message', text: this.t('Key saved.'), ok: true});
        break;
      }
      case 'forget-key':
        await rm(this.keyPath, {force: true}).catch(() => {});
        await this.evaluate({op: 'message', text: this.t('Key forgotten.'), ok: true});
        break;
      case 'close': await this.stop('closed-by-player'); break;
      case 'ready': break;
      case 'state': {
        if (!this.video) break;
        const state = ['playing', 'paused', 'buffering', 'ended'].includes(message.state) ? message.state : null;
        if (!state) break;
        this.video.state = state;
        await this.publish(state === 'ended' ? 'ended' : state === 'paused' ? 'paused' : 'playing');
        break;
      }
      case 'time': {
        if (!this.video) break;
        if (Number.isFinite(message.position)) { this.video.position = message.position; this.video.reportedAt = this.now(); }
        if (Number.isFinite(message.duration) && message.duration > 0) this.video.duration = message.duration;
        // The player's own title (when oEmbed has not answered yet).
        if (!this.video.title) { const title = cleanLine(message.title, 160); if (title) this.video.title = title; }
        if (!this.video.channel) { const channel = cleanLine(message.channel, 80); if (channel) this.video.channel = channel; }
        break;
      }
      case 'error': {
        const code = Number(message.code) || 0;
        this.log(`player error ${code} video=${this.video?.videoId ?? '-'}`);
        if (UNPLAYABLE.has(code)) {
          this.video = null;
          await this.showPicker(this.t('This video cannot be played here. Choose another one.'));
        }
        break;
      }
      case 'autoplay-blocked': this.log('autoplay blocked'); break;
    }
  }
  fromHelper(session, event) {
    if (this.session !== session) return;
    if (event.event === 'gone' || event.event === 'exit') { if (!session.closing) void this.enqueue(() => this.stop(event.event === 'gone' ? 'window-closed' : 'helper-exit')); }
    else if (event.event === 'placed') this.log(`placed ${event.mode} ${event.w}x${event.h}`);
    else if (event.event === 'error') this.log('window: ' + String(event.message).slice(0, 200));
  }
  async play(video) {
    const session = this.session;
    if (!session || !VIDEO_ID.test(video?.videoId ?? '')) return;
    const known = (await this.history()).find(row => row.videoId === video.videoId);
    this.video = {videoId: video.videoId, state: 'buffering', position: video.start || 0, reportedAt: this.now(), duration: null,
      title: known?.title ?? '', channel: known?.channel ?? '', description: '', chapters: [], place: this.place};
    // Back on the TV page first if the player was browsing YouTube's own site.
    if (!session.page.url().startsWith(session.origin)) { session.pendingVideo = video; await session.page.goto(session.url).catch(() => {}); return; }
    await this.evaluate({op: 'play', video});
    session.helper.send({op: 'layout', mode: 'player'});
    this.startDucking(session);
    await this.publish('playing');
    this.log(`playing video=${video.videoId}`);
    const current = this.video;
    void lookupVideo(video.videoId, {fetch: this.fetch, dataApiKey: await this.dataApiKey()}).then(async info => {
      if (this.video !== current) return;
      Object.assign(current, Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined && value !== '')));
      await this.remember(current);
    });
  }
  async control(op) {
    if (!this.video) return;
    await this.evaluate({op});
  }
  async showPicker(message = '') {
    const session = this.session;
    if (!session) return;
    this.video = null; this.stopDucking(session);
    if (!session.page.url().startsWith(session.origin)) await session.page.goto(session.url).catch(() => {});
    await this.evaluate({op: 'picker', message});
    await this.evaluate({op: 'recent', rows: await this.history()});
    session.helper.send({op: 'layout', mode: 'picker'});
    await this.publish('picking');
  }
  // The companion talks or V speaks: the video drops to 30% until the talk has been quiet for a moment.
  startDucking(session) {
    if (session.duckTimer) return;
    session.duckTimer = setInterval(() => {
      if (this.session !== session) { clearInterval(session.duckTimer); return; }
      if (session.duckChecking) return;
      session.duckChecking = true;
      Promise.resolve().then(() => this.audible()).catch(() => false).then(value => {
        session.duckChecking = false;
        if (this.session !== session || !session.duckTimer) return;
        const audible = !!value, now = this.now();
        if (audible) session.quietSince = 0; else if (!session.quietSince) session.quietSince = now;
        const want = audible || (session.ducked && now - session.quietSince < DUCK_RELEASE_MS);
        if (want !== session.ducked) { session.ducked = want; void this.evaluate({op: 'duck', on: want}); }
      });
    }, DUCK_POLL_MS);
    session.duckTimer.unref?.();
  }
  stopDucking(session) { if (session?.duckTimer) { clearInterval(session.duckTimer); session.duckTimer = null; session.ducked = false; } }
  async evaluate(command) {
    const page = this.session?.page;
    if (!page || page.isClosed?.()) return false;
    try { return await page.evaluate(value => window.convaiTvControl?.(value) ?? false, command); } catch { return false; }
  }
  async stop(reason = 'stopped') {
    const session = this.session;
    if (!session) return;
    this.log(`stopped (${reason})`);
    await this.teardown(session);
    await this.publish('closed', {reason});
  }
  async teardown(session) {
    session.closing = true;
    if (this.session === session) { this.session = null; this.video = null; }
    this.stopDucking(session);
    session.helper?.stop();
    const cdp = session.cdp; session.cdp = null;
    await cdp?.detach().catch(() => {});
    await session.context?.close().catch(() => {});
    session.server?.close();
  }
  /** The state the game reads (mod/youtube-tv.lua, once a second while a session is open). */
  async publish(state, extra = {}) {
    const value = {version: 1, state, updated: this.now(), ...extra,
      ...(this.video ? {videoId: this.video.videoId} : {})};
    await atomicFile(this.statePath, JSON.stringify(value)).catch(() => false);
  }
  /** What a companion's turn learns now, or '' (see watchingContext). The position runs on from the player's last report. */
  contextFor(input, options) {
    const video = this.video;
    if (!video || !this.session) return '';
    const playing = video.state === 'playing';
    const position = Number.isFinite(video.position)
      ? video.position + (playing ? Math.max(0, this.now() - video.reportedAt) / 1000 : 0) : null;
    return watchingContext(input, {...video, position: video.duration ? Math.min(position, video.duration) : position}, options);
  }
  /** A snapshot of the playing video for diagnostics and tests (no description). */
  snapshot() {
    if (!this.video) return null;
    const {videoId, state, title, channel, duration} = this.video;
    return {videoId, state, title, channel, duration};
  }
  /**
   * One still of the player, or null: our own TV window's page, scaled to maxWidth by the browser (CDP Page.captureScreenshot with a
   * clip scale), never the game. The DevTools session is kept for the TV session (closed with it), so a frame a second costs one
   * readback and no setup.
   */
  async captureFrame({maxWidth = 640, quality = 60} = {}) {
    const session = this.session, page = session?.page;
    if (!page || !this.video || !page.url().startsWith(session.origin)) return null;
    try {
      const size = await page.evaluate(() => ({w: innerWidth, h: innerHeight}));
      const scale = Math.min(1, maxWidth / Math.max(1, size.w));
      session.cdp ??= await page.context().newCDPSession(page);
      try {
        const shot = await session.cdp.send('Page.captureScreenshot', {format: 'jpeg', quality,
          clip: {x: 0, y: 0, width: size.w, height: size.h, scale}});
        return shot?.data ? {mime: 'image/jpeg', data: shot.data} : null;
      } catch (error) { const cdp = session.cdp; session.cdp = null; await cdp?.detach().catch(() => {}); throw error; }
    } catch { return null; }
  }
  /**
   * The TV as the companions' vision source (bridge/companion-vision.mjs setScreenSource, docs/COMPANION_VISION.md): present while a
   * video is on the TV, playing while it plays and the window shows (not hidden under a menu or alt-tab, not on YouTube's own
   * pages), grab = one 640 px JPEG of the player. Companion vision decides when to grab (about once a second, only while vision is
   * on with Convai and someone is near).
   */
  visionSource() {
    const live = () => !!(this.session && !this.session.closing && this.video);
    return {
      present: () => live(),
      playing: () => live() && !this.session.hidden && this.video.state === 'playing'
        && !!this.session.page?.url?.().startsWith(this.session.origin),
      grab: async () => {
        const shot = await this.captureFrame({maxWidth: 640, quality: 60});
        return shot ? {mime: shot.mime, base64: shot.data} : null;
      },
    };
  }
  t(text) { return this.strings?.[text] ?? text; }
  async dataApiKey() {
    try { const value = JSON.parse(await readFile(this.keyPath, 'utf8')); return validDataApiKey(value?.key) ? value.key.trim() : ''; }
    catch { return ''; }
  }
  async history() {
    try {
      const rows = JSON.parse(await readFile(this.historyPath, 'utf8'));
      const cutoff = this.now() - HISTORY_MAX_AGE_MS;
      return Array.isArray(rows) ? rows.filter(row => VIDEO_ID.test(row?.videoId ?? '') && Number.isFinite(row.at) && row.at >= cutoff)
        .slice(0, HISTORY_MAX).map(row => ({videoId: row.videoId, title: cleanLine(row.title, 160) ?? '', channel: cleanLine(row.channel, 80) ?? '', at: row.at}))
        : [];
    } catch { return []; }
  }
  async remember(video) {
    const rows = (await this.history()).filter(row => row.videoId !== video.videoId);
    rows.unshift({videoId: video.videoId, title: video.title ?? '', channel: video.channel ?? '', at: this.now()});
    await atomicFile(this.historyPath, JSON.stringify(rows.slice(0, HISTORY_MAX))).catch(() => false);
  }
  /** Service shutdown. */
  async close() {
    this.closed = true;
    await this.enqueue(() => this.stop('service-stopped'));
  }
}
