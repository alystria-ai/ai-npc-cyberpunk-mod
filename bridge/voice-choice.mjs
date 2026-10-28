// Speak dialogue choices (Settings > Voices, off by default; docs/VOICE_CHOICES.md).
//
// While the game shows its own dialogue choice list, the player can SAY a choice and it is picked. The game side (mod/voice-choices.lua) only publishes
// the list when it opens or changes (runtime/choice-hub.json: the visible captions, the highlighted one, a fingerprint) and asks the microphone to listen.
// Everything else is here:
//
//   the voice activity detector (bridge/mic-tap.mjs onVad) says the player started speaking  -> a recording takes the tap from the detected start
//   the detector says the player stopped                                                     -> the recording ends and the local recogniser (or
//                                                                                                Mistral's transcription) writes the words
//   the words are matched against the captions (bridge/voice-choice-match.mjs: no language model, microseconds)
//   a pick moves the highlight with the arrow keys and applies it with Enter (bridge/choice-keys.py), but only after the hub is read again
//   (same fingerprint) and, between the two, only when the highlight really is on the chosen line. The result of every spoken line is written to
//   runtime/choice-result.json for the game to show one short notice when nothing was picked.
//
// No conversation is involved: no character, no Convai session, no memory, no model, no reply, no voice for V. A character's turn and this never
// run together (the list is on screen, so the game's own conversation rules already keep the talk keys and Voice activation out).
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {MicrophoneSession} from './microphone-session.mjs';
import {matchChoice} from './voice-choice-match.mjs';
import {TAP} from './mic-tap.mjs';

export const HUB_FILE = 'choice-hub.json';
export const RESULT_FILE = 'choice-result.json';

const FP = /^[\w:.-]{1,80}$/;
const MAX_CHOICES = 12;

/** runtime/choice-hub.json -> {open, fp, hubId, selected, texts} or null. `texts` always has `count` entries ('' for a caption the game left empty). */
export function parseHub(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  if (value.open !== true) return {open: false, fp: typeof value.fp === 'string' && FP.test(value.fp) ? value.fp : '', hubId: null, selected: null, texts: []};
  if (typeof value.fp !== 'string' || !FP.test(value.fp) || !Array.isArray(value.texts)) return null;
  const texts = value.texts.slice(0, MAX_CHOICES).map(text => typeof text === 'string' ? text.slice(0, 400) : '');
  if (!texts.length) return null;
  const selected = Number.isSafeInteger(value.selected) && value.selected >= 0 && value.selected < texts.length ? value.selected : null;
  return {open: true, fp: value.fp, hubId: Number.isSafeInteger(value.hubId) ? value.hubId : null, selected, texts};
}

/** The keys that move the highlight from `selected` to `target` (the list does not wrap): ['down', 'down'], or null when the position is unknown. */
export function scrollKeys(selected, target, count) {
  if (!Number.isSafeInteger(selected) || !Number.isSafeInteger(target) || target < 0 || target >= count || selected < 0 || selected >= count) return null;
  return Array.from({length: Math.abs(target - selected)}, () => target > selected ? 'down' : 'up');
}

