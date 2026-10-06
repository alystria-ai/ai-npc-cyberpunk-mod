import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = resolve(project, 'scripts/Reference-Picker.mjs');
const freePort = () => new Promise(done => { const server = createServer().listen(0, '127.0.0.1', () => { const {port} = server.address(); server.close(() => done(port)); }); });

// The launcher runs headless and detached from the page: no browser, a status file, one instance at a time.
test('starts headless, writes its status file and refuses to start twice', {skip: !existsSync(resolve(project, 'runtime/pocket-voices.json')) || !existsSync(resolve(project, 'runtime/local-voices.json'))}, async () => {
  const work = await mkdtemp(join(tmpdir(), 'launch-')), runtime = join(work, 'runtime'), port = await freePort();
  await mkdir(runtime, {recursive: true});
  await writeFile(join(work, 'pool-index.json'), JSON.stringify({dataRoot: work, voices: {}}));
  const args = [script, '--port', String(port), '--work', work, '--runtime', runtime, '--fake-render'];
  const child = spawn(process.execPath, args, {cwd: project, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', part => { output += part; }); child.stderr.on('data', part => { output += part; });
  try {
    for (let wait = 0; wait < 100 && !existsSync(join(runtime, 'reference-picker.json')); wait++) await new Promise(done => setTimeout(done, 100));
    const status = JSON.parse(await readFile(join(runtime, 'reference-picker.json'), 'utf8'));
    assert.equal(status.port, port); assert.equal(status.pid, child.pid); assert.ok(Date.parse(status.started)); assert.equal(status.url, `http://127.0.0.1:${port}/`);
    assert.equal((await fetch(status.url)).status, 200);
    const second = spawnSync(process.execPath, args, {cwd: project, encoding: 'utf8', timeout: 20_000});
    assert.equal(second.status, 0);
    assert.match(second.stdout, new RegExp(`already running: http://127.0.0.1:${port}/`));
    // a different port with the same status file is still the same instance
    const third = spawnSync(process.execPath, [...args.slice(0, 2), String(port + 1), ...args.slice(3)], {cwd: project, encoding: 'utf8', timeout: 20_000});
    assert.equal(third.status, 0);
    assert.match(third.stdout, /already running/);
    assert.ok(!/opening|browser/i.test(output));
  } finally { child.kill(); }
});
