import {readFile, readdir, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {readKeyFileText} from './key-codec.mjs';

// What the automatic error reports (bridge/error-reports.mjs) need from the data folder and the game's logs: the values to scrub from every
// line, and the plugin versions RED4ext logged.

async function readSmall(path, maxBytes = 262144) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) return null;
    return (await readFile(path, 'utf8')).replace(/^﻿/, '');
  } catch { return null; }
}


const clip = (value, size = 60) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, size) || null : null;

// RED4ext's log lists every plugin it loaded, one line each: "[RED4ext] Codeware (version: 1.20.5, author(s): psiberx) has been loaded".
export function pluginVersions(text) {
  const result = {red4ext: null, plugins: new Map()};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const own = /\[RED4ext\]\s+RED4ext \(v([^)\s]+)\)/.exec(line);
    if (own) { result.red4ext = clip(own[1], 30); continue; }
    const plugin = /\[RED4ext\]\s+(.+?)\s+\(version:\s*([^,)\s]+)/.exec(line);
    if (plugin) result.plugins.set(plugin[1].trim().toLowerCase(), clip(plugin[2], 30));
  }
  return result;
}

// Values that must be scrubbed from every line, besides the ones collectReport already reads (convai-key.txt, the Hugging Face and Kaggle
// tokens, the custom model servers' keys): every other key file of the data folder (player-convai-key.txt, player-mistral-key.txt,
// player-inworld-key.txt...), the Custom (OpenAI-compatible) provider's key (the api-key line of player-custom-endpoint.txt), the sign-in
// file's secret (or CYBERPUNK_CONVAI_AUTH_SECRET) and the key packed into the Runtime (app/defaults/service.txt). They are only returned to
// the redactor; nothing here writes, logs or prints one.
export async function dataFolderSecrets({stateDirectory, project, env = {}}) {
  const found = [];
  const add = value => { if (typeof value === 'string' && value.trim().length >= 6) found.push(value.trim()); };
  // Lines such as `api-key=VALUE`, `key: VALUE` or `token = Bearer VALUE` in a key file of more than one line.
  const labelled = raw => {
    for (const line of raw.split(/\r\n|\r|\n/)) {
      const value = /^\s*(?:api[-_ ]?key|apikey|key|token|secret)\s*[=:]\s*(.+?)\s*$/i.exec(line)?.[1];
      if (!value) continue;
      add(value);
      add(value.replace(/^bearer\s+/i, '').replace(/^["'`<]+|["'`>]+$/g, ''));
    }
  };
  const fromKeyText = raw => {
    const parsed = readKeyFileText(raw);
    if (parsed) add(parsed.key);
    const text = raw.trim();
    add(text);
    const value = /^[A-Za-z0-9_-]+\s*=\s*(\S+)$/.exec(text)?.[1];
    if (value) add(value);
    for (const part of text.split(/\s+/)) if (part.length >= 12) add(part);
    labelled(raw);
  };
  let names = [];
  try { names = stateDirectory ? await readdir(stateDirectory) : []; } catch {}
  // The custom provider's file (docs/CUSTOM_PROVIDER.md) holds its key on an `api-key=` line beside the address and the model ID; only the key is a secret.
  const fromCustomFile = raw => {
    for (const line of raw.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
      const value = /^\s*(?:api[-_]?key|apikey|key)\s*[=:]\s*(.*?)\s*$/i.exec(line)?.[1];
      if (!value) continue;
      const bare = value.replace(/\s+#.*$/, '');
      add(bare);
      add(bare.replace(/^["'`<“”‘’]+|["'`>“”‘’]+$/g, ''));
    }
  };
  for (const name of names) {
    const isKey = /-key\.txt$/i.test(name), isAuth = /^convai-auth\.json$/i.test(name), isCustom = /^player-custom-endpoint\.txt$/i.test(name);
    if (!isKey && !isAuth && !isCustom) continue;
    // The custom provider's file may be as long as its reader takes (bridge/custom-endpoint.mjs: 16 KiB, comments included).
    const raw = await readSmall(join(stateDirectory, name), isCustom ? 16384 : 8192);
    if (raw === null) continue;
    if (isCustom) { fromCustomFile(raw); continue; }
    if (isKey) { fromKeyText(raw); continue; }
    try {
      const walk = (value, key = '', depth = 0) => {
        if (depth > 6 || value === null) return;
        if (typeof value === 'string') { if (/secret|token|key|passw|credential/i.test(key)) add(value); return; }
        if (typeof value === 'object') for (const [name2, item] of Object.entries(value)) walk(item, name2, depth + 1);
      };
      walk(JSON.parse(raw));
    } catch { /* not JSON: nothing to scrub */ }
  }
  const packed = project ? await readSmall(join(project, 'defaults', 'service.txt'), 4096) : null;
  if (packed !== null) { const parsed = readKeyFileText(packed); if (parsed) add(parsed.key); }
  // The error reports' signing secret a release ships (bridge/error-reports.mjs, app/defaults/error-reports.json).
  const shipped = project ? await readSmall(join(project, 'defaults', 'error-reports.json'), 4096) : null;
  if (shipped !== null) { try { add(JSON.parse(shipped.replace(/^﻿/, ''))?.secret); } catch { /* not JSON: nothing to scrub */ } }
  add(env?.CYBERPUNK_CONVAI_AUTH_SECRET);
  return found;
}
