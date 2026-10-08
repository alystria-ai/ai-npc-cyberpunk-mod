// Gender of the vendor character records, for the Model browser's archetype mapping (docs/NPC_ARCHETYPES.md).
//
//   node scripts/Extract-ArchetypeRecordGenders.mjs [--game "E:\SteamLibrary\steamapps\common\Cyberpunk 2077"]
//
// A spawned copy has no body to read before it exists, and most vendor record names carry no gender
// (Character.wat_kab_ripperdoc_01). The shipped REDmod tweak sources do: the parent base (Gun_NPC_Base vs
// Gun_NPC_Base_Female), the entity template (service__vendor_wa.ent) or an inherited record name (_ma, Woman).
// Reads only the installed tweak text files; writes characters/archetype-record-genders.json (record -> MALE|FEMALE),
// which scripts/Build-ArchetypeProfiles.mjs embeds in mod/character-catalog.lua.
import {readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = [
  'tools/redmod/tweaks/base/gameplay/static_data/database/characters/npcs/records/quest/vendors/vendors.tweak',
  'tools/redmod/tweaks/base/gameplay/static_data/database/characters/npcs/records/quest/main_characters/tertiarycharacters.tweak',
  'tools/redmod/tweaks/ep1/gameplay/static_data/database/characters/npcs/records/openworld/ep1_vendors.tweak',
  'tools/redmod/tweaks/ep1/gameplay/static_data/database/characters/npcs/records/openworld/ep1_vendors_additional.tweak',
];

// Gender from a record name or template path alone: "_wa", "_wb", "Woman", "Female" ... (women first: "woman" has "man").
// The same rule is mod/character-catalog.lua M.nameGender (bridge/character-catalog.test.mjs compares them).
const FEMALE_TOKENS = new Set(['woman', 'women', 'female', 'girl', 'w', 'wa', 'wb', 'wc', 'waf', 'wbf', 'wah', 'wf']);
const MALE_TOKENS = new Set(['man', 'men', 'male', 'boy', 'm', 'ma', 'mb', 'mc', 'maf', 'mbf', 'mah', 'mbh', 'mf']);
export function nameGender(value) {
  if (typeof value !== 'string' || !value) return null;
  const tokens = value.replace(/^Character\./, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some(token => FEMALE_TOKENS.has(token) || token.endsWith('woman') || token.endsWith('female'))) return 'FEMALE';
  if (tokens.some(token => MALE_TOKENS.has(token) || token.endsWith('man') || token.endsWith('male'))) return 'MALE';
  return null;
}

// Records declared as "name : Parent { ... }", with their entityTemplatePath when present.
export function parseRecords(text) {
  const records = new Map();
  const pattern = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\{/gm;
  let match;
  while ((match = pattern.exec(text))) {
    const start = pattern.lastIndex;
    const end = text.indexOf('\n}', start);
    const body = end < 0 ? '' : text.slice(start, end);
    const template = /entityTemplatePath\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? null;
    records.set(match[1], {parent: match[2].replace(/^Character\./, ''), template, vendorID: /vendorID\s*=/.test(body)});
  }
  return records;
}

// Vendor records that are one shop each (their own Vendor ID), as opposed to the shared street-stall records
// (Character.Kiosk, Drinks, Grilled_Food, ... all inherit Fluff_Vendor_NPC_Base and stand at many stalls). Only a
// one-shop record is a stable identity for remembering V (docs/NPC_ARCHETYPES.md, "Vendor memory").
export function uniqueVendorRecords(records) {
  const vendor = (name, depth = 0) => {
    const row = records.get(name);
    if (!row || depth > 8) return false;
    return row.vendorID || /(?:^|_)(?:Fluff_)?Vendor_NPC_Base$|^(?:Foodshop|Bartender|Medical|Gun|Ripperdoc|Clothing|Junkshop|Melee|Cyberware|Techstore)_NPC_Base(?:_Female)?$/
      .test(row.parent) || vendor(row.parent, depth + 1);
  };
  const fluff = (name, depth = 0) => {
    const row = records.get(name);
    if (!row || depth > 8) return false;
    return /^Fluff_Vendor_NPC_Base(?:_Female)?$/.test(row.parent) || fluff(row.parent, depth + 1);
  };
  return [...records.keys()].sort()
    .filter(name => !/_NPC_Base(?:_Female)?$/.test(name) && vendor(name) && !fluff(name) && !/^(?:Quest)_NPC_Base$/.test(records.get(name).parent))
    .map(name => 'Character.' + name);
}

export function resolveGenders(records) {
  const memo = new Map();
  const gender = (name, depth = 0) => {
    if (memo.has(name)) return memo.get(name);
    const row = records.get(name);
    let value = null;
    if (row?.template) value = nameGender(row.template.split(/[\\/]/).pop().replace(/\.ent$/i, ''));
    if (!value && /_NPC_Base_Female$/.test(row?.parent ?? '')) value = 'FEMALE';
    if (!value) value = nameGender(name);
    if (!value && row && depth < 8) value = gender(row.parent, depth + 1);
    if (!value && /_NPC_Base$/.test(row?.parent ?? '') && !/^(?:Quest|Interactable|Gameplay)_NPC_Base$/.test(row.parent)) value = 'MALE';
    memo.set(name, value);
    return value;
  };
  const vendor = (name, depth = 0) => {
    const row = records.get(name);
    if (!row || depth > 8) return false;
    return row.vendorID || /(?:^|_)(?:Fluff_)?Vendor_NPC_Base$|^(?:Foodshop|Bartender|Medical|Gun|Ripperdoc|Clothing|Junkshop|Melee|Cyberware|Techstore)_NPC_Base(?:_Female)?$/
      .test(row.parent) || vendor(row.parent, depth + 1);
  };
  const result = {};
  for (const name of [...records.keys()].sort()) {
    if (/_NPC_Base(?:_Female)?$/.test(name) || !vendor(name)) continue;   // vendor copies only; bases are not spawnable
    const value = gender(name);
    if (value && !nameGender(name)) result['Character.' + name] = value;  // only what the record name cannot tell
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--game');
  const game = at < 0 ? (process.env.CYBERPUNK_CONVAI_GAME || 'E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077') : process.argv[at + 1];
  const records = new Map();
  for (const source of SOURCES) for (const [name, row] of parseRecords(await readFile(join(game, source), 'utf8'))) records.set(name, row);
  const genders = resolveGenders(records);
  const target = resolve(root, 'characters/archetype-record-genders.json');
  await writeFile(target, JSON.stringify({version: 1, source: 'REDmod tweak sources: ' + SOURCES.map(path => path.split('/').pop()).join(', '),
    records: genders, uniqueVendors: uniqueVendorRecords(records)}, null, 2) + '\n');
  console.log(`Wrote ${Object.keys(genders).length} record genders and ${uniqueVendorRecords(records).length} one-shop vendor records to characters/archetype-record-genders.json.`);
}
