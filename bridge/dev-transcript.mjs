// Developer mode: a plain text transcript of every turn, so a tester can read what was said and answered without the game's subtitles
// (the owner, 2026-10-30: "you should be able to see the replies, at least in dev mode").
//
//   <state>/dev-transcript.log   one entry per turn, newest last:
//       [2026-10-30 12:01:02] Judy Alvarez | provider local | vision yes
//         where: You are inside the Afterlife, a merc bar in Little China, Watson.
//         V: what do you think of this place
//         Judy Alvarez: It's where the real deals happen.
//   <state>/dev-transcript.log.1  the file before the last rotation (the log is moved there at about 2 MB, and the one before that is dropped)
//
// Developer mode is read from the settings snapshot the bridge polls (`developerMode`, mod/manager.lua). While it is off nothing is written, held or
// read: `record` returns at once. A key the bridge holds never appears in an entry (every known secret is replaced by [key]). The file lives in the
// local data folder and is no part of a support report or an error report (bridge/support-report.mjs lists the logs it takes by name; this is not one).
import {appendFile, mkdir, rename, rm, stat} from 'node:fs/promises';
import {dirname} from 'node:path';

export const TRANSCRIPT_FILE = 'dev-transcript.log';
export const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FIELD = 6000;   // one turn's text is cut here (a reply is far shorter; this only bounds a runaway)

const two = number => String(number).padStart(2, '0');
/** "2026-10-30 12:01:02" on this computer's clock. */
export function stamp(date = new Date()) {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

// A text as indented continuation lines: no control characters but the line breaks.
const body = (label, text) => {
  const clean = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, MAX_FIELD);
  return `  ${label}: ${clean.split('\n').join('\n    ')}`;
};

export class DevTranscript {
  /**
   * path: the log file. secrets: () => the strings that must never be written (keys). maxBytes: the size at which the file is rotated. log: one line per failure.
   */
  constructor({path, secrets = () => [], maxBytes = MAX_BYTES, now = () => new Date(), log = () => {}} = {}) {
    Object.assign(this, {path, secrets, maxBytes, now, log});
    this.on = false; this.size = null; this.queue = Promise.resolve();
  }
  get enabled() { return this.on; }
  /** The settings poll: Developer mode on or off. Returns true when it changed. A settings file that could not be read for a moment changes nothing. */
  update(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const next = settings.developerMode === true;
    if (next === this.on) return false;
    this.on = next;
    if (!next) this.size = null;
    return true;
  }
  #scrub(text) {
    let out = String(text ?? '');
    let keys = [];
    try { keys = this.secrets() ?? []; } catch { keys = []; }
    for (const key of keys) if (typeof key === 'string' && key.length >= 8) out = out.split(key).join('[key]');
    return out;
  }
  /** The entry as text (no write). */
  format({speaker, provider, user, reply, picture, where} = {}) {
    const name = String(speaker ?? 'unknown').replace(/[\u0000-\u001f\u007f|]/g, ' ').trim().slice(0, 60) || 'unknown';
    const head = `[${stamp(this.now())}] ${name} | provider ${String(provider ?? 'unknown').replace(/[^\w.-]/g, '').slice(0, 24) || 'unknown'} | vision ${picture === true ? 'yes' : 'no'}`;
    const lines = [head];
    if (where) lines.push(body('where', where));
    lines.push(body('V', user || '(nothing)'), body(name, reply || '(no reply)'));
    return this.#scrub(lines.join('\n')) + '\n';
  }
  /**
   * Appends one turn: {speaker, provider, user, reply, picture, where}. Nothing happens while Developer mode is off. Never throws and is never awaited by a reply.
   */
  record(entry) {
    if (!this.on || !this.path) return undefined;
    let text;
    try { text = this.format(entry); } catch { return undefined; }
    const bytes = Buffer.byteLength(text, 'utf8');
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (!this.on) return;   // switched off while this waited in the queue
      await mkdir(dirname(this.path), {recursive: true});
      if (this.size === null) this.size = await stat(this.path).then(info => info.size, () => 0);
      // Rotation: the full file becomes .1 (the one before it is dropped) and a new file starts.
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        await rm(`${this.path}.1`, {force: true});
        await rename(this.path, `${this.path}.1`);
        this.size = 0;
      }
      await appendFile(this.path, text, 'utf8');
      this.size += bytes;
    }).catch(error => { this.size = null; try { this.log(`dev transcript not written (${error?.code ?? error?.message})`); } catch {} });
    return this.queue;
  }
  /** Resolves when everything queued so far is written (tests, shutdown). */
  flush() { return this.queue; }
}
