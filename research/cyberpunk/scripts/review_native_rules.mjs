// Read-only inspection and provenance verification for explicitly authored rules.
// This does not infer narrative meaning from fact names or generate rules.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateKnowledgePack} from '../../../bridge/world-knowledge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, 'cache/game');
const get = (object, pointer) => pointer.split('/').slice(1).reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], object);
const name = value => value?.$value ?? value;
async function* rows(index, filter = () => true) {
  const lines = readline.createInterface({input: fs.createReadStream(path.join(cache, `index/${index}.jsonl`)), crlfDelay: Infinity});
  for await (const line of lines) if (line) { const row = JSON.parse(line); if (filter(row)) yield row; }
}
function nodeSummary(node) {
  const result = {id: node.id, type: node.$type};
  for (const field of ['socketName', 'debugString', 'sceneFile', 'phaseResource', 'condition', 'conditions']) {
    if (node[field] !== undefined) result[field] = name(node[field]);
  }
  if (node.type?.Data) result.operation = node.type.Data;
  return result;
}
const [command, arg, extra] = process.argv.slice(2);
if (command === 'facts') {
  const pattern = new RegExp(arg);
  for await (const row of rows('facts', row => pattern.test(row.factName) && (!extra || row.source.depotPath.includes(extra)))) {
    console.log(JSON.stringify({fact: row.factName, role: row.role, value: row.value, comparison: row.comparisonType,
      exact: row.setExactValue, path: row.source.depotPath, pointer: row.jsonPointer, node: row.node?.id}));
  }
} else if (command === 'graph') {
  const ids = extra ? new Set(extra.split(',').map(Number)) : null;
  const inventory = JSON.parse(fs.readFileSync(path.join(cache, 'inventory.json')));
  const asset = inventory.assets.find(row => row.winner && row.depotPath === arg);
  if (!asset) throw new Error('Exact winner not found');
  const json = JSON.parse(fs.readFileSync(path.join(cache, asset.jsonPath)));
  for await (const row of rows('nodes', row => row.source.depotPath === arg && (!ids || ids.has(row.id)))) {
    console.log(JSON.stringify({kind: 'node', pointer: row.jsonPointer, ...nodeSummary(get(json, row.jsonPointer))}));
  }
  const seen = new Set();
  for await (const row of rows('edges', row => row.source.depotPath === arg
    && (!ids || ids.has(row.from?.node?.id) || ids.has(row.to?.node?.id)))) {
    const key = JSON.stringify([row.from?.node?.jsonPointer, row.from?.socket, row.to?.node?.jsonPointer, row.to?.socket]);
    if (seen.has(key)) continue; seen.add(key);
    console.log(JSON.stringify({kind: 'edge', from: row.from, to: row.to, pointer: row.jsonPointer}));
  }
} else if (command === 'route') {
  const [start, target] = extra.split(','), [first, socket] = start.split(':');
  const graph = new Map();
  for await (const row of rows('edges', row => row.source.depotPath === arg
    && /^\/Data\/RootChunk\/graph\/Data\/nodes\/\d+\/Data$/.test(row.from?.node?.jsonPointer ?? '')
    && /^\/Data\/RootChunk\/graph\/Data\/nodes\/\d+\/Data$/.test(row.to?.node?.jsonPointer ?? ''))) {
    if (!graph.has(row.from.node.id)) graph.set(row.from.node.id, []);
    graph.get(row.from.node.id).push(row);
  }
  const queue = [{id: Number(first), edges: []}], seen = new Set(); let found;
  while (queue.length) {
    const item = queue.shift();
    if (item.id === Number(target)) { found = item; break; }
    if (seen.has(item.id)) continue; seen.add(item.id);
    for (const edge of graph.get(item.id) ?? []) {
      if (item.edges.length === 0 && socket && edge.from.socket !== socket) continue;
      queue.push({id: edge.to.node.id, edges: [...item.edges, edge]});
    }
  }
  console.log(JSON.stringify(found ? found.edges.map(edge => ({from: edge.from.node.id, fromSocket: edge.from.socket,
    to: edge.to.node.id, toSocket: edge.to.socket, pointer: edge.jsonPointer})) : {reachable: false}, null, 2));
} else if (command === 'verify') {
  const pack = JSON.parse(fs.readFileSync(path.resolve(arg)));
  const schema = validateKnowledgePack(pack);
  if (!schema.ok) throw new Error(JSON.stringify(schema.errors));
  const checked = new Map();
  for (const evidence of pack.evidence) {
    for (const ref of [...(evidence.native ? [evidence.native] : []), ...(evidence.nativeRefs ?? [])]) {
      const absolute = path.resolve(cache, ref.jsonPath);
      if (!absolute.startsWith(cache + path.sep)) throw new Error('Reference escapes cache');
      if (!checked.has(absolute)) checked.set(absolute, JSON.parse(fs.readFileSync(absolute)));
      const found = get(checked.get(absolute), ref.jsonPointer);
      if (found === undefined) throw new Error(`Missing pointer ${evidence.id}: ${ref.jsonPointer}`);
      if (ref.expectedType && found?.$type !== ref.expectedType) throw new Error(`Changed native type ${evidence.id}`);
      for (const [key, expected] of Object.entries(ref.expected ?? {})) {
        if (JSON.stringify(get(found, key)) !== JSON.stringify(expected)) throw new Error(`Changed native value ${evidence.id}: ${key}`);
      }
      if (ref.assetSha256) {
        const binary = path.resolve(cache, ref.jsonPath.replace(/\.json$/, ''));
        const sha = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
        if (sha !== ref.assetSha256) throw new Error(`Changed native asset ${evidence.id}`);
      }
    }
  }
  console.log(JSON.stringify({ok: true, rules: pack.rules.length, evidence: pack.evidence.length, nativeFiles: checked.size}));
} else throw new Error('Usage: facts <fact-regex> [depot-substring] | graph <exact-depot-path> [node-ids] | route <exact-depot-path> <from:socket,to> | verify <pack-path>');
