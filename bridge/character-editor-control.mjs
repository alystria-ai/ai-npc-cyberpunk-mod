// File IPC for the "Edit characters" button in the settings (docs/CHARACTER_EDITOR.md). The game writes runtime/editor-command.json
// when the player chooses Open; this module, polled by the bridge, starts the editor's server, opens the page in
// the player's browser and answers in runtime/editor-status.json. The game side does no polling of its own and nothing runs per frame:
// while nobody uses the editor the only cost is the bridge's half-second read of one small file (like the other settings actions).
//
// A command left in the file by an earlier session is never replayed (the first read at start-up only records it), and a stale or
// malformed one is ignored, so opening the editor always needs a fresh click.
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {atomicFile} from './guarded-file.mjs';
import {cleanStrings, cleanFacing} from './character-editor-server.mjs';

const COMMAND_MAX_BYTES = 96 * 1024, COMMAND_MAX_AGE_MS = 30_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;

export function parseEditorCommand(raw, now = Date.now()) {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw, 'utf8') > COMMAND_MAX_BYTES) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || value.version !== 1 || typeof value.id !== 'string' || !ID.test(value.id)
      || value.action !== 'open' || !Number.isFinite(value.issuedAt)
      || value.issuedAt > now + 5000 || now - value.issuedAt > COMMAND_MAX_AGE_MS) return null;
  // facing: the character V faced when the player chose Open (read once by the game, never per frame); it only fills the "New character" form.
  return {id: value.id, action: 'open', language: typeof value.language === 'string' ? value.language : 'en', strings: cleanStrings(value.strings), facing: cleanFacing(value.facing)};
}

/** Opens a page in the default browser. No shell is involved: the address is one argument of the system's URL handler. */
export function openInBrowser(url) {
  const [command, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((done, fail) => {
    const child = spawn(command, args, {detached: true, stdio: 'ignore', windowsHide: true});
    child.once('error', fail);
    child.once('spawn', () => { child.unref(); done(); });
  });
}

export class EditorControl {
  static async open(options) {
    const control = new EditorControl(options);
    control.observed = await readFile(control.commandPath, 'utf8').catch(() => '');
    return control;
  }
  /**
   *   server       EditorServer
   *   commandPath  runtime/editor-command.json     statusPath  runtime/editor-status.json
   *   open         (url) => Promise  opens the page in a browser
   */
  constructor({server, commandPath, statusPath, open = openInBrowser, now = Date.now, log = () => {}} = {}) {
    Object.assign(this, {server, commandPath, statusPath, open, now, log});
    this.observed = ''; this.handled = new Set(); this.polling = false; this.closed = false;
  }
  #status(id, state) {
    return atomicFile(this.statusPath, JSON.stringify({version: 1, id, state, updated: this.now()})).catch(() => false);
  }
  async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const raw = await readFile(this.commandPath, 'utf8').catch(() => '');
      if (raw === this.observed) return;
      this.observed = raw;
      const command = parseEditorCommand(raw, this.now());
      if (!command || this.handled.has(command.id)) return;
      this.handled.add(command.id);
      if (this.handled.size > 64) this.handled.delete(this.handled.values().next().value);
      try {
        const url = await this.server.start({strings: command.strings, language: command.language, facing: command.facing});
        await this.open(url);
        await this.#status(command.id, 'open');
      } catch (error) {
        this.log('character editor: ' + (error?.code ?? error?.message ?? 'error'));
        await this.#status(command.id, 'failed');
      }
    } finally { this.polling = false; }
  }
  /** Closes the editor's server (service shutdown). */
  async close() { this.closed = true; await this.server.stop(); }
}
