#!/usr/bin/env node
// Developer-side provisioning: switch long-term memory ON for every mod character, once, with the project's Convai key.
//
// Why: with the sign-in backend (docs/CONVAI_AUTH_BACKEND.md) a player's machine never holds the permanent key, so the bridge no
// longer lists, reads or updates characters at run time (bridge/player-memory-api.mjs, backend mode). Memory therefore has to
// be enabled beforehand, here. Run it again after provisioning new characters or twins.
//
//   node scripts/Enable-CharacterMemory.mjs            plan only: lists the characters, makes no call
//   node scripts/Enable-CharacterMemory.mjs --apply    enables memory where it is off (one update per character)
//   --only judy,panam   limit to some profile keys
//
// It uses the same verified path as the old run-time enable (ownership marker check, one minimal update, read-back that nothing
// else changed), so it never edits a character it cannot prove is the mod's. The key comes from runtime/convai-key.txt (or
// CYBERPUNK_CONVAI_KEY_FILE) and is never printed. This script only ever runs on the developer's machine; it does not ship.
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {PlayerMemoryApi} from '../bridge/player-memory-api.mjs';
import {RelationshipRouting} from '../bridge/relationship-routing.mjs';
import {multilingualTwins} from '../bridge/multilingual.mjs';
import {readKeyFileText} from '../bridge/key-codec.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDirectory = resolve(process.env.CYBERPUNK_CONVAI_STATE || resolve(root, 'runtime'));
const args = process.argv.slice(2), apply = args.includes('--apply');
const onlyAt = args.indexOf('--only');
const only = onlyAt < 0 ? null : new Set(String(args[onlyAt + 1] ?? '').split(',').filter(Boolean));

const readJson = async (path, fallback) => {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, '')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
};

const ids = await readJson(resolve(stateDirectory, 'characters.json'));
const twins = multilingualTwins(await readJson(resolve(stateDirectory, 'multilingual-profiles.json'), null), {ordinaryIds: ids});
const routes = new RelationshipRouting({ordinaryIds: ids, multilingual: twins.twins});
const profiles = Object.keys(routes.providerIds).filter(profile => !only || only.has(profile));
if (only && profiles.length !== only.size) throw Error('Unknown profile in --only selection.');

const keyPath = process.env.CYBERPUNK_CONVAI_KEY_FILE || resolve(stateDirectory, 'convai-key.txt');
const key = readKeyFileText(await readFile(keyPath, 'utf8'))?.key;
if (!key) throw Error('The key file must contain api-key=... (nothing was printed).');

console.log(`${apply ? 'Applying' : 'Planning'} memory enablement for ${profiles.length} characters (no key or character text is printed).`);
if (!apply) console.log('Plan mode makes no call to Convai. --apply reads each character (ownership check) and enables memory where it is off.');

const api = new PlayerMemoryApi({key, characterIds: routes.providerIds, markerKeys: routes.markerKeys, timeoutMs: 30000});
// enableMemory validates an end-user id shape only; it never sends it. A throwaway id satisfies the check.
const endUserId = randomUUID();
const summary = {alreadyOn: 0, enabled: 0, failed: []};
for (const profileKey of profiles) {
  const options = {profileKey, characterId: routes.providerIds[profileKey], endUserId};
  try {
    if (!apply) continue; // plan mode makes no call at all
    const result = await api.enableMemory(options);
    if (result.changed) { summary.enabled += 1; console.log(`enabled  ${profileKey}`); } else summary.alreadyOn += 1;
  } catch (error) {
    summary.failed.push({profileKey, code: error?.code ?? 'ERROR'});
    console.log(`FAILED   ${profileKey}: ${error?.code ?? 'ERROR'}`);
  }
}
console.log(JSON.stringify(apply ? {mode: 'apply', characters: profiles.length, alreadyOn: summary.alreadyOn, enabled: summary.enabled,
  failed: summary.failed} : {mode: 'plan', characters: profiles.length, profiles}, null, 2));
process.exitCode = summary.failed.length ? 1 : 0;
