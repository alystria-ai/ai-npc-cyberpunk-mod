// The file helpers every release package goes through (packaging/lib/files.mjs): verified downloads, the tree walk that refuses links,
// hashing, copying, extraction and the child-process wrapper. A wrong byte here ships in a package, or a build passes that should stop.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {ZipWriter} from './lib/zip.mjs';
import {childEnv, copyInto, download, exists, extractZip, inside, posix, run, sha256Buffer, sha256File, walk} from './lib/files.mjs';

const execFileAsync = promisify(execFile);
const temporary = () => mkdtemp(join(tmpdir(), 'release files test '));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// A local server that counts requests; `routes` maps a path to a function (request, response) or a fixed body.
async function server(routes) {
  const hits = [];
  const instance = http.createServer((request, response) => {
    hits.push(request.url);
    const route = routes[request.url];
    if (typeof route === 'function') return route(request, response, hits.filter(url => url === request.url).length);
    if (route === undefined) { response.writeHead(404); return response.end('no'); }
    response.writeHead(200, {'content-type': 'application/octet-stream'});
    response.end(route);
  });
  await new Promise(done => instance.listen(0, '127.0.0.1', done));
  return {hits, url: path => `http://127.0.0.1:${instance.address().port}${path}`, close: () => new Promise(done => { instance.closeAllConnections?.(); instance.close(done); })};
}

test('a download is checked against its SHA-256 and moved into place only when it matches', async () => {
  const body = Buffer.from('model bytes '.repeat(500));
  const directory = await temporary(), origin = await server({'/a.bin': body});
  try {
    const target = join(directory, 'cache', 'a.bin');
    const logs = [];
    assert.equal(await download(origin.url('/a.bin'), target, sha(body), line => logs.push(line)), target);
    assert.deepEqual(await readFile(target), body);
    assert.deepEqual((await readdir(join(directory, 'cache'))), ['a.bin'], 'the .download temp file is gone');
    assert.match(logs.join('\n'), /Downloading http:\/\/127\.0\.0\.1:\d+\/a\.bin/);
  } finally { await origin.close(); await rm(directory, {recursive: true, force: true}); }
});

test('a cached file with the right hash is reused with no request; a stale one is replaced', async () => {
  const good = Buffer.from('good bytes'), stale = Buffer.from('stale bytes');
  const directory = await temporary(), origin = await server({'/a.bin': good});
  try {
    const target = join(directory, 'a.bin');
    await writeFile(target, good);
    await download(origin.url('/a.bin'), target, sha(good));
    assert.deepEqual(origin.hits, [], 'a verified cache needs no network');
    await writeFile(target, stale);
    await download(origin.url('/a.bin'), target, sha(good));
    assert.deepEqual(origin.hits, ['/a.bin']);
    assert.deepEqual(await readFile(target), good, 'the stale copy was replaced, not trusted');
  } finally { await origin.close(); await rm(directory, {recursive: true, force: true}); }
});

test('a checksum mismatch stops the build, leaves no file at the target and removes the partial download', async () => {
  const directory = await temporary(), origin = await server({'/evil.bin': Buffer.from('tampered')});
  try {
    const target = join(directory, 'evil.bin');
    const expected = sha(Buffer.from('what the pin says'));
    await assert.rejects(download(origin.url('/evil.bin'), target, expected), error => {
      assert.match(error.message, /Checksum mismatch for http:\/\/127\.0\.0\.1:\d+\/evil\.bin/);
      assert(error.message.includes(expected) && error.message.includes(sha(Buffer.from('tampered'))), 'both hashes are in the message');
      return true;
    });
    assert.equal(await exists(target), false);
    assert.equal(await exists(`${target}.download`), false);
    assert.equal(origin.hits.length, 1, 'a bad checksum is not retried like a network failure');
  } finally { await origin.close(); await rm(directory, {recursive: true, force: true}); }
});

test('a download follows a redirect, and with no hash given accepts and later reuses whatever arrived', async () => {
  const body = Buffer.from('redirected');
  const directory = await temporary(), origin = await server({
    '/start': (request, response) => { response.writeHead(302, {location: '/final'}); response.end(); },
    '/final': body,
  });
  try {
    const target = join(directory, 'r.bin');
    await download(origin.url('/start'), target, undefined);
    assert.deepEqual(await readFile(target), body);
    await download(origin.url('/start'), target, undefined);
    assert.deepEqual(origin.hits, ['/start', '/final'], 'the second call used the cached file');
  } finally { await origin.close(); await rm(directory, {recursive: true, force: true}); }
});

