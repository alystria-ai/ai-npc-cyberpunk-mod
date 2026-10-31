// The talk half of the romance animations (docs/ROMANCE_ANIMATIONS.md). After a private reply to V's partner, when V's words asked for a kiss, a hug and the like
// (bridge/romance-anim-intent.mjs), the request goes to the game in runtime/romance-anim.json: {version, revision, requests: [{id, profileKey, kind}]}. The game reads
// it only for a short while after a private turn with a partner (mod/romance-anim.lua), asks V once and plays. Nothing here plays or decides anything:
// the game checks the partner, the setting, danger and the scene again, and V can say no. A request is only written for a partner (the turn's relationship
// selection says so), never for a casual encounter, a friend or a character V ended things with.
import {atomicFile} from './guarded-file.mjs';
import {screenRomanceAnim} from './romance-anim-intent.mjs';

const KEEP = 8;

export class RomanceAnimRequests {
  constructor({path = null, write = (file, text) => atomicFile(file, text), log = () => {}, now = () => Date.now()} = {}) {
    Object.assign(this, {path, write, log, now});
    this.revision = 0;
    this.requests = [];
    this.chain = Promise.resolve();
  }

  /** A turn's words and whether the character is V's partner: the request that was written, or null. */
  afterTurn(profileKey, userText, partner) {
    try {
      if (partner !== true || typeof profileKey !== 'string' || !profileKey) return null;
      const kind = screenRomanceAnim(userText);
      if (!kind) return null;
      // Ids grow with the clock, so a bridge that restarted while the game runs never reuses one the game has seen.
      this.revision = Math.max(this.revision + 1, this.now());
      const request = {id: this.revision, profileKey, kind};
      this.requests.push(request);
      while (this.requests.length > KEEP) this.requests.shift();
      this.log(`profile=${profileKey} asked=${kind}`);
      this.publish();
      return request;
    } catch (error) {
      this.log(`failed: ${String(error?.message ?? error).slice(0, 120)}`);
      return null;
    }
  }

  status() { return {version: 1, revision: this.revision, requests: this.requests.map(request => ({...request}))}; }

  publish() {
    if (!this.path) return;
    const text = JSON.stringify(this.status());
    this.chain = this.chain.then(() => this.write(this.path, text)).catch(error => {
      this.log(`not written: ${String(error?.message ?? error).slice(0, 120)}`);
    });
  }
}
