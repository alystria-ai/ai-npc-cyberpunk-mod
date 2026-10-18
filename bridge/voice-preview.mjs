// A settings draft may prepare the model without committing voice routing.
// The lease expires if the menu, game or writer disappears. Missing/partial
// reads (the game writes the file in place, so a read can find it empty) retain only the previous lease's original expiry.
export const VOICE_PREVIEW_MAX_AGE_MS = 4000;
const MAX_FUTURE_MS = 1500;
const fresh = (value, now) => value && Number.isFinite(now)
  && value.updated <= now + MAX_FUTURE_MS && now - value.updated <= VOICE_PREVIEW_MAX_AGE_MS;

export class VoicePreviewLease {
  constructor() { this.last = null; this.retired = new Map(); }
  observe(raw, now = Date.now()) {
    for (const [owner, until] of this.retired) if (until < now) this.retired.delete(owner);
    let value;
    if (typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') <= 4096) {
      try { value = JSON.parse(raw); } catch {}
    }
    const valid = value?.version === 1 && typeof value.active === 'boolean'
      && typeof value.owner === 'string' && /^[A-Za-z0-9_.:-]{8,96}$/.test(value.owner)
      && Number.isSafeInteger(value.sequence) && value.sequence > 0 && value.sequence <= 2147483647
      && Number.isSafeInteger(value.updated) && value.updated > 0 && fresh(value, now)
      && (!value.active || (['pocket','omni','hybrid','convai'].includes(value.provider)
        && (!['omni','hybrid'].includes(value.provider)||([16,32].includes(value.omniSteps??value.steps??16)
          && (value.omniReference===undefined||['short','long'].includes(value.omniReference))))));
    if (valid && !this.retired.has(value.owner)) {
      if (!this.last || !fresh(this.last, now)) this.last = value;
      else if (value.owner === this.last.owner) {
        if (value.sequence > this.last.sequence && value.updated >= this.last.updated) this.last = value;
      } else if (value.active && value.updated >= this.last.updated && this.retired.size < 16) {
        this.retired.set(this.last.owner, now + VOICE_PREVIEW_MAX_AGE_MS);
        this.last = value;
      }
    }
    const current = fresh(this.last, now) && this.last.active ? this.last : null;
    return current?{provider:current.provider==='hybrid'?'omni':current.provider,
      ...(['omni','hybrid'].includes(current.provider)?{omniSteps:current.omniSteps??current.steps??16,
        ...(current.omniReference?{omniReference:current.omniReference}:{})}:{})}:null;
  }
}