test('a failing server is retried with a growing pause, and a later success is verified; four failures end the build with the status', async () => {
  // download() waits 5, 10 and 15 seconds between its four attempts. The call runs in a child process whose preload shortens every
  // pause of five seconds or more to a millisecond, and records the pauses it was asked for.
  const body = Buffer.from('finally');
  const directory = await temporary();
  const origin = await server({'/flaky.bin': (request, response, count) => {
    if (count <= 3) { response.writeHead(503); return response.end('busy'); }
    response.writeHead(200); response.end(body);
  }, '/dead.bin': (request, response) => { response.writeHead(500); response.end('down'); }});
  try {
    const preload = join(directory, 'preload.mjs'), runner = join(directory, 'runner.mjs'), pauses = join(directory, 'pauses.txt');
    await writeFile(preload, `import {appendFileSync} from 'node:fs';
const real = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...rest) => { if (ms >= 5000) { appendFileSync(${JSON.stringify(pauses)}, ms + '\\n'); return real(callback, 1, ...rest); } return real(callback, ms, ...rest); };
`);
    await writeFile(runner, `import {download} from ${JSON.stringify(new URL('./lib/files.mjs', import.meta.url).href)};
const [url, target, hash] = process.argv.slice(2);
try { await download(url, target, hash); console.log('OK'); } catch (error) { console.log('ERR ' + error.message); }
`);
    const attempt = async (path, name) => {
      // Asynchronous on purpose: the server is in this process, and a blocked event loop would never answer the child.
      const child = await execFileAsync(process.execPath, ['--import', pathToFileURL(preload).href, runner, origin.url(path), join(directory, name), sha(body)], {encoding: 'utf8', timeout: 60_000});
      return child.stdout.trim();
    };
    assert.equal(await attempt('/flaky.bin', 'flaky.bin'), 'OK');
    assert.deepEqual(await readFile(join(directory, 'flaky.bin')), body);
    assert.equal(origin.hits.filter(url => url === '/flaky.bin').length, 4, 'three failures, then the fourth attempt succeeds');
    assert.deepEqual((await readFile(pauses, 'utf8')).trim().split(/\r?\n/), ['5000', '10000', '15000'], 'the pause grows by five seconds each time');
    await rm(pauses);
    assert.match(await attempt('/dead.bin', 'dead.bin'), /^ERR Download failed for .*\/dead\.bin: HTTP 500$/);
    assert.equal(origin.hits.filter(url => url === '/dead.bin').length, 4, 'four attempts, then it gives up');
    assert.equal(await exists(join(directory, 'dead.bin')), false);
    assert.equal((await readFile(pauses, 'utf8')).trim().split(/\r?\n/).length, 3, 'no pause after the last failure');
  } finally { await origin.close(); await rm(directory, {recursive: true, force: true}); }
});