/** The key presser (bridge/choice-keys.py): one short-lived Python process per spoken choice. */
export class KeySender {
  constructor({python, script, spawnFn = spawn, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {}}) {
    Object.assign(this, {python, script, spawnFn, setTimer, clearTimer, log});
    this.child = null; this.ready = null; this.waiting = new Map(); this.seq = 0; this.dead = false; this.closed = false;
  }
  // Starts the process (called when the player starts speaking, so it is ready when the words are).
  start() {
    if (this.child || this.dead || this.closed) return;
    let child;
    try {
      child = this.child = this.spawnFn(this.python || 'python', ['-I', '-B', this.script], {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        env: {...process.env, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1'}});
    } catch (error) { this.dead = true; this.log('key presser could not start: ' + String(error?.code ?? error?.message).slice(0, 60)); return; }
    this.ready = new Promise(done => { this.onReady = done; });
    child.on('error', error => { this.dead = true; this.log('key presser failed: ' + String(error?.code ?? error?.message).slice(0, 60)); this.fail('spawn'); });
    child.on('exit', () => { this.child = null; this.fail('exited'); });
    child.stdin.on('error', () => {});
    createInterface({input: child.stdout}).on('line', line => {
      let answer; try { answer = JSON.parse(line); } catch { return; }
      if (answer?.ready) { this.onReady?.(true); return; }
      const waiting = this.waiting.get(answer?.id);
      if (waiting) { this.waiting.delete(answer.id); this.clearTimer(waiting.timer); waiting.done(answer); }
    });
  }
  fail(reason) {
    this.onReady?.(false);
    for (const [id, waiting] of this.waiting) { this.clearTimer(waiting.timer); waiting.done({ok: false, reason}); this.waiting.delete(id); }
  }
  // Presses the keys; resolves {ok, sent, reason?}.
  async send(keys, {gapMs = 70, holdMs = 45, timeoutMs = 3000} = {}) {
    if (!this.child) this.start();
    if (!this.child) return {ok: false, reason: 'unavailable'};
    if (await this.ready === false || !this.child) return {ok: false, reason: 'unavailable'};
    const id = ++this.seq;
    return new Promise(done => {
      const timer = this.setTimer(() => { this.waiting.delete(id); done({ok: false, reason: 'timeout'}); }, timeoutMs);
      timer?.unref?.();
      this.waiting.set(id, {done, timer});
      try { this.child.stdin.write(JSON.stringify({id, keys, gapMs, holdMs}) + '\n'); } catch { this.waiting.delete(id); this.clearTimer(timer); done({ok: false, reason: 'write'}); }
    });
  }
  // The process ends (nothing is resident between choices).
  quit() {
    this.closed = true;
    const child = this.child; this.child = null;
    if (!child) return;
    try { child.stdin.write(JSON.stringify({quit: true}) + '\n'); child.stdin.end(); } catch { /* it ends by itself */ }
    this.setTimer(() => { try { child.kill(); } catch { /* gone */ } }, 1500).unref?.();
    this.fail('quit');
  }
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

/**
 * deps:
 *   speech        createLocalSpeech(...): voiceChannel() is a recorder + recogniser with no reply step
 *   tap           the microphone tap (bridge/mic-tap.mjs)
 *   readHub       async () => parseHub(...)
 *   publish       async (result) => void   (runtime/choice-result.json)
 *   enabled       () => boolean            the setting
 *   makeSender    () => KeySender-like {start, send, quit}
 *   now, log, sleepFn
 */
export function createVoiceChoice({speech, tap, readHub, publish, enabled, makeSender, now = Date.now, log = () => {}, sleepFn = sleep,
  setTimer = setTimeout, clearTimer = clearTimeout, limits = {}}) {
  const cfg = {scrollWaitMs: 600, scrollPollMs: 25, maxTurnMs: 25_000, minGapMs: 400, ...limits};
  let session = null, turn = null, hub = null, boot = Date.now().toString(36), seq = 0, lastEndedAt = 0, picking = false;

  const stamp = () => boot + ':' + (++seq);
  const result = fields => ({id: stamp(), at: now(), ...fields});
  async function done(fields, reason) {
    const body = result(fields);
    try { log('voice choice: ' + body.status + (body.reason ? ' (' + body.reason + ')' : '') + (body.text ? ' "' + body.text.slice(0, 80) + '"' : '')); } catch { /* never breaks */ }
    try { await publish(body); } catch { /* the game shows no notice then */ }
    void reason;
  }
  function endTurn(sender = turn?.sender) {
    if (turn?.timer) clearTimer(turn.timer);
    try { sender?.quit?.(); } catch { /* it ends by itself */ }
    turn = null;
  }

  // The recording session: the same machinery as a voice-key turn (open, finish, cancel, the tap's hand-over), with a recogniser and no reply.
  session = new MicrophoneSession({
    hostFactory: () => speech.voiceChannel(),
    minRecordMs: 0,
    onState: (state, input) => { if (state === 'off') void tap.release(input.requestId, 'the recording is over'); },
    prepareReply: async () => undefined,
    onReply: async (input, heard) => { await onWords(input, heard); },
    onError: async (input, error) => {
      const code = error?.code, message = String(error?.message ?? '');
      const current = turn?.input === input;
      const sender = turn?.sender;
      if (current) endTurn(sender);
      if (/No speech was heard/.test(message) || code === 'MIC_SILENT') return;            // a sound that was not speech: nothing to say
      if (code === 'local-stt-unavailable' || code === 'STT_LANGUAGE') { if (current) await done({status: 'unavailable', reason: String(code)}); return; }
      if (current) await done({status: 'error', reason: message.slice(0, 80)});
    },
  });

  async function onWords(input, heard) {
    const mine = turn;
    if (!mine || mine.input !== input) return;
    const text = String(heard?.userText ?? '').trim();
    const endedAt = lastEndedAt;
    const current = await readHub();
    if (!current?.open || current.fp !== mine.fp) { endTurn(); return; }    // the list changed while the player spoke: nothing is picked
    const verdict = matchChoice(text, current.texts);
    const heardMs = endedAt ? now() - endedAt : null;
    if (verdict.status !== 'pick') {
      endTurn();
      await done({status: verdict.status, reason: verdict.reason, text, fp: current.fp, hubId: current.hubId});
      return;
    }
    picking = true;
    try {
      const outcome = await pick(mine, current, verdict.index);
      await done({status: outcome.ok ? 'pick' : 'error', reason: outcome.ok ? verdict.reason : outcome.reason, index: verdict.index, text, fp: current.fp, hubId: current.hubId,
        ...(heardMs !== null ? {ms: heardMs, totalMs: now() - endedAt} : {})});
    } finally { picking = false; endTurn(); }
  }

  // Moves the highlight to `index` and applies it. Every key press is preceded by a fresh look at the list.
  async function pick(mine, snapshot, index) {
    const sender = mine.sender;
    const plan = scrollKeys(snapshot.selected, index, snapshot.texts.length);
    if (plan === null) return {ok: false, reason: 'selection-unknown'};
    if (plan.length) {
      const moved = await sender.send(plan);
      if (!moved.ok) return {ok: false, reason: 'keys:' + moved.reason};
      const deadline = now() + cfg.scrollWaitMs;
      for (;;) {
        const check = await readHub();
        if (!check?.open || check.fp !== mine.fp) return {ok: false, reason: 'changed'};
        if (check.selected === index) break;
        if (now() >= deadline) return {ok: false, reason: 'highlight-did-not-move'};
        await sleepFn(cfg.scrollPollMs);
      }
    }
    const last = await readHub();
    if (!last?.open || last.fp !== mine.fp || last.selected !== index) return {ok: false, reason: 'changed'};
    const applied = await sender.send(['apply']);
    return applied.ok ? {ok: true} : {ok: false, reason: 'keys:' + applied.reason};
  }

  return {
    // The detector's start or end of speech (MicTap onVad).
    onVad(status) {
      if (!enabled() || !status) return;
      if (status.phase === 'speech') {
        if (turn || picking || now() - lastEndedAt < cfg.minGapMs) return;
        void begin(status);
      } else if (status.phase === 'ended' && turn) {
        lastEndedAt = now();
        void end(turn);
      }
    },
    // The list on screen changed or closed (the hub file): a recording of the old list is dropped.
    hubChanged(next) {
      hub = next;
      if (turn && !picking && (!next?.open || next.fp !== turn.fp)) cancel('the list changed');
    },
    cancel,
    get active() { return turn !== null; },
    get hub() { return hub; },
    session,
  };

  async function begin(status) {
    const snapshot = await readHub();
    if (!snapshot?.open || !enabled() || turn) return;
    const requestId = 'choice-' + stamp().replace(/[^\w-]/g, '-');
    const input = {requestId, entity: 'choice', generation: 0, profileKey: 'voice-choice', channel: 'choice'};
    const sender = makeSender();
    sender.start?.();                                  // the key presser starts while the player is still speaking
    turn = {input, requestId, fp: snapshot.fp, sender, startedAt: now(), timer: null};
    turn.timer = setTimer(() => cancel('too long'), cfg.maxTurnMs);
    turn.timer?.unref?.();
    // The recording takes the listening tap from the detected start of speech (a little before it), as a Voice activation turn does.
    const onset = tap.listening ? tap.vadStatus?.onsetMs : undefined;
    tap.open(requestId, {vad: true, ...(Number.isFinite(onset) ? {sinceMs: onset - TAP.prerollMs} : {})}).catch(() => {});
    try { await session.start(input, {requestId, profileKey: 'voice-choice', scope: 'private', ttsEnabled: false}); }
    catch (error) { log('voice choice: could not start (' + String(error?.message).slice(0, 80) + ')'); cancel('start failed'); }
  }

  async function end(mine) {
    void tap.stop(mine.requestId);
    void session.stopCapture(mine.requestId).catch(() => {});
    await session.finish(mine.requestId).catch(error => log('voice choice: finish failed (' + String(error?.message).slice(0, 80) + ')'));
  }

  function cancel(reason = 'cancelled') {
    const mine = turn;
    if (!mine) return Promise.resolve();
    endTurn(mine.sender);
    log('voice choice: dropped (' + reason + ')');
    return Promise.resolve(session.cancel()).catch(() => {});
  }
}
