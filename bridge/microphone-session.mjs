import {transportKey} from './transport-pool.mjs';
import {microphoneConnectionFailure} from './realtime-host.mjs';

/**
 * What the game reads from runtime/microphone-state.json for a failed microphone start or turn: {state, reason?, device?}.
 * A recording that held no speech is not a device fault ('no-speech'). A device that sends no sound at all is named ('silent', so the player knows which Windows input to look at).
 * No engine could recognise a recording in another language: reason 'language' (voice is English only for now). Convai's media server or the network did not answer: reason 'connection'
 * (the microphone is fine, the next press opens a fresh connection). Everything else is a plain 'error'.
 */
export function microphoneErrorState(error) {
  if (error?.code === 'MIC_SILENT') return {state: 'silent', device: String(error.device ?? '').slice(0, 80)};
  if (/No speech was heard/.test(error?.message || '')) return {state: 'no-speech'};
  if (error?.code === 'STT_LANGUAGE') return {state: 'error', reason: 'language'};
  if (microphoneConnectionFailure(error)) return {state: 'error', reason: 'connection'};
  return {state: 'error'};
}

// Context can change while V speaks; the recording's recipient cannot. Keep
// this receipt separate from the caller's input object, which may be replaced
// by a freshly verified knowledge projection at finish. The bridge retains
// ownership of its original world/session guard across both projections.
const recordingIdentity = input => JSON.stringify([input?.requestId, input?.entity, input?.generation,
  input?.profileKey, input?.channel ?? 'private', input?.group ? [input.group.id, input.group.index,
    input.group.total, [...input.group.audience].sort()] : null]);

// Hardware operations are serialized. A finish/cancel arriving while the
// device is opening is applied immediately after open completes.
export class MicrophoneSession {
  // minRecordMs: a finish that arrives sooner after the device opened (a double tap, a bouncing key) waits out the
  // rest, so a recording is never submitted empty.
  constructor({hostFactory, onState, onReply, onError, prepareReply = async () => undefined, minRecordMs = 700}) {
    Object.assign(this, {hostFactory, onState, onReply, onError, prepareReply, minRecordMs});
    this.current = null;
    this.revision = 0;
  }
  async start(input, config) {
    config = {...config};
    const identity = recordingIdentity(input), route = transportKey(config);
    const revision = ++this.revision;
    await this.release();
    if (revision !== this.revision) return;
    const session = this.current = {input, requestId: input.requestId, identity, route,
      host: this.hostFactory(input, config), intent: 'record', opened: 0, controller: new AbortController()};
    await this.onState('starting', input);
    if (this.current !== session || session.intent === 'cancel') return;
    // The request id rides beside the config (never inside it: the config keys the connection pool): the microphone tap is owned by it (bridge/mic-tap.mjs).
    session.opening = session.host.beginVoice(config, {requestId: input.requestId});
    try {
      const opened = await session.opening;
      if (this.current !== session || session.intent === 'cancel') { await session.host.close(); return; }
      session.opened = Date.now();
      if (session.intent === 'finish') return this.finish(session.requestId);
      // What the channel says about the recording (a `note` such as 'english-only', bridge/local-stt-capture.mjs) goes to the state the game reads.
      await this.onState('recording', input, opened);
    } catch (error) {
      if (this.current === session && session.intent !== 'cancel') { this.current = null; await session.host.close(); await this.onError(session.input, error); }
    }
  }
  async finish(requestId, refresh) {
    const session = this.current;
    if (!session || session.requestId !== requestId || session.finishing || session.intent === 'cancel') return;
    try {
      if (recordingIdentity(refresh === undefined ? session.input : refresh?.input) !== session.identity) {
        throw Error('Microphone context no longer matches the recording');
      }
      if (refresh !== undefined) {
        if (!refresh || !refresh.input || !refresh.config || typeof refresh.config !== 'object'
            || Array.isArray(refresh.config)
            || transportKey(refresh.config) !== session.route || refresh.config.freshSession) {
          throw Error('Microphone context no longer matches the recording');
        }
        session.input = refresh.input;
        session.finishConfig = {...refresh.config};
      }
    } catch {
      // Retire the original utterance without sending it to another route.
      session.intent = 'cancel'; session.finishing = true;
      session.controller.abort();
      await session.host.close();
      if (this.current === session) {
        this.current = null;
        await this.onError(session.input, Error('Microphone context no longer matches the recording'));
        await this.onState('off', session.input);
      }
      return;
    }
    session.intent = 'finish';
    if (!session.opened) return;
    session.finishing = true;
    const early = this.minRecordMs - (Date.now() - session.opened);
    if (early > 0) {
      await new Promise(done => setTimeout(done, early));
      if (this.current !== session || session.intent === 'cancel') return;
    }
    await this.onState('reply', session.input);
    try {
      if (this.current !== session || session.intent === 'cancel') return;
      const options = await this.prepareReply(session.input, session.controller.signal);
      if (this.current !== session || session.intent === 'cancel') return;
      const result = await session.host.finishVoice(session.finishConfig, options);
      if (this.current === session && session.intent !== 'cancel') await this.onReply(session.input, result, session.controller.signal);
    } catch (error) {
      if (this.current === session && session.intent !== 'cancel') await this.onError(session.input, error);
    } finally {
      await session.host.close();
      if (this.current === session) { this.current = null; await this.onState('off', session.input); }
    }
  }
  // The stop key was pressed for this recording: close the device now (when the host can), before the finish waits for the context
  // refresh and the minimum length. Returns the milliseconds since the device opened (null when it is not open yet or this is not
  // the current recording) so the bridge can log how long the recording ran.
  async stopCapture(requestId) {
    const session = this.current;
    if (!session || session.requestId !== requestId || session.intent === 'cancel' || !session.opened) return null;
    const ran = Date.now() - session.opened;
    if (typeof session.host.endCapture === 'function') {
      try { await session.host.endCapture(); } catch { /* finishVoice reports it */ }
    }
    return ran;
  }
  // The words recognised so far in the open recording, or '' (read-only; touches no state).
  async heard() {
    const session = this.current;
    if (!session?.opened || session.intent === 'cancel' || typeof session.host.heard !== 'function') return '';
    try { const text = await session.host.heard(); return this.current === session && typeof text === 'string' ? text : ''; }
    catch { return ''; }
  }
  async cancel() {
    ++this.revision;
    await this.release();
  }
  async release() {
    const session = this.current;
    if (!session) return;
    session.intent = 'cancel'; this.current = null;
    session.controller.abort();
    await session.host.close();
    await this.onState('off', session.input);
  }
  async tick(alive) {
    const session = this.current;
    if (!session) return;
    if (!alive) { await this.cancel(); return; }
    if (session.opened && Date.now() - session.opened >= 30000) await this.finish(session.requestId);
  }
}
