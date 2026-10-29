// The vision projector of a Local AI or Mature pack (docs/LOCAL_AI.md, "Pictures (Companions can see)"; docs/PACKAGING.md, "Projectors in the packs").
//
// A pack carries its model's projector beside the model, in models/, and names it in its manifest (`mmproj: 'models/<file>'` on the model's entry), so
// bridge/local-llm-server.mjs finds it without guessing: a pack folder holds several .gguf files (the other model, the embedding model), which the
// auto-discovery beside a single model could never sort out. The projector is loaded only while Companions can see is on.
//
// Pure helpers, no network: the builder (packaging/build-release.mjs) fetches the file with its own helper and hands the path here to be checked.
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';

/** The folder of the pack where every model file, projectors included, is written (relative to the Local AI folder). */
export const PROJECTOR_FOLDER = 'models';

/** The fields a projector pin must have, as in release.config.json (`mmproj` of a tier). */
export function validateProjectorSpec(spec, label = 'projector') {
  if (!spec || typeof spec !== 'object') throw Error(`${label}: no projector is pinned`);
  if (!/^[\w.-]+\.gguf$/.test(String(spec.file ?? ''))) throw Error(`${label}: file must be a plain .gguf file name`);
  if (!/mmproj/i.test(spec.file)) throw Error(`${label}: ${spec.file} does not look like a projector (the name has no "mmproj")`);
  if (!/^[0-9a-f]{40}$/.test(String(spec.revision ?? ''))) throw Error(`${label}: revision must be a 40 digit commit hash`);
  if (!/^[0-9a-f]{64}$/.test(String(spec.sha256 ?? ''))) throw Error(`${label}: sha256 must be 64 hex digits`);
  if (!Number.isInteger(spec.size) || spec.size < 1_000_000) throw Error(`${label}: size must be the file's size in bytes`);
  if (typeof spec.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(spec.repository)) throw Error(`${label}: repository must be owner/name`);
  if (spec.license !== 'Apache-2.0') throw Error(`${label}: the packs ship Apache-2.0 files only`);
  return spec;
}

/** The pinned projector of a tier entry, validated, or null when the tier has none (a model that ships without one). */
export function tierProjector(tier, label = 'model') {
  return tier?.mmproj ? validateProjectorSpec(tier.mmproj, `${label} projector`) : null;
}

/** The path a manifest names for a projector: relative to the Local AI folder, inside models/. */
export const projectorManifestPath = spec => `${PROJECTOR_FOLDER}/${spec.file}`;

/** The field a manifest's model entry gets, to spread into it: {mmproj: 'models/<file>'} when the tier has a projector, {} when it has none. */
export const projectorField = spec => (spec ? {mmproj: projectorManifestPath(spec)} : {});

/** Where a projector comes from on Hugging Face: the pinned revision, never a branch. */
export const projectorUrl = spec => `https://huggingface.co/${spec.repository}/resolve/${spec.revision}/${spec.file}`;

const sha256Of = async path => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path, {highWaterMark: 4 * 1024 * 1024})) hash.update(chunk); return hash.digest('hex'); };

/**
 * Checks a downloaded projector against its pin: its size first (cheap), then its SHA-256. Throws with the file, the expected and the found values;
 * returns the path when it is the pinned file.
 */
export async function verifyProjectorFile(path, spec, {sizeOf = async file => (await stat(file)).size, hashOf = sha256Of} = {}) {
  validateProjectorSpec(spec, 'projector');
  const size = await sizeOf(path);
  if (size !== spec.size) throw Error(`${spec.file} is ${size} bytes, not the pinned ${spec.size}`);
  const sha256 = await hashOf(path);
  if (sha256 !== spec.sha256) throw Error(`${spec.file} has SHA-256 ${sha256}, not the pinned ${spec.sha256}`);
  return path;
}

/** The line a pack's THIRD-PARTY-NOTICES names a projector with. `owner` is who made the model it belongs to (for the notice text). */
export const projectorNotice = (spec, owner) => `${spec.name} (GGUF, made for ${owner}'s model; loaded only while Companions can see is on) - ${spec.license}: licenses/Apache-2.0.txt - https://huggingface.co/${spec.repository}`;

/** What a pack's receipt (local-ai-<tier>.json, mature-pack-<tier>.json) records about a projector: where it came from and its hash. */
export const projectorReceipt = spec => (spec ? {projector: `${spec.repository}@${spec.revision}`, projectorFile: spec.file, projectorSha256: spec.sha256} : {});

/**
 * Two packs that carry a projector at the same path must carry the same bytes (a player may install both, in any order). Returns the problems, [] when
 * every shared file name has one pin.
 */
export function projectorConflicts(specs) {
  const byFile = new Map(), problems = [];
  for (const spec of specs.filter(Boolean)) {
    const known = byFile.get(spec.file.toLowerCase());
    if (known && (known.sha256 !== spec.sha256 || known.size !== spec.size)) problems.push(`${spec.file} is pinned with two different hashes`);
    byFile.set(spec.file.toLowerCase(), spec);
  }
  return problems;
}
