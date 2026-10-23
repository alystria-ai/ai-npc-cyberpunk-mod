// The game's two live microphone signals (runtime/microphone-live.json, written by mod/microphone.lua) applied to the microphone tap
// (bridge/mic-tap.mjs):
//   hold    {holdId, down}  the talk key went down or came up: the tap opens at once and keeps what it hears / stops on the spot
//   listen  true | false    Voice activation wants the microphone open (a conversation is possible) or closed
//   warm    true | false    the game is being played and talk by voice is possible: keep the device open, reading nothing, so a key press starts at
//                           once (a real device takes up to about 2 s to open in a running game). The game rewrites the file every 30 s while it
//                           is on; 2 minutes without a write (the game closed or crashed) lets the device go.
// A listen request is honoured only while the Voice activation setting is on (settings.json "voiceActivation", read by the settings poll):
// without it nothing opens, and a listening tap is released at once, so nothing stays open or running when the setting is off.
const HOLD_ID = /^[\w.-]{1,40}$/;

export class MicLive {
  constructor({tap, read, log = () => {}, onListenError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, reopenMs = 400, now = Date.now,
      warmAllowed = true, staleMs = 120_000}) {
    Object.assign(this, {tap, read, log, onListenError, setTimer, clearTimer, reopenMs, now, warmAllowed, staleMs});
    this.observed = ''; this.holdId = null; this.listen = false; this.allowed = false; this.stopped = false; this.timer = null;
    this.warm = false; this.seenAt = this.now();
  }

  // Reads the file; acts on a change only.
  async poll() {
    if (this.stopped) return;
    const raw = await this.read();
    if (raw === this.observed) {
      // The game rewrites the file every 30 s while it wants the device kept open: a long silence means the game is gone.
      if (this.warm && this.now() - this.seenAt > this.staleMs) { this.warm = false; this.reconsiderWarm(); }
      return;
    }
    this.observed = raw; this.seenAt = this.now();
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
    const warm = value.warm === true;
    if (warm !== this.warm) { this.warm = warm; this.reconsiderWarm(); }
  }

  // Keeps the device open, reading nothing, while the game asks for it (and it is not switched off); lets it go otherwise.
  reconsiderWarm() {
    if (this.stopped) return;
    const want = this.warm && this.warmAllowed;
    if (want ? this.tap.warmWanted && this.tap.capture.warmed === true : !this.tap.warmWanted) return;
    this.log(want ? 'the microphone is kept open for the talk key' : 'the microphone is no longer kept open');
    void this.tap.warm(want);
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
    this.reconsiderWarm();
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
    void this.tap.warm(false);
    this.clearTimer(this.timer);
  }
}
