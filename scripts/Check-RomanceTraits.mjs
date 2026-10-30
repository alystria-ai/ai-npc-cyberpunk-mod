// Checks a romance traits file against the rules of bridge/romance-traits.mjs.
//   node scripts/Check-RomanceTraits.mjs <file.json> [--roster]   a file is {"version": 1, "traits": {key: row}} (or a bare {key: row} object)
//   node scripts/Check-RomanceTraits.mjs --shipped                the shipped table must have a row for every roster character (not the two ambient ones)
// With --roster the keys of the file must all be roster keys. Exit code 1 and one line per problem when something is wrong.
import {readFileSync} from 'node:fs';
import {tableProblems, TRAITS_FILE} from '../bridge/romance-traits.mjs';

const roster = JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8'));
const rosterKeys = roster.filter(row => row.kind !== 'ambient').map(row => row.key);
const args = process.argv.slice(2);
const file = args.includes('--shipped') ? TRAITS_FILE : args.find(arg => !arg.startsWith('--'));
if (!file) { console.error('Usage: node scripts/Check-RomanceTraits.mjs <file.json> [--roster] | --shipped'); process.exit(2); }
let table = JSON.parse(readFileSync(file, 'utf8'));
if (table && table.version === undefined && !table.traits) table = {version: 1, traits: table};
const problems = tableProblems(table, args.includes('--shipped') ? rosterKeys : null);
if (args.includes('--roster')) for (const key of Object.keys(table.traits ?? {})) if (!rosterKeys.includes(key)) problems.push(`${key}: not a roster character`);
for (const line of problems.slice(0, 60)) console.error(line);
const rows = Object.values(table.traits ?? {});
console.log(`${rows.length} rows, ${rows.filter(row => row.open).length} open, ${rows.filter(row => row.open === false).length} closed, ${problems.length} problems`);
process.exit(problems.length ? 1 : 0);
