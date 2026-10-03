// Local synthesis has no SDK, session or microphone capability. It feeds the
// same continuous sample reader used for provider audio through one owned page.
import {ContinuousPcmPlayer} from './continuous-pcm-player.mjs';

const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const SHA = /^[a-f0-9]{64}$/;
const OWNER = /^[a-f0-9]{32}$/;
const textValue = (value, limit) => typeof value === 'string' && value.length <= limit
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const packetIdentity = value => JSON.stringify([value.owner, value.id, value.profile, value.modelSha256]);

export class LocalPcmClient {
  constructor({createPlayer = () => new ContinuousPcmPlayer()} = {}) {
    this.createPlayer = createPlayer; this.active = null;
  }

  owned(token) {
    const turn = this.active;
    if (!turn || turn.token !== token || !turn.current) throw Error('Local PCM owner changed');
    return turn;
  }

  async begin(config) {
    if (this.active) throw Error('Local PCM playback is already owned');
    if (!config || typeof config.token !== 'string' || !TOKEN.test(config.token) || !textValue(config.text, 12000) || !config.text.trim()
        || (config.userText !== undefined && !textValue(config.userText, 1200)))
      throw Error('Invalid local PCM admission');
    const turn = {token: config.token, text: config.text, userText: config.userText,
      expressionSignal: config.expressionSignal, current: true, frames: 0, index: 0,
      sourceComplete: false, appending: false, player: this.createPlayer()};
    this.active = turn;
    try {
      await turn.player.open({token: turn.token, sampleRate: 24000, channels: 1});
      if (this.active !== turn || !turn.current) throw Error('Local PCM startup was cancelled');
      return this.snapshot(turn.token);
    } catch (error) {
      turn.current = false;
      if (this.active === turn) this.active = null;
      await turn.player.stop(); throw error;
    }
  }

  async append(packet) {
    const turn = this.owned(packet?.token);
    try {
      if (turn.sourceComplete || turn.appending || packet.version !== 1 || packet.engine !== 'pocket-tts'
          || packet.sampleRate !== 24000 || packet.channels !== 1 || packet.format !== 's16le'
          || typeof packet.owner !== 'string' || !OWNER.test(packet.owner) || !Number.isSafeInteger(packet.id) || packet.id < 1
          || !textValue(packet.profile, 128) || !packet.profile || typeof packet.modelSha256 !== 'string' || !SHA.test(packet.modelSha256)
          || !integer(packet.index) || packet.index !== turn.index + 1
          || !integer(packet.offsetFrames) || packet.offsetFrames !== turn.frames
          || !integer(packet.frames) || packet.frames < 1 || packet.frames > 96000
          || turn.frames + packet.frames > 24000 * 120 || typeof packet.pcm !== 'string'
          || packet.pcm.length > 256000
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packet.pcm))
        throw Error('Local PCM packet is malformed or out of order');
      const identity = packetIdentity(packet);
      if (turn.packetIdentity && identity !== turn.packetIdentity) throw Error('Local PCM producer changed');
      // Decode into a new buffer before crossing the asynchronous renderer ACK.
      const binary = atob(packet.pcm);
      if (binary.length !== packet.frames * 2) throw Error('Local PCM byte count changed');
      const bytes = Uint8Array.from(binary, value => value.charCodeAt(0));
      const {index, offsetFrames, frames} = packet;
      turn.packetIdentity = identity; turn.appending = true;
      await turn.player.append(bytes, offsetFrames);
      if (this.active !== turn || !turn.current) throw Error('Local PCM owner changed');
      turn.frames += frames; turn.index = index;
      return {version: 1, token: turn.token, index, offsetFrames, frames, receivedFrames: turn.frames};
    } catch (error) { turn.player.fail(error.message); throw error; }
    finally { turn.appending = false; }
  }

  async seal({token, totalFrames}) {
    const turn = this.owned(token);
    if (turn.sourceComplete || turn.appending || !integer(totalFrames) || totalFrames < 1
        || totalFrames !== turn.frames) throw Error('Local PCM end sample count changed');
    await turn.player.end(totalFrames);
    if (this.active !== turn || !turn.current) throw Error('Local PCM owner changed');
    turn.sourceComplete = true;
    return this.snapshot(token);
  }

  snapshot(token) {
    const turn = this.owned(token), state = turn.player.snapshot();
    return {...state, version: 1, token, engine: 'pocket-tts', voiceProvider: 'pocket',
      text: turn.text, textComplete: true, sourceComplete: turn.sourceComplete,
      ...(turn.userText !== undefined ? {userText: turn.userText} : {}),
      ...(turn.expressionSignal !== undefined ? {expressionSignal: turn.expressionSignal} : {})};
  }

  control(token, value) {
    const turn = this.owned(token);
    turn.player.control(value); return true;
  }

  async stop(token) {
    const turn = this.active;
    if (!turn || turn.token !== token) return false;
    turn.current = false; this.active = null;
    await turn.player.stop(); return true;
  }
}

if (typeof window !== 'undefined') window.localPcm = new LocalPcmClient();
