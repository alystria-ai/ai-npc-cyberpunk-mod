// Joins files that the release had to split to stay under the 2 GiB download limit.
// Shipped as app/launcher/assemble-parts.mjs. A split file `X` arrives as `X.part1`,
// `X.part2`, ... plus `X.parts.json` ({file, size, sha256, parts: [{name, size, sha256}]}).
// On the first start after extraction the parts are joined into a temporary file, the
// whole file is verified against its SHA-256, renamed into place, and the parts removed.
// `X.verified` records the verified hash so later starts only compare sizes.
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {once} from 'node:events';
import {basename, dirname, join, resolve} from 'node:path';

const sizeOf = async path => { try { const info = await stat(path); return info.isFile() ? info.size : -1; } catch { return -1; } };

async function manifests(directory) {
  const found = [];
  for (const entry of await readdir(directory, {withFileTypes: true}).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await manifests(path));
    else if (entry.isFile() && entry.name.endsWith('.parts.json')) found.push(path);
  }
  return found;
}

export async function assembleParts(root, {log = () => {}} = {}) {
  const results = [];
  for (const manifestPath of await manifests(root)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const directory = dirname(manifestPath);
    if (!manifest || typeof manifest.file !== 'string' || basename(manifest.file) !== manifest.file
        || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Array.isArray(manifest.parts) || !manifest.parts.length) {
      throw Error(`Invalid split-file manifest: ${basename(manifestPath)}`);
    }
    const target = resolve(directory, manifest.file), verified = `${target}.verified`;
    const partPaths = manifest.parts.map(part => {
      if (typeof part.name !== 'string' || basename(part.name) !== part.name) throw Error('Invalid split-file part name');
      return resolve(directory, part.name);
    });
    const present = await Promise.all(partPaths.map(sizeOf));
    if (present.every(size => size < 0)) {
      const done = (await sizeOf(target)) === manifest.size
        && (await readFile(verified, 'utf8').catch(() => '')).trim() === manifest.sha256;
      if (!done) throw Error(`${manifest.file} is incomplete: extract every part of the download again.`);
      results.push({file: manifest.file, state: 'ready'});
      continue;
    }
    const missing = manifest.parts.filter((part, index) => present[index] !== part.size).map(part => part.name);
    if (missing.length) throw Error(`${manifest.file} is missing parts (${missing.join(', ')}): extract every part of the download.`);
    log(`Joining ${manifest.parts.length} parts of ${manifest.file}.`);
    const temporary = `${target}.joining`;
    const hash = createHash('sha256');
    const output = createWriteStream(temporary);
    try {
      for (const path of partPaths) {
        for await (const chunk of createReadStream(path, {highWaterMark: 8 * 1024 * 1024})) {
          hash.update(chunk);
          if (!output.write(chunk)) await once(output, 'drain');
        }
      }
      await new Promise((done, fail) => output.end(error => error ? fail(error) : done()));
    } catch (error) {
      output.destroy(); await rm(temporary, {force: true}); throw error;
    }
    const actual = hash.digest('hex');
    if (actual !== manifest.sha256 || (await sizeOf(temporary)) !== manifest.size) {
      await rm(temporary, {force: true});
      throw Error(`${manifest.file} failed its integrity check after joining: download the parts again.`);
    }
    await rm(target, {force: true});
    await rename(temporary, target);
    await writeFile(verified, `${actual}\n`);
    for (const path of partPaths) await rm(path, {force: true});
    log(`Joined and verified ${manifest.file}.`);
    results.push({file: manifest.file, state: 'joined'});
  }
  return results;
}
