import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {TransportPool, abortable, cancelled, throwIfCancelled, transportKey, SessionBindings} from './transport-pool.mjs';
import {CONNECTION_LIMIT} from './party-connections.mjs';
import {absoluteRuntimeOverride} from './runtime-paths.mjs';
import {browserMissing, browserOutputLines, launchSystemBrowser} from './system-browser.mjs';
import {LocalPcmHost} from './local-pcm-host.mjs';
import {markStage} from './turn-clock.mjs';
import {AudioRates} from './convai-audio-rates.mjs';
import {BrowserPriority} from './process-priority.mjs';

// ----------------------------------------------------------------------------------------------- the hidden browser's sandbox
// The hidden Chromium runs with its renderer sandbox on (Playwright adds --no-sandbox unless chromiumSandbox is true). A sandbox that cannot work
// on a PC (Wine or Proton, a browser on exFAT, FAT32 or a network drive, security software that injects into renderers) usually does not stop the
// browser from starting: it makes every renderer crash at its first page. So a sandboxed browser is trusted only after it has opened one blank page
// and run one line in it (a few seconds at most, once per start, never per turn). If the launch fails, hangs, or that page does not work, the browser
// is started again without the sandbox and the result is remembered: in this process (the three hosts share it) and in the state folder
// (browser-sandbox.json, per browser, 30 days), so a PC where it fails does not pay for the attempt at every start. Delete the file to try again.
// Known limit: a sandboxed audio service silenced by audio-enhancement software (Nahimic, Sonic Studio and similar) gives no error at all, so it
// cannot be detected here; CYBERPUNK_CONVAI_NO_BROWSER_SANDBOX=1 starts the browser without the sandbox (docs/CONVAI_AUDIO_STREAMING.md, "The hidden browser's sandbox").
export const SANDBOX_STATE_FILE = 'browser-sandbox.json';
export const SANDBOX_TIMEOUTS = Object.freeze({launchMs: 20_000, probeMs: 8_000, closeMs: 3_000, rememberMs: 30 * 86_400_000});
const sandboxRefusals = new Map();      // browser key -> when it was found not to work (ms), for this process
const graphicsRefusals = new Map();     // browser key -> when it was found to start only without its graphics process (ms), for this process
const sandboxFilesRead = new Set();     // state files already read in this process
const sandboxPassed = new Set();        // browsers whose sandbox passed the probe in this process (a later launch of the same one is not probed again)
let sandboxLogged = false;
const sandboxKey = options => String(options?.executablePath ?? options?.channel ?? 'default');
/** Forgets what this process learned about the sandbox (the tests). */
export function resetSandboxMemory() { sandboxRefusals.clear(); graphicsRefusals.clear(); sandboxFilesRead.clear(); sandboxPassed.clear(); sandboxLogged = false; }
function sandboxRefused(key, statePath, now) {
  if (statePath && !sandboxFilesRead.has(statePath)) {
    sandboxFilesRead.add(statePath);
    try {
      const saved = JSON.parse(readFileSync(statePath, 'utf8'));
      if (saved?.version === 1 && saved.refused && typeof saved.refused === 'object') {
        for (const [name, at] of Object.entries(saved.refused)) if (Number.isFinite(at) && !sandboxRefusals.has(name)) sandboxRefusals.set(name, at);
      }
      if (saved?.version === 1 && saved.graphicsOff && typeof saved.graphicsOff === 'object') {
        for (const [name, at] of Object.entries(saved.graphicsOff)) if (Number.isFinite(at) && !graphicsRefusals.has(name)) graphicsRefusals.set(name, at);
      }
    } catch { /* no file, or one that is not ours: the sandbox is simply tried */ }
  }
  const at = sandboxRefusals.get(key);
  if (at === undefined) return false;
  if (now - at > SANDBOX_TIMEOUTS.rememberMs) { sandboxRefusals.delete(key); return false; }
  return true;
}
// Does this browser start only without its graphics process on this PC (found out by an earlier start, 30 days)? Read after sandboxRefused, which loads the file.
function graphicsRefused(key, now) {
  const at = graphicsRefusals.get(key);
  if (at === undefined) return false;
  if (now - at > SANDBOX_TIMEOUTS.rememberMs) { graphicsRefusals.delete(key); return false; }
  return true;
}
const saveSandboxState = (statePath, reason) => {
  const temporary = `${statePath}.${process.pid}.tmp`;
  try {
    // A temporary file and a rename: a full disk leaves the old file as it was.
    writeFileSync(temporary, JSON.stringify({version: 1, refused: Object.fromEntries(sandboxRefusals), graphicsOff: Object.fromEntries(graphicsRefusals), reason: String(reason).slice(0, 160)}));
    renameSync(temporary, statePath);
  } catch {
    // Read-only or full: remembered for this process only.
    try { rmSync(temporary, {force: true}); } catch { /* nothing to remove */ }
  }
};
// `persist` false: found out in this process only (a timeout says the PC was slow, not that the sandbox cannot work: it is not written for 30 days).
function rememberSandboxRefusal(key, statePath, now, reason, persist = true) {
  sandboxRefusals.set(key, now);
  if (!statePath || !persist) return;
  saveSandboxState(statePath, reason);
}
function rememberGraphicsRefusal(key, statePath, now, reason) {
  graphicsRefusals.set(key, now); sandboxRefusals.set(key, now);
  if (statePath) saveSandboxState(statePath, reason);
}
// The browser's graphics process is not needed by a page that plays sound and shows nothing. A browser whose every start ended at once (Edge on a card whose driver the browser
// crashes on: the browser process quits with the graphics process) is started once more with it off; the arguments of that start.
export const NO_GRAPHICS_ARGUMENTS = Object.freeze(['--disable-gpu']);
const withoutGraphics = options => ({...options, args: [...(options.args ?? []), ...NO_GRAPHICS_ARGUMENTS]});
// A start that ended because the browser process went away at once (Playwright: "Target page, context or browser has been closed", "Browser closed unexpectedly", an exit code).
const browserWentAway = error => /has been closed|closed unexpectedly|process did exit|exitCode|exited/i.test(String(error?.message ?? error));
// What the last try printed, the process-exit line first (its exit code tells a crash from a refusal), then the browser's own lines.
const rescueOutput = error => {
  const lines = browserOutputLines(error?.message), exit = line => /<process did exit:/i.test(line);
  return [...lines.filter(exit), ...lines.filter(line => !exit(line))].slice(0, 4);
};
const firstLine = error => String(error?.message ?? error).split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 160) ?? 'no reason given';
const sandboxStatePathDefault = () => (process.env.NODE_TEST_CONTEXT ? null
  : resolve(process.env.CYBERPUNK_CONVAI_STATE || fileURLToPath(new URL('../runtime/', import.meta.url)), SANDBOX_STATE_FILE));
