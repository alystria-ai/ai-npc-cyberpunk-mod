// Is the Runtime base older than the Scripts need (bridge/runtime-base.mjs)? Read from the two release.json files; anything unreadable claims nothing.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runtimeBaseOld} from './runtime-base.mjs';

function folders(t, {scripts, runtime}) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-base-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const modRoot = join(root, 'mod'), project = join(root, 'app');
  mkdirSync(modRoot); mkdirSync(project);
  if (scripts !== undefined) writeFileSync(join(modRoot, 'release.json'), typeof scripts === 'string' ? scripts : JSON.stringify(scripts));
  if (runtime !== undefined) writeFileSync(join(project, 'release.json'), typeof runtime === 'string' ? runtime : JSON.stringify(runtime));
  return {modRoot, project};
}

test('a base older than the Scripts name is reported with both versions; an equal or newer one, and every unreadable case, claims nothing', t => {
  const old = folders(t, {scripts: {version: '0.4.0', runtimeBase: '0.3.3'}, runtime: {package: 'runtime', version: '0.3.2'}});
  assert.deepEqual(runtimeBaseOld(old), {runtime: '0.3.2', required: '0.3.3', scripts: '0.4.0'});
  assert.equal(runtimeBaseOld(folders(t, {scripts: {version: '0.4.0', runtimeBase: '0.3.3'}, runtime: {version: '0.3.3'}})), null);
  assert.equal(runtimeBaseOld(folders(t, {scripts: {version: '0.4.0', runtimeBase: '0.3.3'}, runtime: {version: '0.4.0'}})), null);
  assert.equal(runtimeBaseOld(folders(t, {scripts: {version: '0.4.0', runtimeBase: '0.3.10'}, runtime: {version: '0.3.9'}})).runtime, '0.3.9', 'numbers, not text');
  // Scripts from before 0.3.4 name no base; a development checkout has no release.json; a damaged file; no folders.
  assert.equal(runtimeBaseOld(folders(t, {scripts: {version: '0.3.0'}, runtime: {version: '0.2.9'}})), null);
  assert.equal(runtimeBaseOld(folders(t, {scripts: {version: '0.4.0', runtimeBase: '0.3.3'}})), null);
  assert.equal(runtimeBaseOld(folders(t, {scripts: '{broken', runtime: {version: '0.3.2'}})), null);
  assert.equal(runtimeBaseOld(folders(t, {scripts: {runtimeBase: 'not a version'}, runtime: {version: '0.3.2'}})), null);
  assert.equal(runtimeBaseOld({}), null);
  assert.equal(runtimeBaseOld(), null);
});
