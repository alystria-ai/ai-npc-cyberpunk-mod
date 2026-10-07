// Which source files a release must carry: the bridge's production import closure and the
// CET Lua files players need. Shared by the release builder and its tests.
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {dirname, relative, resolve, sep} from 'node:path';

const posix = path => path.split(sep).join('/');
const PATTERNS = [
  /\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bexport\s+[\w*{}\s,$]+\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
];

// Every bridge module reachable from `entries` through static imports, dynamic imports of
// literal paths and `new URL('./x', import.meta.url)` (worker threads). References that leave
// bridge/ (the browser bundle in ../runtime/) are supplied separately as client assets.
export async function importClosure(root, entries) {
  const seen = new Set(), queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const path = resolve(root, rel);
    if (!existsSync(path)) throw Error(`The bridge refers to a missing file: ${rel}`);
    seen.add(rel);
    if (!/\.m?js$/.test(rel)) continue;
    const text = await readFile(path, 'utf8');
    for (const pattern of PATTERNS) for (const match of text.matchAll(pattern)) {
      const target = posix(relative(root, resolve(dirname(path), match[1])));
      if (target.startsWith('bridge/')) queue.push(target);
    }
  }
  const files = [...seen].sort();
  const bad = files.filter(file => /\.test\.mjs$|fixture/i.test(file));
  if (bad.length) throw Error(`Test files reached the production closure: ${bad.join(', ')}`);
  return files;
}

// Splits mod/*.lua into shipped and development-only files. A shipped file may load a
// development-only file only through a guarded pcall(dofile, ...), and every direct
// dofile('x.lua') must name a shipped file. Returns {shipped, excluded}.
export async function checkLuaPartition(modRoot, luaFiles, devOnly) {
  const excludedSet = new Set(devOnly);
  const shipped = luaFiles.filter(rel => !excludedSet.has(rel));
  const shippedSet = new Set(shipped);
  for (const rel of shipped) {
    const text = await readFile(resolve(modRoot, rel), 'utf8');
    for (const match of text.matchAll(/\bdofile\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (excludedSet.has(match[1])) throw Error(`mod/${rel} loads development-only ${match[1]} without a guard.`);
      if (!shippedSet.has(match[1])) throw Error(`mod/${rel} loads ${match[1]}, which is not shipped.`);
    }
  }
  return {shipped, excluded: luaFiles.filter(rel => excludedSet.has(rel))};
}