const withTimeout = (promise, ms, what) => new Promise((resolveIt, rejectIt) => {
  const timer = setTimeout(() => rejectIt(Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
  promise.then(value => { clearTimeout(timer); resolveIt(value); }, error => { clearTimeout(timer); rejectIt(error); });
});
/** One blank page that must open and run a line: the sandbox's renderer works. Closes its page. */
export async function probeBrowser(browser, ms = SANDBOX_TIMEOUTS.probeMs) {
  let page = null;
  try {
    // Opening the page is inside the limit too: a renderer that never comes up must not hang the start.
    await withTimeout((async () => {
      page = await browser.newPage();
      await page.goto('about:blank');
      if (await page.evaluate(() => 1 + 1) !== 2) throw Error('the page ran nothing');
    })(), ms, 'the first page');
  } finally {
    if (page) await Promise.race([page.close({runBeforeUnload: false}).catch(() => {}), new Promise(done => setTimeout(done, 1000).unref?.())]);
  }
}

export const PCM_MODULES = Object.freeze([
  'continuous-pcm-player.mjs', 'continuous-pcm-worklet.mjs', 'continuous-pcm-core.mjs',
  'local-pcm-client.mjs',
]);

const pageKey = transportKey;
// A recording with less audio than this (from the moment the microphone opened to the key release) holds no word.
const MIN_CAPTURED_MS = 120;
// This is the installed SDK 1.7 default, also used by the captured live trial.
// The documentation's example uses live.convai.com; do not redirect the SDK.
const CONVAI_CONNECT_URL = 'https://realtime-api.convai.com/connect';

// Source facial messages allow 120 seconds at 120 Hz, with 61 finite numbers
// per pose. Even 24-character JSON numbers fit below 24 MiB at that ceiling;
// 32 MiB leaves room for pose timestamps, metadata and bounded reply text.
// This is a transport ceiling, not a larger utterance/facial admission limit.
export const CONTINUOUS_SNAPSHOT_JSON_LIMIT = 32 * 1024 * 1024;

// How often the text of a reply that is still being written is read from the page (see evaluateSpeech, textStream).
export const TEXT_STREAM_POLL_MS = 40;

export async function continuousSnapshotForHost(page, token, signal, pcmFrom) {
  // Playwright recursively encodes every number in a returned object. Passing
  // the existing public snapshot as one JSON string avoids that cost without
  // changing a coefficient, PCM packet, device clock or ownership field.
  // pcmFrom optionally requests the facial model's next analysis PCM slice.
  if (pcmFrom !== undefined && (!Number.isSafeInteger(pcmFrom) || pcmFrom < 0)) pcmFrom = undefined;
  const raw = await abortable(page.evaluate(({token, pcmFrom}) => {
    const value = window.convaiRealtime.continuousSnapshot(token, pcmFrom);
    return value == null ? null : JSON.stringify(value);
  }, {token, pcmFrom}), signal);
  if (raw == null) return null;
  if (typeof raw !== 'string' || raw.length > CONTINUOUS_SNAPSHOT_JSON_LIMIT
      || Buffer.byteLength(raw, 'utf8') > CONTINUOUS_SNAPSHOT_JSON_LIMIT)
    throw Error('Invalid continuous browser snapshot size');
  let value;
  try { value = JSON.parse(raw); }
  catch { throw Error('Invalid continuous browser snapshot encoding'); }
  if (value !== null && (typeof value !== 'object' || Array.isArray(value)))
    throw Error('Invalid continuous browser snapshot shape');
  return value;
}

// SDK 1.7 does not serialize audio_config. Patch only its owned LiveKit connect
// request, leaving authentication, session and memory fields intact. Source
// PCM arrives before playback and is passed unchanged to one continuous sink.
// https://docs.convai.com/api-docs/api-reference/core-api-reference/live-apis-beta/audio-data-via-data-channel
export async function installConvaiAudioRoute(page, getOwner) {
  await page.route(CONVAI_CONNECT_URL, async route => {
    const request = route.request();
    if (request.url() !== CONVAI_CONNECT_URL || request.method() !== 'POST') {
      await route.continue(); return;
    }
    let postData;
    try {
      const owner = getOwner(), raw = request.postData();
      if (!owner || typeof owner.characterId !== 'string' || !owner.characterId
          || (owner.endUserId !== null && (typeof owner.endUserId !== 'string' || !owner.endUserId))
          || typeof owner.ttsEnabled !== 'boolean' || typeof raw !== 'string'
          || raw.length > 1048576) throw Error('Invalid owned connect request');
      const body = JSON.parse(raw), object = value => value && typeof value === 'object' && !Array.isArray(value);
      if (!object(body) || body.character_id !== owner.characterId
          || (body.end_user_id ?? null) !== owner.endUserId || body.transport !== 'livekit'
          || body.default_tts_enabled !== owner.ttsEnabled
          || (body.audio_config !== undefined && !object(body.audio_config))
          || (body.audio_config?.output !== undefined && !object(body.audio_config.output)))
        throw Error('Invalid owned connect request');
      postData = JSON.stringify({...body, audio_config: {...body.audio_config,
        output: {...body.audio_config?.output, audio_routing: 'data_only',
          max_chunk_duration_ms: 100, add_wav_header: false}}});
    } catch {
      // Never echo the request body, API key, user identity or session ID.
      // The SDK sees a fetch failure, and the failed lease is discarded.
      await route.abort('failed').catch(() => {}); return;
    }
    await route.continue({postData});
  });
}

// Errors that say the hidden browser, the context or the conversation page is gone (Playwright's wording): a crashed or killed browser, a page closed
// under a running call, a page that navigated. The same turn can be asked again on a fresh page; any other error is not retried here.
export const pageGone = error => /has been closed|Target closed|Target crashed|Page crashed|Execution context was destroyed|browser has disconnected/i
  .test(String(error?.message ?? ''));

// Convai closing (or failing) the realtime connection under a turn (the 'disconnect' and 'error' events of bridge/realtime-client.mjs): 4 reports in 3 days, 3 installs, 3 versions
// (2026-10-22 report 92f464e9, "Convai realtime connection closed"). Convai's side or the player's network; a turn that had received nothing yet can be asked again on a fresh connection.
export const connectionLost = error => /Convai realtime connection (?:closed|failed)/i.test(String(error?.message ?? ''));
// A microphone start or turn that failed because Convai's media server or the network did not answer (LiveKit's ConnectionError, e.g. "publication of local track timed out, no
// response from server" or "could not establish pc connection", 2026-10-22 signature 04af1621; a "Failed to fetch" at connect; or the connectionLost wording above). The player's
// microphone is fine then, so the game says to press the voice key again instead of blaming the Windows input device. Errors that carry their own code (no sound, wrong language) are never this.
export const microphoneConnectionFailure = error => {
  if (!error || typeof error !== 'object' || error.code === 'MIC_SILENT' || error.code === 'STT_LANGUAGE') return false;
  const message = String(error.message ?? '');
  return error.name === 'ConnectionError' || connectionLost(error)
    || /publication of local track timed out|could not establish pc connection|no response from server|^Failed to fetch(?![\w])/i.test(message);
};
/**
 * True when the page's diagnostics (window.convaiRealtime.diagnostics(), read right after the connection was closed) show that nothing of the reply had arrived: no text row of the character (the message events are not looked at: the player's own message may be echoed), no
 * audio packet. Unknown (no diagnostics) is false: a turn that may have been answered is never asked again, so nothing is spoken twice. Pure.
 */
export function arrivedNothing(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return false;
  const turn = diagnostics.previousTurn ?? diagnostics.turn ?? null;
  if (!turn) return true;   // lost while connecting or before the message was sent: there was no turn to answer
  const audio = turn.audio ?? null;
  return !(Number(turn.textCharacters) > 0 || Number(turn.llmRows) > 0 || Number(turn.outputRows) > 0
    || Number(audio?.byteCount) > 0 || Number(audio?.packetCount) > 0 || Number(audio?.frameCount) > 0);
}

const connectOwner = config => ({characterId: config.characterId,
  endUserId: config.endUserId ?? null, ttsEnabled: config.ttsEnabled !== false});

export async function installCompanionActionBinding(page, {isCurrent, onAction}) {
  if (typeof onAction !== 'function') return;
  await page.exposeBinding('__convaiCompanionAction', (source, message) => {
    if (!isCurrent() || source.page !== page || source.frame !== page.mainFrame() || page.isClosed()) return false;
    return onAction(message);
  });
}

export class RealtimeHost {
  // transformReply: optional, applied to every finished reply (Natural speech removes voice tags from the display text).
  // exclusive: {enabled(), limit(), peers(), retryMs}. While enabled the plan caps how many conversation connections may be
  // open at once (a player's own Convai key): limit() of them, one when absent (a free plan; a paid Gamer plan allows six).
  // A request first closes idle connections, here and in the peer hosts, least recently used first, until it fits under
  // the cap, and a "Concurrency limit reached" answer is retried once after retryMs while an old session is released.
  // onFailure(error) / onSuccess(): observers of a finished request (the bridge reads plan-limit failures from them).
  // recover(error, config): may return a changed config for one more attempt (a player's key whose plan has no room for
  // another memory user retries with the account's existing memory user, or without an identity), or nothing. It may be async.
  // guard: {check(), consume()} (bridge/shared-key-guard.mjs), the one place a turn is admitted before it reaches Convai: a
  // turn that may not run makes check() throw (the shared key's one daily cap). Opening or warming a
  // connection is not a turn. A microphone turn is checked when it begins and counted when it is finished.
  // credential(config): optional, may be async. Returns the config as it must be sent to Convai (an `authToken` from the
  // sign-in backend, or the `key`). Asked at the moment a page is called; the token is already in memory (bridge/convai-credential.mjs),
  // so a turn never waits on a network call for it. Absent: the config is sent as it is.
  // vision: optional "Companions can see" policy (bridge/companion-vision.mjs, docs/COMPANION_VISION.md):
  //   connectConfig() -> null | {transport}: whether pages connect with Convai's vision channel (read when a page is called);
  //   imagesForTurn(config, {phase: 'reply' | 'finish'}) -> images or null: the picture(s) for this turn, from memory;
  //   turnWaitMs() -> null | ms: the page's cap on waiting for Convai to buffer a picture not staged ahead.
  // audioRates: {characterId: {declared, actual}} remembered from earlier sessions, and onAudioRate(map): called when it changed (the bridge saves it). Convai's multilingual twin sends 44.1 kHz audio
  // in packets that say 24 kHz (error reports 14e50b97 and others); the first turn finds out when the statistics arrive, later turns of that character are told the rate (config.audioRate) and play right at once.
  constructor({disconnectTimeoutMs = 2500, onCompanionAction, transformReply, exclusive, onFailure, onSuccess, recover, guard, credential, vision, audioRates, onAudioRate, audioRateSeed,
    browserExecutable = process.env.CYBERPUNK_CONVAI_BROWSER,
    clientAssetsDirectory = process.env.CYBERPUNK_CONVAI_CLIENT_ASSETS,
    // The hidden browser outputs real audio in the game. Under the Node test runner (NODE_TEST_CONTEXT is set in every
    // `node --test` child) or with CYBERPUNK_CONVAI_MUTE_BROWSER=1 it stays muted, so tests never reach the player's speakers.
    muteBrowser = process.env.CYBERPUNK_CONVAI_MUTE_BROWSER === '1' || !!process.env.NODE_TEST_CONTEXT,
    launchBrowser, probeSandbox, sandboxStatePath = sandboxStatePathDefault(), sandboxTimeouts = {},
    // The level of the hidden browser's whole process tree (bridge/process-priority.mjs, docs/PROCESS_PRIORITY.md): it plays every reply and hears the microphone, so with 'high' the
    // browser, its audio service and its renderers are raised after the start and after each page. setBrowserTree replaces the PowerShell call (tests). Nothing is raised without a level.
    browserPriority = null, setBrowserTree,
    // One line a retry of a lost page writes (no character, player or text in it).
    log = line => console.error(`[CyberpunkConvai] ${line}`)} = {}) {
    this.browserExecutable = absoluteRuntimeOverride(browserExecutable, 'CYBERPUNK_CONVAI_BROWSER');
    this.clientAssetsDirectory = absoluteRuntimeOverride(clientAssetsDirectory, 'CYBERPUNK_CONVAI_CLIENT_ASSETS');
    // The real launcher is probed (see "the hidden browser's sandbox"); a launcher a test hands in is not, unless it asks for it (probeSandbox: true).
    this.probeSandbox = probeSandbox ?? launchBrowser === undefined;
    this.launchBrowser = launchBrowser ?? (options => chromium.launch(options));
    this.sandboxStatePath = sandboxStatePath; this.sandboxTimeouts = {...SANDBOX_TIMEOUTS, ...sandboxTimeouts};
    this.muteBrowser = !!muteBrowser; this.log = log;
    this.priorityKeeper = browserPriority === 'high' ? new BrowserPriority({level: 'high', log: line => this.log(line), ...(setBrowserTree ? {setTree: setBrowserTree} : {})}) : null;
    // The page keys a running turn or microphone turn owns (key -> how many). The party plan's retain() never closes these: a page that is not in
    // the plan (the other resident of a profile the plan holds one route for, a turn started while the audio service was not ready) is swept when
    // its turn is over, not out from under the call it is running.
    this.pinned = new Map();
    this.running = 0;   // calls that are starting or running (runOnce): the browser is not released under them
    this.epoch = 0; this.sessions = new SessionBindings(); this.connectOwners = new WeakMap();
    this.disconnects = new WeakMap(); this.disconnectTimeoutMs = disconnectTimeoutMs;
    this.onCompanionAction = onCompanionAction;
    this.transformReply = typeof transformReply === 'function' ? transformReply : result => result;
    this.exclusive = exclusive; this.onFailure = onFailure; this.onSuccess = onSuccess; this.recover = recover;
    this.guard = guard;
    this.credential = typeof credential === 'function' ? credential : null;
    this.vision = vision && typeof vision === 'object' ? vision : null;
    this.audioRates = new AudioRates({initial: audioRates, seed: audioRateSeed, onChange: onAudioRate, log: line => this.log(line)});
  }
  // The page config with the current vision setting applied (and any stale vision fields from the caller removed).
  withVision(config) {
    let settings = null, waitMs = null;
    try { settings = this.vision?.connectConfig?.() ?? null; waitMs = this.vision?.turnWaitMs?.() ?? null; } catch { settings = null; }
    const {vision: _vision, visionTransport: _transport, visionWaitMs: _wait, ...rest} = config ?? {};
    return settings ? {...rest, vision: true, visionTransport: settings.transport === 'upload' ? 'upload' : 'video',
      ...(Number.isFinite(waitMs) ? {visionWaitMs: waitMs} : {})} : rest;
  }
  // The picture(s) for one turn, or none. Never throws: a picture is never worth failing a turn for.
  async turnImages(config, phase) {
    if (!this.vision?.imagesForTurn || config?.freshSession || config?.reaction) return null;
    try {
      const images = await this.vision.imagesForTurn(config, {phase});
      return Array.isArray(images) && images.length ? images : null;
    } catch { return null; }
  }
  // Publishes a picture on the idle conversation page for `config` ahead of its turn (the composer is open), so Convai has
  // buffered it before the line is sent. {staged, reason}: 'no-page' while the page is not open yet, 'busy' while it serves a turn.
  async prestageVision(config, images) {
    const entry = this.pool?.entries.get(pageKey(config));
    if (!entry?.value || entry.value.isClosed()) return {staged: false, reason: 'no-page'};
    if (entry.busy) return {staged: false, reason: 'busy'};
    try {
      return await entry.value.evaluate(images => window.convaiRealtime.prestageVision
        ? window.convaiRealtime.prestageVision(images) : {staged: false, reason: 'old-client'}, images);
    } catch { return {staged: false, reason: 'failed'}; }
  }
  // Withdraws a picture staged ahead on an idle page that no turn took. Never throws.
  async unstageVision(config) {
    const entry = this.pool?.entries.get(pageKey(config));
    if (!entry?.value || entry.value.isClosed() || entry.busy) return;
    await entry.value.evaluate(() => window.convaiRealtime.unstageVision?.()).catch(() => {});
  }
  // Hands pictures to the running microphone turn while V is still talking ({staged, reason}); never throws.
  async stageVoiceVision(images, owner) {
    const lease = this.voiceLease;
    if (!lease || (owner !== undefined && lease.owner !== owner) || lease.value.isClosed()) return {staged: false, reason: 'no-recording'};
    try {
      return await lease.value.evaluate(images => window.convaiRealtime.stageVision
        ? window.convaiRealtime.stageVision(images) : {staged: false, reason: 'old-voice-client'}, images);
    } catch { return {staged: false, reason: 'failed'}; }
  }
  // Plans with a connection cap: close idle connections of this host (never `key`) and of its peers, least recently used
  // first, until `key` fits under the cap. A busy connection is never closed.
  async yieldOtherSessions(key) {
    if (!this.exclusive?.enabled?.()) return;
    let cap = 1;
    try { const value = Math.floor(Number(this.exclusive.limit?.() ?? 1)); cap = Number.isFinite(value) && value > 1 ? value : 1; } catch { cap = 1; }
    const others = [];
    for (const host of [this, ...(this.exclusive.peers?.() ?? [])]) {
      const pool = host?.pool;
      if (!pool) continue;
      for (const entry of [...pool.entries.values()]) if (!(host === this && entry.key === key)) others.push({pool, entry});
    }
    let excess = others.length - (cap - 1);
    if (excess <= 0) return;
    others.sort((a, b) => (a.entry.used ?? 0) - (b.entry.used ?? 0));
    for (const {pool, entry} of others) {
      if (excess <= 0) break;
      if (await pool.discardIdle(entry.key).catch(() => false) !== false) excess--;
    }
  }
  // A finished reply proves the key works; opening a connection or a microphone does not (a used-up plan can still connect).
  observe(promise, completesReply = true) {
    return promise.then(value => { try { if (completesReply) this.onSuccess?.(); } catch { /* an observer never fails a reply */ } return value; },
      error => { try { this.onFailure?.(error); } catch { /* an observer never fails a reply */ } throw error; });
  }
  disconnectPage(page) {
    if (!page || page.isClosed?.()) return Promise.resolve();
    this.connectOwners.delete(page);
    if (this.disconnects.has(page)) return this.disconnects.get(page);
    const task = (async () => {
      let timer;
      try {
        // Give the official SDK its normal session-end path before destroying
        // the page. This is a bounded local disconnect, not a cloud flush ack.
        await Promise.race([
          Promise.resolve().then(() => page.evaluate(async () => {
            await window.convaiRealtime?.close('Conversation ended');
          })).catch(() => {}),
          new Promise(resolve => { timer = setTimeout(resolve, this.disconnectTimeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    })();
    this.disconnects.set(page, task); return task;
  }
  // High priority for the hidden browser (docs/PROCESS_PRIORITY.md): once it has started, and again whenever a page opens (a page brings a renderer of its own, the microphone
  // tap's too). Joined and off the turn's path (bridge/process-priority.mjs BrowserPriority).
  keepBrowserPriority(browser) {
    const keeper = this.priorityKeeper;
    if (!keeper || typeof browser?.newPage !== 'function') return;
    const open = browser.newPage.bind(browser);
    browser.newPage = async (...args) => { const page = await open(...args); keeper.request(); return page; };
    keeper.request();
  }
  async disposePage(page) {
    await this.disconnectPage(page);
    await page?.close({runBeforeUnload: false}).catch(() => {});
  }
  async start({signal} = {}) {
    throwIfCancelled(signal);
    this.lastUsedAt = Date.now();
    if (this.closing) await this.closing;
    throwIfCancelled(signal);
    if (this.browser?.isConnected()) return;
    if (this.starting) return this.starting;
    const epoch = this.epoch;
    this.starting = this.initialize(epoch);
    try { await this.starting; } finally { this.starting = null; }
  }
  async initialize(epoch) {
    // A crashed browser must not leave its local server or stale leases behind.
    const previousPool = this.pool, previousLocal = this.localPcm, previousVoiceLine = this.vPcm;
    const previousBrowser = this.browser, previousServer = this.server;
    this.pool = this.localPcm = this.vPcm = this.browser = this.server = null;
    await Promise.allSettled([previousPool?.close(), previousLocal?.close(), previousVoiceLine?.close(), previousBrowser?.close()]);
    previousServer?.close();
    // One hidden browser: eight party private pages plus three optional group
    // pages. No key endpoint, microphone permission or visible user profile.
    const [bundle, ...modules] = await Promise.all([
      readFile(this.clientAssetsDirectory ? resolve(this.clientAssetsDirectory, 'realtime-client.js')
        : new URL('../runtime/realtime-client.js', import.meta.url)),
      ...PCM_MODULES.map(name => readFile(this.clientAssetsDirectory
        ? resolve(this.clientAssetsDirectory, name) : new URL(name, import.meta.url))),
    ]);
    const audioModules = new Map(PCM_MODULES
      .map((name, index) => ['/' + name, modules[index]]));
    if (epoch !== this.epoch) throw cancelled('Conversation startup cancelled');
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.headers.host !== `127.0.0.1:${server.address()?.port}`) { res.writeHead(403).end(); return; }
      if (req.url === '/client.js') {
        res.setHeader('Content-Type', 'text/javascript'); res.end(bundle);
      } else if (audioModules.has(req.url)) {
        res.setHeader('Content-Type', 'text/javascript'); res.end(audioModules.get(req.url));
      } else if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><script type="module" src="/client.js"></script>');
      } else if (req.url === '/local') {
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><script type="module" src="/local-pcm-client.mjs"></script>');
      } else res.writeHead(404).end();
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    let browser;
    try {
      // Edge, else an installed Chrome; CYBERPUNK_CONVAI_BROWSER (a developer's override) names an executable instead.
      browser = await launchSystemBrowser(browserChoice => this.launchWithSandbox({...browserChoice, headless: true,
        ...(this.muteBrowser ? {} : {ignoreDefaultArgs: ['--mute-audio']}),
        // The hidden pages play the reply (and run the Convai connection) while the game window has the focus: Chromium must not treat them as
        // background pages (timers throttled, the renderer's priority class lowered, a window it calls occluded paused), or a reply waits.
        args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows', ...(this.muteBrowser ? ['--mute-audio'] : [])]}),
      {executablePath: this.browserExecutable, log: line => console.error(`[CyberpunkConvai] ${line}`)});
      if (epoch !== this.epoch) throw cancelled('Conversation startup cancelled');
      this.browser = browser; this.server = server;
      this.keepBrowserPriority(browser);
      const createLocalPage = async () => {
        if (epoch !== this.epoch || this.closing) throw cancelled();
        const page = await browser.newPage(), origin = `http://127.0.0.1:${server.address().port}`;
        try {
          // This page has only local PCM modules. It cannot enter the SDK's
          // conversation routes, open a session or request microphone access.
          await page.route('**/*', async route => {
            const request = route.request(); let url;
            try { url = new URL(request.url()); } catch { await route.abort('failed'); return; }
            if (request.method() === 'GET' && url.origin === origin && !url.search
                && (url.pathname === '/local' || PCM_MODULES.includes(url.pathname.slice(1))))
              await route.continue();
            else await route.abort('failed');
          });
          if (epoch !== this.epoch || this.closing) throw cancelled();
          await page.goto(origin + '/local');
          this.priorityKeeper?.request();
          await page.waitForFunction(() => !!window.localPcm, undefined, {timeout: 5000});
          if (epoch !== this.epoch || this.closing) throw cancelled();
          return page;
        } catch (error) { await page.close({runBeforeUnload: false}).catch(() => {}); throw error; }
      };
      this.localPcm = new LocalPcmHost({createPage: createLocalPage, label: 'companion', levelLog: line => console.error(line)});
      // The player's own typed line (V's voice, bridge/v-voice.mjs) plays on a page of its own, so it never waits for, or takes
      // the place of, the companion's utterance. Nothing is opened until a V line is played or warmed.
      this.vPcm = new LocalPcmHost({createPage: createLocalPage, label: 'V', levelLog: line => console.error(line)});
      this.pool = new TransportPool({limit: CONNECTION_LIMIT, create: async () => {
        const page = await browser.newPage();
        try {
          await installCompanionActionBinding(page, {onAction: this.onCompanionAction,
            isCurrent: () => epoch === this.epoch && this.connectOwners.has(page)});
          await installConvaiAudioRoute(page, () => this.connectOwners.get(page));
          await page.goto(`http://127.0.0.1:${server.address().port}`);
          this.priorityKeeper?.request();
          await page.waitForFunction(() => !!window.convaiRealtime);
          return page;
        } catch (error) { await page.close().catch(() => {}); throw error; }
      }, dispose: page => this.disposePage(page)});
      if (this.retained) await this.pool.retain(this.keepKeys(), this.retained.options);
      // The microphone tap's capture page is opened ahead (a blank page, no device): the first key press then pays no page start (bridge/mic-tap.mjs).
      try { this.onStarted?.(); } catch { /* an observer never breaks the start */ }
    } catch (error) { await browser?.close(); server.close(); throw error; }
  }
  /**
   * Starts the hidden Chromium with its renderer sandbox on, and trusts it only once one blank page has opened and run a line (probeBrowser). A browser
   * that will not start that way, hangs, or whose pages die is closed and started once more without the sandbox; the reason is logged and the result is
   * remembered (module level, shared by the hosts, and on disk), so no later start tries the sandbox on that PC again. A browser that is simply not
   * there is not retried.
   */
  async launchWithSandbox(wanted) {
    const key = sandboxKey(wanted), now = Date.now();
    const log = line => { try { this.log(line); } catch { /* a log that fails changes nothing */ } };
    const noSandbox = process.env.CYBERPUNK_CONVAI_NO_BROWSER_SANDBOX === '1';
    const refused = !noSandbox && sandboxRefused(key, this.sandboxStatePath, now);   // also loads the state file, which graphicsRefused reads
    // A browser that an earlier start found to quit at once unless its graphics process is off starts that way from the first try.
    const options = graphicsRefused(key, now) ? withoutGraphics(wanted) : wanted;
    if (noSandbox) return this.launchBrowser({...options, chromiumSandbox: false});
    if (refused) {
      if (!sandboxLogged) { sandboxLogged = true; log(`The hidden browser runs without its sandbox: an earlier start found it does not work on this PC (delete ${SANDBOX_STATE_FILE} to try it again)`); }
      return this.launchWithoutSandbox(options, key, now, null);
    }
    let browser = null;
    try {
      browser = await this.launchBrowser({...options, chromiumSandbox: true, ...(this.probeSandbox ? {timeout: this.sandboxTimeouts.launchMs} : {})});
      if (this.probeSandbox && !sandboxPassed.has(key)) { await probeBrowser(browser, this.sandboxTimeouts.probeMs); sandboxPassed.add(key); }
      if (!sandboxLogged) { sandboxLogged = true; log('The hidden browser runs with its sandbox (if replies are silent, audio-enhancement software may be silencing it: CYBERPUNK_CONVAI_NO_BROWSER_SANDBOX=1 starts it without)'); }
      return browser;
    } catch (error) {
      if (browser) await Promise.race([browser.close().catch(() => {}), new Promise(done => setTimeout(done, this.sandboxTimeouts.closeMs).unref?.())]);
      if (browserMissing(error)) throw error;
      const reason = firstLine(error);
      const plain = await this.launchWithoutSandbox(options, key, now, reason);
      // A start that needed the rescue below has remembered more than the sandbox; one that did not remembers the sandbox only.
      if (!graphicsRefused(key, now)) rememberSandboxRefusal(key, this.sandboxStatePath, now, reason, !/took longer than|\btimeout\b|timed out/i.test(String(error?.message ?? error)));
      sandboxLogged = true;
      log(`The hidden browser would not work with its sandbox (${reason}); it runs without it`);
      return plain;
    }
  }
  /**
   * The start without the sandbox. A browser that goes away at once even so ("Target page, context or browser has been closed": 27 Oct 2026, Edge on an AMD RX 9070 XT, no
   * voice at all) is started once more with its graphics process off, which a page that only plays sound does not need; if that works it is remembered like the sandbox's verdict
   * and used from the first try. Whatever fails last carries the earlier reasons (`earlier`, `rescue`), which the report prints below the browser's own lines.
   */
  async launchWithoutSandbox(options, key, now, earlier) {
    const annotate = (error, extra = {}) => { try { if (earlier) error.earlier = earlier; Object.assign(error, extra); } catch { /* a frozen error stays as it is */ } return error; };
    try { return await this.launchBrowser({...options, chromiumSandbox: false}); }
    catch (error) {
      if (browserMissing(error) || !browserWentAway(error) || (options.args ?? []).includes(NO_GRAPHICS_ARGUMENTS[0])) throw annotate(error);
      let browser;
      try { browser = await this.launchBrowser({...withoutGraphics(options), chromiumSandbox: false}); }
      catch (second) { throw annotate(error, {rescue: firstLine(second), rescueLines: rescueOutput(second)}); }
      const reason = `${firstLine(error)}; it starts without its graphics process`;
      rememberGraphicsRefusal(key, this.sandboxStatePath, now, reason);
      try { this.log(`The hidden browser went away at once (${firstLine(error)}); it runs without its graphics process`); } catch { /* a log that fails changes nothing */ }
      return browser;
    }
  }
  async evaluateSpeech(page, method, config, {signal, liveSpeech, textStream, current = () => true} = {}) {
    if (this.credential) config = await abortable(Promise.resolve(this.credential(config)), signal);
    config = this.withVision(config);
    if (!liveSpeech || config?.ttsEnabled === false) {
      const textKey = textStream && method === 'reply' && typeof textStream.update === 'function' ? randomUUID() : null;
      const call = page.evaluate(({config, method}) => window.convaiRealtime[method](config), {config: textKey ? {...config, textStreamKey: textKey} : config, method});
      // A text-only reply the bridge voices while Convai is still writing it (a local voice on the Convai text route): the text so far is read
      // from the page every TEXT_STREAM_POLL_MS and handed to the reply stream, which finds the first sentence the voice can start on. The reply's
      // own result still decides the final text. A poll that fails changes nothing (the call itself reports the failure).
      if (textKey) {
        let over = false, last = '';
        const poll = (async () => {
          // Only the first sentence is read this way (the rest comes from the finished reply): the polling ends when the stream has its head, or is over.
          while (!over && !signal?.aborted && !textStream.committed && !textStream.complete) {
            try {
              // null: this page runs a client bundle older than the source (npm run build:voice) and cannot hand its text over; no polling, one line.
              const text = await page.evaluate(key => window.convaiRealtime.partialReply ? window.convaiRealtime.partialReply(key) : null, textKey);
              if (text === null) {
                if (!this.earlyTextMissing) { this.earlyTextMissing = true; try { this.log('The conversation page has no early reply text (an older voice client bundle: npm run build:voice); replies are voiced when finished'); } catch { /* a line never fails a turn */ } }
                break;
              }
              if (!over && typeof text === 'string' && text && text !== last) { last = text; textStream.update(text); }
            } catch { /* the reply call reports a real failure */ }
            if (over) break;
            await new Promise(done => { const timer = setTimeout(done, TEXT_STREAM_POLL_MS); timer.unref?.(); });
          }
        })();
        void poll.catch(() => {});
        return abortable(call.finally(() => { over = true; }), signal);
      }
      return abortable(call, signal);
    }
    const {token, onFrame} = liveSpeech;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(token) || typeof onFrame !== 'function')
      throw Error('Invalid live speech admission');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    const check = () => { throwIfCancelled(controller.signal); if (!current()) throw cancelled(); };
    let settled = false;
    // The sample rate the statistics showed for this turn's audio (the page puts it in the snapshot). A turn played live that finds out its audio is mislabelled is already playing at
    // the label's rate: it plays on to its end at that rate (the first turn of a character not yet remembered is heard at the wrong speed) and no longer fails (it used to, with
    // "Continuous speech format changed"); the character learns the rate, so every later turn of it starts right (2026-10-21 reports of 55741d05, 0.2.6).
    const seenRate = {};
    const snapshot = () => continuousSnapshotForHost(page, token, controller.signal, liveSpeech.pcmCursor?.()).then(value => {
      if (value?.token === token) {
        if (value.sampleRateCorrected) seenRate.corrected = value.sampleRateCorrected;
        if (value.sampleRateHintMissed === true) { seenRate.missed = true; seenRate.sampleRate = value.sampleRate; }
        // The corrected rate above is for the character's memory; the live speech is checked against the rate the player runs at (a correction found at the end of the
        // turn is not a format change of the audio that has been playing: it used to fail the turn with "Continuous speech format changed").
        if (Number.isInteger(value.openedSampleRate) && value.openedSampleRate !== value.sampleRate) {
          const {openedSampleRate, ...rest} = value;
          return {...rest, sampleRate: openedSampleRate};
        }
      }
      return value;
    });
    const request = Promise.resolve().then(() => {
      check();
      return page.evaluate(({config, method}) => window.convaiRealtime[method](config),
        {config: {...config, liveSpeechToken: token}, method});
    }).finally(() => { settled = true; });
    const pump = (async () => {
      while (!settled) {
        check();
        const frame = await snapshot();
        check();
        if (frame?.token === token) {
          const control = await abortable(Promise.resolve().then(() => onFrame(frame)), controller.signal);
          check();
          if (!settled && control !== undefined)
            await abortable(page.evaluate(({token, control}) => window.convaiRealtime.continuousControl(token, control), {token, control}), controller.signal);
        }
        // A look-ahead turn that is only buffering polls less often.
        if (!settled) await abortable(new Promise(resolve => {
          const timer = setTimeout(resolve, liveSpeech.pollMs?.() ?? 40);
          // Released from its hold: poll at once instead of finishing the slow wait.
          liveSpeech.wake?.()?.then(() => { clearTimeout(timer); resolve(); });
        }), controller.signal);
      }
      return request;
    })();
    try {
      const result = await abortable(Promise.race([request, pump]), controller.signal);
      await abortable(pump, controller.signal);
      check();
      // Preserve the last drain acknowledgement before releasing this page.
      const final = await snapshot();
      check();
      if (final?.token === token) await abortable(Promise.resolve().then(() => onFrame(final)), controller.signal);
      check();
      return result;
    } finally {
      settled = true; controller.abort(); signal?.removeEventListener('abort', cancel);
      if (seenRate.corrected || seenRate.missed) this.audioRates.learn(config, {sampleRateCorrected: seenRate.corrected, sampleRateHintMissed: seenRate.missed, sampleRate: seenRate.sampleRate});
      // Both promises remain observed even when a failed callback wins first.
      void pump.catch(() => {}); void request.catch(() => {});
    }
  }
  run(config, method, options = {}) {
    const attempt = async () => {
      // One admission per turn; the recovery retries below repeat the same turn.
      if (method !== 'warm' && this.guard) { this.guard.check(config); this.guard.consume(config); }
      let current = config, waited = false, lost = false, dropped = false;
      for (let retries = 0; ; retries++) {
        const epoch = this.epoch;
        try { return await this.runOnce(current, method, options); }
        catch (error) {
          if (retries >= 2 || options.signal?.aborted) throw error;
          // The page (or the whole hidden browser) went away under the call. If this host closed it on purpose (a world reset, a key or provider change)
          // the turn was cancelled, not broken. Otherwise it was a crash, a kill or a close we did not ask for (2026-10-20 report 94bc8efa4ebda288, two
          // turns in a row failed 2 s in): the failed page is already discarded and a lost browser starts again, so the same turn is asked once more.
          if (pageGone(error)) {
            if (epoch !== this.epoch || this.closing) throw cancelled();
            if (!lost) {
              lost = true;
              try { this.log('The conversation page closed during a turn; opening it again and asking once more'); } catch { /* a log line never fails a turn */ }
              continue;
            }
          }
          // Convai closed the connection before anything of the reply arrived (markEarlyDisconnect): asked once more on a fresh connection, then it fails as before. Nothing had been
          // received, so nothing is spoken or written twice; the admission above is not charged again.
          if (error?.beforeReply === true && !dropped && !options.discard) {
            if (epoch !== this.epoch || this.closing) throw cancelled();
            dropped = true;
            try { this.log('Convai closed the connection before the reply began; opening a new one and asking once more'); } catch { /* a log line never fails a turn */ }
            continue;
          }
          if (!waited && this.exclusive?.enabled?.() && /concurrency limit/i.test(String(error?.message))) {
            waited = true;
            await abortable(new Promise(resolve => setTimeout(resolve, this.exclusive.retryMs ?? 1500)), options.signal);
            continue;
          }
          let changed; try { changed = await this.recover?.(error, current); } catch { changed = undefined; }
          if (!changed) throw error;
          current = changed;
        }
      }
    };
    return this.observe(attempt(), method !== 'warm');
  }
  async runOnce(config, method, options = {}) {
    // A call that is starting or running keeps the browser open (releaseIfIdle / releaseIdlePages look at this).
    this.running = (this.running ?? 0) + 1;
    try { return await this.runOnceCounted(config, method, options); } finally { this.running--; }
  }
  async runOnceCounted(config, method, {signal, discard = false, onAudioChunk, liveSpeech, textStream} = {}) {
    throwIfCancelled(signal);
    config = {...config}; // Keep queued work bound to the identity admitted now.
    // Retire the old per-file chunk capability. Only an explicit liveSpeech
    // admission can authorize the continuous renderer on this leased page.
    delete config.audioStreamToken;
    delete config.liveSpeechToken;
    if (onAudioChunk !== undefined) throw Error('Chunked Convai playback is retired; use liveSpeech or the complete reply audio');
    const key = pageKey(config);
    this.sessions.check(config);
    // A turn's picture comes from the in-memory frame buffer (bridge/companion-vision.mjs); nothing is captured here.
    const pictures = method === 'reply' ? this.turnImages(config, 'reply') : null;
    const started = performance.now();
    await this.start({signal});
    throwIfCancelled(signal);
    const startupMs = performance.now() - started, epoch = this.epoch;
    await this.yieldOtherSessions(key);
    throwIfCancelled(signal);
    const waiting = performance.now(), unpin = this.pin(key);
    let lease;
    try { lease = await this.pool.acquire(key, {signal}); } catch (error) { unpin(); throw error; }
    const poolWaitMs = performance.now() - waiting;
    const cancel = () => { this.connectOwners.delete(lease.value); void lease.release({discard: true}).catch(() => {}); };
    signal?.addEventListener('abort', cancel, {once: true});
    let failed = true;
    try {
      throwIfCancelled(signal);
      if (epoch !== this.epoch) throw cancelled();
      this.connectOwners.set(lease.value, connectOwner(config));
      const images = await pictures;
      throwIfCancelled(signal);
      if (images) config.visionImages = images;
      let result;
      try {
        result = await this.evaluateSpeech(lease.value, method, this.audioRates.forConfig(config), {signal, liveSpeech, textStream,
          current: () => epoch === this.epoch && !this.closing});
      } catch (error) {
        // Only on a failure, and only for the connection Convai closed: one short look at the page (never on the way to a normal reply).
        if (method === 'reply' && !discard) await this.markEarlyDisconnect(lease.value, error, signal);
        throw error;
      }
      throwIfCancelled(signal);
      if (epoch !== this.epoch) throw cancelled();
      if (method === 'reply') this.audioRates.learn(config, result);
      this.sessions.accept(config);
      this.sessions.bind(config, result.sessionID);
      failed = false;
      const host = {browserStartupMs: startupMs, poolWaitMs, pageReused: lease.reused, pages: this.pool?.entries.size || 0};
      return method === 'warm' ? {...result, ...host} : this.transformReply({...result, timing: {...result.timing, ...host}});
    } finally {
      signal?.removeEventListener('abort', cancel);
      try { await lease.release({discard: discard || failed || signal?.aborted}); } finally { unpin(); }
    }
  }
  // Convai closed the connection under a text turn: if the page says nothing of the reply had arrived, the error is marked so run() asks once more on a fresh connection. The look is capped
  // at a second and never throws. A speculative turn (discard) is not asked again: nobody is waiting for it.
  async markEarlyDisconnect(page, error, signal) {
    if (!error || typeof error !== 'object' || signal?.aborted || !connectionLost(error) || page.isClosed?.()) return;
    let timer;
    try {
      const value = await Promise.race([page.evaluate(() => window.convaiRealtime.diagnostics()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 1000); })]);
      if (arrivedNothing(value)) error.beforeReply = true;
    } catch { /* unknown: not asked again */ } finally { clearTimeout(timer); }
  }
  reply(config, options) { return this.run(config, 'reply', options); }
  warm(config, options) { return this.run(config, 'warm', options); }
  // True while a local PCM turn still owns the single renderer page, including
  // its drain and retirement after the audible end.
  get localPcmBusy() { return !!this.localPcm?.active; }
  // Starts the hidden browser and opens the local voice's renderer page before the first turn needs it (about a second on a cold
  // start, which a text route otherwise pays in front of its first reply). Never throws and never interrupts a turn.
  async prewarmLocal({signal} = {}) {
    try {
      await this.start({signal});
      return await (this.localPcm?.warm?.() ?? false);
    } catch { return false; }
  }
  // A turn that will be voiced through the local renderer (Pocket, Voxtral) has started: open the page and a silent output device now,
  // while the model thinks, so the renderer is not what the first sound waits for (LocalPcmHost.standby). Never throws.
  async standbyLocal({signal} = {}) {
    try {
      await this.start({signal});
      return await (this.localPcm?.standby?.() ?? false);
    } catch { return false; }
  }
  async playLocalPcm(config, producer, options = {}) {
    const {signal, current = () => true} = options;
    throwIfCancelled(signal);
    await abortable(this.start({signal}), signal);
    markStage('browserReady');
    throwIfCancelled(signal);
    const epoch = this.epoch, local = this.localPcm;
    if (!local || this.closing) throw cancelled();
    // A page being released a moment ago (releaseRendererPages) finishes closing first; the turn then opens its own.
    if (local.closing) await abortable(local.closing.catch(() => {}), signal);
    try {
      return await local.play(config, producer, {...options,
        current: async () => epoch === this.epoch && local === this.localPcm && !this.closing && await current()});
    } finally { this.lastUsedAt = Date.now(); }
  }
  // V's voice for typed lines: the same renderer page and the same PCM format as a companion's local voice, on a second page. There
  // is no game utterance behind it (no face, lip sync or subtitle): the caller answers the renderer's clock with its own control.
  get voiceLineBusy() { return !!this.vPcm?.active; }
  async prewarmVoiceLine({signal} = {}) {
    try {
      await this.start({signal});
      return await (this.vPcm?.warm?.() ?? false);
    } catch { return false; }
  }
  async playVoiceLine(config, producer, options = {}) {
    const {signal, current = () => true} = options;
    throwIfCancelled(signal);
    await abortable(this.start({signal}), signal);
    markStage('browserReady');
    throwIfCancelled(signal);
    const epoch = this.epoch, host = this.vPcm;
    if (!host || this.closing) throw cancelled();
    if (host.closing) await abortable(host.closing.catch(() => {}), signal);
    // The line before this one may still be releasing its page (a dropped line is cut off at once, its device drain and retirement take a moment): the next line waits for it.
    if (host.active) await abortable(host.whenFree(8000, signal), signal);
    try {
      return await host.play(config, producer, {...options,
        current: async () => epoch === this.epoch && host === this.vPcm && !this.closing && await current()});
    } finally { this.lastUsedAt = Date.now(); }
  }
  // ---- Releasing what nothing uses (docs/RESOURCE_LIFECYCLE.md) ----
  // Closes a local renderer page (a Chromium renderer, an AudioContext and its worklet) that no turn owns: V's line page (`line`, when
  // V's voice is off) and/or the companions' page (`companion`, when voice playback is off). A page that owns a turn is left alone and
  // the next call tries again. The next turn or warm-up opens a page again (about a second, overlapped with the voice's first packet).
  async releaseRendererPages({line = false, companion = false} = {}) {
    const closing = [];
    for (const [wanted, host] of [[companion, this.localPcm], [line, this.vPcm]]) {
      if (wanted && host && !host.active && !host.closing && (host.page || host.warming)) closing.push(host.close());
    }
    await Promise.allSettled(closing);
    return closing.length;
  }
  // Closes the whole hidden browser (Edge: a process tree of several hundred MB with a few pages) when nothing needs it: no Convai page open in
  // the pool (the keys the party retains are only permissions to keep one), no microphone lease, no renderer turn, and nothing used it for `idleMs`. `keepRenderer` is the
  // caller's wish to keep the local voice's renderer warm (a text provider with voice playback on); the browser then stays. The next
  // use starts it again (about 0.8 s for the browser and about 1 s for the page; a composer warm-up does it before the first reply).
  // Resolves true when the browser was closed.
  async releaseIfIdle({idleMs = 300_000, keepRenderer = false, now = Date.now()} = {}) {
    if (keepRenderer || this.closing || this.starting || !this.browser || this.running > 0) return false;
    if (this.pool?.entries.size || this.voiceLease) return false;
    // The microphone tap's device lives in this browser (bridge/mic-tap.mjs): an open microphone is in use.
    if (this.micTap && (this.micTap.state !== 'closed' || this.micTap.lingering)) return false;
    for (const host of [this.localPcm, this.vPcm]) if (host && (host.active || host.warming || host.closing)) return false;
    if (now - (this.lastUsedAt ?? 0) < idleMs) return false;
    await this.close();
    return true;
  }
  prepare(config, options) {
    // A speculative session is never written back by the page or retained in
    // the pool. Only the bridge can commit its result after exact submission.
    return this.run({...config, sessionId: '-1', freshSession: true}, 'reply', {...options, discard: true});
  }
  pin(key) {
    this.pinned.set(key, (this.pinned.get(key) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return; done = true;
      const left = (this.pinned.get(key) ?? 1) - 1;
      if (left > 0) this.pinned.set(key, left); else this.pinned.delete(key);
    };
  }
  // What the pool keeps: the plan's keys and the keys of the calls running now.
  keepKeys() { return [...new Set([...this.retained.keys, ...this.pinned.keys()])]; }
  async retain(configs, options) {
    this.retained = {keys: configs.map(pageKey), options};
    await this.pool?.retain(this.keepKeys(), options);
  }
  async readiness(config, {keepAlive = false} = {}) {
    const entry = this.pool?.entries.get(pageKey(config));
    if (!entry?.value || entry.value.isClosed()) return {present: false, ready: false};
    if (entry.busy) return {present: true, busy: true};
    // A page kept alive on purpose (a phone Chat that is open) is in use: the idle release (releaseIdlePages) does not count its quiet time.
    if (keepAlive) this.pool.touch(pageKey(config));
    return {present: true, ...await entry.value.evaluate(keepAlive => window.convaiRealtime.readiness(keepAlive), keepAlive)};
  }
  /**
   * Closes the conversation pages nothing has used for `idleMs` and, when that leaves the host with nothing to serve, the hidden browser itself (a process tree of
   * several hundred MB), with the close confirmed before this resolves. The next use opens it again on demand. Resolves {pages, browser}: how many pages and
   * whether the browser were closed. Never throws.
   */
  async releaseIdlePages({idleMs = 180_000, now = Date.now()} = {}) {
    try {
      if (this.closing || this.starting || !this.browser || this.running > 0) return {pages: 0, browser: false};
      const pages = await (this.pool?.evictIdle({idleMs}) ?? 0);
      const browser = await this.releaseIfIdle({idleMs, now});
      return {pages, browser};
    } catch { return {pages: 0, browser: false}; }
  }
  // Convai's emotion for a finished text-only reply (`lateEmotionToken` in that reply), which arrives about half a
  // second after its text. Reads the reply's own page only; never connects, waits or retains anything.
  async lateEmotion(config, token) {
    if (!Number.isSafeInteger(token) || token < 1) return {};
    const page = this.pool?.entries.get(pageKey(config))?.value;
    if (!page || page.isClosed()) return {};
    try { return await page.evaluate(token => window.convaiRealtime.lateEmotion?.(token) ?? {}, token) ?? {}; }
    catch { return {}; }
  }
  async refreshIdle(config) {
    // Reconnect only the exact idle transport after new memory is seeded.
    // SessionBindings and caller-owned session IDs retain their original
    // user/save/audience ownership; refreshing a page never resets history.
    const key = pageKey(config), pool = this.pool;
    return pool ? pool.discardIdle(key) : true;
  }
  voiceChannel() {
    const owner = {}, controller = new AbortController();
    return {beginVoice: (config, extra) => this.beginVoice(config, {owner, signal: controller.signal, requestId: extra?.requestId}),
      finishVoice: (config, options) => this.finishVoice(owner, config, {...options, signal: controller.signal}),
      heard: () => this.voiceHeard(owner),
      // The key was let go: the microphone tap stops now and what it caught reaches the page before the finish (bridge/mic-tap.mjs).
      endCapture: () => this.endVoiceCapture(owner),
      close: async () => { controller.abort(); await this.cancelVoice(owner); }};
  }
  // The recognised words of the running microphone turn (empty when none): one cheap read of the voice page.
  async voiceHeard(owner = this) {
    const lease = this.voiceLease;
    if (!lease || lease.owner !== owner || lease.value.isClosed()) return '';
    try {
      const words = await lease.value.evaluate(() => window.convaiRealtime.heard ? window.convaiRealtime.heard() : null);
      // null: this page runs a voice client bundle older than the source (npm run build:voice); say so once.
      if (words === null && !this.heardBundleReported) {
        this.heardBundleReported = true;
        console.error('[CyberpunkConvai] Microphone: the voice client bundle has no live transcript yet; run npm run build:voice and restart the bridge');
      }
      return typeof words === 'string' ? words : '';
    }
    catch { return ''; }
  }
  beginVoice(config, options = {}) { return this.observe(this.beginVoiceOnce(config, options), false); }
  async beginVoiceOnce(config, {signal, owner = this, requestId} = {}) {
    throwIfCancelled(signal);
    this.guard?.check();
    config = {...config};
    delete config.audioStreamToken;
    delete config.liveSpeechToken;
    const key = pageKey(config);
    this.sessions.check(config);
    if (this.voiceLease) throw Error('Microphone connection is already running');
    await this.start({signal});
    const epoch = this.epoch;
    await this.yieldOtherSessions(key);
    throwIfCancelled(signal);
    const unpin = this.pin(key);
    let lease;
    try { lease = await this.pool.acquire(key, {signal}); } catch (error) { unpin(); throw error; }
    lease.unpin = unpin;
    try {
      throwIfCancelled(signal);
      if (epoch !== this.epoch) throw cancelled();
      if (this.voiceLease) throw Error('Microphone connection is already running');
      lease.owner = owner; lease.config = config; lease.epoch = epoch; this.voiceLease = lease;
      this.connectOwners.set(lease.value, connectOwner(config));
      // The page's own microphone path (the fallback) is the only code that grants the Convai page microphone permission.
      await lease.value.context().grantPermissions(['microphone'], {origin: new URL(lease.value.url()).origin});
      throwIfCancelled(signal);
      const credentialed = this.audioRates.forConfig(this.withVision(this.credential ? await abortable(Promise.resolve(this.credential(config)), signal) : config));
      throwIfCancelled(signal);
      // Instant push-to-talk: when the microphone tap already listens for this request (bridge/mic-tap.mjs), the page takes its audio from
      // the tap instead of opening the device itself, so what the player said while this connection opened is not lost.
      const tap = this.micTap, tapOwner = typeof requestId === 'string' ? requestId : null;
      const relay = process.env.CYBERPUNK_CONVAI_MIC_RELAY !== '0' && tap && tapOwner !== null && tap.isOwner(tapOwner);
      lease.tapOwner = relay ? tapOwner : null;
      const beginning = lease.value.evaluate(([config, options]) => window.convaiRealtime.beginVoice(config, options),
        [credentialed, {relay: !!relay, device: ''}]);
      beginning.catch(() => {});
      if (relay) lease.pump = this.startRelayPump(lease, tap, tapOwner);
      const result = await beginning;
      if (lease.pump) lease.pump.started = true;
      throwIfCancelled(signal);
      if (epoch !== this.epoch || this.voiceLease !== lease) throw cancelled();
      if (relay) {
        // The page used its own microphone after all (the relay could not open): the tap is not needed.
        if (result?.relay !== true) { lease.pump?.close(); lease.pump = null; tap.release(tapOwner, 'the page opened its own microphone'); lease.tapOwner = null; }
        else {
          // The device itself must have opened (a missing or blocked microphone fails the turn here, as it does on the other routes).
          const info = await tap.whenReady(tapOwner);
          throwIfCancelled(signal);
          if (info?.device) result.device = info.device;
          // The input the player chose was not there and the default opened: the game tells them once (bridge/local-stt-capture.mjs MIC_DEVICE_NOTE).
          if (info?.missing && !result.note) result.note = 'mic-device-gone';
        }
      }
      this.sessions.accept(config);
      this.sessions.bind(config, result.sessionID);
      lease.sessionID = result.sessionID;
      return result;
    } catch (error) {
      lease.pump?.close(); lease.pump = null;
      if (lease.tapOwner) this.micTap?.release(lease.tapOwner, 'the voice turn failed');
      try { await lease.release({discard: true}); } finally { lease.unpin(); }
      if (this.voiceLease === lease) this.voiceLease = null;
      throw error;
    }
  }
  // Hands the tap's audio (the kept part first, then every live chunk) to the page's relay in order, one call at a time. Never throws.
  startRelayPump(lease, tap, owner) {
    // `started`: the page's beginVoice has answered. Until then a refusal only means its relay is not created yet (the calls are issued in order, but
    // the page may run the first push a moment before beginVoice), so the same chunk is offered again.
    const pump = {chain: Promise.resolve(), closed: false, started: false, failed: 0, pushed: 0,
      idle() { return this.chain; },
      close() { this.closed = true; tap.detach(owner); }};
    const send = async encoded => {
      for (let attempt = 0; attempt < 150 && !pump.closed && !lease.value.isClosed(); attempt++) {
        const accepted = await lease.value.evaluate(text => window.convaiRealtime.pushAudio(text), encoded);
        if (accepted !== false) return true;
        if (pump.started) return false;
        await new Promise(done => setTimeout(done, 20));
      }
      return false;
    };
    const push = chunk => {
      if (pump.closed) return;
      const encoded = chunk.toString('base64');
      pump.chain = pump.chain.then(() => pump.closed ? true : send(encoded))
        .then(accepted => { if (accepted === false) pump.failed++; else pump.pushed += chunk.length; }, () => { pump.failed++; });
    };
    const attached = tap.attach(owner, push, {mode: 'speech'});
    if (!attached.ok) pump.closed = true;
    return pump;
  }
  // The key was let go on a relayed turn: stop the tap (its last block is flushed) and wait until the page has every chunk.
  async endVoiceCapture(owner) {
    const lease = this.voiceLease;
    if (!lease || lease.owner !== owner || !lease.pump || !lease.tapOwner) return;
    await this.micTap.stop(lease.tapOwner);
    await lease.pump.idle();
  }
  finishVoice(owner = this, config, options = {}) { return this.observe(this.finishVoiceOnce(owner, config, options)); }
  async finishVoiceOnce(owner = this, config, {signal, liveSpeech} = {}) {
    const lease = this.voiceLease;
    if (!lease || lease.owner !== owner) throw Error('Microphone connection is not running');
    this.guard?.consume();
    let failed = true;
    try {
      if (lease.epoch !== this.epoch || this.closing) throw cancelled();
      if (config !== undefined) {
        config = {...config}; delete config.audioStreamToken; delete config.liveSpeechToken;
        if (config.freshSession || transportKey(config) !== transportKey(lease.config)
            || (config.sessionId && config.sessionId !== lease.config.sessionId && config.sessionId !== lease.sessionID)) {
          throw Error('Microphone reply identity changed');
        }
        this.sessions.check(config);
      }
      // "Companions can see": the frame staged while V talked is already on the page; only queued pictures go with the finish.
      // Everything the player said is in the page before it finishes (the tap stops when the key is let go; this covers a finish that arrives first).
      if (lease.pump && lease.tapOwner) {
        await this.micTap.stop(lease.tapOwner); await lease.pump.idle();
        // A key let go before the microphone had opened (a Bluetooth headset takes 1.5 to 2.5 s) captured nothing: there is nothing to recognise, so say so now
        // instead of after Convai's 15 s recognition window (live 2026-10-24). The words of a hold this short do not exist; the player is told to speak and try again.
        if (this.micTap.streamMs < MIN_CAPTURED_MS) throw Error('No speech was heard');
      }
      let finishConfig = config || lease.config;
      const images = this.withVision(finishConfig).vision ? await this.turnImages(finishConfig, 'finish') : null;
      if (images) finishConfig = {...finishConfig, visionImages: images};
      const result = await this.evaluateSpeech(lease.value, 'finishVoice', this.audioRates.forConfig(finishConfig), {signal, liveSpeech,
        current: () => lease.epoch === this.epoch && this.voiceLease === lease && !this.closing});
      if (lease.epoch !== this.epoch || this.voiceLease !== lease) throw cancelled();
      this.audioRates.learn(finishConfig, result);
      this.sessions.accept(config || lease.config);
      this.sessions.bind(lease.config, result.sessionID);
      failed = false; return this.transformReply(result);
    }
    finally {
      lease.pump?.close(); lease.pump = null;
      if (lease.tapOwner) this.micTap?.release(lease.tapOwner, 'the voice turn ended');
      await lease.value.context().clearPermissions().catch(() => {});
      try { await lease.release({discard: failed}); } finally { lease.unpin?.(); }
      if (this.voiceLease === lease) this.voiceLease = null;
    }
  }
  async cancelVoice(owner = this) {
    const lease = this.voiceLease;
    if (!lease || lease.owner !== owner) return;
    this.voiceLease = null;
    lease.pump?.close(); lease.pump = null;
    if (lease.tapOwner) this.micTap?.release(lease.tapOwner, 'the voice turn was cancelled');
    await lease.value.context().clearPermissions().catch(() => {});
    try { await lease.release({discard: true}); } finally { lease.unpin?.(); }
  }
  close() {
    if (this.closing) return this.closing;
    this.epoch++;
    this.priorityKeeper?.cancel();
    // The microphone tap's device lives in this browser (bridge/mic-tap.mjs): it goes with it.
    try { this.onClosed?.(); } catch { /* an observer never breaks the close */ }
    this.connectOwners = new WeakMap();
    const pool = this.pool, local = this.localPcm, voiceLine = this.vPcm, browser = this.browser, server = this.server, starting = this.starting;
    this.closing = (async () => {
      // Retire every ready page in parallel; total grace is one deadline, not
      // one deadline per companion. Closing the pool immediately fences leases.
      const grace = Promise.allSettled([...pool?.entries.values() || []]
        .map(entry => this.disconnectPage(entry.value)));
      const disposing = pool?.close();
      const localDisposing = local?.close(), voiceLineDisposing = voiceLine?.close();
      await grace;
      await Promise.allSettled([disposing, localDisposing, voiceLineDisposing, browser?.close(), starting]);
      server?.close();
      this.pool = this.localPcm = this.vPcm = this.browser = this.server = this.voiceLease = null;
    })().finally(() => { this.closing = null; });
    return this.closing;
  }
  async diagnostics() {
    // Inspect existing pages only: no connection, microphone or conversation.
    // The browser getter enumerates booleans/counts and excludes all identities,
    // credentials and dialogue. Never serialize pool keys or SDK objects.
    const pages = [...this.pool?.entries.values() || []].map(entry => entry.value).slice(0, CONNECTION_LIMIT);
    return Promise.all(pages.map(async (page, index) => {
      let timer;
      try {
        const value = await Promise.race([
          page.evaluate(() => window.convaiRealtime.diagnostics()),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 2000); }),
        ]);
        return {index, value};
      } catch { return {index, unavailable: true}; }
      finally { clearTimeout(timer); }
    }));
  }
}
