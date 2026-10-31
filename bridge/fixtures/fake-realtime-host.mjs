// Test double for realtime-host.mjs (loaded in its place by fake-hooks.mjs). It
// plays the part of Convai's speech path: reply text and PCM arrive after
// configurable delays, and a simulated renderer buffers PCM, starts only when
// the game's control allows it, and plays in real time. Every start, abort and
// audible start/end is logged with a timestamp for the scenario runner.
import {appendFileSync, existsSync, readFileSync} from 'node:fs';

const log = event => appendFileSync(process.env.FAKE_HOST_LOG, JSON.stringify({t: Date.now(), ...event}) + '\n');
// A test can hold the END of a character's line: while the file `<timings file>.hold-<characterId>` exists, the simulated renderer plays the whole line
// but does not report it drained, so the line stays "playing" however long the machine takes to run the test's check. The test removes the file to let it end.
const held = characterId => existsSync(`${process.env.FAKE_HOST_TIMINGS}.hold-${characterId}`);
const timings = () => JSON.parse(readFileSync(process.env.FAKE_HOST_TIMINGS, 'utf8'));
const aborted = () => { const error = Error('Conversation cancelled'); error.name = 'AbortError'; return error; };
const sleep = (ms, signal, wake) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  wake?.then(() => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(); });
  const stop = () => { clearTimeout(timer); reject(aborted()); };
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, {once: true});
});
const poses = duration => Array.from({length: Math.round(duration * 30) + 2}, (_, i) => {
  const values = Array(61).fill(0); values[17] = .4; return {at: i / 30, values};
});

export class RealtimeHost {
  constructor() { this.active = new Set(); this.calls = new Map(); this.pages = new Map(); }
  // A connection costs its character's connectMs (when the timings say so) the first time it is needed, and nothing once a warm()
  // opened it ahead of the turn. A page that is still opening is shared: the turn waits only for what is left.
  page(characterId, connectMs) {
    let page = this.pages.get(characterId);
    if (!page) { page = {readyAt: Date.now() + connectMs, opened: false}; this.pages.set(characterId, page); }
    return page;
  }
  async warm(config, {signal} = {}) {
    const ms = timings()[config.characterId]?.connectMs ?? 0, existed = this.pages.has(config.characterId);
    log({event: 'warm', characterId: config.characterId, existed});
    const page = this.page(config.characterId, ms);
    try { await sleep(Math.max(0, page.readyAt - Date.now()), signal); }
    catch (error) { if (!page.opened) this.pages.delete(config.characterId); throw error; }
    page.opened = true;
    return {};
  }
  async retain() {}
  async readiness() { return {present: true, ready: true}; }
  async refreshIdle() { return true; }
  async diagnostics() { return []; }
  get localPcmBusy() { return false; }
  async close() { for (const controller of this.active) controller.abort(); }
  async reply(config, {signal, liveSpeech} = {}) {
    const spec = {firstTextMs: 1100, textCompleteMs: 1400, firstPcmMs: 1500, pcmCompleteMs: 2600, audioSeconds: 4,
      text: 'A short spoken reply. It has two sentences.', ...timings()[config.characterId]};
    const call = (this.calls.get(config.characterId) ?? 0) + 1; this.calls.set(config.characterId, call);
    const token = liveSpeech?.token;
    const own = new AbortController(); this.active.add(own);
    const cancel = () => own.abort(); signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    log({event: 'reply-start', characterId: config.characterId, context: config.context, ttsEnabled: config.ttsEnabled,
      text: config.text, reaction: config.reaction?.kind, reactionEvent: config.reaction?.event});
    if (spec.connectMs) {
      const page = this.page(config.characterId, spec.connectMs), existed = page.opened;
      try { await sleep(Math.max(0, page.readyAt - Date.now()), own.signal); page.opened = true; }
      catch (error) { if (!page.opened) this.pages.delete(config.characterId); log({event: 'reply-abort', characterId: config.characterId}); throw error; }
      log({event: 'connected', characterId: config.characterId, warm: existed});
    }
    const start = Date.now();
    if (spec.failBeforeMs !== undefined && (spec.failOnCall === undefined || spec.failOnCall === call)) {
      try { await sleep(spec.failBeforeMs, own.signal); } catch (error) { log({event: 'reply-abort', characterId: config.characterId}); throw error; }
      log({event: 'reply-fail', characterId: config.characterId}); throw Error('Simulated provider failure');
    }
    let position = 0, playing = false, allowed = false, last = start, startedAudible = false, readyLogged = false;
    try {
      for (;;) {
        const now = Date.now(), elapsed = now - start, dt = (now - last) / 1000; last = now;
        const textComplete = elapsed >= spec.textCompleteMs;
        const text = elapsed < spec.firstTextMs ? '' : textComplete ? spec.text
          : spec.text.slice(0, Math.max(1, Math.floor(spec.text.length * .5)));
        const sourceFrac = elapsed < spec.firstPcmMs ? 0 : Math.min(1, (elapsed - spec.firstPcmMs) / (spec.pcmCompleteMs - spec.firstPcmMs));
        const received = spec.audioSeconds * sourceFrac, sourceComplete = sourceFrac >= 1;
        if (!playing && allowed && (received >= .4 || sourceComplete) && received > 0) playing = true;
        if (playing && allowed) position = Math.min(received, position + dt);
        const ended = sourceComplete && textComplete && position >= spec.audioSeconds - .001 && !held(config.characterId);
        // Everything of the reply has arrived and is buffered: a reply the game has not allowed to play is now ready to be heard the moment it is.
        if (sourceComplete && textComplete && !readyLogged) { readyLogged = true; log({event: 'reply-ready', characterId: config.characterId}); }
        if (position > 0 && !startedAudible) { startedAudible = true; log({event: 'play-start', characterId: config.characterId}); }
        const frames = Math.round(received * 24000);
        if (liveSpeech) {
          const snapshot = {version: 1, token, text, textComplete, sampleRate: 24000, channels: 1, receivedFrames: frames,
            receivedDuration: received, positionSeconds: Math.min(position, frames / 24000), playedFrames: Math.round(position * 24000),
            bufferedFrames: frames - Math.round(position * 24000), state: ended ? 'drained' : playing ? 'playing' : 'buffering',
            ended, error: null, underruns: 0, sourceComplete, ...(frames ? {faces: poses(received), facesFormat: 'arkit61', facesTimebase: 'audio-seconds'} : {})};
          const control = await liveSpeech.onFrame(snapshot);
          if (control) allowed = control.allow === true && control.paused !== true && control.volume > 0;
        }
        if (ended) { log({event: 'play-end', characterId: config.characterId}); break; }
        await sleep(liveSpeech?.pollMs?.() ?? 40, own.signal, liveSpeech?.wake?.());
      }
      return {text: spec.text, sessionID: 'fake-session-' + config.characterId, continuous: true, liveSpeechToken: token,
        timing: {fake: true}, streamed: true, faces: [], facesFormat: 'arkit61', facesTimebase: 'audio-seconds', captions: []};
    } catch (error) {
      log({event: 'reply-abort', characterId: config.characterId, message: error.message}); throw error;
    } finally { signal?.removeEventListener('abort', cancel); this.active.delete(own); }
  }
}