test('walk lists regular files only, sorted with forward slashes, honours skip, and refuses a link inside a package tree', async (t) => {
  const directory = await temporary();
  try {
    await mkdir(join(directory, 'b/deep'), {recursive: true});
    await mkdir(join(directory, 'skipme'));
    for (const rel of ['z.txt', 'a.txt', 'b/two.txt', 'b/deep/three.txt', 'skipme/x.txt', 'B.txt']) await writeFile(join(directory, rel), rel);
    assert.deepEqual(await walk(directory), ['B.txt', 'a.txt', 'b/deep/three.txt', 'b/two.txt', 'skipme/x.txt', 'z.txt'], 'sorted by code unit, not by locale');
    assert.deepEqual(await walk(directory, {skip: rel => rel === 'skipme' || rel.startsWith('b/deep')}), ['B.txt', 'a.txt', 'b/two.txt', 'z.txt']);
    assert.deepEqual(await walk(join(directory, 'b')), ['deep/three.txt', 'two.txt'], 'paths are relative to the root given');
    await mkdir(join(directory, 'outside'));
    try { await symlink(join(directory, 'outside'), join(directory, 'b/link'), 'junction'); }
    catch (error) { return t.skip(`cannot create a link here: ${error.code}`); }
    await assert.rejects(walk(directory), /Refusing a link inside a package tree: b\/link/);
    assert.deepEqual(await walk(directory, {skip: rel => rel === 'b/link'}).then(list => list.includes('b/two.txt')), true, 'a skipped link is not an error');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('copyInto creates the folders it needs and refuses anything that is not a regular file', async () => {
  const directory = await temporary();
  try {
    await writeFile(join(directory, 'source.bin'), 'payload');
    await copyInto(join(directory, 'source.bin'), join(directory, 'new/deeper/copy.bin'));
    assert.equal(await readFile(join(directory, 'new/deeper/copy.bin'), 'utf8'), 'payload');
    await mkdir(join(directory, 'folder'));
    await assert.rejects(copyInto(join(directory, 'folder'), join(directory, 'x/folder')), /Not a regular file/);
    await assert.rejects(copyInto(join(directory, 'missing'), join(directory, 'x/missing')), {code: 'ENOENT'});
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('sha256File hashes whole files and exact byte ranges, and an empty file has the well-known empty hash', async () => {
  const directory = await temporary();
  try {
    const bytes = Buffer.from(Array.from({length: 10_000}, (value, index) => index % 251));
    await writeFile(join(directory, 'b.bin'), bytes);
    assert.equal(await sha256File(join(directory, 'b.bin')), sha(bytes));
    assert.equal(await sha256File(join(directory, 'b.bin'), {start: 100, length: 400}), sha(bytes.subarray(100, 500)));
    assert.equal(await sha256File(join(directory, 'b.bin'), {start: 9_900, length: 100}), sha(bytes.subarray(9_900)));
    await writeFile(join(directory, 'empty'), '');
    assert.equal(await sha256File(join(directory, 'empty')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Buffer(Buffer.alloc(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    await assert.rejects(sha256File(join(directory, 'missing')), {code: 'ENOENT'});
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('childEnv drops PSModulePath only for Windows PowerShell and never changes the caller\'s environment', () => {
  const env = {PATH: 'p', PSModulePath: 'c:\\ps7', psmodulepath: 'lower', Other: '1'};
  for (const command of ['powershell', 'powershell.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '/usr/bin/powershell']) {
    assert.deepEqual(childEnv(command, env), {PATH: 'p', Other: '1'}, command);
  }
  for (const command of ['node', 'pwsh', 'pwsh.exe', 'powershell-core.exe', 'C:\\tools\\mypowershell.cmd']) {
    assert.deepEqual(childEnv(command, env), env, command);
  }
  assert.equal(env.PSModulePath, 'c:\\ps7', 'the original object is untouched');
});

test('run resolves with the tail of the output when quiet, and a non-zero exit rejects with the command and the output', async () => {
  const quiet = await run(process.execPath, ['-e', 'console.log("hello"); console.error("warned")'], {quiet: true});
  assert.match(quiet, /hello/);
  assert.match(quiet, /warned/);
  await assert.rejects(run(process.execPath, ['-e', 'console.error("boom reason"); process.exit(3)'], {quiet: true}), error => {
    assert.match(error.message, /exited with 3/);
    assert.match(error.message, /boom reason/);
    return true;
  });
  await assert.rejects(run(join(tmpdir(), 'no-such-program-for-the-release-test'), [], {quiet: true}), {code: 'ENOENT'});
  const long = await run(process.execPath, ['-e', 'process.stdout.write("x".repeat(50000) + "END")'], {quiet: true});
  assert(long.length <= 20000 && long.endsWith('END'), 'only the last 20 KB of output are kept');
});

test('extractZip replaces what was in the destination and unpacks a real archive; a broken archive fails', async () => {
  const directory = await temporary();
  try {
    const zip = await ZipWriter.create(join(directory, 'a.zip'));
    await zip.add('dir/one.txt', {buffer: Buffer.from('one')});
    await zip.add('two.txt', {buffer: Buffer.from('two')});
    await zip.close();
    const destination = join(directory, 'out');
    await mkdir(destination);
    await writeFile(join(destination, 'leftover.txt'), 'from an earlier extraction');
    await extractZip(join(directory, 'a.zip'), destination);
    assert.deepEqual(await walk(destination), ['dir/one.txt', 'two.txt'], 'the old content of the folder is gone first');
    assert.equal(await readFile(join(destination, 'dir/one.txt'), 'utf8'), 'one');
    await writeFile(join(directory, 'broken.zip'), 'this is not a zip');
    await assert.rejects(extractZip(join(directory, 'broken.zip'), join(directory, 'out2')), /exited with/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('inside accepts the root and its descendants only, and posix turns separators into slashes', () => {
  const root = resolve('/project/root');
  assert.equal(inside(root, root), true);
  assert.equal(inside(root, join(root, 'a', 'b')), true);
  assert.equal(inside(root, resolve(root, '..', 'sibling')), false);
  assert.equal(inside(root, resolve(root, '..')), false);
  assert.equal(inside(root, resolve(root, '..hidden')), false, 'a name that merely starts with two dots is still rejected (the rule is deliberately strict)');
  assert.equal(posix(join('a', 'b', 'c.txt')), 'a/b/c.txt');
});
