// The game's two live microphone signals (runtime/microphone-live.json, written by mod/microphone.lua) applied to the microphone tap
// (bridge/mic-tap.mjs):
//   hold    {holdId, down}  the talk key went down or came up: the tap opens at once and keeps what it hears / stops on the spot
//   listen  true | false    Voice activation wants the microphone open (a conversation is possible) or closed
// A listen request is honoured only while the Voice activation setting is on (settings.json "voiceActivation", read by the settings poll):
// without it nothing opens, and a listening tap is released at once, so nothing stays open or running when the setting is off.
const HOLD_ID = /^[\w.-]{1,40}$/;

export class MicLive {
  constructor({tap, read, log = () => {}, onListenError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, reopenMs = 400}) {
    Object.assign(this, {tap, read, log, onListenError, setTimer, clearTimer, reopenMs});
    this.observed = ''; this.holdId = null; this.listen = false; this.allowed = false; this.stopped = false; this.timer = null;
  }

  // Reads the file; acts on a change only.
  async poll() {
    if (this.stopped) return;
    const raw = await this.read();
    if (raw === this.observed) return;
    this.observed = raw;
    let value; try { value = JSON.parse(raw); } catch { return; }
    if (!value || typeof value !== 'object') return;
    const holdId = typeof value.holdId === 'string' && HOLD_ID.test(value.holdId) ? value.holdId : null;
    if (holdId && value.down === true && holdId !== this.holdId) {
      this.holdId = holdId;
      this.tap.hold(holdId).catch(error => this.log('the key press could not open the microphone: ' + String(error?.message ?? error).slice(0, 160)));
    } else if (holdId && value.down === false && holdId === this.holdId) {
      void this.tap.released(holdId);
    }
    const listen = value.listen === true;
    if (listen !== this.listen) { this.listen = listen; this.reconsider(); }
  }

  // The Voice activation setting, as the settings poll reads it.
  setAllowed(allowed) {
    allowed = allowed === true;
    if (allowed === this.allowed) return;
    this.allowed = allowed;
    this.reconsider();
  }

  // Opens the listening tap when the game asks for it and the setting allows it, releases it when either stops.
  reconsider() {
    if (this.stopped) return;
    const want = this.listen && this.allowed;
    if (want && this.tap.state === 'closed') {
      this.log('voice activation listens');
      this.tap.open('vad', {listen: true}).catch(error => {
        this.log('voice activation could not open the microphone: ' + String(error?.message ?? error).slice(0, 160));
        this.onListenError(error);
      });
    } else if (!want && this.tap.listening) void this.tap.release('vad', 'voice activation is off');
  }

  // The tap was released (a turn ended, the voice browser restarted): listening resumes when the game still asks for it.
  afterRelease() {
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.reconsider(), this.reopenMs);
    this.timer?.unref?.();
  }

  stop() {
    this.stopped = true;
    this.clearTimer(this.timer);
  }
}
