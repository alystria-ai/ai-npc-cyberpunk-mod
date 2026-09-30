import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';

// Absence is a first run. Corruption, permissions and other I/O failures must
// not silently erase account ownership mappings or authorize fresh creates.
export async function readProvisionState(path) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  let value;
  try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw Error(`Invalid JSON in ${basename(path)}; restore its last good backup before provisioning.`); }
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.values(value).some(id => typeof id !== 'string' || !id.trim())) {
    throw Error(`Invalid mapping in ${basename(path)}; provisioning stopped without remote writes.`);
  }
  return value;
}
