import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ZipWriter} from './lib/zip.mjs';
import {zipListing} from './lib/zip-listing.mjs';

test('the list worked out from a zip has the paths, sizes and SHA-256 of the files in it, like the build\'s .files.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-listing-'));
  try {
    const files = {'a/one.txt': 'one', 'b/two.bin': Buffer.alloc(300_000, 7).toString('latin1'), 'three.json': '{}'};
    const path = join(dir, 'x.zip');
    const writer = await ZipWriter.create(path);
    for (const name of Object.keys(files)) await writer.add(name, {buffer: Buffer.from(files[name], 'latin1')});
    await writer.close();
    const rows = await zipListing(path);
    assert.deepEqual(rows.map(row => row.path).sort(), Object.keys(files).sort());
    for (const row of rows) {
      const bytes = Buffer.from(files[row.path], 'latin1');
      assert.equal(row.bytes, bytes.length, row.path);
      assert.equal(row.sha256, createHash('sha256').update(bytes).digest('hex'), row.path);
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});
