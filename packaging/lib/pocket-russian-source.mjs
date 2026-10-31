// The files of the Russian PocketTTS model's repository (genvoice/xVibePocketTTS, packaging/build-pocket-models.mjs): which file a configuration value names, and the
// repository's own checksum list that every file is checked against. Kept apart from the builder because our own tools never write or publish a loose checksum file
// (packaging/hf-layout.test.mjs); this one only reads the list the upstream repository ships.

/** The name of the checksum list in the upstream repository. */
export const UPSTREAM_SUMS = 'SHA256SUMS';

/** The path a configuration value names inside its repository: `hf://genvoice/xVibePocketTTS/model.safetensors@<revision>` -> `model.safetensors`; a revision given as a version tag (`@v0.1.0`, as the real configuration has it) is dropped the same way; a plain path stays. */
export function repositoryPath(value, repo) {
  let path = String(value ?? '').trim().replace(/@(?:[0-9a-f]{7,40}|v\d+(?:\.\d+)*)$/, '');
  if (path.startsWith(`hf://${repo}/`)) path = path.slice(`hf://${repo}/`.length);
  path = path.replace(/^\.\//, '');
  if (!path || path.startsWith('/') || path.includes('..') || path.includes('\\') || /^[a-z]+:/i.test(path)) throw Error(`the configuration names a file this build cannot take: ${String(value).slice(0, 80)}`);
  return path;
}

/** The rows of the checksum list (`<64 hex>  <path>`, the sha256sum format) as {path: sha256}. */
export function parseSums(text) {
  const sums = {};
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(line);
    if (!match) throw Error(`the checksum list has a line this build cannot read: ${line.slice(0, 60)}`);
    sums[match[2].replace(/^\.\//, '')] = match[1].toLowerCase();
  }
  return sums;
}
