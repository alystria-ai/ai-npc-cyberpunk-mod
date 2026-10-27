import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RemoteOmniAddress, RemoteOmniControl, parseRemoteCommand, REMOTE_FILE, COMMANDS} from './remote-omni-control.mjs';

const until = async (condition, ms = 3000) => { const end = Date.now() + ms; while (!condition() && Date.now() < end) await new Promise(done => setTimeout(done, 5)); assert.ok(condition(), 'waited for the background test'); };

function rig({clipboard = '192.168.1.20:8765', probe} = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'remote-omni-'));
  const states = [], logs = [];
  const address = new RemoteOmniAddress({path: join(folder, REMOTE_FILE), log: line => logs.push(line)});
  let text = clipboard, command = '';
  const control = new RemoteOmniControl({address, commandPath: 'command', publish: value => states.push(JSON.parse(JSON.stringify(value))),
    readClipboard: async () => { if (text instanceof Error) throw text; return text; },
    probe: probe ?? (async endpoint => ({state: 'ok', ms: 3, version: '0.3.3', device: 'cuda:0', host: endpoint.host})), read: async () => command, log: line => logs.push(line)});
  const send = (action, id = `s:remote:${states.length + 1}`) => { command = JSON.stringify({version: 1, id, action, issuedAt: Date.now()}); return id; };
  return {folder, address, control, states, logs, send, setClipboard: value => { text = value; }, last: () => states.at(-1), done: () => { try { rmSync(folder, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}); } catch {} }};
}

test('commands: only the three, well formed, not from the future', () => {
  assert.deepEqual(COMMANDS, ['paste-address', 'clear-address', 'test']);
  const base = {version: 1, id: 'a:remote:1', action: 'test', issuedAt: 1000};
  assert.deepEqual(parseRemoteCommand(JSON.stringify(base), 1000), {id: 'a:remote:1', action: 'test'});
  for (const bad of [{...base, action: 'paste-key'}, {...base, id: '../x'}, {...base, version: 2}, {...base, issuedAt: 9_999_999}, {...base, issuedAt: 1.5}, 'nope', '[]', {}]) {
    assert.equal(parseRemoteCommand(typeof bad === 'string' ? bad : JSON.stringify(bad), 1000), null);
  }
  assert.equal(parseRemoteCommand('x'.repeat(5000), 1000), null);
});

test('the address file: read at start, written by a paste, removed by Remove, and a hand edit is read again', async () => {
  const r = rig();
  try {
    await r.address.load(); assert.equal(r.address.endpoint, null); assert.equal(r.address.text, null);
    await r.control.open(); assert.deepEqual([r.last().set, r.last().address], [false, null]);
    r.send('paste-address', 'a:remote:1'); await r.control.poll();
    assert.deepEqual(r.last().result, {id: 'a:remote:1', state: 'saved'});
    assert.equal(r.last().address, '192.168.1.20:8765'); assert.equal(r.last().set, true);
    assert.equal(readFileSync(join(r.folder, REMOTE_FILE), 'utf8'), 'address=192.168.1.20:8765\n');
    // the same command again does nothing (the file is unchanged)
    const count = r.states.length; await r.control.poll(); assert.equal(r.states.length, count);
    r.send('clear-address', 'a:remote:2'); await r.control.poll();
    assert.deepEqual(r.last().result, {id: 'a:remote:2', state: 'cleared'}); assert.equal(r.last().set, false); assert.ok(!existsSync(join(r.folder, REMOTE_FILE)));
    writeFileSync(join(r.folder, REMOTE_FILE), '﻿# mine\r\naddress = http://Gaming-PC.local:9000/\r\n');
    await r.address.load(); assert.equal(r.address.text, 'gaming-pc.local:9000');
    writeFileSync(join(r.folder, REMOTE_FILE), 'address=bad address\n');
    await r.address.load(); assert.equal(r.address.endpoint, null);
  } finally { r.done(); }
});

test('a paste is checked: every refusal has its reason and nothing is saved', async () => {
  const r = rig();
  try {
    await r.control.open();
    for (const [clipboard, reason] of [['', 'empty'], ['https://host:1', 'scheme'], ['http://u:p@host', 'extras'], ['host/path', 'extras'], ['bad host', 'host'], ['host:99999', 'port'], ['x'.repeat(400), 'long']]) {
      r.setClipboard(clipboard); r.send('paste-address'); await r.control.poll();
      assert.deepEqual([r.last().result.state, r.last().result.reason], ['invalid', reason], clipboard.slice(0, 20));
    }
    assert.equal(r.address.endpoint, null); assert.ok(!existsSync(join(r.folder, REMOTE_FILE)));
    r.setClipboard(new Error('no clipboard')); r.send('paste-address'); await r.control.poll();
    assert.equal(r.last().result.state, 'unreadable');
    // only the first line of the clipboard counts
    r.setClipboard('10.0.0.5:9000\nsecond line'); r.send('paste-address'); await r.control.poll();
    assert.equal(r.address.text, '10.0.0.5:9000');
  } finally { r.done(); }
});

test('Test: runs in the background, answers the latest press, and without an address says so', async () => {
  let release; const gate = new Promise(done => { release = done; });
  const asked = [];
  const r = rig({probe: async endpoint => { asked.push(endpoint); await gate; return {state: 'ok', ms: 2, version: '0.3.3', device: 'cuda:0'}; }});
  try {
    await r.control.open();
    r.send('test', 'a:remote:1'); await r.control.poll(); await until(() => r.last().test?.state === 'failed');
    assert.deepEqual(r.last().test, {id: 'a:remote:1', state: 'failed', code: 'no-address'});
    r.setClipboard('127.0.0.1:8765'); r.send('paste-address', 'a:remote:2'); await r.control.poll();
    r.send('test', 'a:remote:3'); await r.control.poll(); await until(() => asked.length === 1);
    assert.deepEqual(r.last().test, {id: 'a:remote:3', state: 'testing'});
    r.send('test', 'a:remote:4'); await r.control.poll();          // a second press while one runs: no second request, the running one answers to it
    assert.deepEqual(r.last().test, {id: 'a:remote:4', state: 'testing'});
    assert.equal(asked.length, 1);
    release(); await until(() => r.last().test?.state === 'ok');
    assert.deepEqual(r.last().test, {id: 'a:remote:4', state: 'ok', ms: 2, version: '0.3.3', device: 'cuda:0'});
    assert.deepEqual(asked[0], {host: '127.0.0.1', port: 8765, origin: 'http://127.0.0.1:8765'});
    // a new address clears the old answer
    r.setClipboard('127.0.0.1:9000'); r.send('paste-address', 'a:remote:5'); await r.control.poll();
    assert.equal(r.last().test, undefined);
    // the address is never in a log line
    assert.ok(!r.logs.join('\n').includes('127.0.0.1'));
  } finally { r.done(); }
});

test('a probe that throws is an unreachable server, not a crash', async () => {
  const r = rig({probe: async () => { throw Error('boom'); }});
  try {
    await r.control.open(); r.setClipboard('10.1.1.1'); r.send('paste-address', 'a:remote:1'); await r.control.poll();
    r.send('test', 'a:remote:2'); await r.control.poll(); await until(() => r.last().test?.state === 'failed');
    assert.deepEqual(r.last().test, {id: 'a:remote:2', state: 'failed', code: 'unreachable'});
  } finally { r.done(); }
});
